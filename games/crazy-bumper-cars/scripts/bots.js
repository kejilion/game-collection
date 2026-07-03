'use strict';
// 机器人陪玩：连接若干个会追人、会撞人、偶尔说话的机器人。
// 用法：node scripts/bots.js [数量=4] [ws地址=ws://localhost:3000]
const WebSocket = require('ws');

const COUNT = parseInt(process.argv[2], 10) || 4;
const URL = process.argv[3] || 'ws://localhost:3000';
const NAMES = ['铁头阿强', '风火轮', '碰碰怪', '油门焊死', '漂移大爷', '小钢炮', '追风少年', '横冲直撞'];
const TAUNTS = ['来追我呀~', '看我的铁头功!', '哎哟谁撞我!', '这把稳了', '氮气走起!', '别跑!'];

function bot(name, color) {
  const ws = new WebSocket(URL);
  let myId = 0;
  let target = null;
  let me = null;

  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name, color })));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'welcome') myId = msg.id;
    if (msg.type !== 'state' || !myId) return;

    me = msg.players.find(p => p.id === myId);
    if (!me || me.dd) return;

    // 找最近的活人当目标
    let best = null, bestD = Infinity;
    for (const p of msg.players) {
      if (p.id === myId || p.dd) continue;
      const d = Math.hypot(p.x - me.x, p.y - me.y);
      if (d < bestD) { bestD = d; best = p; }
    }
    target = best;

    const input = { type: 'input', up: false, down: false, left: false, right: false, boost: false };
    if (target) {
      const dx = target.x - me.x, dy = target.y - me.y;
      input.right = dx > 30;
      input.left = dx < -30;
      input.down = dy > 30;
      input.up = dy < -30;
      input.boost = bestD < 500 && me.nt > 40; // 贴近就冲刺撞击
    } else {
      input.up = Math.random() < 0.5;
      input.right = Math.random() < 0.5;
    }
    ws.send(JSON.stringify(input));
  });

  setInterval(() => {
    if (ws.readyState === 1 && Math.random() < 0.12) {
      ws.send(JSON.stringify({ type: 'chat', text: TAUNTS[Math.floor(Math.random() * TAUNTS.length)] }));
    }
    if (ws.readyState === 1 && Math.random() < 0.15) {
      ws.send(JSON.stringify({ type: 'horn' }));
    }
  }, 4000);

  ws.on('close', () => setTimeout(() => bot(name, color), 2000));
  ws.on('error', () => {});
}

for (let i = 0; i < Math.min(COUNT, NAMES.length); i++) {
  setTimeout(() => bot(NAMES[i], i % 8), i * 400);
}
console.log(`已放出 ${Math.min(COUNT, NAMES.length)} 个机器人 -> ${URL}（Ctrl+C 停止）`);
