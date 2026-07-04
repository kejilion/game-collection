// ============================================================================
// 参考实现：摘自「霓虹竞技场」项目真实代码（server/index.js + server/world.js）
// 这是一个跑通过完整测试的真实接线示例，不是伪代码。
// 标了【游戏特定】的地方要换成你自己项目的逻辑，其余部分可以整段照抄。
// ============================================================================
'use strict';
const path = require('path');
const { WebSocketServer } = require('ws');   // 换成你项目实际用的网络库
const { AntiCheat, fpsPreset, createJsonStore, TokenBucket, RATE_PRESETS } = require('./anticheat');

// ---------------------------------------------------------------------------
// 1) 装配引擎（照抄）
// ---------------------------------------------------------------------------
const acStore = createJsonStore(path.join(__dirname, 'data', 'anticheat.json'));
const sockets = new Map();   // playerId -> ws，【游戏特定】换成你项目已有的映射

const ac = new AntiCheat(fpsPreset({
  enabled: process.env.AC_MODE !== 'off',
  store: acStore,
  onAction(playerKey, action, reason) {
    const ws = sockets.get(playerKey);
    if (action === 'warn') { rawSend(ws, { type: 'acwarn', text: reason }); return; }
    if (ws) {
      rawSend(ws, { type: 'kicked', text: action === 'ban' ? `你已被临时封禁：${reason}` : `你已被移出对局：${reason}` });
      setTimeout(() => { try { ws.close(4001, 'anticheat'); } catch (_) { /* 忽略 */ } }, 60);
    }
  },
  log: e => console.warn(`[anticheat] ${e.name || e.key} ${e.rule} ${e.detail} score=${e.score}`),
}));
setInterval(() => ac.tick(1), 1000);

function rawSend(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

// ---------------------------------------------------------------------------
// 2) 连接与加入 / 离开（照抄结构，players/world 换成你自己的）
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ port: 3000 });
const players = new Map();   // 【游戏特定】你项目自己的玩家表

wss.on('connection', (ws, req) => {
  ws.ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  ws.preBucket = new TokenBucket(6, 12);   // 加入前（未 attach）的连接级限速，防止 join 洪泛

  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data); } catch (_) { return; }
    if (!msg || typeof msg.type !== 'string') return;
    const player = ws.playerId ? players.get(ws.playerId) : null;

    // 分类型限速：已加入的玩家走各自的 mon，未加入的连接走前置小桶
    if (player && player.mon) {
      if (!player.mon.rate(msg.type, ...(RATE_PRESETS[msg.type] || RATE_PRESETS.default))) return;
    } else if (msg.type !== 'ping' && !ws.preBucket.take()) return;

    if (msg.type === 'join') {
      // 封禁门：IP + 昵称任一命中即拒绝
      const cleanName = String(msg.name || '').replace(/[<>&"']/g, '').trim().slice(0, 20);
      const ban = ac.isBanned(['ip:' + ws.ip, 'name:' + cleanName]);
      if (ban) {
        const mins = Math.max(1, Math.ceil((ban.until - Date.now()) / 60000));
        rawSend(ws, { type: 'err', text: `你已被临时封禁（${ban.reason}），剩余约 ${mins} 分钟` });
        return;
      }
      const player = createPlayer(cleanName);           // 【游戏特定】你项目自己的建号逻辑
      player.mon = ac.attach(player.id, { ip: ws.ip, name: cleanName });
      player.mon.resetPos(player.pos);                  // 出生点作为移动基线
      players.set(player.id, player);
      ws.playerId = player.id;
      sockets.set(player.id, ws);
      rawSend(ws, { type: 'joined', id: player.id });
      return;
    }

    if (!player) return;
    switch (msg.type) {
      case 'move': handleMove(player, msg); break;
      case 'fire': handleFire(player, msg); break;
      // ...你项目其余的消息类型
    }
  });

  ws.on('close', () => {
    if (ws.playerId) { ac.detach(ws.playerId); players.delete(ws.playerId); sockets.delete(ws.playerId); }
  });
});

// ---------------------------------------------------------------------------
// 3) 移动校验（结构照抄，maxSpeedOf/floorAt 换成你游戏自己的公式）
// ---------------------------------------------------------------------------
function handleMove(player, msg) {
  const nx = +msg.p[0], ny = +msg.p[1], nz = +msg.p[2];
  if (!isFinite(nx) || !isFinite(ny) || !isFinite(nz)) { player.mon.flag('badvec', 4, 'move 非法坐标'); return; }

  const cand = { x: nx, y: ny, z: nz };
  const res = player.mon.movement(cand, {
    maxSpeed: maxSpeedOf(player),        // 【游戏特定】见下方示例
    floorY: floorHeightAt(cand),         // 【游戏特定】见下方示例
    // inSolid: q => isInsideAnyWall(q), // 可选：需要检测穿墙时提供
  });
  player.pos = res.pos;   // 违规时已回拉到最后合法位置；广播给其他玩家的永远是这个 pos
}

// 【游戏特定示例】霓虹竞技场里的真实实现，供你参考公式怎么写：
// maxSpeedOf(p) 需要覆盖"所有增益叠乘后的最大速度"，不是基础速度
function maxSpeedOf(player) {
  const BASE_SPEED = 6.2;
  return BASE_SPEED
    * (1 + 0.1 * (player.boots || 0))         // 装备叠加
    * (player.hasBuff('speed') ? 1.6 : 1)     // 限时增益
    * (player.hasBuff('zombie') ? 1.35 : 1);  // 特殊状态
}
// floorHeightAt(pos) 需要覆盖地形/平台/坡道的支撑面查询——这是唯一需要
// 和你游戏地图数据打交道的部分，通常复用你已有的"站立面检测"逻辑即可
function floorHeightAt(pos) {
  return 0; // 【替换】查询该 (x,z) 位置下方最高支撑面的 y 值
}

// ---------------------------------------------------------------------------
// 4) 攻击/开火：冷却收口 + 方向清洗 + 命中统计（结构照抄）
// ---------------------------------------------------------------------------
function handleFire(player, msg) {
  const weapon = getWeaponOf(player);                     // 【游戏特定】
  if (!player.mon.cooldown('fire_' + weapon.id, weapon.cooldownMs * 0.8)) return;

  const dir = player.mon.vec3(msg.d, { unit: true });      // 非法/未归一化返回 null
  if (!dir) return;

  const result = performHitscan(player, dir);              // 【游戏特定】你的射线/命中判定
  player.mon.aimShot({
    dir, view: currentViewVectorOf(player),                // 【游戏特定】玩家当前视角方向
    hit: !!result.target, headshot: !!result.headshot,
  });
}

// ---------------------------------------------------------------------------
// 5) 运维指标（照抄）
// ---------------------------------------------------------------------------
// app.get('/health', (req, res) => res.json({ ok: true, anticheat: ac.status() }));

// ============================================================================
// 自测思路（对应 HANDOFF.md 第 7 步）：
// 用两个 ws 客户端连自己的服务器：
//  1. 诚实客户端按正常频率发 move/fire，跑完检查 ac.status().flags 应为 0（或该客户端
//     产生的那部分为 0——多客户端场景下按 name/id 过滤服务端日志确认）。
//  2. 作弊客户端发一个远距离坐标模拟瞬移，确认玩家最终位置未偏离、且收到的快照坐标合法。
//  3. 作弊客户端疯狂发 fire/move，确认只有冷却/限速允许的次数被处理。
//  4. 持续触发违规直到收到 {type:'kicked'}，确认连接随后被服务端关闭。
// ============================================================================
