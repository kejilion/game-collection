// ============================================================================
// 通用反作弊引擎（零依赖，可移植到任何 Node 多人在线对战服务器）
//
// 设计原则：
//  1. 服务端权威 —— 一切校验基于服务器已知状态，客户端输入只是"请求"
//  2. 分通道计分 + 独立衰减 —— 网络移动噪声不污染战斗与完整性证据
//  3. 阶梯处置 —— 纠正(回拉) → 警告 → 踢出 → 封禁，容忍网络抖动带来的误差
//  4. 引擎只做"通用数学与流程"，几何/速度公式等游戏差异经由回调注入
//
// 校验分两类：
//  - 功能校验（enabled=false 时仍生效）：cooldown 冷却时序、vec3/num 数值清洗
//  - 惩罚校验（enabled=false 时直通）：movement 移动、rate 限速、aim 统计、flag 计分
//    rate 超限始终丢弃；只做 observe 审计，不累计处罚分
// ============================================================================
'use strict';

const now = () => Date.now();
const hyp2 = (x, z) => Math.sqrt(x * x + z * z);
const SCORE_CHANNELS = ['movement', 'combat', 'integrity'];
const MOVEMENT_RULES = new Set(['teleport', 'speed', 'fly', 'clip']);

const DEFAULTS = {
  enabled: true,
  // 阈值保持直观总分；不同证据通道独立衰减，避免网络噪声污染战斗证据。
  thresholds: { warn: 20, kick: 45, ban: 90 },
  channelDecayPerSec: { movement: 1, combat: 0.25, integrity: 0.25 },
  movementBanContribution: 15,
  warnCooldownMs: 30000,     // 同一玩家两次警告的最小间隔
  banMinutes: 10,            // 直接封禁时长
  kicksToBan: 3,             // 24h 内被踢 N 次自动升级封禁
  movementKicksToBan: 6,     // 仅网络敏感规则导致的踢出提高升级门槛，避免高延迟误封
  kickWindowMs: 24 * 3600 * 1000,
  sustainedSpeed: {
    enabled: true,
    windowMs: 5 * 60 * 1000,
    observeCount: 12,
    warnCount: 20,
    kickCount: 36,
    maxRttMs: 150,
    minRttSamples: 3,
  },
  // 各规则默认计分权重
  weights: {
    teleport: 10,  // 单包位移超过瞬移阈值
    speed: 3,      // 超速漏桶溢出
    fly: 6,        // 持续悬空
    clip: 4,       // 卡入实体几何
    badvec: 10,    // 非法数值/未归一化向量（明确的协议篡改）
    cooldown: 3,   // 冷却滥用（连点宏，达到统计阈值后计）
    aim: 15,        // 瞄准统计异常
    hipsniper: 7,   // 狙击枪未开镜异常（实际按档位传入 3/7/12）
    spk: 15,       // shots-per-kill 异常低
    range: 2,      // 远距离探测类请求
  },
  ruleChannels: {
    teleport: 'movement', speed: 'movement', fly: 'movement', clip: 'movement',
    cooldown: 'combat', aim: 'combat', hipsniper: 'combat', spk: 'combat',
    killpace: 'combat', streak: 'combat', preaim: 'combat', dominance: 'combat',
    badvec: 'integrity', range: 'integrity', sustainedspeed: 'integrity',
  },
  scoreCooldownMs: {
    badvec: 1000, cooldown: 10000, range: 3000, spk: 30000,
    preaim: 300000, dominance: 120000,
  },
  rateObserveEvery: 25,
  // 移动校验
  movement: {
    dtMinMs: 15, dtMaxMs: 400,   // 单包计时钳制（防时间伪造/卡顿误判）
    speedSlack: 1.3,             // 速度许可倍率（容忍插值与抖动）
    packetPad: 0.05,             // 每包固定余量（米）
    teleportDist: 10,            // 单包位移即判瞬移的距离（下限，会随 dt 动态放大）
    teleportDtScale: 3,          // 瞬移阈值 = max(teleportDist, allowed×此系数)，长间隔包自动放宽
    speedBucketMax: 7,           // 超速漏桶容量（米），溢出记违规并回拉
    speedBucketLeak: 0.25,       // 合法包时漏桶回收比例
    clipStreak: 3,               // 连续 N 包卡在实体内才判穿墙
    // 网络尖峰期间按真实断流时间发放一次性移动额度；额度只够合法速度使用，不能给外挂加速。
    // 超额位置始终回拉，保护期内只是不计分，解决排队位置包集中到达造成的连续误罚。
    lagSpikeMs: 350,
    lagGraceMs: 1500,
    lagCreditMaxMs: 1000,
    moveFlagCooldownMs: 2500,
    penaltyRttMs: 500,              // 服务端协议心跳 RTT 达到此值时仍回拉非法位置，但暂停移动计分
    maxAboveFloor: 4.5,
    airMinAboveFloor: 1.25,
    maxAirMs: 1900,
    flyBucketMax: 4,
  },
  // 瞄准统计
  aim: {
    evalShots: 40,               // 每累计 N 枪评估一次
    minHitsForHs: 20,            // 爆头率评估的最小命中数
    hsRatioMax: 0.8,             // 爆头率上限
    hitRatioMax: 0.95,           // 命中率上限
    snapAngleDeg: 40,            // 开火方向与视角方向的夹角超过即记 snap（仅统计命中的枪，防误伤甩狙真人）
    snapRatioMax: 0.4,           // snap 占命中数的比例上限
    minHitsForSnap: 15,          // snap 评估的最小命中数
    familyCooldownMs: 30000,     // aim/hipsniper 共用冷却，避免同一批枪法证据重复加分
    correctionGraceMs: 5000,     // 服务端位置回拉后暂缓枪法加分，避免网络波动与枪法证据叠加误伤
  },
  // 狙击枪未开镜命中统计：只作为辅助证据，单次最高 12 分，低于 FPS 预设 15 分警告线
  hipSniper: {
    windowMs: 120000,
    evalShots: 24,
    retainShots: 12,
    adsSettleMs: 220,
    longRange: 18,
    mild:   { hitRatio: 0.75, longHits: 8,  avgDistance: 18, minVictims: 3, weight: 3 },
    strong: { hitRatio: 0.85, longHits: 10, avgDistance: 22, minVictims: 3, weight: 7 },
    severe: { hitRatio: 0.92, longHits: 12, avgDistance: 24, minVictims: 4, weight: 12 },
    severeMovingRatio: 0.45,
    severeHeadshotRatio: 0.60,
    severeSnapRatio: 0.20,
  },
  // 冷却滥用统计
  cdAbuse: { severeRatio: 0.4, countWindowMs: 10000, countMax: 6 },
  // shots-per-kill 检测
  spk: {
    evalKills: 8,              // 每累计 N 次击杀评估一次
    spkMin: 3.5,               // 平均弹药消耗低于此值触发
    severeSpk: 2.0,            // 极低弹药消耗提高证据权重，但不一票踢出
    severeWeight: 25,
    minGunKills: 5,             // 枪械击杀至少达到此数才评估
  },
  logSize: 200,
  onAction: null,                // (key, action, reason, monitor) => {}  action: warn|kick|ban
  log: null,                     // (entry) => {}
  store: null,                   // 持久化适配器：{ getBan, setBan, addKick, kickCount, save }
  audit: null,                   // 追加式审计器：{ identityHash, write, status, close }
};

