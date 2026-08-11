'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 1000 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('health timeout')));
    request.on('error', reject);
  });
}

async function waitForHealth(port, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}`);
    try { return await getJson(port, '/health'); } catch (_) { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw new Error('server did not become healthy');
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const messages = [];
    ws.on('message', data => {
      try { messages.push(JSON.parse(data)); } catch (_) { /* ignore */ }
    });
    ws.once('open', () => resolve({ ws, messages }));
    ws.once('error', reject);
  });
}

function waitFor(client, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const match = client.messages.find(predicate);
      if (match) {
        clearInterval(timer);
        resolve(match);
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(`message timeout: ${JSON.stringify(client.messages.slice(-5))}`));
      }
    }, 20);
  });
}

async function main() {
  const port = await reservePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-guard-e2e-'));
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, {
      PORT: String(port),
      DATA_DIR: dataDir,
      AC_MODE: 'off',
      IP_MAX_PLAYERS: '2',
      DEVICE_MAX_PLAYERS: '1',
      AFK_WARN_MS: '1000',
      AFK_KICK_MS: '2000',
      AFK_CHECK_INTERVAL_MS: '1000',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const clients = [];
  try {
    await waitForHealth(port, child);

    const missingDevice = await connect(port); clients.push(missingDevice);
    missingDevice.ws.send(JSON.stringify({ type: 'join', name: 'guard-missing' }));
    const missingDeviceError = await waitFor(missingDevice, message => message.type === 'err');
    assert.equal(missingDeviceError.code, 'missing_device_id');
    missingDevice.ws.send(JSON.stringify({ type: 'spectate' }));
    await waitFor(missingDevice, message => message.type === 'spec');
    await new Promise(resolve => {
      missingDevice.ws.once('close', resolve);
      missingDevice.ws.close();
    });

    const first = await connect(port); clients.push(first);
    first.ws.send(JSON.stringify({ type: 'join', name: 'guard-a', deviceId: 'a'.repeat(32) }));
    await waitFor(first, message => message.type === 'joined');

    const duplicateDevice = await connect(port); clients.push(duplicateDevice);
    duplicateDevice.ws.send(JSON.stringify({ type: 'join', name: 'guard-b', deviceId: 'a'.repeat(32) }));
    const deviceError = await waitFor(duplicateDevice, message => message.type === 'err');
    assert.equal(deviceError.code, 'device_limit');
    duplicateDevice.ws.send(JSON.stringify({ type: 'spectate' }));
    await waitFor(duplicateDevice, message => message.type === 'spec');

    const second = await connect(port); clients.push(second);
    second.ws.send(JSON.stringify({ type: 'join', name: 'guard-c', deviceId: 'b'.repeat(32) }));
    await waitFor(second, message => message.type === 'joined');

    const third = await connect(port); clients.push(third);
    third.ws.send(JSON.stringify({ type: 'join', name: 'guard-d', deviceId: 'c'.repeat(32) }));
    const ipError = await waitFor(third, message => message.type === 'err');
    assert.equal(ipError.code, 'ip_limit');

    second.ws.send(JSON.stringify({ type: 'leave' }));
    await waitFor(second, message => message.type === 'left');
    third.ws.send(JSON.stringify({ type: 'join', name: 'guard-d', deviceId: 'c'.repeat(32) }));
    await waitFor(third, message => message.type === 'joined');

    const kicked = await waitFor(first, message => message.type === 'kicked', 6000);
    assert.match(kicked.text, /无有效操作/);

    const health = await getJson(port, '/health');
    assert.equal(health.sessionGuard.maxPlayersPerIp, 2);
    assert.equal(health.sessionGuard.maxPlayersPerDevice, 1);
    assert.equal(health.sessionGuard.rejectedByDevice, 1);
    assert.equal(health.sessionGuard.rejectedByIp, 1);
    assert.equal(health.sessionGuard.rejectedMissingDevice, 1);
    assert(health.sessionGuard.afkKicks >= 1);
    console.log('session_guard_e2e=pass');
  } catch (error) {
    error.message += `\nserver output:\n${output}`;
    throw error;
  } finally {
    for (const client of clients) {
      try { client.ws.close(); } catch (_) { /* ignore */ }
    }
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); resolve(); }, 3000);
    });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
