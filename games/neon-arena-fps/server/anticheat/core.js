// ============================================================================
// 通用反作弊引擎（零依赖，可移植到任何 Node 多人在线对战服务器）
//
// 设计原则：
//  1. 服务端权威 —— 一切校验基于服务器已知状态，客户端输入只是"请求"
//  2. 违规计分 + 时间衰减 —— 单次抖动不惩罚，持续作弊必然积分越阈
//  3. 阶梯处置 —— 纠正(回拉) → 警告 → 踢出 → 封禁，容忍网络抖动带来的误差
//  4. 引擎只做"通用数学与流程"，几何/速度公式等游戏差异经由回调注入
//
// 校验分两类：
//  - 功能校验（enabled=false 时仍生效）：cooldown 冷却时序、vec3/num 数值清洗
//  - 惩罚校验（enabled=false 时直通）：movement 移动、rate 限速、aim 统计、flag 计分
// ============================================================================
'use strict';

const now = () => Date.now();
const hyp2 = (x, z) => Math.sqrt(x * x + z * z);

const DEFAULTS = {
  enabled: true,
  // 违规分阈值与衰减
  thresholds: { warn: 20, kick: 45, ban: 90 },
  decayPerSec: 0.5,          // 违规分每秒衰减
  warnCooldownMs: 30000,     // 同一玩家两次警告的最小间隔
  banMinutes: 10,            // 直接封禁时长
  kicksToBan: 3,             // 24h 内被踢 N 次自动升级封禁
  kickWindowMs: 24 * 3600 * 1000,
  // 各规则默认计分权重
  weights: {
    teleport: 8,   // 单包位移超过瞬移阈值
    speed: 3,      // 超速漏桶溢出
    fly: 4,        // 持续悬空
    clip: 4,       // 卡入实体几何
    badvec: 4,     // 非法数值/未归一化向量（明确的协议篡改）
    rate: 0.5,     // 消息洪泛（每 10 次丢弃计 1 次）
    cooldown: 2,   // 冷却滥用（连点宏，达到统计阈值后计）
    aim: 8,        // 瞄准统计异常
    range: 0.5,    // 远距离探测类请求
    protocol: 3,   // 其他协议违规
  },
  // 移动校验
  movement: {
    dtMinMs: 15, dtMaxMs: 400,   // 单包计时钳制（防时间伪造/卡顿误判）
    speedSlack: 1.3,             // 速度许可倍率（容忍插值与抖动）
    packetPad: 0.05,             // 每包固定余量（米）
    teleportDist: 10,            // 单包位移即判瞬移的距离（下限，会随 dt 动态放大）
    teleportDtScale: 3,          // 瞬移阈值 = max(teleportDist, allowed×此系数)，长间隔包自动放宽
    speedBucketMax: 7,           // 超速漏桶容量（米），溢出记违规并回拉
    speedBucketLeak: 0.25,       // 合法包时漏桶回收比例
    maxAboveFloor: 7,            // 高于支撑面多少米算"飞天"（含跳跃+平台余量）
    flyBucketMax: 6,             // 飞天漏桶（米·包）
    clipStreak: 3,               // 连续 N 包卡在实体内才判穿墙
    // 网络尖峰豁免：包间隔超过 lagSpikeMs（丢包/卡顿恢复）时，仅回拉位置不计分，
    // 使卡顿玩家不被误封；外挂即便利用大间隔发包也照样被回拉，占不到便宜。
    // 为防刻意慢速发包滥用豁免，lagBudget 为窗口内可豁免次数，超出则恢复正常计分。
    lagSpikeMs: 500,
    lagBudget: 8,                // 60s 窗口内的豁免额度
    lagWindowMs: 60000,
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
  },
  // 冷却滥用统计
  cdAbuse: { severeRatio: 0.4, countWindowMs: 10000, countMax: 6 },
  logSize: 200,
  onAction: null,                // (key, action, reason, monitor) => {}  action: warn|kick|ban
  log: null,                     // (entry) => {}
  store: null,                   // 持久化适配器：{ getBan, setBan, addKick, kickCount, save }
};

