# 通用反作弊引擎

零依赖、可移植的 Node.js 多人对战反作弊模块。核心原则是服务端权威、先拒绝非法收益、再依据多维证据处罚。

## 架构

| 通道 | 规则 | 默认衰减 | 作用 |
| --- | --- | --- | --- |
| `movement` | `teleport` `speed` `fly` `clip` | 1 分/秒 | 位置即时回拉；可警告/踢出，不能单独直接封禁 |
| `combat` | `cooldown` `aim` `hipsniper` `spk` `killpace` `streak` `preaim` `dominance` | 0.25 分/秒 | 检测射速、枪法、隔墙预瞄和击杀节奏 |
| `integrity` | `badvec` `range` `sustainedspeed` 及未知自定义规则 | 0.25 分/秒 | 检测非法数值、越权请求和低延迟持续超速 |

默认引擎阈值为 `20/45/90`，`fpsPreset()` 使用 `15/35/70`。只有临时战斗或完整性证据存在时才允许直接封禁；混合判定中移动分最多贡献 15 分。连杀辅助分不衰减，由游戏在死亡时清零；30 连杀在至少两人在线时达到现有踢出阈值，用于阻断低人数刷榜。

消息洪泛使用令牌桶直接丢弃，只记 `observe` 审计事件，不累计处罚分。这样防护仍生效，但不会因为客户端重发或网络拥塞叠分。

## 能力边界

| 行为 | 服务端处理 |
| --- | --- |
| 瞬移、加速、飞天、穿墙 | 拒绝位置并回拉；服务端协议心跳确认高延迟时暂停移动计分 |
| 持续低频加速 | 仅统计可信服务端 RTT；5 分钟内 12 次观察、20 次警告、36 次踢出，重复 3 个会话进入既有临时封禁 |
| 射速/连点宏 | 冷却内请求直接拒绝，严重连续提前才计分 |
| 非法向量、远距拾取 | 请求拒绝并按冷却计完整性分 |
| 自瞄/静默瞄准 | PvP 命中率、爆头率、视角夹角滚动统计 |
| 未开镜狙击 | 结合命中率、距离、目标数、移动/爆头特征分档计分 |
| 每杀耗弹异常 | 足够手枪/机枪击杀样本后计分；狙击枪正常单发击杀不进入该统计 |
| 慢速自瞄/透视 | 榜首玩家隔墙持续贴准后快速命中多个不同目标，再与长期统治力交叉验证 |
| 消息洪泛 | 超出令牌桶的消息直接丢弃并记录观察事件 |
| 封禁绕过 | IP + 昵称双标识持久化拦截 |

K/D 不作为处罚规则：它高度依赖玩家水平、对局人数和弱势目标，与击杀节奏、命中率、每杀耗弹重复，容易放大误伤。

## 快速接入

```js
const { AntiCheat, fpsPreset, createJsonStore, RATE_PRESETS } = require('./anticheat');

const ac = new AntiCheat(fpsPreset({
  store: createJsonStore('./data/anticheat.json'),
  onAction(playerId, action, reason, monitor) {
    if (action === 'warn') return send(playerId, { type: 'acwarn', text: reason });
    send(playerId, { type: 'kicked', text: reason });
    closePlayer(playerId);
  },
  log(entry) {
    console.warn('[AC]', entry.name, entry.rule, entry.channel, entry.score, entry.detail);
  },
}));

setInterval(() => ac.tick(1), 1000);

function onJoin(player) {
  const ban = ac.isBanned([`ip:${player.ip}`, `name:${player.name}`]);
  if (ban) return false;
  player.mon = ac.attach(player.id, { ip: player.ip, name: player.name });
  player.mon.resetPos(player.pos);
  return true;
}

function onMessage(player, message) {
  const limits = RATE_PRESETS[message.type] || RATE_PRESETS.default;
  if (!player.mon.rate(message.type, ...limits)) return;
  // 再进入游戏逻辑
}
```

## API

### `AntiCheat`