function deepMerge(base, over) {
  const out = Object.assign({}, base);
  for (const k of Object.keys(over || {})) {
    const overPlain = over[k] && typeof over[k] === 'object' && !Array.isArray(over[k])
      && Object.getPrototypeOf(over[k]) === Object.prototype;
    const basePlain = base && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      && Object.getPrototypeOf(base[k]) === Object.prototype;
    if (overPlain && basePlain)
      out[k] = deepMerge(base[k], over[k]);
    else out[k] = over[k];
  }
  return out;
}

// ---------------------------------------------------------------------------
// 令牌桶
// ---------------------------------------------------------------------------
class TokenBucket {
  constructor(perSec, burst) {
    this.rate = perSec; this.cap = burst || perSec;
    this.tokens = this.cap; this.last = now();
  }
  take(n = 1) {
    const t = now();
    this.tokens = Math.min(this.cap, this.tokens + (t - this.last) / 1000 * this.rate);
    this.last = t;
    if (this.tokens >= n) { this.tokens -= n; return true; }
    return false;
  }
}

// ---------------------------------------------------------------------------
// 单个玩家的监控器
// ---------------------------------------------------------------------------
class Monitor {
  constructor(engine, key, meta) {
    this.engine = engine;
    this.key = key;
    this.meta = meta || {};          // 建议含 { ip, name } 用于封禁标识
    this.score = 0;
    this._scores = { movement: 0, combat: 0, integrity: 0 };
    this.flags = 0;
    this.kicked = false;
    this.lastWarnAt = 0;
    this.violations = [];            // 最近违规明细（环形）
    this._buckets = new Map();       // rate 令牌桶
    this._rateDrops = new Map();     // rate 丢弃计数（每 10 次计分一次）
    this._cds = new Map();           // cooldown 上次通过时间
    this._cdAbuse = new Map();       // cooldown 滥用滑动计数
    this._mv = null;                 // movement 状态
    this._aim = { shots: 0, hits: 0, hs: 0, snaps: 0 };
    this._hipSniper = [];
    this._lastAccuracyFlagAt = 0;
    this._lastCorrectionAt = 0;
    this._spk = { shotsFired: 0, killRecords: [] };
    this._lastScoreAt = new Map();
    this._persistentScores = new Map();
    this._sustainedSpeedEvents = [];
    this._sustainedSpeedStage = 0;
    this.networkRtt = null;         // 仅接受服务端 WebSocket ping/pong 测得的可信 RTT
    this.clientRtt = null;          // 客户端自报 RTT 只作诊断，不参与处罚
    this.identity = this.engine.identityFor(this.meta);
    this.ruleCounts = {};
    this.observeCounts = {};
    this._rttSamples = [];
    this._clientRttSamples = [];
    this.stats = { corrections: 0, teleports: 0, dropped: 0 };
  }
  get enabled() { return this.engine.opts.enabled; }

  idents() {
    const ids = [];
    if (this.meta.ip) ids.push('ip:' + this.meta.ip);
    if (this.meta.name) ids.push('name:' + this.meta.name);
    return ids;
  }

  channelScore(channel, includePersistent = true) {
    let total = this._scores[channel] || 0;
    if (!includePersistent) return total;
    for (const row of this._persistentScores.values()) {
      if (row.channel === channel) total += row.value;
    }
    return total;
  }

