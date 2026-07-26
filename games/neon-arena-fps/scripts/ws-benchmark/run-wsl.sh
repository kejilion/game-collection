#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$script_dir/../.." && pwd)"
results_dir="${1:-$project_dir/reports/ws-benchmark}"
repetitions="${BENCH_REPETITIONS:-3}"
warmup_ms="${BENCH_WARMUP_MS:-3000}"
duration_ms="${BENCH_DURATION_MS:-12000}"
port="${BENCH_PORT:-3210}"
clock_ticks="$(getconf CLK_TCK)"

run_id="$$"
server_ns="wsbs${run_id}"
client_ns="wsbc${run_id}"
server_if="wssa${run_id}"
client_if="wsca${run_id}"
temp_dir="$(mktemp -d /tmp/wsbench.XXXXXX)"
raw_file="$results_dir/raw.jsonl"
server_log="$results_dir/server.log"
bot_log="$results_dir/bots.log"

server_pid=""
bot_pid=""
client_pid=""
probe_pid=""

cleanup_processes() {
  for pid in "$client_pid" "$probe_pid" "$bot_pid" "$server_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      for _ in {1..20}; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.05
      done
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
  server_pid=""
  bot_pid=""
  client_pid=""
  probe_pid=""
}

cleanup() {
  cleanup_processes
  ip netns del "$server_ns" 2>/dev/null || true
  ip netns del "$client_ns" 2>/dev/null || true
  if [[ "$temp_dir" == /tmp/wsbench.* ]]; then
    rm -rf -- "$temp_dir"
  fi
}
trap cleanup EXIT INT TERM

mkdir -p "$results_dir"
: > "$raw_file"
: > "$server_log"
: > "$bot_log"

ip netns add "$server_ns"
ip netns add "$client_ns"
ip link add "$server_if" type veth peer name "$client_if"
ip link set "$server_if" netns "$server_ns"
ip link set "$client_if" netns "$client_ns"
ip -n "$server_ns" addr add 10.203.0.1/24 dev "$server_if"
ip -n "$client_ns" addr add 10.203.0.2/24 dev "$client_if"
ip -n "$server_ns" link set lo up
ip -n "$client_ns" link set lo up
ip -n "$server_ns" link set "$server_if" up
ip -n "$client_ns" link set "$client_if" up

scenarios=(
  "lan|0|0|0|0|0"
  "latency|200|20|0|5mbit|1mbit"
  "good4g|100|20|0.25|2mbit|512kbit"
  "weak3g|200|50|1|768kbit|256kbit"
  "lossy|120|30|3|3mbit|512kbit"
  "severe|400|100|2.5|256kbit|128kbit"
)

read_cpu_ticks() {
  awk '{print $14 + $15}' "/proc/$1/stat"
}

read_rss_kb() {
  awk '/^VmRSS:/ {print $2}' "/proc/$1/status"
}

read_counter() {
  ip netns exec "$1" cat "/sys/class/net/$2/statistics/$3"
}

configure_netem() {
  local rtt_ms="$1"
  local jitter_ms="$2"
  local loss_pct="$3"
  local down_rate="$4"
  local up_rate="$5"
  local one_way_ms=$((rtt_ms / 2))
  local one_way_jitter=$((jitter_ms / 2))

  ip netns exec "$server_ns" tc qdisc del dev "$server_if" root 2>/dev/null || true
  ip netns exec "$client_ns" tc qdisc del dev "$client_if" root 2>/dev/null || true

  if [[ "$rtt_ms" == "0" ]]; then
    return
  fi

  ip netns exec "$server_ns" tc qdisc add dev "$server_if" root netem \
    delay "${one_way_ms}ms" "${one_way_jitter}ms" distribution normal \
    loss random "${loss_pct}%" rate "$down_rate"
  ip netns exec "$client_ns" tc qdisc add dev "$client_if" root netem \
    delay "${one_way_ms}ms" "${one_way_jitter}ms" distribution normal \
    loss random "${loss_pct}%" rate "$up_rate"
}

