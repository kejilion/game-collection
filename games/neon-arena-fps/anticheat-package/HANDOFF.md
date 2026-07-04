# 反作弊模块 · AI 接入交接包

> **这份文档是写给 AI 看的操作手册**，不是给人看的产品介绍（那份在 `anticheat/README.md`，接入完成后可以留给人类开发者参考）。
> 如果你是被要求"接入这个反作弊模块"的 AI：请按下面的步骤顺序执行，每步做完自查一次，最后跑第 7 步的自测清单再向用户汇报。

## 0. 这是什么，为什么能直接用

一个零依赖的 Node.js 反作弊引擎，`anticheat/` 目录四个文件，`require('./anticheat')` 即可，不需要 `npm install` 任何包，不 import 宿主项目的任何其他文件。它已经在一个 3D FPS 多人游戏里实装并跑过完整的自动化测试（诚实玩家零误伤、瞬移/超速/飞天/连点宏/协议篡改全部被拦截、24h 内多次被踢自动升级封禁）。

它的设计前提：**引擎只做通用的"计分 → 衰减 → 阶梯处置"流程，所有游戏特定的东西（最大速度、地面高度、冷却时间、消息格式）由你在接入时通过参数/回调传入**。所以你不需要改 `anticheat/` 里的任何一行代码，只需要在宿主项目里"接线"。

```
anticheat/
├── core.js    引擎本体（AntiCheat 类 + Monitor 类）
├── store.js   封禁记录持久化（JSON 文件版 + 内存版）
├── index.js   入口，导出 AntiCheat/fpsPreset/turnBasedPreset/RATE_PRESETS
└── README.md  完整 API 参考 + 设计理念 + 调参 checklist（深入细节看这个）
```

## 1. 第一步：先侦察宿主项目，不要瞎接

在写任何代码之前，找到并记录以下信息（没有就问用户，不要猜）：

1. **网络层是什么**：原生 `ws`？`socket.io`？自定义 TCP？—— 反作弊引擎不关心网络库，但你接线的位置在这几种里长得不一样。
2. **玩家/会话对象长什么样**：每个连接有没有一个稳定的 `player` 或 `session` 对象？有没有唯一 id？有没有能拿到 IP 的地方（`req.socket.remoteAddress` 或 `x-forwarded-for`）？
3. **消息分发的入口在哪**：通常是 `ws.on('message', ...)` 里的一个 `switch(msg.type)` 或类似结构。
4. **游戏是否有"位置同步"这个概念**：如果是回合制/卡牌/棋类，大概率没有，直接跳过第 4 步的 movement 部分，改用 `turnBasedPreset`。
5. **游戏循环 tick 在哪**：找到 `setInterval` 驱动的主循环，等下要在这里加一行 `ac.tick(1)`。
6. **持久化目录**：项目有没有现成的 `data/` 目录用来存档？封禁记录建议存在同一个地方。

## 2. 第二步：复制文件

```bash
cp -r anticheat-package/anticheat  <宿主项目>/server/anticheat
```

（如果宿主项目结构不是 `server/`，就放到网络层代码所在的目录旁边，保证 `require('./anticheat')` 的相对路径能打通即可。）

## 3. 第三步：判断游戏体裁，选预设

| 游戏类型 | 用哪个预设 | 要不要 movement 校验 | 要不要 aimShot |
|---|---|---|---|
| FPS / 动作 / 需要同步位置的任何实时对战 | `fpsPreset()` | 要 | 要（如果有瞄准/命中概念） |
| 回合制卡牌 / 棋牌 / 慢节奏策略 | `turnBasedPreset()` | 不要，跳过 | 不要 |
| MOBA / RPG（有位置同步但节奏没 FPS 快） | `fpsPreset()` 但放宽 `movement.speedSlack` 和限速值 | 要 | 视情况 |
| 赛车 / 载具 | `fpsPreset()`，`movement.maxSpeed` 换成载具速度公式，去掉 `aimShot` | 要 | 不要 |

## 4. 第四步：装配引擎（约 40 行，抄这段改名字就行）

```js
const path = require('path');
const { AntiCheat, fpsPreset, createJsonStore, TokenBucket, RATE_PRESETS } = require('./anticheat');

const acStore = createJsonStore(path.join(__dirname, '..', 'data', 'anticheat.json'));
const ac = new AntiCheat(fpsPreset({
  enabled: process.env.AC_MODE !== 'off',   // 留这个开关，方便后续调试/压测时关闭
  store: acStore,
  onAction(playerKey, action, reason) {
    // action: 'warn' | 'kick' | 'ban'
    const ws = sockets.get(playerKey);       // 换成宿主项目自己维护的 id -> ws/session 映射
    if (action === 'warn') { sendTo(ws, { type: 'acwarn', text: reason }); return; }
    sendTo(ws, { type: 'kicked', text: action === 'ban' ? `你已被临时封禁：${reason}` : `你已被移出对局：${reason}` });
    setTimeout(() => { try { ws.close(4001, 'anticheat'); } catch (_) {} }, 60);
  },
  log: e => console.warn(`[anticheat] ${e.name || e.key} ${e.rule} ${e.detail} score=${e.score}`),
}));
setInterval(() => ac.tick(1), 1000);         // 违规分每秒衰减，加进现有的心跳/定时器都行
```

**自查**：这一步做完，`node -e "require('./server/anticheat')"` 应该不报错。如果报错，八成是路径不对，不是库本身的问题。

## 5. 第五步：在玩家生命周期与消息处理里插桩

### 5.1 加入 / 离开

