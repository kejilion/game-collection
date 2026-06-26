// ============================================================================
//  Procedural cartoon climber art.  No external sprites — every character is
//  drawn from shapes, parameterised by skin / outfit / hat colour and a hat
//  silhouette.  Used by the character creator preview and the in-game renderer
//  so the look is identical everywhere.
//
//  drawClimber(ctx, look, state, scale)
//    look  : { skin, outfit, hat, style }
//    state : { anim:'idle'|'run'|'jump'|'fall', t, runPhase, attack, frozen, blink }
//    Drawn with the character's FEET at the current origin (0,0), facing +x.
//    Caller handles world translate + horizontal flip for facing.
// ============================================================================

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = Math.max(0, Math.min(255, r + amt));
  g = Math.max(0, Math.min(255, g + amt));
  b = Math.max(0, Math.min(255, b + amt));
  return `rgb(${r},${g},${b})`;
}

function rr(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function circle(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.closePath();
}

export function drawClimber(ctx, look, state = {}, scale = 1) {
  const { skin = '#ffd9b3', outfit = '#3498db', hat = '#c0392b', style = 'beanie' } = look;
  const t = state.t || 0;
  const anim = state.anim || 'idle';
  const atk = Math.max(0, Math.min(1, state.attack || 0));

  ctx.save();
  ctx.scale(scale, scale);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // gentle motion
  let bob = 0, lean = 0, legSwing = 0, armSwing = 0;
  if (anim === 'idle') bob = Math.sin(t * 3.2) * 1.1;
  else if (anim === 'run') {
    legSwing = Math.sin(state.runPhase || 0) * 6;
    armSwing = Math.sin((state.runPhase || 0) + Math.PI) * 5;
    lean = 4;
    bob = Math.abs(Math.cos(state.runPhase || 0)) * 1.4;
  } else if (anim === 'jump') { legSwing = -3; armSwing = -7; lean = 2; }
  else if (anim === 'fall') { legSwing = 5; armSwing = 6; }

  ctx.translate(0, -bob);

  const outDark = shade(outfit, -38);
  const outLite = shade(outfit, 34);
  const skinDark = shade(skin, -34);

  // ---- legs + boots ----
  drawLeg(ctx, -6, legSwing, outDark, skinDark);
  drawLeg(ctx, 6, -legSwing, outDark, skinDark);

  // ---- back arm ----
  drawArm(ctx, 11, armSwing, outfit, outDark, skin, false, 0);

  // ---- torso (puffy jacket) ----
  ctx.translate(lean * 0.2, 0);
  ctx.fillStyle = outfit;
  ctx.strokeStyle = outDark;
  ctx.lineWidth = 2;
  rr(ctx, -13, -34, 26, 24, 11);
  ctx.fill();
  ctx.stroke();
  // belly highlight + zipper
  ctx.fillStyle = outLite;
  rr(ctx, -9, -31, 9, 17, 6);
  ctx.fill();
  ctx.strokeStyle = outDark;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(0, -32);
  ctx.lineTo(0, -12);
  ctx.stroke();

  // ---- head ----
  const headY = -42;
  ctx.fillStyle = skin;
  ctx.strokeStyle = skinDark;
  ctx.lineWidth = 1.6;
  circle(ctx, 0, headY, 11.5);
  ctx.fill();
  ctx.stroke();

  // face
  const blink = state.blink;
  ctx.fillStyle = '#21303f';
  if (!blink) {
    circle(ctx, -4, headY + 1, 1.8); ctx.fill();
    circle(ctx, 4.5, headY + 1, 1.8); ctx.fill();
    ctx.fillStyle = '#fff';
    circle(ctx, -3.4, headY + 0.3, 0.7); ctx.fill();
    circle(ctx, 5.1, headY + 0.3, 0.7); ctx.fill();
  } else {
    ctx.strokeStyle = '#21303f'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(-6, headY + 1); ctx.lineTo(-2, headY + 1);
    ctx.moveTo(2.6, headY + 1); ctx.lineTo(6.6, headY + 1); ctx.stroke();
  }
  // cheeks
  ctx.fillStyle = 'rgba(255,120,120,.5)';
  circle(ctx, -6.5, headY + 4, 2.2); ctx.fill();
  circle(ctx, 6.5, headY + 4, 2.2); ctx.fill();
  // smile
  ctx.strokeStyle = '#b15a4a'; ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.arc(0.6, headY + 4, 3, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();

  // ---- hat ----
  drawHat(ctx, headY, hat, style);

  // ---- front arm (animates on attack) ----
  const swing = atk > 0 ? Math.sin(atk * Math.PI) * 34 : armSwing;
  drawArm(ctx, -11, atk > 0 ? swing : -armSwing, outfit, outDark, skin, true, atk);

  // ---- frozen / CC overlay ----
  if (state.frozen) drawFrozen(ctx);

  ctx.restore();
}

function drawLeg(ctx, x, swing, pants, bootDark) {
  ctx.save();
  ctx.translate(x, -12);
  ctx.rotate((swing * Math.PI) / 180);
  ctx.fillStyle = pants;
  rr(ctx, -3.5, 0, 7, 9, 3);
  ctx.fill();
  // boot
  ctx.fillStyle = '#5b3b22';
  ctx.strokeStyle = bootDark;
  ctx.lineWidth = 1.2;
  rr(ctx, -4.5, 7, 10, 6, 3);
  ctx.fill();
  ctx.fillStyle = '#7a5031';
  rr(ctx, -4.5, 7, 10, 2.6, 2);
  ctx.fill();
  ctx.restore();
}

function drawArm(ctx, x, swing, jacket, jacketDark, skin, front, atk) {
  ctx.save();
  ctx.translate(x, -30);
  ctx.rotate((swing * Math.PI) / 180);
  ctx.fillStyle = jacket;
  ctx.strokeStyle = jacketDark;
  ctx.lineWidth = 1.4;
  rr(ctx, -3.5, 0, 7, 12, 3.5);
  ctx.fill();
  ctx.stroke();
  // mitten
  ctx.fillStyle = shade(jacket, -52);
  circle(ctx, 0, 13.5, 3.6);
  ctx.fill();
  // little mallet when the front arm is mid-swing
  if (front && atk > 0.25) {
    ctx.fillStyle = '#8a5a2b';
    rr(ctx, -1.4, 13, 2.8, 12, 1.4); ctx.fill();
    ctx.fillStyle = '#c7d2da';
    ctx.strokeStyle = '#8794a0'; ctx.lineWidth = 1.2;
    rr(ctx, -6, 23, 12, 7, 2.4); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

function drawHat(ctx, headY, hat, style) {
  const hatDark = shade(hat, -40);
  const hatLite = shade(hat, 28);
  ctx.strokeStyle = hatDark;
  ctx.lineWidth = 1.6;

  // common cap dome
  ctx.fillStyle = hat;
  ctx.beginPath();
  ctx.arc(0, headY - 1, 12, Math.PI, Math.PI * 2);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // folded brim
  ctx.fillStyle = hatLite;
  rr(ctx, -12.5, headY - 3, 25, 5, 2.5);
  ctx.fill();
  ctx.stroke();

  if (style === 'beanie') {
    // tiny fold lines
    ctx.strokeStyle = hatDark; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-7, headY - 1); ctx.lineTo(-7, headY - 6);
    ctx.moveTo(0, headY - 2); ctx.lineTo(0, headY - 11);
    ctx.moveTo(7, headY - 1); ctx.lineTo(7, headY - 6);
    ctx.stroke();
  } else if (style === 'bobble') {
    // pom-pom on top
    ctx.fillStyle = '#fff';
    circle(ctx, 0, headY - 14, 4.2); ctx.fill();
    ctx.strokeStyle = '#dfe9f0'; ctx.lineWidth = 1; ctx.stroke();
  } else if (style === 'earflap') {
    // ear flaps + top knob
    ctx.fillStyle = hat; ctx.strokeStyle = hatDark; ctx.lineWidth = 1.4;
    rr(ctx, -13, headY - 1, 5, 9, 2.5); ctx.fill(); ctx.stroke();
    rr(ctx, 8, headY - 1, 5, 9, 2.5); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff';
    circle(ctx, -10.5, headY + 8, 2.2); ctx.fill();
    circle(ctx, 10.5, headY + 8, 2.2); ctx.fill();
    circle(ctx, 0, headY - 13, 2.8); ctx.fillStyle = hatLite; ctx.fill();
  }
}

function drawFrozen(ctx) {
  ctx.save();
  ctx.fillStyle = 'rgba(150, 220, 255, 0.34)';
  ctx.strokeStyle = 'rgba(220, 245, 255, 0.85)';
  ctx.lineWidth = 1.5;
  rr(ctx, -15, -56, 30, 50, 6);
  ctx.fill();
  ctx.stroke();
  // crack / shine lines
  ctx.strokeStyle = 'rgba(255,255,255,.7)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(-9, -50); ctx.lineTo(-3, -38); ctx.lineTo(-7, -22);
  ctx.moveTo(8, -52); ctx.lineTo(3, -40); ctx.lineTo(9, -28);
  ctx.stroke();
  ctx.restore();
}

/**
 * 倒地死亡绘制：角色向后倾倒旋转 + X 眼 + 随进度渐隐。
 * progress: 1 = 刚死, 0 = 即将重生。脚部仍在 (0,0)。
 */
export function drawDeadClimber(ctx, look, t, progress, scale = 1) {
  const { skin = '#ffd9b3', outfit = '#3498db', hat = '#c0392b', style = 'beanie' } = look;
  const p = Math.max(0, Math.min(1, progress));
  const tilt = (1 - p) * (Math.PI / 2); // 0 -> 90deg 倒地
  const fade = Math.min(1, p * 1.6);    // 后半段渐隐
  ctx.save();
  ctx.scale(0.96 * scale, 0.96 * scale);
  ctx.globalAlpha = fade;
  ctx.rotate(-tilt);  // 向后倒
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const outDark = shade(outfit, -38), outLite = shade(outfit, 34), skinDark = shade(skin, -34);

  // legs + boots (瘫软)
  drawLeg(ctx, -6, 10, outDark, skinDark);
  drawLeg(ctx, 6, -10, outDark, skinDark);
  // back arm
  drawArm(ctx, 11, 12, outfit, outDark, skin, false, 0);

  // torso
  ctx.fillStyle = outfit; ctx.strokeStyle = outDark; ctx.lineWidth = 2;
  rr(ctx, -13, -34, 26, 24, 11); ctx.fill(); ctx.stroke();
  ctx.fillStyle = outLite; rr(ctx, -9, -31, 9, 17, 6); ctx.fill();

  // head
  const headY = -42;
  ctx.fillStyle = skin; ctx.strokeStyle = skinDark; ctx.lineWidth = 1.6;
  circle(ctx, 0, headY, 11.5); ctx.fill(); ctx.stroke();

  // X 眼
  ctx.strokeStyle = '#21303f'; ctx.lineWidth = 1.8;
  const ex = [-4.5, 4.5];
  for (const cx of ex) {
    ctx.beginPath();
    ctx.moveTo(cx - 2.4, headY - 1.4); ctx.lineTo(cx + 2.4, headY + 3.4);
    ctx.moveTo(cx + 2.4, headY - 1.4); ctx.lineTo(cx - 2.4, headY + 3.4);
    ctx.stroke();
  }
  // 张嘴
  ctx.strokeStyle = '#b15a4a'; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.arc(0.6, headY + 5, 3.2, 0.1 * Math.PI, 0.9 * Math.PI); ctx.stroke();

  drawHat(ctx, headY, hat, style);
  // front arm
  drawArm(ctx, -11, 14, outfit, outDark, skin, true, 0);

  ctx.restore();
  ctx.globalAlpha = 1;
}

/** Small standalone icon used in the creator chip row. */
export function drawHeadIcon(ctx, look, style, x, y, s) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.fillStyle = look.skin || '#ffd9b3';
  circle(ctx, 0, 0, 9); ctx.fill();
  drawHat(ctx, 0, look.hat || '#c0392b', style);
  ctx.restore();
}