  scoreSnapshot() {
    const scores = {};
    for (const channel of SCORE_CHANNELS) scores[channel] = this.channelScore(channel);
    return scores;
  }

  refreshScore() {
    const scores = this.scoreSnapshot();
    this.score = SCORE_CHANNELS.reduce((sum, channel) => sum + scores[channel], 0);
    return scores;
  }

  // ---- 计分与处置 ----
  flag(rule, weight, detail) {
    if (!this.enabled || this.kicked) return false;
    const t = now();
    const policy = this.engine.rulePolicy(rule);
    const configured = this.engine.opts.weights[rule];
    const w = Number(weight !== undefined ? weight : (configured !== undefined ? configured : 1));
    if (!isFinite(w) || w <= 0) return false;
    const scoreCooldownMs = this.engine.opts.scoreCooldownMs[rule] || 0;
    const lastScoreAt = this._lastScoreAt.get(rule) || 0;
    if (scoreCooldownMs && t - lastScoreAt < scoreCooldownMs) return false;
    this._lastScoreAt.set(rule, t);
    this._scores[policy.channel] += w;
    const scores = this.refreshScore();
    this.flags++;
    const entry = {
      type: 'flag', t, key: this.key, name: this.meta.name, rule,
      channel: policy.channel, w, detail: detail || '', score: Math.round(this.score), scores,
    };
    this.violations.push(entry);
    if (this.violations.length > 30) this.violations.shift();
    this.engine._log(entry);
    this.engine._evaluate(this, entry);
    this.trackSustainedSpeed(rule, t);
    return true;
  }

  trackSustainedSpeed(rule, t) {
    const cfg = this.engine.opts.sustainedSpeed || {};
    if (!cfg.enabled || rule !== 'speed') return;
    if (this._rttSamples.length < Math.max(1, Number(cfg.minRttSamples) || 1)) return;
    if (!this.movementEvidenceSafe(Number(cfg.maxRttMs) || 150)) return;

    const windowMs = Math.max(1000, Number(cfg.windowMs) || 300000);
    this._sustainedSpeedEvents = this._sustainedSpeedEvents.filter(at => t - at <= windowMs);
    this._sustainedSpeedEvents.push(t);
    const count = this._sustainedSpeedEvents.length;
    const observeCount = Math.max(1, Number(cfg.observeCount) || 12);
    const warnCount = Math.max(observeCount, Number(cfg.warnCount) || 20);
    const kickCount = Math.max(warnCount, Number(cfg.kickCount) || 36);
    const nextStage = count >= kickCount ? 3 : count >= warnCount ? 2 : count >= observeCount ? 1 : 0;

    const previousStage = this._sustainedSpeedStage;
    this._sustainedSpeedStage = nextStage;
    if (nextStage === 0) return;
    if (nextStage >= 1 && previousStage < 1)
      this.observe('sustainedspeed', `可信低延迟持续超速 ${count} 次/${Math.round(windowMs / 1000)}s`);
    if (nextStage <= previousStage || nextStage < 2) return;

    const score = nextStage >= 3
      ? this.engine.opts.thresholds.kick
      : this.engine.opts.thresholds.warn;
    this.flag('sustainedspeed', score,
      `可信低延迟持续超速 ${count} 次/${Math.round(windowMs / 1000)}s rtt=${Math.round(this.networkRtt)}ms`);
  }

  // 不随时间衰减的弱辅助分；适合连杀等上下文证据，调用方负责在死亡/回合结束时清零。
  setPersistentScore(rule, value, detail) {
    const next = Math.max(0, Number(value) || 0);
    const policy = this.engine.rulePolicy(rule);
    const previousRow = this._persistentScores.get(rule);
    const previous = previousRow ? previousRow.value : 0;
    if (next === previous) return;
    if (!this.enabled && next > 0) return;
    if (next > 0) this._persistentScores.set(rule, { value: next, channel: policy.channel });
    else this._persistentScores.delete(rule);
    const scores = this.refreshScore();
    if (!this.enabled || this.kicked || next <= previous) return;
    const w = next - previous;
    this.flags++;
    const entry = {
      type: 'flag', t: now(), key: this.key, name: this.meta.name, rule, w,
      channel: policy.channel, detail: detail || '', score: Math.round(this.score),
      scores, persistent: true,
    };
    this.violations.push(entry);
    if (this.violations.length > 30) this.violations.shift();
    this.engine._log(entry);
    this.engine._evaluate(this, entry);
  }

  persistentScore(channel) {
    let total = 0;
    for (const row of this._persistentScores.values()) {
      if (!channel || row.channel === channel) total += row.value;
    }
    return total;
  }

  observe(rule, detail) {
    if (!this.enabled || this.kicked) return;
    this.engine._observe({
      type: 'observe', t: now(), key: this.key, name: this.meta.name,
      rule, channel: this.engine.rulePolicy(rule).channel, detail: detail || '',
      score: Math.round(this.score), scores: this.scoreSnapshot(),
    });
  }

  // ---- 消息限速（惩罚类）：false = 丢弃该消息 ----
  rate(tag, perSec, burst) {
    if (!this.enabled) return true;
    let b = this._buckets.get(tag);
    if (!b) { b = new TokenBucket(perSec, burst); this._buckets.set(tag, b); }
    if (b.take()) return true;
    this.stats.dropped++;
    const n = (this._rateDrops.get(tag) || 0) + 1;
    this._rateDrops.set(tag, n);
    const every = this.engine.opts.rateObserveEvery || 25;
    if (n % every === 0) this.observe('rate', `${tag} 洪泛丢弃 x${n}`);
    return false;
  }

