'use strict';

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeAngleDelta(a, b) {
  let delta = Math.abs(a - b) % (Math.PI * 2);
  if (delta > Math.PI) delta = Math.PI * 2 - delta;
  return delta;
}

function normalizeDeviceId(value) {
  const deviceId = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{32}$/.test(deviceId) ? deviceId : '';
}

class SessionGuard {
  constructor(options = {}) {
    this.maxPlayersPerDevice = Math.max(1, finiteNumber(options.maxPlayersPerDevice, 1));
    this.maxPlayersPerIp = Math.max(1, finiteNumber(options.maxPlayersPerIp, 2));
    this.warnAfterMs = Math.max(1000, finiteNumber(options.warnAfterMs, 180000));
    this.kickAfterMs = Math.max(this.warnAfterMs + 1000, finiteNumber(options.kickAfterMs, 300000));
    this.moveDistance = Math.max(0.05, finiteNumber(options.moveDistance, 0.3));
    this.yawDelta = Math.max(0.01, finiteNumber(options.yawDelta, 0.08));
    this.pitchDelta = Math.max(0.01, finiteNumber(options.pitchDelta, 0.06));
    this.players = new Map();
    this.ipPlayers = new Map();
    this.devicePlayers = new Map();
    this.rejectedByDevice = 0;
    this.rejectedByIp = 0;
    this.rejectedMissingDevice = 0;
    this.afkWarnings = 0;
    this.afkKicks = 0;
  }

  _count(map, key) {
    if (!key) return 0;
    const players = map.get(key);
    return players ? players.size : 0;
  }

  _add(map, key, playerId) {
    if (!key) return;
    let players = map.get(key);
    if (!players) {
      players = new Set();
      map.set(key, players);
    }
    players.add(playerId);
  }

  _delete(map, key, playerId) {
    if (!key) return;
    const players = map.get(key);
    if (!players) return;
    players.delete(playerId);
    if (players.size === 0) map.delete(key);
  }

  canJoin({ ip, deviceId }) {
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    if (!normalizedDeviceId) {
      this.rejectedMissingDevice++;
      return { ok: false, reason: 'missing_device_id', deviceId: '' };
    }
    if (normalizedDeviceId && this._count(this.devicePlayers, normalizedDeviceId) >= this.maxPlayersPerDevice) {
      this.rejectedByDevice++;
      return { ok: false, reason: 'device_limit', deviceId: normalizedDeviceId };
    }
    if (this._count(this.ipPlayers, ip) >= this.maxPlayersPerIp) {
      this.rejectedByIp++;
      return { ok: false, reason: 'ip_limit', deviceId: normalizedDeviceId };
    }
    return { ok: true, deviceId: normalizedDeviceId };
  }

  activate(playerId, { ip, deviceId, state, now = Date.now() }) {
    this.release(playerId);
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    const record = {
      ip: String(ip || ''),
      deviceId: normalizedDeviceId,
      lastActivityAt: now,
      warned: false,
      kickPending: false,
      x: finiteNumber(state && state.pos && state.pos.x, 0),
      y: finiteNumber(state && state.pos && state.pos.y, 0),
      z: finiteNumber(state && state.pos && state.pos.z, 0),
      yaw: finiteNumber(state && state.yaw, 0),
      pitch: finiteNumber(state && state.pitch, 0),
    };
    this.players.set(playerId, record);
    this._add(this.ipPlayers, record.ip, playerId);
    this._add(this.devicePlayers, record.deviceId, playerId);
  }

  release(playerId) {
    const record = this.players.get(playerId);
    if (!record) return false;
    this.players.delete(playerId);
    this._delete(this.ipPlayers, record.ip, playerId);
    this._delete(this.devicePlayers, record.deviceId, playerId);
    return true;
  }

  noteActivity(playerId, now = Date.now()) {
    const record = this.players.get(playerId);
    if (!record) return false;
    record.lastActivityAt = now;
    record.warned = false;
    record.kickPending = false;
    return true;
  }

  noteState(playerId, state, now = Date.now()) {
    const record = this.players.get(playerId);
    if (!record || !state || !state.pos) return false;
    const x = finiteNumber(state.pos.x, record.x);
    const y = finiteNumber(state.pos.y, record.y);
    const z = finiteNumber(state.pos.z, record.z);
    const yaw = finiteNumber(state.yaw, record.yaw);
    const pitch = finiteNumber(state.pitch, record.pitch);
    const moved = Math.hypot(x - record.x, y - record.y, z - record.z) >= this.moveDistance;
    const looked = normalizeAngleDelta(yaw, record.yaw) >= this.yawDelta || Math.abs(pitch - record.pitch) >= this.pitchDelta;
    if (!moved && !looked) return false;
    record.x = x;
    record.y = y;
    record.z = z;
    record.yaw = yaw;
    record.pitch = pitch;
    return this.noteActivity(playerId, now);
  }

  sweep(now = Date.now()) {
    const warnings = [];
    const kicks = [];
    for (const [playerId, record] of this.players) {
      const idleMs = Math.max(0, now - record.lastActivityAt);
      if (idleMs >= this.kickAfterMs) {
        if (record.kickPending) continue;
        record.kickPending = true;
        this.afkKicks++;
        kicks.push({ playerId, idleMs });
      } else if (idleMs >= this.warnAfterMs && !record.warned) {
        record.warned = true;
        this.afkWarnings++;
        warnings.push({ playerId, idleMs });
      }
    }
    return { warnings, kicks };
  }

  status() {
    return {
      activePlayers: this.players.size,
      activeIps: this.ipPlayers.size,
      activeDevices: this.devicePlayers.size,
      maxPlayersPerIp: this.maxPlayersPerIp,
      maxPlayersPerDevice: this.maxPlayersPerDevice,
      afkWarnSeconds: Math.round(this.warnAfterMs / 1000),
      afkKickSeconds: Math.round(this.kickAfterMs / 1000),
      rejectedByIp: this.rejectedByIp,
      rejectedByDevice: this.rejectedByDevice,
      rejectedMissingDevice: this.rejectedMissingDevice,
      afkWarnings: this.afkWarnings,
      afkKicks: this.afkKicks,
    };
  }
}

module.exports = { SessionGuard, normalizeDeviceId };
