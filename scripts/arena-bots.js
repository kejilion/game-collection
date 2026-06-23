'use strict';

const WebSocket = require('ws');

const targetUrl = process.env.BOT_URL || 'ws://127.0.0.1:3000';
const botCount = clampInt(process.env.BOT_COUNT, 10, 1, 30);
const botPrefix = String(process.env.BOT_PREFIX || '测试机器人').slice(0, 10);
const classes = ['warrior', 'mage', 'assassin'];
const reconnectDelayMs = clampInt(process.env.BOT_RECONNECT_MS, 2500, 500, 30000);
const view = { w: 1280, h: 720 };

let stopping = false;

function clampInt(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomRange(min, max) {
  return min + Math.random() * (max - min);
}

class ArenaBot {
  constructor(index) {
    this.index = index;
    this.name = `${botPrefix}${String(index + 1).padStart(2, '0')}`;
    this.cls = classes[index % classes.length];
    this.ws = null;
    this.playerId = null;
    this.self = null;
    this.players = [];
    this.roam = { x: 0, y: 0, until: 0 };
    this.moveUntil = 0;
    this.restUntil = 0;
    this.chaseDuringMove = false;
    this.lastInput = null;
    this.lastAttackAt = 0;
    this.lastSkillAt = [0, 0];
    this.thinkTimer = null;
  }

  connect() {
    if (stopping) return;
    this.ws = new WebSocket(targetUrl);
    this.ws.on('open', () => {
      this.send({ type: 'join', name: this.name, cls: this.cls });
      this.send({ type: 'view', ...view });
      this.startThinking();
      console.log(`[bot] ${this.name} connected as ${this.cls}`);
    });
    this.ws.on('message', raw => this.onMessage(raw));
    this.ws.on('error', () => {});
    this.ws.on('close', () => {
      this.stopThinking();
      this.playerId = null;
      this.self = null;
      if (!stopping) {
        console.log(`[bot] ${this.name} reconnecting in ${reconnectDelayMs}ms`);
        setTimeout(() => this.connect(), reconnectDelayMs);
      }
    });
  }

  onMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.type === 'welcome') {
      this.playerId = message.id;
      return;
    }
    if (message.type !== 'state' || !this.playerId) return;
    this.players = Array.isArray(message.players) ? message.players : [];
    this.self = this.players.find(player => player.id === this.playerId) || null;
  }

  startThinking() {
    this.stopThinking();
    this.thinkTimer = setInterval(() => this.think(), 480 + this.index * 11);
  }

  stopThinking() {
    if (this.thinkTimer) clearInterval(this.thinkTimer);
    this.thinkTimer = null;
  }

  think() {
    if (!this.self || this.self.dead) {
      this.sendInput(false, false, false, false);
      return;
    }

    const now = Date.now();
    const target = this.nearestVisibleOpponent();
    const moving = this.shouldMove(now, target);
    let moveX = 0;
    let moveY = 0;

    if (moving && target && this.chaseDuringMove) {
      moveX = target.x - this.self.x;
      moveY = target.y - this.self.y;
    } else if (moving) {
      if (now >= this.roam.until) {
        const angle = randomRange(0, Math.PI * 2);
        this.roam = {
          x: Math.cos(angle),
          y: Math.sin(angle),
          until: now + randomRange(3200, 6200)
        };
      }
      moveX = this.roam.x;
      moveY = this.roam.y;
    }

    this.sendInput(moving && moveY < -8, moving && moveY > 8, moving && moveX < -8, moving && moveX > 8);

    if (target && now - this.lastAttackAt > randomRange(1250, 1900)) {
      this.send({ type: 'attack' });
      this.lastAttackAt = now;
    }
    if (target && now - this.lastSkillAt[0] > randomRange(10000, 14000)) {
      this.send({ type: 'skill', slot: 0 });
      this.lastSkillAt[0] = now;
    }
    if (target && now - this.lastSkillAt[1] > randomRange(20000, 28000)) {
      this.send({ type: 'skill', slot: 1 });
      this.lastSkillAt[1] = now;
    }
  }

  shouldMove(now, target) {
    if (now >= this.restUntil) {
      this.moveUntil = now + randomRange(850, 1550);
      this.restUntil = this.moveUntil + randomRange(700, 1500);
      this.chaseDuringMove = !!target && Math.random() < 0.45;
    }
    return now < this.moveUntil;
  }

  nearestVisibleOpponent() {
    let best = null;
    let bestDistance = Infinity;
    for (const player of this.players) {
      if (player.id === this.playerId || player.dead) continue;
      const dx = player.x - this.self.x;
      const dy = player.y - this.self.y;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        best = player;
        bestDistance = distance;
      }
    }
    return best;
  }

  sendInput(up, down, left, right) {
    const input = { up, down, left, right };
    const serialized = JSON.stringify(input);
    if (serialized === this.lastInput) return;
    this.lastInput = serialized;
    this.send({ type: 'input', ...input });
  }

  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  close() {
    this.stopThinking();
    if (this.ws) this.ws.close();
  }
}

async function main() {
  console.log(`[bots] starting ${botCount} bots against ${targetUrl}`);
  const bots = Array.from({ length: botCount }, (_, index) => new ArenaBot(index));
  for (const bot of bots) {
    bot.connect();
    await sleep(180);
  }
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const bot of bots) bot.close();
    setTimeout(() => process.exit(0), 250);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch(error => {
  console.error('[bots] fatal:', error);
  process.exit(1);
});