  // ---- 冷却校验（功能类，始终生效）：true = 允许执行 ----
  cooldown(tag, cdMs) {
    const t = now();
    const last = this._cds.get(tag) || 0;
    const delta = t - last;
    if (delta >= cdMs) { this._cds.set(tag, t); return true; }
    // 滥用统计：明显早于冷却（宏/连点器特征），仅惩罚模式计分
    if (this.enabled && cdMs > 0 && (cdMs - delta) / cdMs > this.engine.opts.cdAbuse.severeRatio) {
      const win = this.engine.opts.cdAbuse.countWindowMs;
      let a = this._cdAbuse.get(tag);
      if (!a || t - a.t0 > win) a = { t0: t, n: 0 };
      a.n++;
      this._cdAbuse.set(tag, a);
      if (a.n === this.engine.opts.cdAbuse.countMax) this.flag('cooldown', undefined, `${tag} 冷却滥用 x${a.n}`);
    }
    return false;
  }

  // ---- 数值清洗（功能类）：非法返回 null ----
  num(v, min, max) {
    const n = +v;
    if (!isFinite(n)) { this.flag('badvec', undefined, '非法数值'); return null; }
    return Math.max(min, Math.min(max, n));
  }

  noteRtt(value) {
    const sample = +value;
    if (!isFinite(sample) || sample < 0 || sample > 15000) return;
    this.networkRtt = this.networkRtt === null ? sample : this.networkRtt * 0.75 + sample * 0.25;
    this._rttSamples.push(sample);
    if (this._rttSamples.length > 60) this._rttSamples.shift();
  }
  noteClientRtt(value) {
    const sample = +value;
    if (!isFinite(sample) || sample < 0 || sample > 5000) return;
    this.clientRtt = this.clientRtt === null ? sample : this.clientRtt * 0.75 + sample * 0.25;
    this._clientRttSamples.push(sample);
    if (this._clientRttSamples.length > 60) this._clientRttSamples.shift();
  }
  rttStats() {
    if (!this._rttSamples.length) return null;
    const values = this._rttSamples.slice().sort((a, b) => a - b);
    const percentile = ratio => values[Math.min(values.length - 1, Math.floor((values.length - 1) * ratio))];
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    return {
      samples: values.length,
      avg: Math.round(average),
      p50: Math.round(percentile(0.5)),
      p95: Math.round(percentile(0.95)),
      max: Math.round(values[values.length - 1]),
    };
  }
  combatEvidenceSafe() {
    const t = now();
    const correctionGraceMs = this.engine.opts.aim.correctionGraceMs || 0;
    if (this.networkRtt !== null && this.networkRtt >= 800) return false;
    if (t - this._lastCorrectionAt < correctionGraceMs) return false;
    if (this._mv && t < (this._mv.lagGraceUntil || 0)) return false;
    return true;
  }
  movementEvidenceSafe(maxRttMs = 250) {
    return this._rttSamples.length > 0 && this.networkRtt !== null && this.networkRtt <= maxRttMs;
  }
  vec3(arr, opts) {
    if (!Array.isArray(arr) || arr.length < 3) { this.flag('badvec', undefined, '缺失向量'); return null; }
    const x = +arr[0], y = +arr[1], z = +arr[2];
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) { this.flag('badvec', undefined, '向量含 NaN/Inf'); return null; }
    if (opts && opts.unit) {
      const len = Math.sqrt(x * x + y * y + z * z);
      if (len < 0.8 || len > 1.2) { this.flag('badvec', undefined, `方向未归一化 len=${len.toFixed(2)}`); return null; }
      return [x / len, y / len, z / len];
    }
    return [x, y, z];
  }

  // ---- 移动校验（惩罚类）----
  // ctx: { maxSpeed(米/秒), floorY, maxAboveFloor?, inSolid?(pos)->bool, teleportDist? }
  // 返回 { ok, pos }：违规时 pos 为回拉后的安全位置
  movement(cand, ctx) {
    const M = this.engine.opts.movement;
    const t = now();
    if (!this._mv) {
      this._mv = { pos: { x: cand.x, y: cand.y, z: cand.z }, at: t, speedBucket: 0, flyBucket: 0, airMs: 0, clipN: 0, lagGraceUntil: 0, lagCredit: 0, nextFlagAt: 0 };
      return { ok: true, pos: cand };
    }
    const st = this._mv;
    if (!this.enabled) { st.pos = cand; st.at = t; return { ok: true, pos: cand }; }
    const rawDelta = Math.max(0, t - st.at);   // 真实包间隔（未钳制）
    const dt = Math.max(M.dtMinMs, Math.min(M.dtMaxMs, rawDelta));
    st.at = t;
    const dx = cand.x - st.pos.x, dz = cand.z - st.pos.z;
    const horiz = hyp2(dx, dz);
    const maxSpeed = ctx.maxSpeed || 10;
    const normalAllowed = maxSpeed * dt / 1000 * M.speedSlack + M.packetPad;
    let reject = false, reason = '';

    // 网络尖峰：按断流时长发放有上限的一次性移动额度，后续集中到达的排队包共同消耗。
    // 额度仍严格受 maxSpeed 约束；超额位置只回拉不计分，外挂无法借保护期获得位移收益。
    if (rawDelta > M.lagSpikeMs) {
      const creditMs = Math.min(rawDelta, M.lagCreditMaxMs);
      st.lagGraceUntil = t + M.lagGraceMs;
      st.lagCredit = maxSpeed * creditMs / 1000 * M.speedSlack;
      st.speedBucket = 0;
      st.flyBucket = 0;
      st.airMs = 0;
    }
    const lagProtected = t < (st.lagGraceUntil || 0);
    if (lagProtected && rawDelta <= M.lagSpikeMs) {
      const creditCap = maxSpeed * M.lagCreditMaxMs / 1000 * M.speedSlack;
      st.lagCredit = Math.min(creditCap, (st.lagCredit || 0) + maxSpeed * rawDelta / 1000 * M.speedSlack);
    } else if (!lagProtected) st.lagCredit = 0;
    const allowed = lagProtected ? Math.max(normalAllowed, (st.lagCredit || 0) + M.packetPad) : normalAllowed;
    const movementFlag = (rule, weight, detail) => {
      const latencyProtected = this._rttSamples.length > 0 && this.networkRtt >= M.penaltyRttMs;
      if (lagProtected || latencyProtected || t < (st.nextFlagAt || 0)) return false;
      st.nextFlagAt = t + M.moveFlagCooldownMs;
      const rtt = this.networkRtt === null ? '' : ` rtt=${Math.round(this.networkRtt)}ms`;
      this.flag(rule, weight, `${detail} raw=${rawDelta}ms${rtt}`);
      return true;
    };

    // 瞬移硬阈值不使用网络额度放大，避免长间隔发送者一次跨越过远。
    const tpDist = Math.max(ctx.teleportDist || M.teleportDist, normalAllowed * M.teleportDtScale);
    if (horiz > tpDist) {
      this.stats.teleports++;
      movementFlag('teleport', undefined, `单包位移 ${horiz.toFixed(1)}m (${st.pos.x.toFixed(1)},${st.pos.z.toFixed(1)})→(${cand.x.toFixed(1)},${cand.z.toFixed(1)}) dt=${dt}ms`);
      reject = true; reason = lagProtected ? 'lag' : 'teleport';
    } else if (horiz > allowed) {
      if (lagProtected) {
        reject = true; reason = 'lag';
      } else {
        st.speedBucket += horiz - allowed;
        if (st.speedBucket > M.speedBucketMax) {
          movementFlag('speed', undefined, `累计超速 ${st.speedBucket.toFixed(1)}m`);
          st.speedBucket *= 0.5;
          reject = true; reason = 'speed';
        }
      }
    } else {
      st.speedBucket = Math.max(0, st.speedBucket - allowed * M.speedBucketLeak);
      if (lagProtected) st.lagCredit = Math.max(0, (st.lagCredit || 0) - horiz);
    }

    // 飞天：网络保护期不累计高度异常，位置仍由服务端正常裁决。
    if (!reject && ctx.floorY !== undefined) {
      const maxAbove = ctx.maxAboveFloor || M.maxAboveFloor;
      const over = cand.y - (ctx.floorY + maxAbove);
      if (over > 0 && !lagProtected) {
        st.flyBucket += Math.min(over, 2);
        if (st.flyBucket > M.flyBucketMax) {
          movementFlag('fly', undefined, `悬空 y=${cand.y.toFixed(1)} floor=${ctx.floorY.toFixed(1)}`);
          st.flyBucket = 0;
          st.airMs = 0;
          reject = true; reason = 'fly';
          st.pos.y = Math.min(st.pos.y, ctx.floorY + 1);  // 基线可能已悬空，一并拉回地表附近
          reject = true; reason = 'fly';
        }
      } else if (over <= 0) {
        st.flyBucket = Math.max(0, st.flyBucket - 0.5);
      }
    }

    // 穿墙：连续多包卡在实体内
    // Sustained hover below the hard height cap is still flying.
    if (!reject && ctx.floorY !== undefined && !lagProtected) {
      const aboveAir = cand.y - ctx.floorY;
      const airMin = ctx.airMinAboveFloor || M.airMinAboveFloor;
      const maxAirMs = ctx.maxAirMs || M.maxAirMs;
      if (aboveAir > airMin) st.airMs = (st.airMs || 0) + dt;
      else st.airMs = Math.max(0, (st.airMs || 0) - dt * 1.5);
      if (st.airMs > maxAirMs) {
        movementFlag('fly', undefined, `sustained air ${(st.airMs / 1000).toFixed(1)}s y=${cand.y.toFixed(1)} floor=${ctx.floorY.toFixed(1)}`);
        st.flyBucket = 0;
        st.airMs = 0;
        st.pos.y = Math.min(st.pos.y, ctx.floorY + 0.4);
        reject = true; reason = 'fly';
      }
    }

    if (!reject && ctx.inSolid) {
      if (ctx.inSolid(cand)) {
        st.clipN++;
        if (st.clipN >= M.clipStreak) {
          movementFlag('clip', undefined, `卡入几何体 (${cand.x.toFixed(1)},${cand.y.toFixed(1)},${cand.z.toFixed(1)})`);
          st.clipN = 0;
          reject = true; reason = 'clip';
        }
      } else st.clipN = 0;
    }

    if (reject) {
      this.stats.corrections++;
      this._lastCorrectionAt = t;
      return { ok: false, pos: { x: st.pos.x, y: st.pos.y, z: st.pos.z }, reason };
    }
    st.pos = { x: cand.x, y: cand.y, z: cand.z };
    return { ok: true, pos: cand };
  }
  // 合法传送（出生/复活/技能位移）后由游戏调用，重置移动基线
  resetPos(pos) {
    this._mv = { pos: { x: pos.x, y: pos.y, z: pos.z }, at: now(), speedBucket: 0, flyBucket: 0, airMs: 0, clipN: 0, lagGraceUntil: 0, lagCredit: 0, nextFlagAt: 0 };
  }

  // ---- 瞄准统计（惩罚类）----
  accuracyFlag(rule, weight, detail) {
    const t = now();
    const cooldownMs = this.engine.opts.aim.familyCooldownMs || 30000;
    if (t - this._lastCorrectionAt < (this.engine.opts.aim.correctionGraceMs || 0)) return false;
    if (t - this._lastAccuracyFlagAt < cooldownMs) return false;
    this._lastAccuracyFlagAt = t;
    this.flag(rule, weight, detail);
    return true;
  }

  // { dir:[x,y,z] 开火方向, view:[x,y,z] 最近上报的视线方向, hit, headshot }
  aimShot(s) {
    if (!this.enabled) return;
    const A = this.engine.opts.aim;
    const a = this._aim;
    a.shots++;
    if (s.hit) a.hits++;
    if (s.headshot) a.hs++;
    if (s.hit && s.dir && s.view) {
      const dot = s.dir[0] * s.view[0] + s.dir[1] * s.view[1] + s.dir[2] * s.view[2];
      const ang = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
      if (ang > A.snapAngleDeg) a.snaps++;   // 开火方向与视线严重偏离却命中 = 静默瞄准特征
    }
    if (a.shots >= A.evalShots) {
      const hitRatio = a.hits / a.shots;
      const snapRatio = a.hits >= A.minHitsForSnap ? a.snaps / a.hits : 0;
      const hsRatio = a.hits >= A.minHitsForHs ? a.hs / a.hits : 0;
      const reasons = [];
      if (hsRatio > A.hsRatioMax) reasons.push(`爆头率 ${(hsRatio * 100) | 0}%`);
      if (hitRatio > A.hitRatioMax) reasons.push(`命中率 ${(hitRatio * 100) | 0}%`);
      if (snapRatio > A.snapRatioMax) reasons.push(`甩枪/静默瞄准 ${(snapRatio * 100) | 0}%`);
      if (reasons.length) this.accuracyFlag('aim', undefined, reasons.join('；'));
      // 滚动窗口：折半保留
      a.shots = (a.shots / 2) | 0; a.hits = (a.hits / 2) | 0;
      a.hs = (a.hs / 2) | 0; a.snaps = (a.snaps / 2) | 0;
    }
  }

  // 狙击枪未开镜统计：高命中率必须同时满足远距离、不同目标和足够样本才加辅助分
  hipSniperShot(s) {
    const H = this.engine.opts.hipSniper;
    if (!this.enabled || this.kicked || !H || !s || s.scoped || s.aimingMs >= H.adsSettleMs) return;
    const t = now();
    this._hipSniper = this._hipSniper.filter(row => t - row.t <= H.windowMs);
    let snap = false;
    if (s.hit && s.dir && s.view) {
      const dot = s.dir[0] * s.view[0] + s.dir[1] * s.view[1] + s.dir[2] * s.view[2];
      const angle = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
      snap = angle > this.engine.opts.aim.snapAngleDeg;
    }
    this._hipSniper.push({
      t, hit: !!s.hit, hs: !!s.headshot, moving: !!s.moving, snap,
      distance: s.hit ? Math.max(0, Number(s.distance) || 0) : 0,
      victimId: s.hit ? s.victimId : null,
    });
    if (this._hipSniper.length < H.evalShots) return;

    const rows = this._hipSniper.slice(-H.evalShots);
    const hits = rows.filter(row => row.hit);
    const hitCount = hits.length;
    const hitRatio = hitCount / rows.length;
    const longHits = hits.filter(row => row.distance >= H.longRange).length;
    const avgDistance = hitCount ? hits.reduce((sum, row) => sum + row.distance, 0) / hitCount : 0;
    const victims = new Set(hits.map(row => row.victimId).filter(Boolean)).size;
    const movingRatio = hitCount ? hits.filter(row => row.moving).length / hitCount : 0;
    const headshotRatio = hitCount ? hits.filter(row => row.hs).length / hitCount : 0;
    const snapRatio = hitCount ? hits.filter(row => row.snap).length / hitCount : 0;
    const matches = tier => hitRatio >= tier.hitRatio && longHits >= tier.longHits
      && avgDistance >= tier.avgDistance && victims >= tier.minVictims;

    let tier = null, label = '';
    const severeSignals = Number(movingRatio >= H.severeMovingRatio)
      + Number(headshotRatio >= H.severeHeadshotRatio)
      + Number(snapRatio >= H.severeSnapRatio);
    if (matches(H.severe) && severeSignals >= 1) { tier = H.severe; label = '严重'; }
    else if (matches(H.strong)) { tier = H.strong; label = '明显'; }
    else if (matches(H.mild)) { tier = H.mild; label = '可疑'; }

    if (tier) {
      this.accuracyFlag(
        'hipsniper', tier.weight,
        `${label}未开镜狙击 ${hitCount}/${rows.length} 命中 ${(hitRatio * 100).toFixed(0)}%，远距 ${longHits}，均距 ${avgDistance.toFixed(1)}m，目标 ${victims}，移动 ${(movingRatio * 100).toFixed(0)}%，爆头 ${(headshotRatio * 100).toFixed(0)}%`
      );
    }
    this._hipSniper = this._hipSniper.slice(-H.retainShots);
  }

  // ---- shots-per-kill 检测 ----
  recordKill(wp) {
    if (!this.enabled || this.kicked) return;
    const S = this.engine.opts.spk;
    if (!S) return;
    const s = this._spk;
    const isGun = wp && wp !== 'fist' && wp !== 'knife' && wp !== 'sword' && wp !== 'hammer' && wp !== 'nade' && wp !== 'barrel';
    s.killRecords.push({ shots: s.shotsFired, gun: isGun, wp: wp || '' });
    s.shotsFired = 0;
    if (s.killRecords.length >= S.evalKills) {
      const gunKills = s.killRecords.filter(k => k.gun);
      // 狙击枪与火箭筒都以单发爆发为设计目标，不参与“每杀耗弹过低”规则。
      const evaluatedKills = gunKills.filter(k => k.wp !== 'sniper' && k.wp !== 'rocket');
      if (evaluatedKills.length >= S.minGunKills) {
        const totalShots = evaluatedKills.reduce((sum, k) => sum + k.shots, 0);
        const avgSpk = totalShots / evaluatedKills.length;
        const weaponCounts = evaluatedKills.reduce((counts, k) => {
          counts[k.wp] = (counts[k.wp] || 0) + 1;
          return counts;
        }, {});
        const weaponText = Object.entries(weaponCounts).map(([name, count]) => `${name}:${count}`).join(' ');
        if (avgSpk < S.spkMin) {
          const detail = `平均 ${avgSpk.toFixed(1)} 发/杀 (最近 ${evaluatedKills.length} 次非狙击枪击杀 ${weaponText})`;
          const severe = avgSpk <= S.severeSpk;
          this.flag('spk', severe ? S.severeWeight : undefined, detail);
        }
      }
      s.killRecords = s.killRecords.slice(Math.floor(s.killRecords.length / 2));
    }
  }
  recordShot() { this._spk.shotsFired++; }
}

