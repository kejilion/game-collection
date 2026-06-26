// ============================================================================
//  Server-side player entity.  Holds the authoritative physics/combat state;
//  the per-tick simulation & interactions live in GameRoom so all entities are
//  resolved together.  serialize() produces the compact form sent in snapshots.
// ============================================================================
import {
  PLAYER_MAX_HP, PLAYER_H, floorTopY, floorAtY,
  SKIN_TONES, OUTFIT_COLORS, HAT_COLORS, BODY_STYLES,
  DEATH_DURATION,
} from '../../public/shared/constants.js';

function validColor(c, list, fallback) {
  return list.includes(c) ? c : fallback;
}

export class Player {
  constructor(id, name, look = {}) {
    this.id = id;
    this.name = String(name || '无名氏').slice(0, 12).trim() || '无名氏';
    this.look = {
      skin: validColor(look.skin, SKIN_TONES, SKIN_TONES[0]),
      outfit: validColor(look.outfit, OUTFIT_COLORS, OUTFIT_COLORS[5]),
      hat: validColor(look.hat, HAT_COLORS, HAT_COLORS[0]),
      style: BODY_STYLES.includes(look.style) ? look.style : BODY_STYLES[0],
    };

    // physics
    this.x = 0; this.y = 0; this.vx = 0; this.vy = 0;
    this.facing = 1; this.onGround = false; this.jumpHeld = false;
    this.fallStartY = 0; this.supportType = null; this.supportId = null;

    // status
    this.hp = PLAYER_MAX_HP;
    this.alive = true;
    this.invuln = 0; // i-frames timer
    this.stun = 0; // CC timer
    this.deaths = 0;
    this.deadTimer = 0; // >0 表示正在死亡动画/等待重生

    // combat
    this.attackCd = 0;
    this.attackAnim = 0; // >0 while swing visual plays
    this.fireCd = 0;

    // buffs (absolute remaining seconds)
    this.jumpBuff = 0;
    this.fireBuff = 0;

    // progress / round
    this.maxFloor = 0;
    this.floor = 0;
    this.rescued = false;
    this.finishMs = 0;
    this.rank = 0;
    this.lifting = false; // being picked up animation flag
    this.startMs = Date.now(); // per-player timer start (spawn -> rescue)

    // networking
    this.input = { left: false, right: false, jump: false, attack: false };
    this.lastSeq = 0;
    this.lastInputAt = Date.now();
    this.connected = true;
    this.chat = null;              // { text, until } displayed as a speech bubble
    this.chatReadyAt = 0;          // server-side throttle timestamp (anti-spam)
  }

  spawn(x, y) {
    this.x = x; this.y = y; this.vx = 0; this.vy = 0;
    this.onGround = true; this.jumpHeld = false;
    this.fallStartY = y; this.supportType = null; this.supportId = null;
    this.hp = PLAYER_MAX_HP; this.alive = true;
    this.invuln = 1.0; this.stun = 0;
    this.attackCd = 0; this.attackAnim = 0; this.fireCd = 0;
    this.rescued = false; this.lifting = false;
    this.deadTimer = 0;
    this.finishMs = 0; this.rank = 0;
    this.chat = null;
  }

  /** Reset for a brand-new round (also clears buffs & progress). */
  resetForRound(x, y) {
    this.spawn(x, y);
    this.jumpBuff = 0; this.fireBuff = 0;
    this.maxFloor = 0; this.floor = 0; this.deaths = 0;
    this.startMs = Date.now(); // restart per-player timer for the new round
    this.finishMs = 0; this.rank = 0; this.rescued = false;
  }

  updateFloor() {
    this.floor = floorAtY(this.y);
    if (this.floor > this.maxFloor) this.maxFloor = this.floor;
  }

  serialize() {
    return {
      id: this.id,
      name: this.name,
      look: this.look,
      x: Math.round(this.x * 10) / 10,
      y: Math.round(this.y * 10) / 10,
      vx: Math.round(this.vx),
      vy: Math.round(this.vy),
      f: this.facing,
      g: this.onGround ? 1 : 0,
      hp: Math.max(0, Math.round(this.hp)),
      floor: this.floor,
      stun: this.stun > 0 ? 1 : 0,
      inv: this.invuln > 0 ? 1 : 0,
      atk: this.attackAnim > 0 ? 1 : 0,
      jb: this.jumpBuff > 0 ? 1 : 0,
      fb: this.fireBuff > 0 ? 1 : 0,
      res: this.rescued ? 1 : 0,
      lift: this.lifting ? 1 : 0,
      dead: this.deadTimer > 0 ? Math.round(this.deadTimer * 100) / 100 : 0,
      st: this.startMs || 0,
      fn: this.rescued ? (this.finishMs || 0) : 0,
      seq: this.lastSeq,
      chat: this.chat ? this.chat.text : null,
    };
  }
}
