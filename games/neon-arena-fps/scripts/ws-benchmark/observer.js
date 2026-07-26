'use strict';

const fs = require('fs');
const WebSocket = require('ws');

const host = process.env.BENCH_HOST || 'ws://127.0.0.1:3000';
const warmupMs = numberEnv('BENCH_WARMUP_MS', 3000);
const durationMs = numberEnv('BENCH_DURATION_MS', 12000);
const signalFile = process.env.BENCH_SIGNAL_FILE || '';
const pingEveryMs = numberEnv('BENCH_PING_MS', 500);
const expectedStateRate = numberEnv('BENCH_STATE_RATE', 20);
const freshStateThresholdMs = numberEnv('BENCH_FRESH_STATE_MS', 250);

let ws;
let openedAt = 0;
let measuring = false;
let measureStartedAt = 0;
let finishing = false;
let messageCount = 0;
let malformedMessages = 0;
let shapeErrors = 0;
let timestampRegressions = 0;
let appBytes = 0;
let stateBytes = 0;
let lastStateTimestamp = null;
let lastStateReceivedAt = null;
let closeCode = null;
let closeReason = '';
let freshStateCount = 0;
const stateAges = [];
const stateIntervals = [];
const statePayloads = [];
const pingRtts = [];
const errors = [];

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentileValue * sorted.length) - 1));
  return Number(sorted[index].toFixed(2));
}

function summary(values) {
  if (!values.length) return { count: 0, min: null, p50: null, p95: null, p99: null, max: null, mean: null };
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    min: Number(Math.min(...values).toFixed(2)),
    p50: percentile(values, 0.50),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: Number(Math.max(...values).toFixed(2)),
    mean: Number((total / values.length).toFixed(2)),
  };
}

function startMeasurement() {
  if (measuring || finishing) return;
  measuring = true;
  measureStartedAt = Date.now();
  if (signalFile) {
    fs.writeFileSync(signalFile, JSON.stringify({ pid: process.pid, startedAt: measureStartedAt }));
  }
  setTimeout(finish, durationMs);
}

function finish() {
  if (finishing) return;
  finishing = true;
  const finishedAt = Date.now();
  const elapsedMs = Math.max(1, finishedAt - measureStartedAt);
  const expectedStates = elapsedMs / 1000 * expectedStateRate;
  const result = {
    ok: errors.length === 0 && malformedMessages === 0 && shapeErrors === 0,
    host,
    extensions: ws ? ws.extensions : '',
    connectMs: openedAt || null,
    elapsedMs,
    messages: messageCount,
    malformedMessages,
    shapeErrors,
    timestampRegressions,
    appBytes,
    stateBytes,
    appKbps: Number((appBytes * 8 / elapsedMs).toFixed(2)),
    stateKbps: Number((stateBytes * 8 / elapsedMs).toFixed(2)),
    stateRateHz: Number((stateAges.length * 1000 / elapsedMs).toFixed(2)),
    deliveryRatioPct: Number((stateAges.length / expectedStates * 100).toFixed(2)),
    freshStateThresholdMs,
    freshStateRateHz: Number((freshStateCount * 1000 / elapsedMs).toFixed(2)),
    freshDeliveryRatioPct: Number((Math.min(1, freshStateCount / expectedStates) * 100).toFixed(2)),
    staleStateRatioPct: Number((stateAges.length ? (1 - freshStateCount / stateAges.length) * 100 : 100).toFixed(2)),
    stateAgeMs: summary(stateAges),
    stateIntervalMs: summary(stateIntervals),
    statePayloadBytes: summary(statePayloads),
    pingRttMs: summary(pingRtts),
    gapsOver100Ms: stateIntervals.filter(value => value > 100).length,
    gapsOver250Ms: stateIntervals.filter(value => value > 250).length,
    closeCode,
    closeReason,
    errors,
  };

  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close(1000, 'benchmark complete');
    setTimeout(() => ws.terminate(), 250).unref();
  }
  setTimeout(() => process.exit(result.ok ? 0 : 2), 300).unref();
}

const connectStartedAt = Date.now();
ws = new WebSocket(host, { perMessageDeflate: true, handshakeTimeout: 15000 });

ws.on('open', () => {
  openedAt = Date.now() - connectStartedAt;
  ws.send(JSON.stringify({ type: 'spectate' }));
  setTimeout(startMeasurement, warmupMs);
});

ws.on('message', data => {
  const receivedAt = Date.now();
  let message;
  try {
    message = JSON.parse(data);
  } catch (error) {
    if (measuring) malformedMessages++;
    return;
  }

  if (!measuring || finishing) return;
  messageCount++;
  appBytes += data.length;

  if (message.type === 'pong' && Number.isFinite(message.t)) {
    pingRtts.push(Math.max(0, receivedAt - message.t));
    return;
  }
  if (message.type !== 'state') return;

  if (!Array.isArray(message.pl) || !Number.isFinite(message.t)) shapeErrors++;
  if (lastStateTimestamp !== null && message.t < lastStateTimestamp) timestampRegressions++;
  if (lastStateReceivedAt !== null) stateIntervals.push(receivedAt - lastStateReceivedAt);
  lastStateTimestamp = message.t;
  lastStateReceivedAt = receivedAt;
  const stateAge = Math.max(0, receivedAt - message.t);
  stateAges.push(stateAge);
  if (stateAge <= freshStateThresholdMs) freshStateCount++;
  statePayloads.push(data.length);
  stateBytes += data.length;
});

ws.on('close', (code, reason) => {
  closeCode = code;
  closeReason = reason.toString();
  if (!finishing) {
    errors.push(`closed before completion: ${code} ${closeReason}`.trim());
    if (measuring) finish();
    else process.exit(3);
  }
});

ws.on('error', error => {
  errors.push(error.message);
  if (!measuring && !finishing) {
    process.stderr.write(`${error.stack || error.message}\n`);
  }
});

const pingTimer = setInterval(() => {
  if (measuring && !finishing && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping', t: Date.now(), rtt: pingRtts.at(-1) || 0 }));
  }
}, pingEveryMs);
pingTimer.unref();

setTimeout(() => {
  if (!finishing) {
    errors.push('benchmark hard timeout');
    if (measuring) finish();
    else process.exit(4);
  }
}, warmupMs + durationMs + 30000).unref();