// ---------------------------------------------------------------------------
// 引擎
// ---------------------------------------------------------------------------
class AntiCheat {
  constructor(opts) {
    this.opts = deepMerge(DEFAULTS, opts || {});
    this.monitors = new Map();
    this.recentLog = [];
    this.totalFlags = 0;
    this.totalObservations = 0;
    this.totalKicks = 0;
    this.totalBans = 0;
    this.ruleCounts = {};
    this.observeCounts = {};
    this.actionCounts = { warn: 0, kick: 0, ban: 0 };
  }

  attach(key, meta) {
    const mon = new Monitor(this, key, meta);
    this.monitors.set(key, mon);
    return mon;
  }
  detach(key) { this.monitors.delete(key); }
  monitorOf(key) { return this.monitors.get(key); }

  identityFor(meta) {
    if (!this.opts.audit || typeof this.opts.audit.identityHash !== 'function') return null;
    return this.opts.audit.identityHash(meta && meta.ip);
  }

  rulePolicy(rule) {
    const configured = this.opts.ruleChannels[rule];
    const channel = SCORE_CHANNELS.includes(configured)
      ? configured
      : (MOVEMENT_RULES.has(rule) ? 'movement' : 'integrity');
    return { channel };
  }

  // 封禁检查：传入身份数组（如 ['ip:1.2.3.4', 'name:xxx']）
  isBanned(idents) {
    if (!this.opts.store) return null;
    for (const id of idents || []) {
      const ban = this.opts.store.getBan(id);
      if (ban && ban.until > now()) return ban;
    }
    return null;
  }
  _escalatedMinutes(idents, baseMinutes) {
    if (!this.opts.store || !this.opts.store.banCount) return baseMinutes;
    let maxPrior = 0;
    for (const id of idents || []) {
      const c = this.opts.store.banCount(id);
      if (c > maxPrior) maxPrior = c;
    }
    const tiers = [baseMinutes, 60, 360, 1440, 0];
    if (maxPrior >= tiers.length - 1) return 0;
    return tiers[maxPrior] || baseMinutes;
  }
  registerBan(idents, minutes, reason) {
    if (!this.opts.store) return;
    const actualMin = this._escalatedMinutes(idents, minutes);
    const until = actualMin === 0 ? now() + 100 * 365.25 * 24 * 3600000 : now() + actualMin * 60000;
    const suffix = actualMin !== minutes ? ` [升级→${actualMin === 0 ? "永封" : actualMin + "min"}]` : '';
    for (const id of idents || []) {
      this.opts.store.setBan(id, { until, reason: reason + suffix, at: now() });
      if (this.opts.store.addBanRecord) this.opts.store.addBanRecord(id);
    }
    this.totalBans++;
  }

