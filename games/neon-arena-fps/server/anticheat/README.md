# 通用反作弊引擎（anticheat）

零依赖、可移植的多人在线对战反作弊模块。在「霓虹竞技场」中实装验证，可直接复制 `anticheat/` 目录到任何 Node.js 游戏服务器（ws / socket.io / uWS 均可，引擎不绑定网络库）。

```
anticheat/
├── core.js    引擎：违规计分/衰减、限速、冷却、移动校验、瞄准统计、阶梯处置
├── store.js   封禁持久化适配器（JSON 文件版 + 内存版，可自行实现 Redis 版）
├── index.js   入口与体裁预设（fpsPreset / turnBasedPreset / RATE_PRESETS）
└── README.md  本文档
```

## 一、设计理念

1. **服务端权威**：浏览器/客户端代码可被任意篡改，一切校验只信服务器自己看到的状态；客户端消息一律视为"请求"而非"事实"。
2. **计分 + 衰减，而非一票否决**：网络抖动、丢包重发都会产生零星异常。每条规则违规只累计分数（可配权重），分数随时间衰减；只有持续作弊才会积分越阈。
3. **阶梯处置**：`纠正(回拉) → 警告 → 踢出 → 封禁`。位置违规当场回拉修正（其他玩家永远看到合法位置），积分越阈才升级处置；24h 内被踢 N 次自动升级临时封禁。
4. **引擎与游戏解耦**：引擎只实现通用数学与流程；地面高度、实体碰撞、最大速度公式等游戏差异，通过**每次调用时传入的回调/参数**注入。换游戏不改引擎。

### 校验分两类

| 类别 | 方法 | `enabled=false` 时 |
| --- | --- | --- |
| 功能校验（游戏正确性） | `cooldown` `vec3` `num` | **仍然生效**（只是不计分） |
| 惩罚校验（反作弊） | `movement` `rate` `aimShot` `flag` | 直通不处置 |

这样 `AC_MODE=off` 用于开发调试/压测时，游戏基础规则（射速、数值合法性）依然成立。

## 二、能防住什么

| 作弊手段 | 检测方式 | 处置 |
| --- | --- | --- |
| 瞬移 | 单包位移 > `teleportDist` | 立即回拉 + 计分（权重 8） |
| 加速外挂 | 超速漏桶（容忍抖动，溢出才判） | 回拉 + 计分 |
| 飞天/悬浮 | 位置持续高于支撑面 `maxAboveFloor` | 回拉 + 计分 |
| 穿墙/卡体 | 连续 N 包处于实体几何内 | 回拉 + 计分 |
| 连点宏/射速外挂 | 冷却校验 + 严重提前统计 | 拒绝执行 + 计分 |
| 消息洪泛 | 分类型令牌桶限速 | 丢弃消息 + 计分 |
| 协议篡改（NaN/超长/未归一化向量） | 数值清洗 | 拒绝 + 计分（权重 4） |
| 自瞄/静默瞄准 | 统计窗口：爆头率、命中率、开火方向与视线夹角(snap) | 缓慢计分（只对离谱者生效） |
| 封禁绕过 | IP + 昵称双标识封禁，持久化落盘 | 加入时拦截 |

**边界诚实说明**：透视（ESP）类作弊在"全量状态广播"架构下无法从服务端根除，缓解手段是兴趣管理（只下发视野内实体）；自瞄检测是统计学手段，阈值故意保守，抓的是"离谱的"而非"疑似的"。

## 三、快速接入（任意 ws 游戏，约 40 行）

