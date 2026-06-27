import { GameRoom } from '../server/game/GameRoom.js';
import { Leaderboard } from '../server/game/Leaderboard.js';
import { DEATH_DURATION, PLAYER_MAX_HP } from '../public/shared/constants.js';
import assert from 'node:assert/strict';

const emitted = [];
const mockIo = () => ({
  emit(ev, d){ emitted.push({ev,d}); },
  volatile: { emit(){} },
});

const room = new GameRoom(mockIo(), new Leaderboard({ persist: false }));
room.start();
try {
  const p = room.addPlayer('p1', 'tester', {});
  p.invuln = 0; // 清除出生无敌以便测试致伤
  p.y = 50; p.updateFloor();
  const dieX = p.x, dieY = p.y;
  let diedEvt = null;
  room.io.emit = (ev, d) => { if (ev==='playerDied') diedEvt = d; emitted.push({ev,d}); };

  room.damagePlayer(p, 99999, { cause: 'fall' });

  assert.ok(p.deadTimer > 0, 'deadTimer set: '+p.deadTimer);
  assert.equal(p.alive, true);
  assert.equal(Math.round(p.x), Math.round(dieX), 'stays at death x');
  assert.equal(Math.round(p.y), Math.round(dieY), 'stays at death y');
  assert.ok(diedEvt && diedEvt.id==='p1' && diedEvt.cause==='fall', 'playerDied emitted');
  assert.equal(p.deaths, 1);

  const hpBefore = p.hp;
  room.damagePlayer(p, 50, { cause: 'pvp' });
  assert.equal(p.hp, hpBefore, 'no further damage while dead');

  const ser = p.serialize();
  assert.ok(ser.dead > 0, 'serialize dead>0: '+ser.dead);

  const ticks = Math.ceil(DEATH_DURATION * 60) + 5;
  for (let i = 0; i < ticks; i++) room.tick();

  assert.equal(p.deadTimer, 0, 'deadTimer reached 0');
  assert.ok(p.hp >= PLAYER_MAX_HP, 'respawned full hp: '+p.hp);
  assert.ok(p.y > dieY, 'respawned back to ground floor (larger y)');
  assert.equal(p.serialize().dead, 0, 'serialize dead=0 after respawn');
  console.log('PASS death-flow: respawn hp=%s', p.hp);
} finally {
  room.stop();
}