  // 每秒调用：各证据通道独立衰减；连杀等持久辅助分由游戏事件显式清零。
  tick(dtSec) {
    const elapsed = Math.max(0, Number(dtSec) || 1);
    for (const mon of this.monitors.values()) {
      for (const channel of SCORE_CHANNELS) {
        const decay = Math.max(0, Number(this.opts.channelDecayPerSec[channel]) || 0) * elapsed;
        mon._scores[channel] = Math.max(0, mon._scores[channel] - decay);
      }
      mon.refreshScore();
    }
  }

  status() {
    const activeMax = { movement: 0, combat: 0, integrity: 0 };
    for (const mon of this.monitors.values()) {
      const scores = mon.scoreSnapshot();
      for (const channel of SCORE_CHANNELS) activeMax[channel] = Math.max(activeMax[channel], Math.round(scores[channel]));
    }
    const persisted = this.opts.store && typeof this.opts.store.eventStats === 'function'
      ? this.opts.store.eventStats()
      : null;
    return {
      enabled: this.opts.enabled,
      players: this.monitors.size,
      flags: this.totalFlags,
      observations: this.totalObservations,
      kicks: this.totalKicks,
      bans: this.totalBans,
      ruleCounts: Object.assign({}, this.ruleCounts),
      observeCounts: Object.assign({}, this.observeCounts),
      actionCounts: Object.assign({}, this.actionCounts),
      activeMaxScores: activeMax,
      persisted,
      recent: this.recentLog.slice(-10).map(e => ({
        t: e.t, type: e.type, rule: e.rule, channel: e.channel,
        action: e.action, score: e.score,
      })),
    };
  }

