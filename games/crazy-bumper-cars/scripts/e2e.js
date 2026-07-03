'use strict';
// 端到端冒烟测试：起 3 个 WebSocket 客户端，验证加入、快照、聊天、排行榜、喇叭。
// 用法：先启动服务器，再  node scripts/e2e.js  [ws地址，默认 ws://localhost:3000]
const WebSocket = require('ws');

const URL = process.argv[2] || 'ws://localhost:3000';
const NAMES = ['测试甲', '测试乙', '测试丙'];

let failed = false;
function check(cond, label) {
  console.log((cond ? '  ✔ ' : '  ✖ ') + label);
  if (!cond) failed = true;
}

function client(name, color) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const got = { welcome: null, states: 0, chats: [], boards: 0, players: 0, events: [] };
    const timer = setTimeout(() => { ws.close(); resolve({ name, got }); }, 6000);

    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', name, color })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'welcome') {
        got.welcome = msg;
        // 开车 + 聊天 + 按喇叭
        ws.send(JSON.stringify({ type: 'input', up: true, left: color % 2 === 0, right: color % 2 === 1, down: false, boost: true }));
        ws.send(JSON.stringify({ type: 'chat', text: `${name} 来啦!` }));
        ws.send(JSON.stringify({ type: 'horn' }));
      } else if (msg.type === 'state') {
        got.states++;
        got.players = Math.max(got.players, msg.players.length);
        for (const e of msg.events) got.events.push(e.e);
      } else if (msg.type === 'chat') {
        got.chats.push(msg.from + ': ' + msg.text);
      } else if (msg.type === 'boards') {
        got.boards++;
        got.lastBoards = msg;
      }
    });
    ws.on('error', reject);
  });
}

(async () => {
  console.log('连接到', URL);
  const results = await Promise.all(NAMES.map((n, i) => client(n, i)));

  for (const { name, got } of results) {
    console.log(`\n[${name}]`);
    check(!!got.welcome, '收到 welcome（含地图数据）');
    check(got.welcome && got.welcome.world.w > 0 && got.welcome.world.bumpers.length > 0, '地图数据完整');
    check(got.states > 30, `持续收到快照 (${got.states} 帧)`);
    check(got.players >= 3, `快照里能看到所有玩家 (${got.players} 人)`);
    check(got.chats.length >= 2, `收到其他人的聊天 (${got.chats.length} 条)`);
    check(got.boards >= 2, `收到排行榜推送 (${got.boards} 次)`);
    check(got.lastBoards && got.lastBoards.live.length >= 3, '实时排行包含在线玩家');
    check(got.events.includes('horn'), '收到喇叭事件');
  }

  const anyMoved = results[0].got.states > 0;
  console.log('');
  check(anyMoved, '模拟循环在推进');
  console.log(failed ? '\n💥 冒烟测试失败' : '\n🎉 联机冒烟测试全部通过');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error('e2e 出错:', err.message); process.exit(1); });
