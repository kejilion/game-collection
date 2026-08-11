'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocket-regression-'));
process.env.DATA_DIR = testDataDir;

const board = require('../server/leaderboard');
board.save = () => {};

const World = require('../server/world');
const { WEAPONS, PICKUP_POOLS } = require('../server/config');

function makeMonitor() {
  return {
    identity: 'rocket-regression',
    kicked: false,
    resetPos() {},
    cooldown() { return true; },
    recordShot() {},
    recordKill() {},
    aimShot() {},
    setPersistentScore() {},
    flag() {},
    vec3(value) {
      if (!Array.isArray(value) || value.length !== 3) return null;
      const length = Math.hypot(...value);
      return length ? value.map(component => component / length) : null;
    },
  };
}

function addTestPlayer(world, name, ip, position) {
  const player = world.addPlayer(name, ip);
  Object.assign(player, {
    hp: 100,
    armor: 0,
    shield: 0,
    protectUntil: 0,
    alive: true,
  });
  Object.assign(player.pos, position);
  return player;
}

try {
  const events = [];
  const world = new World(
    event => events.push(event),
    () => {},
    { attach: makeMonitor, detach() {} },
    null,
    [],
    null,
  );
  world.updateAntiCheatVision = () => {};

  const rocket = WEAPONS.rocket;
  assert(rocket, 'rocket weapon config is missing');
  assert.equal(rocket.slot, 'gun', 'rocket must use the gun slot');
  assert.equal(rocket.mag, 1, 'rocket magazine must contain one round');
  assert.equal(rocket.mag + rocket.reserveMags, 5, 'rocket total ammo must be five');
  assert.equal(
    PICKUP_POOLS.wep.filter(item => item === 'rocket').length,
    1,
    'rocket must have one pickup-pool weight',
  );

  const shooter = addTestPlayer(world, 'rocket-tester-a', '127.0.0.1', { x: -12, y: 0, z: -12 });
  const target = addTestPlayer(world, 'rocket-tester-b', '127.0.0.2', { x: -4, y: 0, z: -12 });
  Object.assign(shooter, {
    gun: 'rocket',
    active: 'gun',
    ammo: 1,
    ammoReserve: 4,
    reloadUntil: 0,
    yaw: -Math.PI / 2,
    pitch: 0,
  });

  world.handleFire(shooter, { o: [-12, 1.6, -12], d: [1, 0, 0] });
  assert.equal(shooter.ammo, 0, 'firing must consume the loaded rocket');
  assert.equal(world.projs.length, 1, 'firing must create one server projectile');
  assert.equal(world.projs[0].kind, 'rocket', 'projectile kind must be rocket');
  assert(events.some(event => event.k === 'rocketshot'), 'rocketshot effect event is missing');
  assert(world.snapshot().fb.some(projectile => projectile[7] === 3), 'rocket snapshot kind is missing');

  for (let tick = 0; tick < 20 && target.alive; tick++) world.update(1 / 30);
  assert.equal(target.alive, false, `direct rocket impact must kill an unarmored target; hp=${target.hp}`);
  shooter.reloadUntil = Date.now() - 1;
  world.update(0);
  assert.equal(shooter.ammo, 1, 'completed reload must restore one rocket');
  assert.equal(shooter.ammoReserve, 3, 'completed reload must consume one reserve rocket');

  const self = addTestPlayer(world, 'rocket-self', '127.0.0.3', { x: 20, y: 0, z: 20 });
  world.aoeDamage(
    { x: 20, y: 1, z: 20 },
    rocket.radius,
    rocket.dmg,
    self,
    {
      wp: 'rocket',
      falloff: rocket.falloff,
      selfMul: rocket.selfDamageMul,
      lineOfSight: true,
    },
  );
  assert.equal(self.hp, 26, `center self-damage must be 74; hp=${self.hp}`);

  const covered = addTestPlayer(world, 'rocket-cover', '127.0.0.4', { x: 0, y: 0, z: 3.9 });
  world.aoeDamage(
    { x: 0, y: 1, z: 2.1 },
    rocket.radius,
    rocket.dmg,
    shooter,
    {
      wp: 'rocket',
      falloff: rocket.falloff,
      selfMul: rocket.selfDamageMul,
      lineOfSight: true,
    },
  );
  assert.equal(covered.hp, 100, `static cover must block rocket splash; hp=${covered.hp}`);

  console.log(JSON.stringify({
    pass: true,
    directKill: !target.alive,
    reload: `${shooter.ammo}/${rocket.mag} + ${shooter.ammoReserve}`,
    selfDamage: 100 - self.hp,
    coverBlocked: covered.hp === 100,
    pickupWeight: '1/15',
  }));
} finally {
  fs.rmSync(testDataDir, { recursive: true, force: true });
}