  // ---- 内部：计分后阈值评估 ----
  _evaluate(mon) {
    const T = this.opts.thresholds;
    if (mon.kicked) return;
    const movementScore = mon.channelScore('movement');
    const temporaryNonMovement = mon.channelScore('combat', false) + mon.channelScore('integrity', false);
    const nonMovementScore = mon.channelScore('combat') + mon.channelScore('integrity');
    const movementOnly = temporaryNonMovement <= 0;
    const effectiveScore = movementOnly ? movementScore : mon.score;
    const banScore = nonMovementScore + Math.min(movementScore, this.opts.movementBanContribution);
    if (!movementOnly && banScore >= T.ban) {
      this._punish(mon, 'ban', '多维异常行为封禁', { movementOnly: false });
    } else if (effectiveScore >= T.kick) {
      this._punish(mon, 'kick', '异常行为移出', { movementOnly });
    } else if (effectiveScore >= T.warn) {
      const t = now();
      if (t - mon.lastWarnAt > this.opts.warnCooldownMs) {
        mon.lastWarnAt = t;
        this._action(mon, 'warn', '检测到异常操作', { movementOnly });
      }
    }
  }
  _punish(mon, kind, reason, context) {
    mon.kicked = true;
    if (kind === 'ban') {
      this.registerBan(mon.idents(), this.opts.banMinutes, reason);
      this._action(mon, 'ban', reason, context);
    } else {
      this.totalKicks++;
      let escalated = false;
      const movementOnly = !!(context && context.movementOnly);
      const kicksToBan = movementOnly ? this.opts.movementKicksToBan : this.opts.kicksToBan;
      if (this.opts.store) {
        for (const id of mon.idents()) {
          const kickKey = movementOnly ? 'network:' + id : id;
          if (this.opts.store.addKick(kickKey, this.opts.kickWindowMs) >= kicksToBan) escalated = true;
        }
      }
      if (escalated) {
        this.registerBan(mon.idents(), this.opts.banMinutes, `24h 内被踢出 ${kicksToBan} 次`);
        this._action(mon, 'ban', '多次违规封禁', { movementOnly });
      } else {
        this._action(mon, 'kick', reason, { movementOnly });
      }
    }
  }