```js
// 加入前：封禁门
const ban = ac.isBanned(['ip:' + ip, 'name:' + name]);
if (ban) { /* 拒绝加入，提示剩余时间 Math.ceil((ban.until - Date.now())/60000) 分钟 */ return; }

// 加入成功后
player.mon = ac.attach(player.id, { ip, name });
player.mon.resetPos(player.pos);   // 有初始位置的游戏才需要

// 断开 / 主动离开
ac.detach(player.id);
```

### 5.2 每条消息先过限速（在 switch 分发之前插一行）

```js
if (!player.mon.rate(msg.type, ...(RATE_PRESETS[msg.type] || RATE_PRESETS.default))) return; // false = 丢弃
```

### 5.3 位置同步消息（如果游戏有这个概念）

```js
function handleMove(player, msg) {
  const nx = +msg.p[0], ny = +msg.p[1], nz = +msg.p[2];
  if (!isFinite(nx) || !isFinite(ny) || !isFinite(nz)) return player.mon.flag('badvec', 4, '非法坐标');
  const res = player.mon.movement({ x: nx, y: ny, z: nz }, {
    maxSpeed: computeMaxSpeed(player),      // 【要你写】游戏自己的速度公式，含所有增益的最大值
    floorY: computeFloorHeight(cand),        // 【要你写】查询该位置的地面/平台高度
    // inSolid: (pos) => ...,               // 可选：查询该位置是否卡入实体几何
  });
  player.pos = res.pos;   // 违规时已经是回拉后的合法坐标，直接用，不用自己判断
}
```

### 5.4 有冷却的动作（攻击/技能/任何"多久能做一次"的操作）

```js
if (!player.mon.cooldown('fire_' + weaponId, cdMs * 0.8)) return;  // *0.8 = 容忍网络抖动，抄这个系数
```

### 5.5 传入的方向/坐标向量清洗

```js
const dir = player.mon.vec3(msg.d, { unit: true });  // 非法/未归一化返回 null
if (!dir) return;
```

### 5.6 命中/瞄准统计（只有"开火判定命中"这种场景才需要）

```js
player.mon.aimShot({ dir, view: currentViewVector(player), hit: !!target, headshot: !!isHeadshot });
```

### 5.7 每一处"合法传送"之后（出生、复活、传送门、闪现技能、上下载具）

```js
player.mon.resetPos(player.pos);
```

**这一条最容易漏，漏了会把正常复活/传送误判成瞬移。把项目里所有改变位置但不经过 `handleMove` 的地方都过一遍，逐个加上。**

### 5.8 自定义违规（这个游戏特有的作弊手段）

```js
if (player.coinsThisMinute > 2000) player.mon.flag('economy', 6, `金币增速异常 ${player.coinsThisMinute}/min`);
```

## 6. 第六步：暴露运维指标（可选但强烈建议）

在健康检查接口里加一行：

```js
app.get('/health', (req, res) => res.json({ ok: true, anticheat: ac.status() }));
```

## 7. 第七步：自测清单（做完必须跑，不要只凭"看起来对"就交付）

写一个简单脚本（可以参考本包 `example-wiring.js` 末尾注释里的测试思路），用两个 WebSocket 客户端模拟：

- [ ] **诚实玩家**：以该游戏正常的消息频率移动/操作 10~20 次，服务端日志里 `mon.flag` 一次都不应该触发。这是最重要的一条，宁可漏抓也不能错杀。
- [ ] **瞬移**：发一个远超单帧合法位移的坐标，确认玩家最终位置被回拉、且其他玩家看到的是回拉后的合法位置。
- [ ] **协议篡改**：坐标/方向传字符串或超界数值，确认被拒绝且不崩服务器（注意：`JSON.stringify(NaN)` 会变成 `null`，测这个用字符串或超大数字，别用 `NaN` 字面量，传不过去）。
- [ ] **连点宏**：同一操作以远超正常频率发送，确认只有冷却允许的次数被放行。
- [ ] **累计违规到踢出**：连续触发违规直到达到 `kick` 阈值，确认收到 `kicked` 消息且连接被服务端关闭。
- [ ] **封禁生效**：模拟同一 IP/昵称达到 `kicksToBan` 次后自动封禁，再次加入应被拒绝。
- [ ] **AC_MODE=off**：设置该环境变量后重跑前面的作弊用例，确认惩罚类校验直通（但 `cooldown`/`vec3` 等功能类校验应仍然生效，游戏基础规则不受影响）。

全部打勾之后再跟用户汇报"已接入"，并附上这份清单的跑测结果（哪几条过了，数字是多少），不要只说"应该没问题"。

## 8. 调参：把这几个数字问清楚或自己从代码里量出来

不问清楚直接抄默认值，大概率会误伤真玩家或者放过明显作弊：

1. **该游戏的理论最大移动速度**是多少（基础速度 × 所有增益叠乘的最大值，不是平均速度）。
2. **最大跳跃高度**（一般 = `跳跃初速²/(2×重力)`）+ **最高可站立的落差**，两者相加再加 1~2 米余量，就是 `movement.maxAboveFloor`。
3. **各类消息客户端正常发送频率**是多少 Hz，限速值至少设为它的 2 倍。
4. **各个冷却动作的真实冷却时间**，接入时传 `真实值 × 0.8`。
5. 这个游戏**有没有"合法但看起来像瞬移"的场景**（传送门、载具切换视角、复活点跳跃动画），确认这些地方都调用了 `resetPos`。

深入的 API 细节、每个字段的默认值、更多示例代码，看 `anticheat/README.md`。有疑问优先读那份文档，不要凭空猜测字段名或行为。
