'use strict';

const assert = require('assert');
const { AntiCheat, createMemoryStore, fpsPreset } = require('../server/anticheat');

const realNow = Date.now;
let clock = 1_700_000_000_000;
Date.now = () => clock;

function createHarness(overrides) {
  const actions = [];
  const store = createMemoryStore();
  const engine = new AntiCheat(fpsPreset(Object.assign({
    store,
    onAction(key, action, reason, monitor) {
      actions.push({ key, action, reason, scores: monitor.scoreSnapshot() });
    },
  }, overrides || {})));
  return { engine, store, actions };
}

function addTrustedRtt(monitor, value = 45) {
  monitor.noteRtt(value);
  monitor.noteRtt(value);
  monitor.noteRtt(value);
}

function speedFlag(engine, monitor, intervalSec = 5) {
  clock += intervalSec * 1000;
  engine.tick(intervalSec);
  assert.strictEqual(monitor.flag('speed', undefined, 'test'), true);
}

try {
  {
    const { engine, actions } = createHarness();
    const monitor = engine.attach(1, { ip: '198.51.100.10', name: 'normal' });
    addTrustedRtt(monitor);
    for (let i = 0; i < 19; i++) speedFlag(engine, monitor);
    assert.strictEqual(actions.length, 0, '19次可信超速不应处罚');
    assert.strictEqual(monitor.channelScore('integrity'), 0, '观察阶段不应增加完整性分');
    assert.strictEqual(engine.observeCounts.sustainedspeed, 1, '达到观察线只记录一次');
  }

  {
    const { engine, actions } = createHarness();
    const monitor = engine.attach(2, { ip: '198.51.100.20', name: 'warn' });
    addTrustedRtt(monitor);
    for (let i = 0; i < 20; i++) speedFlag(engine, monitor);
    assert.deepStrictEqual(actions.map(row => row.action), ['warn']);
    assert.strictEqual(monitor.channelScore('integrity'), engine.opts.thresholds.warn);
  }

  {
    const { engine, actions } = createHarness();
    const monitor = engine.attach(3, { ip: '198.51.100.30', name: 'kick' });
    addTrustedRtt(monitor);
    for (let i = 0; i < 36; i++) speedFlag(engine, monitor);
    assert.deepStrictEqual(actions.map(row => row.action), ['warn', 'kick']);
    assert.strictEqual(monitor.kicked, true);
  }

  {
    const { engine, actions } = createHarness();
    for (let session = 0; session < 3; session++) {
      const monitor = engine.attach(10 + session, { ip: '198.51.100.40', name: 'repeat' });
      addTrustedRtt(monitor);
      for (let i = 0; i < 36; i++) speedFlag(engine, monitor);
      engine.detach(10 + session);
    }
    assert.strictEqual(actions.filter(row => row.action === 'kick').length, 2);
    assert.strictEqual(actions.filter(row => row.action === 'ban').length, 1);
    assert.ok(engine.isBanned(['ip:198.51.100.40']), '三次高置信持续超速应进入既有临时封禁');
  }

  {
    const { engine, actions } = createHarness();
    const monitor = engine.attach(20, { ip: '198.51.100.50', name: 'high-rtt' });
    addTrustedRtt(monitor, 600);
    for (let i = 0; i < 40; i++) speedFlag(engine, monitor);
    assert.strictEqual(actions.length, 0, '高延迟移动信号不得升级处罚');
    assert.strictEqual(monitor.channelScore('integrity'), 0);
  }

  {
    const { engine, actions } = createHarness();
    const monitor = engine.attach(30, { ip: '198.51.100.60', name: 'sparse' });
    addTrustedRtt(monitor);
    for (let i = 0; i < 40; i++) speedFlag(engine, monitor, 20);
    assert.strictEqual(actions.length, 0, '窗口外稀疏超速不得升级处罚');
    assert.strictEqual(monitor.channelScore('integrity'), 0);
  }

  console.log('anticheat_sustained_speed=pass');
} finally {
  Date.now = realNow;
}
