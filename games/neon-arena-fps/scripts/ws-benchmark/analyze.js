'use strict';

const fs = require('fs');
const path = require('path');

const inputPath = process.argv[2];
const jsonOutputPath = process.argv[3];
const markdownOutputPath = process.argv[4];

if (!inputPath || !jsonOutputPath || !markdownOutputPath) {
  process.stderr.write('Usage: node analyze.js <raw.jsonl> <summary.json> <report.md>\n');
  process.exit(1);
}

const rows = fs.readFileSync(inputPath, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map(line => JSON.parse(line));

function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function round(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function metric(value, suffix = '') {
  return Number.isFinite(value) ? `${value}${suffix}` : 'N/A';
}

function aggregate(group) {
  const value = selector => round(mean(group.map(selector)));
  return {
    runs: group.length,
    negotiationPass: group.every(row =>
      row.mode === 'on'
        ? row.weakClient.extensions.includes('permessage-deflate')
        : !row.weakClient.extensions
    ),
    correctnessPass: group.every(row =>
      row.weakClient.ok &&
      row.weakClient.malformedMessages === 0 &&
      row.weakClient.shapeErrors === 0 &&
      row.weakClient.timestampRegressions === 0
    ),
    connectMs: value(row => row.weakClient.connectMs),
    wireDownKbps: value(row => row.wire.downKbps),
    wireUpKbps: value(row => row.wire.upKbps),
    stateRateHz: value(row => row.weakClient.stateRateHz),
    deliveryRatioPct: value(row => row.weakClient.deliveryRatioPct),
    freshStateRateHz: value(row => row.weakClient.freshStateRateHz),
    freshDeliveryRatioPct: value(row => row.weakClient.freshDeliveryRatioPct),
    relativeFreshDeliveryPct: value(row =>
      row.localProbe.stateRateHz > 0
        ? Math.min(100, row.weakClient.freshStateRateHz / row.localProbe.stateRateHz * 100)
        : null
    ),
    staleStateRatioPct: value(row => row.weakClient.staleStateRatioPct),
    stateAgeP50Ms: value(row => row.weakClient.stateAgeMs.p50),
    stateAgeP95Ms: value(row => row.weakClient.stateAgeMs.p95),
    stateAgeP99Ms: value(row => row.weakClient.stateAgeMs.p99),
    stateIntervalP95Ms: value(row => row.weakClient.stateIntervalMs.p95),
    pingRttP50Ms: value(row => row.weakClient.pingRttMs.p50),
    pingRttP95Ms: value(row => row.weakClient.pingRttMs.p95),
    gapsOver100Ms: value(row => row.weakClient.gapsOver100Ms),
    serverCpuPct: value(row => row.server.cpuPct),
    serverRssMb: value(row => row.server.rssEndKb / 1024),
    localProbeStateRateHz: value(row => row.localProbe.stateRateHz),
    localProbeAgeP95Ms: value(row => row.localProbe.stateAgeMs.p95),
    localProbeRttP95Ms: value(row => row.localProbe.pingRttMs.p95),
  };
}

const scenarioOrder = [...new Set(rows.map(row => row.scenario))];
const scenarioMeta = Object.fromEntries(rows.map(row => [row.scenario, row.network]));
const groups = {};
for (const scenario of scenarioOrder) {
  groups[scenario] = {};
  for (const mode of ['off', 'on']) {
    groups[scenario][mode] = aggregate(rows.filter(row => row.scenario === scenario && row.mode === mode));
  }
}

const comparisons = {};
for (const scenario of scenarioOrder) {
  const off = groups[scenario].off;
  const on = groups[scenario].on;
  comparisons[scenario] = {
    wireDownSavingPct: round(off.wireDownKbps > 0 ? (1 - on.wireDownKbps / off.wireDownKbps) * 100 : null),
    freshStateRateDeltaHz: round(on.freshStateRateHz - off.freshStateRateHz),
    freshDeliveryDeltaPctPoints: round(on.relativeFreshDeliveryPct - off.relativeFreshDeliveryPct),
    stateAgeP95ReductionPct: round(off.stateAgeP95Ms > 0 ? (1 - on.stateAgeP95Ms / off.stateAgeP95Ms) * 100 : null),
    pingRttP95ReductionPct: round(off.pingRttP95Ms > 0 ? (1 - on.pingRttP95Ms / off.pingRttP95Ms) * 100 : null),
    cpuDeltaPctPoints: round(on.serverCpuPct - off.serverCpuPct),
    rssDeltaMb: round(on.serverRssMb - off.serverRssMb),
  };
}

const summary = {
  generatedAt: new Date().toISOString(),
  testRuns: rows.length,
  repetitionsPerMode: Math.min(...scenarioOrder.flatMap(scenario =>
    ['off', 'on'].map(mode => rows.filter(row => row.scenario === scenario && row.mode === mode).length)
  )),
  scenarios: scenarioOrder.map(name => ({
    name,
    network: scenarioMeta[name],
    off: groups[name].off,
    on: groups[name].on,
    comparison: comparisons[name],
  })),
  allNegotiationChecksPassed: Object.values(groups).every(group =>
    group.off.negotiationPass && group.on.negotiationPass
  ),
  allCorrectnessChecksPassed: Object.values(groups).every(group =>
    group.off.correctnessPass && group.on.correctnessPass
  ),
};

fs.mkdirSync(path.dirname(jsonOutputPath), { recursive: true });
fs.writeFileSync(jsonOutputPath, `${JSON.stringify(summary, null, 2)}\n`);

const lines = [
  '# WebSocket 压缩弱网对照测试',
  '',
  `- 生成时间：${summary.generatedAt}`,
  `- 总运行次数：${summary.testRuns}`,
  `- 每种模式重复：${summary.repetitionsPerMode} 次`,
  '- 负载：24 名玩家 + 1 名弱网观战客户端 + 1 名本地探针',
  '- 状态广播：20Hz',
  `- 扩展协商校验：${summary.allNegotiationChecksPassed ? '通过' : '失败'}`,
  `- 消息正确性校验：${summary.allCorrectnessChecksPassed ? '通过' : '失败'}`,
  '',
  '## 网络场景',
  '',
  '| 场景 | RTT | 抖动 | 每方向丢包 | 下行 | 上行 |',
  '|---|---:|---:|---:|---:|---:|',
];

for (const scenario of scenarioOrder) {
  const network = scenarioMeta[scenario];
  const downRate = network.downRate === '0' ? '不限' : network.downRate;
  const upRate = network.upRate === '0' ? '不限' : network.upRate;
  lines.push(
    `| ${scenario} | ${network.rttMs}ms | ${network.jitterMs}ms | ${network.lossPctPerDirection}% | ${downRate} | ${upRate} |`
  );
}

lines.push(
  '',
  '## 聚合结果',
  '',
  '| 场景 | 模式 | 下行 Kbps | 有效状态 Hz | 有效交付率 | 陈旧状态率 | 状态年龄 P95 | RTT P95 | 服务端 CPU | RSS |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
);

for (const scenario of scenarioOrder) {
  for (const mode of ['off', 'on']) {
    const result = groups[scenario][mode];
    lines.push(
      `| ${scenario} | ${mode} | ${metric(result.wireDownKbps)} | ${metric(result.freshStateRateHz)} | ${metric(result.relativeFreshDeliveryPct, '%')} | ${metric(result.staleStateRatioPct, '%')} | ${metric(result.stateAgeP95Ms, 'ms')} | ${metric(result.pingRttP95Ms, 'ms')} | ${metric(result.serverCpuPct, '%')} | ${metric(result.serverRssMb, 'MB')} |`
    );
  }
}

lines.push(
  '',
  '## 开启压缩后的变化',
  '',
  '| 场景 | 下行节省 | 状态频率变化 | 交付率变化 | P95 状态年龄改善 | CPU 变化 | RSS 变化 |',
  '|---|---:|---:|---:|---:|---:|---:|',
);

for (const scenario of scenarioOrder) {
  const comparison = comparisons[scenario];
  lines.push(
    `| ${scenario} | ${comparison.wireDownSavingPct}% | ${comparison.freshStateRateDeltaHz}Hz | ${comparison.freshDeliveryDeltaPctPoints}pp | ${comparison.stateAgeP95ReductionPct}% | ${comparison.cpuDeltaPctPoints}pp | ${comparison.rssDeltaMb}MB |`
  );
}

const normalScenarios = ['lan', 'latency', 'good4g', 'lossy'].filter(name => comparisons[name]);
const normalWireSaving = round(mean(normalScenarios.map(name => comparisons[name].wireDownSavingPct)));
const averageCpuDelta = round(mean(scenarioOrder.map(name => comparisons[name].cpuDeltaPctPoints)));
const averageRssDelta = round(mean(scenarioOrder.map(name => comparisons[name].rssDeltaMb)));
const weak3gOff = groups.weak3g && groups.weak3g.off;
const weak3gOn = groups.weak3g && groups.weak3g.on;
const severeOn = groups.severe && groups.severe.on;

lines.push(
  '',
  '## 结论',
  '',
  `- 在未打满链路的场景中，开启压缩平均减少约 ${metric(normalWireSaving, '%')} 下行流量。`,
  `- 满房负载下，开启压缩平均增加约 ${metric(averageCpuDelta)} 个百分点的服务端 CPU，并增加约 ${metric(averageRssDelta, 'MB')} RSS。`,
);

if (weak3gOff && weak3gOn) {
  lines.push(
    `- 弱 3G 场景关闭压缩时有效交付率为 ${metric(weak3gOff.relativeFreshDeliveryPct, '%')}，开启后为 ${metric(weak3gOn.relativeFreshDeliveryPct, '%')}；压缩对当前 20Hz 全量快照架构有决定性收益。`
  );
}
if (severeOn) {
  lines.push(
    `- 极差网络开启压缩后有效交付率仍仅 ${metric(severeOn.relativeFreshDeliveryPct, '%')}，不能只依赖压缩，还需要自适应降低广播率、增量快照或更新传输策略。`
  );
}
lines.push(
  '- 建议在确认生产服务器具备 CPU 和内存余量后，采用本次受控参数开启；上线时同时监控事件循环延迟、RSS、CPU 和状态丢帧。',
);

lines.push(
  '',
  '说明：网络参数中的丢包率为每个方向分别施加；状态年龄使用客户端接收时间减去服务端快照时间；“有效状态”指年龄不超过 250ms 的快照；有效交付率以同轮本地探针实测状态频率为基准，排除服务端定时器波动。CPU 为单个 Node 服务进程在测量窗口内的占用率。',
  '',
);

fs.writeFileSync(markdownOutputPath, `${lines.join('\n')}\n`);
process.stdout.write(`${JSON.stringify(summary)}\n`);
