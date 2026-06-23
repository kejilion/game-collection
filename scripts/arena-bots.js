'use strict';

const WebSocket = require('ws');

const targetUrl = process.env.BOT_URL || 'ws://127.0.0.1:3000';
const botCount = clampInt(process.env.BOT_COUNT, 10, 1, 30);
const botPrefix = String(process.env.BOT_PREFIX || '').slice(0, 4);
const classes = ['warrior', 'mage', 'assassin'];
const reconnectDelayMs = clampInt(process.env.BOT_RECONNECT_MS, 2500, 500, 30000);
const view = { w: 1280, h: 720 };
const playStyles = [
  { label: 'wanderer', thinkMs: 720, chaseChance: 0.18, lootChance: 0.68, retreatHp: 0.42, attackMs: [2100, 3200], skill0Ms: [21000, 30000], skill1Ms: [36000, 50000], moveMs: [900, 1500], restMs: [1700, 3000] },
  { label: 'cautious', thinkMs: 650, chaseChance: 0.32, lootChance: 0.55, retreatHp: 0.54, attackMs: [1800, 2800], skill0Ms: [17000, 25000], skill1Ms: [30000, 43000], moveMs: [1000, 1750], restMs: [1300, 2500] },
  { label: 'skirmisher', thinkMs: 560, chaseChance: 0.52, lootChance: 0.36, retreatHp: 0.36, attackMs: [1350, 2100], skill0Ms: [12500, 18500], skill1Ms: [23000, 34000], moveMs: [1050, 1850], restMs: [900, 1800] },
  { label: 'scavenger', thinkMs: 700, chaseChance: 0.24, lootChance: 0.82, retreatHp: 0.46, attackMs: [2000, 3100], skill0Ms: [19000, 28000], skill1Ms: [34000, 48000], moveMs: [1100, 1900], restMs: [1200, 2400] },
  { label: 'brawler', thinkMs: 600, chaseChance: 0.62, lootChance: 0.28, retreatHp: 0.30, attackMs: [1200, 1850], skill0Ms: [10500, 16000], skill1Ms: [20000, 30000], moveMs: [900, 1650], restMs: [900, 1700] }
];
const nameStarts = ['雾隐', '碎月', '霜刃', '夜航', '云岚', '逐风', '星尘', '银翼', '青柠', '洛川', '熔岩', '长街', '赤焰', '白昼', '浮光', '墨羽', '远山', '流萤', '晴空', '孤岛'];
const nameEnds = ['旅者', '团子', '猎手', '小鹿', '骑士', '弓手', '猫咪', '星火', '短刃', '纸鸢', '渡鸦', '行者', '柚子', '飞鱼', '山雀', '影子', '风铃', '夜莺', '松果', '追光'];
const botNames = makeBotNames(botCount);

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

function makeBotNames(count) {
  const names = [];
  const used = new Set();
  while (names.length < count) {
    const start = nameStarts[Math.floor(Math.random() * nameStarts.length)];
    const end = nameEnds[Math.floor(Math.random() * nameEnds.length)];
    const candidate = (botPrefix + start + end).slice(0, 14);
    if (used.has(candidate)) continue;
    used.add(candidate);
    names.push(candidate);
  }
  return names;
}

class ArenaBot {
  constructor(index) {
    this.index = index;
    this.name = botNames[index];
    this.cls = classes[index % classes.length];
    this.style = playStyles[index % playStyles.length];
    this.ws = null;
    this.playerId = null;
    this.self = null;
    this.players = [];
    this.items = [];
    this.roam = { x: 0, y: 0, until: 0 };
    this.moveUntil = 0;
    this.restUntil = 0;
    this.intent = 'roam';
    this.intentTargetId = null;
    this.fleeBias = randomRange(-0.55, 0.55);
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
      console.log(`[bot] ${this.name} connected as ${this.cls} (${this.style.label})`);
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
    this.items = Array.isArray(message.items) ? message.items : [];
    this.self = this.players.find(player => player.id === this.playerId) || null;
  }

  startThinking() {
    this.stopThinking();
    this.thinkTimer = setInterval(() => this.think(), this.style.thinkMs + this.index * 11);
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
    const visibleTarget = this.nearestVisibleOpponent();
    const target = this.lockedTarget(visibleTarget);
    const item = this.nearestVisibleItem();
    const moving = this.shouldMove(now, target, item, this.healthRatio());
    let moveX = 0;
    let moveY = 0;

    if (moving && this.intent === 'retreat' && target) {
      const dx = this.self.x - target.x;
      const dy = this.self.y - target.y;
      moveX = dx - dy * this.fleeBias;
      moveY = dy + dx * this.fleeBias;
    } else if (moving && this.intent === 'chase' && target) {
      moveX = target.x - this.self.x;
      moveY = target.y - this.self.y;
    } else if (moving && this.intent === 'loot' && item) {
      moveX = item.x - this.self.x;
      moveY = item.y - this.self.y;
    } else if (moving) {
      if (now >= this.roam.until) {
        const angle = randomRange(0, Math.PI * 2);
        this.roam = {
          x: Math.cos(angle),
          y: Math.sin(angle),
          until: now + randomRange(3600, 7600)
        };
      }
      moveX = this.roam.x;
      moveY = this.roam.y;
    }

    this.sendInput(moving && moveY < -8, moving && moveY > 8, moving && moveX < -8, moving && moveX > 8);

    const targetDistance = target ? this.distanceTo(target) : Infinity;
    const fighting = target && this.intent !== 'retreat' && targetDistance < 500;
    if (fighting && now - this.lastAttackAt > randomRange(...this.style.attackMs)) {
      this.send({ type: 'attack' });
      this.lastAttackAt = now;
    }
    if (fighting && now - this.lastSkillAt[0] > randomRange(...this.style.skill0Ms)) {
      this.send({ type: 'skill', slot: 0 });
      this.lastSkillAt[0] = now;
    }
    if (fighting && now - this.lastSkillAt[1] > randomRange(...this.style.skill1Ms)) {
      this.send({ type: 'skill', slot: 1 });
      this.lastSkillAt[1] = now;
    }
  }

  shouldMove(now, target, item, hpRatio) {
    if (now >= this.restUntil) {
      this.moveUntil = now + randomRange(...this.style.moveMs);
      this.restUntil = this.moveUntil + randomRange(...this.style.restMs);
      this.intent = 'roam';
      this.intentTargetId = null;
      if (target && hpRatio < this.style.retreatHp) {
        this.intent = 'retreat';
        this.intentTargetId = target.id;
      } else if (item && Math.random() < this.style.lootChance) {
        this.intent = 'loot';
      } else if (target && Math.random() < this.style.chaseChance) {
        this.intent = 'chase';
        this.intentTargetId = target.id;
      }
    }
    return now < this.moveUntil;
  }

  healthRatio() {
    const maxHp = this.self.maxHp || 100;
    return Math.max(0, Math.min(1, this.self.hp / maxHp));
  }

  distanceTo(entity) {
    return Math.hypot(entity.x - this.self.x, entity.y - this.self.y);
  }

  lockedTarget(fallback) {
    if (this.intentTargetId) {
      const locked = this.players.find(player => player.id === this.intentTargetId && !player.dead);
      if (locked) return locked;
    }
    return fallback;
  }

  nearestVisibleItem() {
    let best = null;
    let bestDistance = Infinity;
    for (const item of this.items) {
      const distance = this.distanceTo(item);
      if (distance < bestDistance) {
        best = item;
        bestDistance = distance;
      }
    }
    return best;
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