wait_for_health() {
  for _ in {1..100}; do
    if ip netns exec "$server_ns" curl --noproxy '*' -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

wait_for_players() {
  for _ in {1..150}; do
    local count
    count="$(ip netns exec "$server_ns" curl --noproxy '*' -fsS "http://127.0.0.1:$port/health" 2>/dev/null | jq -r '.players // 0' || true)"
    if [[ "$count" == "24" ]]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

start_stack() {
  local mode="$1"
  local data_dir="$temp_dir/data-${mode}"
  mkdir -p "$data_dir"
  ip netns exec "$server_ns" env \
    PORT="$port" \
    DATA_DIR="$data_dir" \
    AC_MODE=off \
    AC_AUDIT_MODE=off \
    CHAT_FILTER_MODE=off \
    IP_MAX_CONCURRENT=64 \
    WS_FLOOD_MAX_PER_SECOND=100 \
    WS_COMPRESSION="$mode" \
    WS_COMPRESSION_THRESHOLD=1024 \
    WS_COMPRESSION_CONCURRENCY=5 \
    WS_COMPRESSION_LEVEL=3 \
    node "$project_dir/server/index.js" >>"$server_log" 2>&1 &
  server_pid=$!

  if ! wait_for_health; then
    echo "server failed to start for mode=$mode" >&2
    tail -n 40 "$server_log" >&2
    exit 10
  fi

  ip netns exec "$server_ns" env \
    BENCH_HOST="ws://127.0.0.1:$port" \
    BENCH_BOTS=24 \
    node "$script_dir/bot-load.js" >>"$bot_log" 2>&1 &
  bot_pid=$!

  if ! wait_for_players; then
    echo "bots failed to fill the room for mode=$mode" >&2
    tail -n 40 "$bot_log" >&2
    exit 11
  fi
}

stop_stack() {
  cleanup_processes
  sleep 0.2
}

run_repetition() {
  local scenario="$1"
  local mode="$2"
  local repetition="$3"
  local rtt_ms="$4"
  local jitter_ms="$5"
  local loss_pct="$6"
  local down_rate="$7"
  local up_rate="$8"
  local weak_output="$temp_dir/weak-${scenario}-${mode}-${repetition}.json"
  local probe_output="$temp_dir/probe-${scenario}-${mode}-${repetition}.json"
  local weak_signal="$temp_dir/weak-${scenario}-${mode}-${repetition}.signal"

  rm -f -- "$weak_output" "$probe_output" "$weak_signal"
  configure_netem "$rtt_ms" "$jitter_ms" "$loss_pct" "$down_rate" "$up_rate"

  ip netns exec "$client_ns" env \
    BENCH_HOST="ws://10.203.0.1:$port" \
    BENCH_WARMUP_MS="$warmup_ms" \
    BENCH_DURATION_MS="$duration_ms" \
    BENCH_SIGNAL_FILE="$weak_signal" \
    node "$script_dir/observer.js" >"$weak_output" 2>"$weak_output.stderr" &
  client_pid=$!

  ip netns exec "$server_ns" env \
    BENCH_HOST="ws://127.0.0.1:$port" \
    BENCH_WARMUP_MS="$warmup_ms" \
    BENCH_DURATION_MS="$duration_ms" \
    node "$script_dir/observer.js" >"$probe_output" 2>"$probe_output.stderr" &
  probe_pid=$!

  for _ in {1..300}; do
    [[ -f "$weak_signal" ]] && break
    if ! kill -0 "$client_pid" 2>/dev/null; then
      echo "weak observer exited before measurement: $scenario/$mode/$repetition" >&2
      cat "$weak_output.stderr" >&2 || true
      exit 12
    fi
    sleep 0.05
  done
  if [[ ! -f "$weak_signal" ]]; then
    echo "weak observer did not start measurement: $scenario/$mode/$repetition" >&2
    exit 13
  fi

  local started_at
  local cpu_start
  local rss_start
  local down_start
  local up_start
  started_at="$(date +%s%3N)"
  cpu_start="$(read_cpu_ticks "$server_pid")"
  rss_start="$(read_rss_kb "$server_pid")"
  down_start="$(read_counter "$server_ns" "$server_if" tx_bytes)"
  up_start="$(read_counter "$client_ns" "$client_if" tx_bytes)"

  wait "$client_pid"
  client_pid=""
  wait "$probe_pid"
  probe_pid=""

  local finished_at
  local elapsed_ms
  local cpu_end
  local rss_end
  local down_end
  local up_end
  local down_bytes
  local up_bytes
  local cpu_pct
  local down_kbps
  local up_kbps
  finished_at="$(date +%s%3N)"
  elapsed_ms=$((finished_at - started_at))
  cpu_end="$(read_cpu_ticks "$server_pid")"
  rss_end="$(read_rss_kb "$server_pid")"
  down_end="$(read_counter "$server_ns" "$server_if" tx_bytes)"
  up_end="$(read_counter "$client_ns" "$client_if" tx_bytes)"
  down_bytes=$((down_end - down_start))
  up_bytes=$((up_end - up_start))
  cpu_pct="$(awk -v ticks="$((cpu_end - cpu_start))" -v hz="$clock_ticks" -v ms="$elapsed_ms" 'BEGIN { printf "%.2f", ticks / hz / (ms / 1000) * 100 }')"
  down_kbps="$(awk -v bytes="$down_bytes" -v ms="$elapsed_ms" 'BEGIN { printf "%.2f", bytes * 8 / ms }')"
  up_kbps="$(awk -v bytes="$up_bytes" -v ms="$elapsed_ms" 'BEGIN { printf "%.2f", bytes * 8 / ms }')"

  jq -nc \
    --arg scenario "$scenario" \
    --arg mode "$mode" \
    --argjson repetition "$repetition" \
    --argjson rttMs "$rtt_ms" \
    --argjson jitterMs "$jitter_ms" \
    --argjson lossPctPerDirection "$loss_pct" \
    --arg downRate "$down_rate" \
    --arg upRate "$up_rate" \
    --argjson elapsedMs "$elapsed_ms" \
    --argjson downBytes "$down_bytes" \
    --argjson upBytes "$up_bytes" \
    --argjson downKbps "$down_kbps" \
    --argjson upKbps "$up_kbps" \
    --argjson cpuPct "$cpu_pct" \
    --argjson rssStartKb "$rss_start" \
    --argjson rssEndKb "$rss_end" \
    --slurpfile weakClient "$weak_output" \
    --slurpfile localProbe "$probe_output" \
    '{
      scenario: $scenario,
      mode: $mode,
      repetition: $repetition,
      network: {
        rttMs: $rttMs,
        jitterMs: $jitterMs,
        lossPctPerDirection: $lossPctPerDirection,
        downRate: $downRate,
        upRate: $upRate
      },
      measurementElapsedMs: $elapsedMs,
      wire: {
        downBytes: $downBytes,
        upBytes: $upBytes,
        downKbps: $downKbps,
        upKbps: $upKbps
      },
      server: {
        cpuPct: $cpuPct,
        rssStartKb: $rssStartKb,
        rssEndKb: $rssEndKb
      },
      weakClient: $weakClient[0],
      localProbe: $localProbe[0]
    }' >>"$raw_file"

  echo "PASS scenario=$scenario mode=$mode repetition=$repetition down=${down_kbps}Kbps state=$(jq -r '.stateRateHz' "$weak_output")Hz ageP95=$(jq -r '.stateAgeMs.p95' "$weak_output")ms cpu=${cpu_pct}%"
}

for scenario_row in "${scenarios[@]}"; do
  IFS='|' read -r scenario rtt_ms jitter_ms loss_pct down_rate up_rate <<<"$scenario_row"
  for mode in off on; do
    start_stack "$mode"
    for repetition in $(seq 1 "$repetitions"); do
      run_repetition "$scenario" "$mode" "$repetition" "$rtt_ms" "$jitter_ms" "$loss_pct" "$down_rate" "$up_rate"
    done
    stop_stack
  done
done

node "$script_dir/analyze.js" \
  "$raw_file" \
  "$results_dir/summary.json" \
  "$results_dir/report.md" \
  >/dev/null

echo "RESULTS $results_dir"
