'use strict';

const WebSocket = require('ws');

const targetUrl = process.env.BOT_URL || 'ws://127.0.0.1:3000';
const botCount = clampInt(process.env.BOT_COUNT, 10, 1, 30);
const botPrefix = String(process.env.BOT_PREFIX || '').slice(0, 4);
const classes = ['warrior', 'mage', 'assassin'];
const reconnectDelayMs = clampInt(process.env.BOT_RECONNECT_MS, 2500, 500, 30000);
const sessionMinMinutes = clampInt(process.env.BOT_SESSION_MIN_MINUTES, 30, 10, 240);
const sessionMaxMinutes = Math.max(sessionMinMinutes, clampInt(process.env.BOT_SESSION_MAX_MINUTES, 60, sessionMinMinutes, 240));
const replacementMinMinutes = clampInt(process.env.BOT_REPLACEMENT_MIN_MINUTES, 5, 1, 60);
const replacementMaxMinutes = Math.max(replacementMinMinutes, clampInt(process.env.BOT_REPLACEMENT_MAX_MINUTES, 10, replacementMinMinutes, 60));
const sessionMinMs = sessionMinMinutes * 60 * 1000;
const sessionMaxMs = sessionMaxMinutes * 60 * 1000;
const replacementMinMs = replacementMinMinutes * 60 * 1000;
const replacementMaxMs = replacementMaxMinutes * 60 * 1000;
const initialFastJoinCount = clampInt(process.env.BOT_INITIAL_FAST_JOIN_COUNT, Math.min(botCount, 6), 1, botCount);
const initialFastJoinMaxMs = clampInt(process.env.BOT_INITIAL_FAST_JOIN_MAX_SECONDS, 90, 20, 900) * 1000;
const initialLateJoinMinMs = clampInt(process.env.BOT_INITIAL_LATE_JOIN_MIN_SECONDS, 120, 60, 1800) * 1000;
const initialLateJoinMaxMs = Math.max(initialLateJoinMinMs, clampInt(process.env.BOT_INITIAL_LATE_JOIN_MAX_SECONDS, 600, 60, 1800) * 1000);
const view = { w: 1280, h: 720 };
const playStyles = [
  { label: 'wanderer', thinkMs: 310, chaseChance: 0.18, lootChance: 0.68, retreatHp: 0.42, attackMs: [2100, 3200], skill0Ms: [21000, 30000], skill1Ms: [36000, 50000], moveMs: [2600, 4200], restMs: [350, 750] },
  { label: 'cautious', thinkMs: 270, chaseChance: 0.32, lootChance: 0.55, retreatHp: 0.54, attackMs: [1800, 2800], skill0Ms: [17000, 25000], skill1Ms: [30000, 43000], moveMs: [2300, 3800], restMs: [220, 550] },
  { label: 'skirmisher', thinkMs: 210, chaseChance: 0.52, lootChance: 0.36, retreatHp: 0.36, attackMs: [1350, 2100], skill0Ms: [12500, 18500], skill1Ms: [23000, 34000], moveMs: [2000, 3400], restMs: [140, 380] },
  { label: 'scavenger', thinkMs: 300, chaseChance: 0.24, lootChance: 0.82, retreatHp: 0.46, attackMs: [2000, 3100], skill0Ms: [19000, 28000], skill1Ms: [34000, 48000], moveMs: [2500, 4200], restMs: [220, 550] },
  { label: 'brawler', thinkMs: 230, chaseChance: 0.62, lootChance: 0.28, retreatHp: 0.30, attackMs: [1200, 1850], skill0Ms: [10500, 16000], skill1Ms: [20000, 30000], moveMs: [2100, 3300], restMs: [120, 320] }
];
const combatProfiles = {
  warrior: { minDistance: 0, maxDistance: 150, attackDistance: 175, skillDistance: 225, crowdLimit: 3 },
  mage: { minDistance: 270, maxDistance: 520, attackDistance: 600, skillDistance: 600, crowdLimit: 1 },
  assassin: { minDistance: 0, maxDistance: 120, attackDistance: 125, skillDistance: 360, crowdLimit: 1 }
};
const namePools = {
  single: ['风', '墨', '夜', '七', '零', '川', '岚', '白', '烬', '禾', '北', '弦'],
  chineseTwo: ['阿北', '小七', '林深', '夏木', '北辰', '晚风', '小满', '星野', '阿梨', '墨白', '言川', '南枝'],
  chineseThree: ['小雨点', '别追我', '白月光', '风见悠', '糖醋鱼', '一只猫', '青石桥', '桃乐丝', '雾里花', '慢半拍', '小行星', '柚子茶'],
  chineseFour: ['今晚不鸽', '一剑西来', '星河入梦', '南风知我', '秋日私语', '月下独酌', '正在加载', '借过一下', '云端散步', '小熊软糖', '别打我呀', '落日飞车'],
  english: ['Nova', 'Luna', 'Raven', 'Milo', 'Echo', 'Nox', 'Astra', 'Kite', 'Moss', 'Iris', 'Rook', 'Sora'],
  mixed: ['momo77', 'Neo_404', 'K9_Zero', 'RinX', 'Qing9', 'Fox_21', 'Mia2K', 'ByteCat', 'Aki_7', 'PandaX', 'Sky_66', 'Zed99']
};
const nameFormats = Object.keys(namePools);
const botNames = makeBotNames(botCount);
const reservedBotNames = new Set(botNames);

