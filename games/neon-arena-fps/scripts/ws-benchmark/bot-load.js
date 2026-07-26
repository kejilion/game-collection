'use strict';

const WebSocket = require('ws');

const host = process.env.BENCH_HOST || 'ws://127.0.0.1:3000';
const botCount = numberEnv('BENCH_BOTS', 24);
const moveEveryMs = numberEnv('BENCH_MOVE_MS', 66);
const bots = [];
let joinedCount = 0;
let shuttingDown = false;

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function createBot(index) {
  const bot = {
    index,
    id: 0,
    pos: [0, 0, 0],
    yaw: index / Math.max(1, botCount) * Math.PI * 2,
    direction: index % 2 ? 1 : -1,
    ws: null,
  };
  const ws = new WebSocket(host, { perMessageDeflate: true, handshakeTimeout: 10000 });
  bot.ws = ws;

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'join', name: `Bench-${String(index + 1).padStart(2, '0')}` }));
  });
  ws.on('message', data => {
    let message;
    try {
      message = JSON.parse(data);
    } catch (_) {
      return;
    }
    if (message.type === 'joined') {
      bot.id = message.id;
      joinedCount++;
      if (joinedCount === botCount) process.stdout.write(`READY ${joinedCount}\n`);
      return;
    }
    if (message.type !== 'state' || !bot.id) return;
    const self = (message.pl || []).find(player => player.i === bot.id);
    if (self && Array.isArray(self.p)) bot.pos = self.p.slice();
  });
  ws.on('error', error => {
    if (!shuttingDown) process.stderr.write(`bot ${index + 1}: ${error.message}\n`);
  });
  ws.on('close', () => {
    if (!shuttingDown) process.stderr.write(`bot ${index + 1}: closed unexpectedly\n`);
  });
  return bot;
}

for (let index = 0; index < botCount; index++) {
  setTimeout(() => bots.push(createBot(index)), index * 20);
}

const moveTimer = setInterval(() => {
  for (const bot of bots) {
    if (!bot.id || bot.ws.readyState !== WebSocket.OPEN) continue;
    bot.yaw += 0.012 * bot.direction;
    bot.ws.send(JSON.stringify({
      type: 'move',
      p: bot.pos,
      ya: bot.yaw,
      pi: Math.sin(bot.yaw * 0.7) * 0.08,
      an: 1,
      zm: 0,
    }));
  }
}, moveEveryMs);

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(moveTimer);
  for (const bot of bots) {
    if (bot.ws && bot.ws.readyState === WebSocket.OPEN) bot.ws.close(1000, 'benchmark complete');
  }
  setTimeout(() => process.exit(0), 200).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