```js
const { AntiCheat, fpsPreset, createJsonStore, RATE_PRESETS } = require('./anticheat');

const ac = new AntiCheat(fpsPreset({
  enabled: process.env.AC_MODE !== 'off',
  store: createJsonStore('./data/anticheat.json'),
  onAction(playerId, action, reason) {          // 阶梯处置回调
    const ws = sockets.get(playerId);
    if (action === 'warn') send(ws, { type: 'acwarn', text: '检测到异常操作' });
    if (action === 'kick' || action === 'ban') {
      send(ws, { type: 'kicked', text: reason });
      ws.close(4001, 'anticheat');
    }
  },
  log: e => console.warn('[AC]', e.name, e.rule, e.detail, `score=${e.score}`),
}));
setInterval(() => ac.tick(1), 1000);            // 违规分每秒衰减

wss.on('connection', (ws, req) => {
  ws.ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
       || req.socket.remoteAddress;

  ws.on('message', raw => {
    const m = JSON.parse(raw);
    // ① 加入前：封禁门
    if (m.type === 'join') {
      const ban = ac.isBanned([`ip:${ws.ip}`, `name:${m.name}`]);
      if (ban) return send(ws, { type: 'err', text: `封禁中，剩余 ${Math.ceil((ban.until - Date.now()) / 60000)} 分钟` });
      const player = world.addPlayer(m.name);
      player.mon = ac.attach(player.id, { ip: ws.ip, name: player.name });
      player.mon.resetPos(player.pos);          // 出生点作为移动基线
      return;
    }
    const mon = player && player.mon;
    if (!mon) return;
    // ② 分类型限速（false = 丢弃）
    if (!mon.rate(m.type, ...(RATE_PRESETS[m.type] || RATE_PRESETS.default))) return;
    // ③ 业务处理内按需调用 movement / cooldown / vec3 / aimShot（见下）
    world.handle(player, m);
  });

  ws.on('close', () => player && ac.detach(player.id));
});
```

### 移动校验（客户端权威移动的收口）

```js
handleMove(p, m) {
  const nx = +m.p[0], ny = +m.p[1], nz = +m.p[2];
  if (!isFinite(nx + ny + nz)) return p.mon.flag('badvec', 4, '非法坐标');
  const cand = clampToArena({ x: nx, y: ny, z: nz });
  const res = p.mon.movement(cand, {
    maxSpeed: this.maxSpeedOf(p),      // 游戏自己的速度公式（含 buff）
    floorY: this.floorAt(cand),        // 游戏自己的支撑面查询
    maxAboveFloor: 7,                  // 跳跃高度 + 最高平台 + 余量
    inSolid: q => this.inSolid(q),     // 游戏自己的实体几何查询（可省略）
  });
  p.pos = res.pos;                     // 违规时 res.pos 已回拉到最后合法位置
}
// 合法传送（出生/复活/闪现技能）后必须重置基线，否则会误判瞬移：
respawn(p) { ...; p.mon.resetPos(p.pos); }
```

### 冷却与数值收口

```js
handleFire(p, m) {
  if (!p.mon.cooldown('fire_' + p.gun, weapon.cd * 1000 * 0.8)) return; // 0.8 = 网络抖动容忍
  const d = p.mon.vec3(m.d, { unit: true });   // 方向必须是单位向量
  if (!d) return;
  const result = raycast(...);
  p.mon.aimShot({ dir: d, view: viewVectorOf(p), hit: result.hit, headshot: result.hs });
}
```

## 四、API 参考

### `new AntiCheat(opts)`

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭时惩罚类直通、功能类保留 |
| `thresholds` | `{warn:20, kick:45, ban:90}` | 违规分阈值 |
| `decayPerSec` | `0.8` | 每秒衰减分 |
| `weights` | 见 core.js | 各规则计分权重 |
| `movement` | 见 core.js | 移动校验参数（瞬移距离、漏桶容量等） |
| `aim` | 见 core.js | 瞄准统计阈值 |
| `banMinutes` / `kicksToBan` | `10` / `3` | 封禁时长；24h 被踢 N 次自动封禁 |
| `store` | `null` | 持久化适配器（不传则封禁功能停用） |
| `onAction(key, action, reason, mon)` | — | `warn`/`kick`/`ban` 处置回调（网络断连由接入方执行） |
| `log(entry)` | — | 每条违规明细回调 |

方法：`attach(key, {ip, name}) → Monitor`、`detach(key)`、`isBanned(idents[])`、`registerBan(idents[], minutes, reason)`（手动封禁/管理后台可用）、`tick(dtSec)`、`status()`。