- `attach(key, { ip, name })`：创建玩家监控器。
- `detach(key)`：移除在线监控器。
- `tick(dtSec)`：按通道衰减临时分。
- `isBanned(idents)`：检查 IP/昵称封禁。
- `registerBan(idents, minutes, reason)`：手动登记封禁。
- `status()`：返回会话规则计数、处置计数、在线通道最高分及持久审计汇总。

### `Monitor`

- `rate(tag, perSec, burst)`：令牌桶限速，`false` 表示丢弃。
- `cooldown(tag, cdMs)`：服务端冷却裁决，冷却内返回 `false`。
- `num()` / `vec3()`：数值和向量清洗。
- `movement(pos, ctx)`：移动裁决，异常返回服务端安全位置。
- `resetPos(pos)`：出生、复活和合法传送后重置移动基线。
- `aimShot()` / `hipSniperShot()`：喂入服务端确认的 PvP 射击结果。
- `recordShot()` / `recordKill(weapon)`：喂入每杀耗弹样本。
- `flag(rule, weight?, detail?)`：上报计分证据；未知规则默认归入 `integrity`。
- `observe(rule, detail?)`：只审计，不计分。
- `setPersistentScore(rule, value, detail?)`：设置由游戏事件清零的辅助分。

`score` 是兼容旧接线的总分；`scoreSnapshot()` 返回三个通道的当前分数。

## 持久化审计

JSON store 保留封禁、踢出记录，以及最近 500 条结构化反作弊事件：

- `events`：`flag`、`observe`、`action` 事件。
- `eventStats.flags`：累计规则计分次数。
- `eventStats.observations`：累计只观察次数。
- `eventStats.actions`：累计警告、踢出、封禁次数。

健康接口不返回玩家昵称，只返回规则与处置汇总；详细复盘直接读取受保护的数据文件。

项目接入 `createAuditLog()` 后，还会按天写入 `data/anticheat-audit-YYYY-MM-DD.jsonl`：

- 反作弊计分、观察、警告、踢出、封禁事件完整保留 30 天。
- 玩家会话每 5 分钟及离线时汇总 KPM、K/D、命中率、爆头率、每杀耗弹、武器分布、RTT 和规则命中次数。
- IP 不落明文，只保存由本机随机盐生成的稳定匿名哈希；部署版本与规则版本随每条记录写入。
- 写入采用 1 秒内存缓冲，避免每次射击同步写盘；队列、错误和丢弃数可在 `/health.audit` 查看。

生成最近 7 天报告：

```bash
node server/tools/anticheat-report.js --days 7 --data-dir ./data
```

加 `--json` 可输出机器可读结果。报告会按会话去重，只使用每个会话最新的一条累计汇总，避免周期记录重复统计。

## 调参原则

1. 每处合法传送都必须调用 `resetPos()`。
2. 移动规则优先回拉，不依赖提高分数解决作弊收益。
3. 统计规则至少需要足够样本、稳定目标身份和计分冷却；同一网络身份换名或重连仍按同一受害者统计。
4. PvP 命中率不能混入 BOSS、怪物、箱子或场景物件。
5. 单一弱证据不应越过踢出线；确定性强证据才允许高权重。
6. 上线前先用历史样本回放，再观察 `eventStats` 调参。
7. `preaim` 和 `dominance` 必须作为组合证据：高延迟、位置回拉、出生保护、近距离和已交火目标不进入预瞄样本，高战绩本身只观察不计分；统治力只有关联枪法证据，或同时关联服务端冷却滥用与低延迟移动异常时才计分。
8. `sustainedspeed` 只聚合已通过合法 Buff/装备速度计算后仍溢出的 `speed` 事件，并要求至少 3 个服务端 RTT 样本且平滑 RTT 不高于 150ms；窗口仅保存在当前会话内。

本项目的历史样本统计、规则取舍与固定回归项见 `server/anticheat/REVIEW.md`。

## 项目接线

- `server/index.js`：引擎实例化、限速、封禁门、处置回调和 `/health`。
- `server/world.js`：移动、冷却、PvP 命中、击杀节奏与每杀耗弹。
- `server/anticheat/store.js`：封禁、踢出和结构化事件持久化。