let stopping = false;

function clampInt(value, fallback, min, max) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function randomRange(min, max) {
  return min + Math.random() * (max - min);
}

function drawBotName(format = nameFormats[Math.floor(Math.random() * nameFormats.length)]) {
  const pool = namePools[format];
  return (botPrefix + pool[Math.floor(Math.random() * pool.length)]).slice(0, 14);
}

function makeBotNames(count) {
  const names = [];
  const used = new Set();
  const formats = [];
  while (formats.length < count) {
    const round = [...nameFormats].sort(() => Math.random() - 0.5);
    formats.push(...round);
  }
  for (const format of formats.slice(0, count)) {
    let candidate;
    do {
      candidate = drawBotName(format);
    } while (used.has(candidate));
    used.add(candidate);
    names.push(candidate);
  }
  return names;
}

function replacementName(previousName) {
  reservedBotNames.delete(previousName);
  let candidate = previousName;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    candidate = drawBotName();
    if (!reservedBotNames.has(candidate)) break;
  }
  reservedBotNames.add(candidate);
  return candidate;
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
    this.merchants = [];
    this.shopEquipment = [];
    this.purchasedEquipment = new Set();
    this.roam = { x: 0, y: 0, until: 0 };
    this.moveUntil = 0;
    this.restUntil = 0;
    this.intent = 'roam';
    this.intentTargetId = null;
    this.intentShopId = null;
    this.intentShopItemId = null;
    this.fleeBias = randomRange(-0.55, 0.55);
    this.lastInput = null;
    this.lastAttackAt = 0;
    this.lastSkillAt = [0, 0];
    this.thinkTimer = null;
    this.sessionTimer = null;
    this.returnTimer = null;
    this.initialTimer = null;
    this.takingBreak = false;
    this.returnDelayMs = 0;
    this.shopReadyAt = 0;
    this.pendingBuyId = null;
  }

  connect() {
    if (stopping || this.ws) return;
    this.ws = new WebSocket(targetUrl);
    this.ws.on('open', () => {
      this.lastInput = null;
      this.send({ type: 'join', name: this.name, cls: this.cls });
      this.send({ type: 'view', ...view });
      this.startThinking();
      const duration = this.startSession();
      console.log(`[bot] ${this.name} connected as ${this.cls} (${this.style.label}); session ~${Math.round(duration / 60000)}m`);
    });
    this.ws.on('message', raw => this.onMessage(raw));
    this.ws.on('error', () => {});
    this.ws.on('close', () => {
      this.stopThinking();
      this.stopSession();
      this.playerId = null;
      this.self = null;
      this.lastInput = null;
      this.purchasedEquipment.clear();
      this.pendingBuyId = null;
      this.intentShopId = null;
      this.intentShopItemId = null;
      this.ws = null;
      if (!stopping) {
        if (this.takingBreak) {
          const delay = this.returnDelayMs || randomRange(replacementMinMs, replacementMaxMs);
          console.log(`[bot] ${this.name} signed off; replacement in ~${Math.round(delay / 60000)}m`);
          this.returnTimer = setTimeout(() => {
            this.returnTimer = null;
            if (stopping) return;
            this.takingBreak = false;
            this.name = replacementName(this.name);
            this.connect();
          }, delay);
        } else {
          console.log(`[bot] ${this.name} reconnecting in ${reconnectDelayMs}ms`);
          setTimeout(() => this.connect(), reconnectDelayMs);
        }
      }
    });
  }

  scheduleInitialJoin(delay) {
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      this.connect();
    }, delay);
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
    if (message.type === 'defs') {
      this.shopEquipment = Array.isArray(message.permanentShop?.equipment) ? message.permanentShop.equipment : [];
      return;
    }
    if (message.type === 'shopResult') {
      if (message.ok && this.pendingBuyId) this.purchasedEquipment.add(this.pendingBuyId);
      this.pendingBuyId = null;
      return;
    }
    if (message.type !== 'state' || !this.playerId) return;
    this.players = Array.isArray(message.players) ? message.players : [];
    this.items = Array.isArray(message.items) ? message.items : [];
    this.merchants = Array.isArray(message.merchants) ? message.merchants : [];
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

  startSession() {
    this.stopSession();
    const duration = randomRange(sessionMinMs, sessionMaxMs);
    this.sessionTimer = setTimeout(() => this.takeBreak(), duration);
    return duration;
  }

  stopSession() {
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = null;
  }

  takeBreak() {
    if (stopping || this.takingBreak) return;
    this.takingBreak = true;
    this.returnDelayMs = randomRange(replacementMinMs, replacementMaxMs);
    this.stopSession();
    this.sendInput(false, false, false, false);
    if (this.ws) this.ws.close();
  }

  think() {
    if (!this.self || this.self.dead) {
      this.sendInput(false, false, false, false);
      return;
    }

    const now = Date.now();
    const visibleTarget = this.bestVisibleOpponent();
    const target = this.lockedTarget(visibleTarget);
    const hpRatio = this.healthRatio();
    const item = this.bestVisibleItem(hpRatio);
    const shop = this.shopPlan();
    const pressure = this.nearbyOpponentCount(360);
    const moving = this.shouldMove(now, target, item, shop, hpRatio, pressure);
    let moveX = 0;
    let moveY = 0;
    const shopMerchant = this.intent === 'shop' ? this.merchantById(this.intentShopId) : null;

    if (moving && this.intent === 'retreat' && target) {
      ({ x: moveX, y: moveY } = this.retreatVector(target));
    } else if (moving && this.intent === 'chase' && target) {
      ({ x: moveX, y: moveY } = this.combatVector(target));
    } else if (moving && this.intent === 'loot' && item) {
      moveX = item.x - this.self.x;
      moveY = item.y - this.self.y;
    } else if (moving && this.intent === 'shop' && shopMerchant) {
      moveX = shopMerchant.x - this.self.x;
      moveY = shopMerchant.y - this.self.y;
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
    this.tryPurchase(now, shopMerchant);

    const targetDistance = target ? this.distanceTo(target) : Infinity;
    const profile = this.combatProfile();
    const fighting = target && this.intent !== 'retreat' && targetDistance < profile.attackDistance;
    if (fighting && now - this.lastAttackAt > randomRange(...this.style.attackMs)) {
      this.send({ type: 'attack' });
      this.lastAttackAt = now;
    }
    if (target && this.intent !== 'retreat' && targetDistance < profile.skillDistance && now - this.lastSkillAt[0] > randomRange(...this.style.skill0Ms)) {
      this.send({ type: 'skill', slot: 0 });
      this.lastSkillAt[0] = now;
    }
    if (this.self.level >= 3 && target && this.intent !== 'retreat' && targetDistance < profile.skillDistance && now - this.lastSkillAt[1] > randomRange(...this.style.skill1Ms)) {
      this.send({ type: 'skill', slot: 1 });
      this.lastSkillAt[1] = now;
    }
  }

  shouldMove(now, target, item, shop, hpRatio, pressure) {
    if (now >= this.restUntil) {
      this.moveUntil = now + randomRange(...this.style.moveMs);
      this.restUntil = this.moveUntil + randomRange(...this.style.restMs);
      this.intent = 'roam';
      this.intentTargetId = null;
      this.intentShopId = null;
      this.intentShopItemId = null;
      const profile = this.combatProfile();
      const targetDistance = target ? this.distanceTo(target) : Infinity;
      const outnumbered = pressure > profile.crowdLimit && hpRatio < 0.78;
      const urgentHeal = item?.type === 'heal' && hpRatio < 0.72;
      if (target && (hpRatio < this.style.retreatHp || outnumbered)) {
        this.intent = 'retreat';
        this.intentTargetId = target.id;
      } else if (urgentHeal) {
        this.intent = 'loot';
      } else if (shop && (!target || targetDistance > profile.maxDistance + 100) && Math.random() < 0.7) {
        this.intent = 'shop';
        this.intentShopId = shop.merchant.id;
        this.intentShopItemId = shop.item.id;
      } else if (target && this.shouldEngage(target, hpRatio, pressure)) {
        this.intent = 'chase';
        this.intentTargetId = target.id;
      } else if (item && Math.random() < this.style.lootChance) {
        this.intent = 'loot';
      }
    }
    return this.intent !== 'roam' || now < this.moveUntil;
  }

  healthRatio() {
    const maxHp = this.self.maxHp || 100;
    return Math.max(0, Math.min(1, this.self.hp / maxHp));
  }

  entityHealthRatio(entity) {
    const maxHp = entity.maxHp || 100;
    return Math.max(0, Math.min(1, entity.hp / maxHp));
  }

  combatProfile() {
    return combatProfiles[this.cls] || combatProfiles.warrior;
  }

  distanceTo(entity) {
    return Math.hypot(entity.x - this.self.x, entity.y - this.self.y);
  }

  nearbyOpponentCount(radius) {
    let count = 0;
    for (const player of this.players) {
      if (player.id === this.playerId || player.dead) continue;
      if (this.distanceTo(player) <= radius) count += 1;
    }
    return count;
  }

  shouldEngage(target, hpRatio, pressure) {
    const profile = this.combatProfile();
    if (target.prot || hpRatio < Math.max(0.54, this.style.retreatHp + 0.1)) return false;
    if (pressure > profile.crowdLimit) return false;
    return this.entityHealthRatio(target) < 0.58 || Math.random() < this.style.chaseChance;
  }

  retreatVector(target) {
    const dx = this.self.x - target.x;
    const dy = this.self.y - target.y;
    return { x: dx - dy * this.fleeBias, y: dy + dx * this.fleeBias };
  }

  combatVector(target) {
    const dx = target.x - this.self.x;
    const dy = target.y - this.self.y;
    const distance = Math.hypot(dx, dy) || 1;
    const profile = this.combatProfile();
    const side = this.fleeBias >= 0 ? 1 : -1;
    if (this.cls === 'mage') {
      if (distance < profile.minDistance) return { x: -dx - dy * 0.35 * side, y: -dy + dx * 0.35 * side };
      if (distance > profile.maxDistance) return { x: dx, y: dy };
      return { x: -dy * 0.55 * side, y: dx * 0.55 * side };
    }
    if (this.cls === 'assassin' && distance < 58) return { x: -dy * 0.35 * side, y: dx * 0.35 * side };
    if (this.cls === 'warrior' && distance < 95) return { x: -dy * 0.18 * side, y: dx * 0.18 * side };
    return { x: dx, y: dy };
  }

  lockedTarget(fallback) {
    if (this.intentTargetId) {
      const locked = this.players.find(player => player.id === this.intentTargetId && !player.dead);
      if (locked) return locked;
    }
    return fallback;
  }

  bestVisibleItem(hpRatio) {
    let best = null;
    let bestScore = Infinity;
    const value = {
      life: 520, heal: hpRatio < 0.72 ? 500 : 65, power: 280, defense: 250,
      haste: 220, speed: 205, reveal: 150, exp: 145, gold: 125, invis: 110
    };
    for (const item of this.items) {
      const score = this.distanceTo(item) - (value[item.type] || 80);
      if (score < bestScore) {
        best = item;
        bestScore = score;
      }
    }
    return best;
  }

  bestVisibleOpponent() {
    let best = null;
    let bestScore = Infinity;
    for (const player of this.players) {
      if (player.id === this.playerId || player.dead || player.prot) continue;
      const distance = this.distanceTo(player);
      const hpRatio = this.entityHealthRatio(player);
      const levelGap = Math.max(0, (player.level || 1) - (this.self.level || 1));
      let nearbyAllies = 0;
      for (const other of this.players) {
        if (other.id === this.playerId || other.id === player.id || other.dead) continue;
        if (Math.hypot(other.x - player.x, other.y - player.y) < 220) nearbyAllies += 1;
      }
      const score = distance + hpRatio * 160 + levelGap * 55 + nearbyAllies * 90 - (1 - hpRatio) * 300;
      if (score < bestScore) {
        best = player;
        bestScore = score;
      }
    }
    return best;
  }

  merchantById(id) {
    return this.merchants.find(merchant => merchant.id === id && merchant.hp > 0) || null;
  }

  shopPlan() {
    if (!this.self || !this.shopEquipment.length) return null;
    const item = this.shopEquipment.find(entry => this.self.gold >= entry.price && !this.purchasedEquipment.has(entry.id));
    if (!item) return null;
    let merchant = null;
    let bestDistance = Infinity;
    for (const candidate of this.merchants) {
      if (candidate.hp <= 0) continue;
      const distance = this.distanceTo(candidate);
      if (distance < bestDistance) {
        merchant = candidate;
        bestDistance = distance;
      }
    }
    return merchant ? { merchant, item } : null;
  }

  tryPurchase(now, merchant) {
    if (this.intent !== 'shop' || !merchant || !this.intentShopItemId || this.pendingBuyId || now < this.shopReadyAt) return;
    const item = this.shopEquipment.find(entry => entry.id === this.intentShopItemId);
    if (!item || this.self.gold < item.price || this.distanceTo(merchant) > 130) return;
    this.pendingBuyId = item.id;
    this.shopReadyAt = now + 5000;
    this.send({ type: 'shopPermanentBuy', item: item.id });
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
    this.stopSession();
    if (this.returnTimer) clearTimeout(this.returnTimer);
    this.returnTimer = null;
    if (this.initialTimer) clearTimeout(this.initialTimer);
    this.initialTimer = null;
    if (this.ws) this.ws.close();
  }
}

function initialJoinDelay(index) {
  if (index === 0) return randomRange(2000, 8000);
  if (index < initialFastJoinCount) return randomRange(12000, initialFastJoinMaxMs);
  return randomRange(initialLateJoinMinMs, initialLateJoinMaxMs);
}

async function main() {
  console.log(`[bots] starting ${botCount} bots against ${targetUrl}`);
  const bots = Array.from({ length: botCount }, (_, index) => new ArenaBot(index));
  for (const bot of bots) {
    const delay = initialJoinDelay(bot.index);
    console.log(`[bots] ${bot.name} enters in ~${Math.max(1, Math.round(delay / 1000))}s`);
    bot.scheduleInitialJoin(delay);
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