### `Monitor`（每玩家一个）

| 方法 | 类别 | 说明 |
| --- | --- | --- |
| `rate(tag, perSec, burst) → bool` | 惩罚 | 令牌桶限速，false=丢弃该消息 |
| `cooldown(tag, cdMs) → bool` | 功能 | true=允许执行并记时；内置连点宏统计 |
| `vec3(arr, {unit}) → [x,y,z]\|null` | 功能 | NaN/Inf/未归一化 → null 并计分 |
| `num(v, min, max) → number\|null` | 功能 | 数值清洗 |
| `movement(pos, ctx) → {ok, pos, reason}` | 惩罚 | 瞬移/超速/飞天/穿墙，违规回拉 |
| `resetPos(pos)` | — | 合法传送后重置基线（**必须调用**） |
| `aimShot({dir, view, hit, headshot})` | 惩罚 | 喂入每次开火，窗口满自动评估 |
| `flag(rule, weight?, detail?)` | 惩罚 | 手动上报自定义违规 |

属性：`score`（当前违规分）、`violations`（最近明细）、`stats`（corrections/teleports/dropped）。

## 五、调参指南（新游戏接入 checklist）

1. **算出你的理论极限速度**：基础速度 × 所有增益叠乘的最大值。`movement.speedSlack`(1.25) 已含容忍，不要拿平均速度当上限。
2. **`maxAboveFloor` = 最大跳跃高度 + 最高可站立差 + 1~2m 余量**。跳跃高度 = `jumpVel² / (2·gravity)`。
3. **每一处合法传送都要 `resetPos`**：出生、复活、传送门、位移技能、载具上下——漏一处就是误杀。
4. **冷却传"已含容忍的值"**：推荐 `实际冷却 × 0.8`，容忍客户端预测与网络抖动。
5. **限速值 ≥ 客户端正常频率 × 2**：如客户端 15Hz 发位置，限 40/s。
6. **瞄准统计只抓离谱者**：先用默认阈值跑一周，看 `log` 输出的分布再收紧；永远不要单靠 aim 规则直接封禁（权重设计上单次不越 kick 阈）。
7. **上线前先 `enabled:false` 灰度**：功能校验照跑，观察 `status()` 与日志里"如果开启会罚谁"，确认无误杀再打开。
8. **回拉要广播**：违规后服务器持有的合法位置要照常进快照广播，其他玩家看到的永远是合法位置——这是"纠正优先于惩罚"的关键。

## 六、扩展自定义规则

任何游戏私有规则用 `flag` 上报即可复用计分/处置链路：

```js
// 例：经济系统防刷 —— 单局金币增速异常
if (p.coinsGainedThisMinute > 2000) p.mon.flag('economy', 6, `金币增速 ${p.coinsGainedThisMinute}/min`);
// 例：回合制游戏 —— 非本回合出牌
if (game.turn !== p.id) return p.mon.flag('protocol', 3, '非本回合操作');
```

权重建议：确定性篡改（协议/数值）4~8 分；统计性怀疑 ≤ 权重和不足以单独触发 kick；体验型骚扰（刷屏）0.5~2 分。

## 七、在霓虹竞技场中的实装位置

| 文件 | 接入点 |
| --- | --- |
| `server/index.js` | 引擎实例化、封禁门、分类型限速、处置回调、`/health` 指标、`AC_MODE` 开关 |
| `server/world.js` | `handleMove` 移动校验（`floorAtSrv`/`inSolidSrv`/`maxSpeedOf`）、fire/melee/nade 冷却收口与方向清洗、`aimShot` 喂入、出生/复活 `resetPos` |
| `public/js/game.js` | `kicked`（断线原因展示）与 `acwarn`（警告提示）消息处理 |

运行时观测：`GET /health` 返回 `anticheat: { players, flags, kicks, bans, recent }`；封禁数据在 `data/anticheat.json`，删除对应键即可手动解封。
