const WebSocket = require("ws");

const HOST = process.env.BOT_HOST || "ws://127.0.0.1:3000";
const BOT_NAMES = ["Easy-Alpha", "Easy-Bravo", "Easy-Charlie"];
const MAP_HALF = 35;
const TICK_MS = 1000 / 10;
const SPEED = 3.8;
const VIEW_RANGE = 18;
const GUN_RANGE = 24;
const MELEE_RANGE = 2.9;
const FIRE_INTERVAL_MS = 1700;
const MELEE_INTERVAL_MS = 1400;
const AIM_ERROR = 0.28;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalize(x, z) {
  const length = Math.hypot(x, z) || 1;
  return { x: x / length, z: z / length };
}

function jitter(value) {
  return value + (Math.random() - 0.5) * AIM_ERROR;
}

class SimpleBot {
  constructor(name) {
    this.name = name;
    this.id = 0;
    this.alive = false;
    this.pos = { x: 0, y: 0, z: 0 };
    this.yaw = 0;
    this.hasGun = false;
    this.players = [];
    this.pickups = [];
    this.pickupDefs = [];
    this.wanderTarget = null;
    this.wanderUntil = 0;
    this.nextFireAt = 0;
    this.nextMeleeAt = 0;
    this.ws = null;
  }

  connect() {
    this.ws = new WebSocket(HOST);
    this.ws.on("open", () => {
      console.log(`${this.name} connected`);
      this.send({ type: "join", name: this.name });
    });
    this.ws.on("message", data => {
      try {
        this.handle(JSON.parse(data));
      } catch (_) {
        // Ignore malformed frames.
      }
    });
    this.ws.on("close", () => setTimeout(() => this.connect(), 3000));
    this.ws.on("error", () => {});
  }

  handle(message) {
    if (message.type === "defs" && message.map) {
      this.pickupDefs = message.map.pickups || [];
      return;
    }

    if (message.type === "joined") {
      this.id = message.id;
      this.alive = true;
      console.log(`${this.name} joined as ${this.id}`);
      return;
    }

    if (message.type !== "state") return;

    this.players = message.pl || [];
    this.pickups = message.pk || [];
    const me = this.players.find(player => player.i === this.id);
    if (!me) return;

    this.pos = { x: me.p[0], y: me.p[1], z: me.p[2] };
    this.alive = me.al === 1;
    this.hasGun = Boolean(me.gw);
  }

  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  nearestEnemy() {
    let best = null;
    let bestDist = Infinity;

    for (const player of this.players) {
      if (player.i === this.id || player.al !== 1) continue;
      const dist = Math.hypot(player.p[0] - this.pos.x, player.p[2] - this.pos.z);
      if (dist < bestDist) {
        best = player;
        bestDist = dist;
      }
    }

    return { enemy: best, dist: bestDist };
  }

  nearestPickup() {
    let best = null;
    let bestDist = Infinity;

    for (let index = 0; index < this.pickups.length; index += 1) {
      if (!this.pickups[index] || !this.pickupDefs[index]) continue;
      const pickup = this.pickupDefs[index];
      const dist = Math.hypot(pickup.x - this.pos.x, pickup.z - this.pos.z);
      if (dist < bestDist) {
        best = { index, x: pickup.x, z: pickup.z };
        bestDist = dist;
      }
    }

    return { pickup: best, dist: bestDist };
  }

  pickWanderTarget(now) {
    if (this.wanderTarget && now < this.wanderUntil) return this.wanderTarget;

    this.wanderTarget = {
      x: (Math.random() - 0.5) * 54,
      z: (Math.random() - 0.5) * 54,
    };
    this.wanderUntil = now + 4500 + Math.random() * 3500;
    return this.wanderTarget;
  }

  attack(enemy, dist, now) {
    const dx = enemy.p[0] - this.pos.x;
    const dz = enemy.p[2] - this.pos.z;
    const direction = normalize(dx, dz);

    if (this.hasGun && dist < GUN_RANGE && now >= this.nextFireAt) {
      this.nextFireAt = now + FIRE_INTERVAL_MS + Math.random() * 700;
      this.send({ type: "switch", slot: "gun" });
      this.send({
        type: "fire",
        o: [this.pos.x, this.pos.y + 1.62, this.pos.z],
        d: [
          jitter(direction.x),
          jitter((enemy.p[1] + 1.0 - this.pos.y - 1.62) / Math.max(1, dist)),
          jitter(direction.z),
        ],
      });
      return;
    }

    if (dist < MELEE_RANGE && now >= this.nextMeleeAt) {
      this.nextMeleeAt = now + MELEE_INTERVAL_MS + Math.random() * 500;
      this.send({ type: "switch", slot: "melee" });
      this.send({ type: "melee", d: [dx, 0, dz] });
    }
  }

  tick() {
    if (!this.id || !this.alive) return;

    const now = Date.now();
    const { enemy, dist: enemyDist } = this.nearestEnemy();
    let target = null;

    if (enemy && enemyDist < VIEW_RANGE) {
      target = { x: enemy.p[0], z: enemy.p[2] };
      this.attack(enemy, enemyDist, now);
    } else {
      const { pickup, dist: pickupDist } = this.nearestPickup();
      if (pickup && pickupDist < 18 && Math.random() < 0.65) {
        target = pickup;
        if (pickupDist < 2.5) this.send({ type: "pickup", id: pickup.index });
      } else {
        target = this.pickWanderTarget(now);
      }
    }

    const direction = normalize(target.x - this.pos.x, target.z - this.pos.z);
    this.yaw = Math.atan2(-direction.x, -direction.z);

    const step = SPEED * (TICK_MS / 1000);
    const nextX = clamp(this.pos.x + direction.x * step, -MAP_HALF + 1, MAP_HALF - 1);
    const nextZ = clamp(this.pos.z + direction.z * step, -MAP_HALF + 1, MAP_HALF - 1);

    this.send({
      type: "move",
      p: [Number(nextX.toFixed(2)), this.pos.y, Number(nextZ.toFixed(2))],
      ya: this.yaw,
      pi: 0,
      an: 1,
    });
  }
}

const bots = BOT_NAMES.map(name => new SimpleBot(name));
bots.forEach(bot => bot.connect());
setInterval(() => bots.forEach(bot => bot.tick()), TICK_MS);

console.log("simple bots started");