  _action(mon, action, reason, context) {
    this.actionCounts[action] = (this.actionCounts[action] || 0) + 1;
    mon.lastAction = action;
    const entry = {
      type: 'action', t: now(), key: mon.key, name: mon.meta.name,
      action, reason, score: Math.round(mon.score), scores: mon.scoreSnapshot(),
      movementOnly: !!(context && context.movementOnly),
    };
    this._record(entry);
    if (typeof this.opts.onAction === 'function') {
      try { this.opts.onAction(mon.key, action, reason, mon); } catch (_) { /* 动作回调不允许炸引擎 */ }
    }
  }
  _log(entry) {
    this.totalFlags++;
    this.ruleCounts[entry.rule] = (this.ruleCounts[entry.rule] || 0) + 1;
    const mon = this.monitors.get(entry.key);
    if (mon) mon.ruleCounts[entry.rule] = (mon.ruleCounts[entry.rule] || 0) + 1;
    this._record(entry);
    if (typeof this.opts.log === 'function') {
      try { this.opts.log(entry); } catch (_) { /* 日志回调不允许炸引擎 */ }
    }
  }
  _observe(entry) {
    this.totalObservations++;
    this.observeCounts[entry.rule] = (this.observeCounts[entry.rule] || 0) + 1;
    const mon = this.monitors.get(entry.key);
    if (mon) mon.observeCounts[entry.rule] = (mon.observeCounts[entry.rule] || 0) + 1;
    this._record(entry);
  }
  _record(entry) {
    entry.t = entry.t || now();
    const mon = this.monitors.get(entry.key);
    if (mon && mon.identity) entry.identity = mon.identity;
    entry.players = this.monitors.size;
    this.recentLog.push(entry);
    if (this.recentLog.length > this.opts.logSize) this.recentLog.shift();
    if (this.opts.store && typeof this.opts.store.addEvent === 'function') this.opts.store.addEvent(entry);
    if (this.opts.audit && typeof this.opts.audit.write === 'function') this.opts.audit.write(entry);
  }
}

module.exports = { AntiCheat, Monitor, TokenBucket, DEFAULTS };