function deepMerge(base, over) {
  const out = Object.assign({}, base);
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && typeof base[k] === 'object')
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
    this.stats = { corrections: 0, teleports: 0, dropped: 0 };
  }
  get enabled() { return this.engine.opts.enabled; }

  idents() {
    const ids = [];
    if (this.meta.ip) ids.push('ip:' + this.meta.ip);
    if (this.meta.name) ids.push('name:' + this.meta.name);
    return ids;
  }

  // ---- 计分与处置 ----
  flag(rule, weight, detail) {
    if (!this.enabled || this.kicked) return;
    const w = weight !== undefined ? weight : (this.engine.opts.weights[rule] || 1);
    this.score += w;
    this.flags++;
    const entry = { t: now(), key: this.key, name: this.meta.name, rule, w, detail: detail || '', score: Math.round(this.score) };
    this.violations.push(entry);
    if (this.violations.length > 30) this.violations.shift();
    this.engine._log(entry);
    this.engine._evaluate(this);
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
    if (n % 10 === 0) this.flag('rate', undefined, `${tag} 洪泛 x${n}`);
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
      this._mv = { pos: { x: cand.x, y: cand.y, z: cand.z }, at: t, speedBucket: 0, flyBucket: 0, airMs: 0, clipN: 0 };
      return { ok: true, pos: cand };
    }
    const st = this._mv;
    if (!this.enabled) { st.pos = cand; st.at = t; return { ok: true, pos: cand }; }
    const rawDelta = t - st.at;   // 真实包间隔（未钳制）
    const dt = Math.max(M.dtMinMs, Math.min(M.dtMaxMs, rawDelta));
    st.at = t;
    const dx = cand.x - st.pos.x, dz = cand.z - st.pos.z;
    const horiz = hyp2(dx, dz);
    const allowed = (ctx.maxSpeed || 10) * dt / 1000 * M.speedSlack + M.packetPad;
    let reject = false, reason = '';

    // 网络尖峰判定：包间隔异常大 = 丢包/卡顿恢复。豁免额度按 60s 窗口滚动补充，防刻意慢发滥用。
    let lagExempt = false;
    if (rawDelta > M.lagSpikeMs) {
      if (st.lagWinAt === undefined || t - st.lagWinAt > M.lagWindowMs) { st.lagWinAt = t; st.lagUsed = 0; }
      if ((st.lagUsed || 0) < M.lagBudget) { st.lagUsed = (st.lagUsed || 0) + 1; lagExempt = true; }
    }

    // 瞬移：单包位移离谱。阈值随 dt 动态放大——长间隔包本就该允许更大位移。
    const tpDist = Math.max(ctx.teleportDist || M.teleportDist, allowed * M.teleportDtScale);
    if (horiz > tpDist) {
      this.stats.teleports++;
      if (lagExempt) {
        // 网络尖峰：静默回拉到最后合法位置，不计分（公平性由回拉保证，外挂占不到便宜）
        st.speedBucket = 0;
        this.stats.corrections++;
        return { ok: false, pos: { x: st.pos.x, y: st.pos.y, z: st.pos.z }, reason: 'lag' };
      }
      this.flag('teleport', undefined, `单包位移 ${horiz.toFixed(1)}m (${st.pos.x.toFixed(1)},${st.pos.z.toFixed(1)})→(${cand.x.toFixed(1)},${cand.z.toFixed(1)}) dt=${dt}ms`);
      reject = true; reason = 'teleport';
    } else if (horiz > allowed) {
      // 超速：漏桶累积，溢出才处置（容忍抖动）。网络尖峰包不喂桶，避免卡顿恢复的正常位移被累计。
      if (!lagExempt) {
        st.speedBucket += horiz - allowed;
        if (st.speedBucket > M.speedBucketMax) {
          this.flag('speed', undefined, `累计超速 ${st.speedBucket.toFixed(1)}m`);
          st.speedBucket *= 0.5;
          reject = true; reason = 'speed';
        }
      }
    } else {
      st.speedBucket = Math.max(0, st.speedBucket - allowed * M.speedBucketLeak);
    }

    // 飞天：持续高于支撑面（网络尖峰包不喂桶，卡顿恢复时的高度跳变不误判）
    if (!reject && ctx.floorY !== undefined) {
      const maxAbove = ctx.maxAboveFloor || M.maxAboveFloor;
      const over = cand.y - (ctx.floorY + maxAbove);
      if (over > 0 && !lagExempt) {
        st.flyBucket += Math.min(over, 2);
        if (st.flyBucket > M.flyBucketMax) {
          this.flag('fly', undefined, `悬空 y=${cand.y.toFixed(1)} floor=${ctx.floorY.toFixed(1)}`);
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
    if (!reject && ctx.floorY !== undefined && !lagExempt) {
      const aboveAir = cand.y - ctx.floorY;
      const airMin = ctx.airMinAboveFloor || M.airMinAboveFloor;
      const maxAirMs = ctx.maxAirMs || M.maxAirMs;
      if (aboveAir > airMin) st.airMs = (st.airMs || 0) + dt;
      else st.airMs = Math.max(0, (st.airMs || 0) - dt * 1.5);
      if (st.airMs > maxAirMs) {
        this.flag('fly', undefined, `sustained air ${(st.airMs / 1000).toFixed(1)}s y=${cand.y.toFixed(1)} floor=${ctx.floorY.toFixed(1)}`);
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
          this.flag('clip', undefined, `卡入几何体 (${cand.x.toFixed(1)},${cand.y.toFixed(1)},${cand.z.toFixed(1)})`);
          st.clipN = 0;
          reject = true; reason = 'clip';
        }
      } else st.clipN = 0;
    }

    if (reject) {
      this.stats.corrections++;
      return { ok: false, pos: { x: st.pos.x, y: st.pos.y, z: st.pos.z }, reason };
    }
    st.pos = { x: cand.x, y: cand.y, z: cand.z };
    return { ok: true, pos: cand };
  }
  // 合法传送（出生/复活/技能位移）后由游戏调用，重置移动基线
  resetPos(pos) {
    this._mv = { pos: { x: pos.x, y: pos.y, z: pos.z }, at: now(), speedBucket: 0, flyBucket: 0, airMs: 0, clipN: 0 };
  }

  // ---- 瞄准统计（惩罚类）----
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
      if (hsRatio > A.hsRatioMax) this.flag('aim', undefined, `爆头率异常 ${(hsRatio * 100) | 0}%`);
      if (hitRatio > A.hitRatioMax) this.flag('aim', undefined, `命中率异常 ${(hitRatio * 100) | 0}%`);
      if (snapRatio > A.snapRatioMax) this.flag('aim', undefined, `甩枪/静默瞄准特征 ${(snapRatio * 100) | 0}%`);
      // 滚动窗口：折半保留
      a.shots = (a.shots / 2) | 0; a.hits = (a.hits / 2) | 0;
      a.hs = (a.hs / 2) | 0; a.snaps = (a.snaps / 2) | 0;
    }
  }
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
    this.totalKicks = 0;
    this.totalBans = 0;
  }

  attach(key, meta) {
    const mon = new Monitor(this, key, meta);
    this.monitors.set(key, mon);
    return mon;
  }
  detach(key) { this.monitors.delete(key); }
  monitorOf(key) { return this.monitors.get(key); }

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

  // 每秒调用：违规分衰减
  tick(dtSec) {
    const decay = this.opts.decayPerSec * (dtSec || 1);
    for (const mon of this.monitors.values())
      mon.score = Math.max(0, mon.score - decay);
  }

  status() {
    return {
      enabled: this.opts.enabled,
      players: this.monitors.size,
      flags: this.totalFlags,
      kicks: this.totalKicks,
      bans: this.totalBans,
      recent: this.recentLog.slice(-10),
    };
  }

  // ---- 内部：计分后阈值评估 ----
  _evaluate(mon) {
    const T = this.opts.thresholds;
    if (mon.kicked) return;
    if (mon.score >= T.ban) {
      this._punish(mon, 'ban', `违规分 ${Math.round(mon.score)} 达封禁阈值`);
    } else if (mon.score >= T.kick) {
      this._punish(mon, 'kick', `违规分 ${Math.round(mon.score)} 达踢出阈值`);
    } else if (mon.score >= T.warn) {
      const t = now();
      if (t - mon.lastWarnAt > this.opts.warnCooldownMs) {
        mon.lastWarnAt = t;
        this._action(mon, 'warn', '检测到异常操作');
      }
    }
  }
  _punish(mon, kind, reason) {
    mon.kicked = true;
    if (kind === 'ban') {
      this.registerBan(mon.idents(), this.opts.banMinutes, reason);
      this._action(mon, 'ban', reason);
    } else {
      this.totalKicks++;
      let escalated = false;
      if (this.opts.store) {
        for (const id of mon.idents()) {
          if (this.opts.store.addKick(id, this.opts.kickWindowMs) >= this.opts.kicksToBan) escalated = true;
        }
      }
      if (escalated) {
        const escMin = this._escalatedMinutes(mon.idents(), this.opts.banMinutes);
        const escLabel = escMin === 0 ? '永封' : (escMin + '分钟');
        this.registerBan(mon.idents(), this.opts.banMinutes, `24h 内被踢出 ${this.opts.kicksToBan} 次`);
        this._action(mon, 'ban', `多次被踢，封禁 ${escLabel}`);
      } else {
        this._action(mon, 'kick', reason);
      }
    }
  }

  _action(mon, action, reason) {
    if (typeof this.opts.onAction === 'function') {
      try { this.opts.onAction(mon.key, action, reason, mon); } catch (_) { /* 动作回调不允许炸引擎 */ }
    }
  }
  _log(entry) {
    this.totalFlags++;
    entry.t = entry.t || now();
    this.recentLog.push(entry);
    if (this.recentLog.length > this.opts.logSize) this.recentLog.shift();
    if (typeof this.opts.log === 'function') {
      try { this.opts.log(entry); } catch (_) { /* 日志回调不允许炸引擎 */ }
    }
  }
}

module.exports = { AntiCheat, Monitor, TokenBucket, DEFAULTS };