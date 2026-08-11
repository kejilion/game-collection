'use strict';

const assert = require('assert');
const { SessionGuard, normalizeDeviceId } = require('../server/session-guard');

const deviceA = 'a'.repeat(32);
const deviceB = 'b'.repeat(32);
const deviceC = 'c'.repeat(32);
const guard = new SessionGuard({
  maxPlayersPerDevice: 1,
  maxPlayersPerIp: 2,
  warnAfterMs: 1000,
  kickAfterMs: 2000,
  moveDistance: 0.3,
  yawDelta: 0.08,
  pitchDelta: 0.06,
});

assert.equal(normalizeDeviceId(deviceA.toUpperCase()), deviceA);
assert.equal(normalizeDeviceId('invalid'), '');
assert.equal(guard.canJoin({ ip: '10.0.0.9', deviceId: '' }).reason, 'missing_device_id');
assert.equal(guard.canJoin({ ip: '10.0.0.9', deviceId: 'not-valid' }).reason, 'missing_device_id');

assert.deepEqual(guard.canJoin({ ip: '10.0.0.1', deviceId: deviceA }), { ok: true, deviceId: deviceA });
guard.activate(1, { ip: '10.0.0.1', deviceId: deviceA, state: { pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 }, now: 0 });
assert.equal(guard.canJoin({ ip: '10.0.0.2', deviceId: deviceA }).reason, 'device_limit');

assert.equal(guard.canJoin({ ip: '10.0.0.1', deviceId: deviceB }).ok, true);
guard.activate(2, { ip: '10.0.0.1', deviceId: deviceB, state: { pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 }, now: 0 });
assert.equal(guard.canJoin({ ip: '10.0.0.1', deviceId: deviceC }).reason, 'ip_limit');
assert.equal(guard.canJoin({ ip: '10.0.0.1', deviceId: '' }).reason, 'missing_device_id');

assert.equal(guard.noteState(1, { pos: { x: 0.1, y: 0, z: 0 }, yaw: 0.02, pitch: 0.01 }, 500), false);
assert.equal(guard.sweep(1000).warnings.length, 2);
assert.equal(guard.sweep(1500).warnings.length, 0, 'warning should only be emitted once per idle period');
assert.equal(guard.noteState(1, { pos: { x: 0.31, y: 0, z: 0 }, yaw: 0.02, pitch: 0.01 }, 1500), true);
const firstKicks = guard.sweep(2000).kicks;
assert.equal(firstKicks.some(item => item.playerId === 1), false);
assert.equal(firstKicks.some(item => item.playerId === 2), true);
assert.equal(guard.sweep(2000).kicks.length, 0, 'pending kick should not be emitted twice');

assert.equal(guard.release(2), true);
assert.equal(guard.canJoin({ ip: '10.0.0.1', deviceId: deviceC }).ok, true);
guard.activate(3, { ip: '10.0.0.1', deviceId: deviceC, state: { pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 }, now: 2000 });
assert.equal(guard.noteActivity(3, 2500), true);
assert.equal(guard.sweep(3400).warnings.some(item => item.playerId === 3), false);
assert.equal(guard.sweep(3500).warnings.some(item => item.playerId === 3), true);

const status = guard.status();
assert.equal(status.activePlayers, 2);
assert.equal(status.activeIps, 1);
assert.equal(status.activeDevices, 2);
assert.equal(status.rejectedByDevice, 1);
assert.equal(status.rejectedByIp, 1);
assert.equal(status.rejectedMissingDevice, 3);
assert.equal(status.afkKicks, 2);

console.log('session_guard_regression=pass');
