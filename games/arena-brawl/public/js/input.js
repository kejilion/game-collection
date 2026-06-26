// ============================================================================
//  Input — keyboard handling (movement, attack, skills, hotkeys)
//  Movement keys are sampled into {up,down,left,right} and pushed to the
//  server only when the combination changes.
// ============================================================================
const Input = (() => {
  const keys = { up: false, down: false, left: false, right: false };
  let handlers = {};
  let attackHeld = false;
  let attackTimer = null;
  let initialized = false;
  let joystickPointerId = null;
  let attackPointerId = null;
  // ---- dynamic (floating) joystick state ----
  // The movement stick spawns wherever the thumb first touches the left
  // half of the screen, so the finger never runs off a fixed pad and the
  // move action stays uninterrupted even when dragging toward center.
  const JOY_RADIUS = 42;     // max knob travel (px), matches CSS travel
  const JOY_HALF = 66;       // half visual stick size (132px pad / 2)
  let joystickOrigin = null; // {x,y} client coords of the press point

  const MOVE = {
    ArrowUp: 'up', KeyW: 'up',
    ArrowDown: 'down', KeyS: 'down',
    ArrowLeft: 'left', KeyA2: 'left',   // (A reserved for attack; use ←)
    ArrowRight: 'right', KeyD: 'right'
  };

  function typing() {
    const a = document.activeElement;
    return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
  }
  function sendMove() { handlers.move && handlers.move({ ...keys }); }

  function startAttackLoop() {
    if (attackTimer) return;
    handlers.attack && handlers.attack();
    attackTimer = setInterval(() => { if (attackHeld) handlers.attack && handlers.attack(); }, 140);
  }
  function stopAttackLoop() { attackHeld = false; clearInterval(attackTimer); attackTimer = null; }

  function setKeys(next) {
    let changed = false;
    for (const key of Object.keys(keys)) {
      if (keys[key] !== next[key]) { keys[key] = next[key]; changed = true; }
    }
    if (changed) sendMove();
  }

  function onKeyDown(e) {
    // chat / typing: let the field handle it (Enter/Esc managed in main)
    if (typing()) return;

    const code = e.code;
    if (MOVE[code]) { e.preventDefault(); if (!keys[MOVE[code]]) { keys[MOVE[code]] = true; sendMove(); } return; }

    if (code === 'KeyA') { e.preventDefault(); if (!attackHeld) { attackHeld = true; startAttackLoop(); } return; }
    if (/^Digit[1-5]$/.test(code)) { e.preventDefault(); handlers.skill && handlers.skill(+code.slice(5) - 1); return; }
    if (code === 'KeyE') { e.preventDefault(); handlers.toggleShop && handlers.toggleShop(); return; }
    if (code === 'Escape') { e.preventDefault(); handlers.escape && handlers.escape(); return; }
    if (code === 'Enter') { e.preventDefault(); handlers.chat && handlers.chat(); return; }
    if (code === 'Space') { e.preventDefault(); handlers.skill && handlers.skill(0); return; }
  }

  function onKeyUp(e) {
    const code = e.code;
    if (MOVE[code]) { if (keys[MOVE[code]]) { keys[MOVE[code]] = false; sendMove(); } return; }
    if (code === 'KeyA') stopAttackLoop();
  }

  function releaseAll() {
    setKeys({ up: false, down: false, left: false, right: false });
    stopAttackLoop(); sendMove();
    joystickPointerId = null; attackPointerId = null;
    resetJoystickVisual();
  }

  // Reset stick to hidden + knob centered.
  function resetJoystickVisual() {
    const knob = document.getElementById('moveJoystickKnob');
    if (knob) knob.style.transform = 'translate(0, 0)';
    const stick = document.getElementById('moveJoystick');
    if (stick) stick.classList.remove('active');
  }

  function updateJoystick(e) {
    const knob = document.getElementById('moveJoystickKnob');
    if (!knob || !joystickOrigin) return;
    let dx = e.clientX - joystickOrigin.x;
    let dy = e.clientY - joystickOrigin.y;
    let len = Math.hypot(dx, dy);
    if (len > JOY_RADIUS) { dx = dx / len * JOY_RADIUS; dy = dy / len * JOY_RADIUS; len = JOY_RADIUS; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    const x = dx / JOY_RADIUS, y = dy / JOY_RADIUS;
    const deadzone = 0.24;
    setKeys({ up: y < -deadzone, down: y > deadzone, left: x < -deadzone, right: x > deadzone });
  }

  function clearJoystick() {
    joystickPointerId = null;
    joystickOrigin = null;
    setKeys({ up: false, down: false, left: false, right: false });
    resetJoystickVisual();
  }

  function onJoystickDown(e) {
    // Floating stick: ignore presses on interactive controls / right half.
    if (e.target.closest('[data-touch-action]')) return;
    if (e.target.closest('#skillbar')) return;
    if (e.target.closest('#mobileBtns')) return;
    if (e.target.closest('.overlay-panel')) return;
    if (e.target.id !== 'mobileControls' && e.target.id !== 'canvas') return;
    if (e.clientX > window.innerWidth * 0.5) return; // right half reserved for actions
    e.preventDefault();
    joystickPointerId = e.pointerId;
    joystickOrigin = { x: e.clientX, y: e.clientY };
    const stick = document.getElementById('moveJoystick');
    if (stick) {
      stick.style.left = (e.clientX - JOY_HALF) + 'px';
      stick.style.top = (e.clientY - JOY_HALF) + 'px';
      stick.classList.add('active');
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    updateJoystick(e);
  }

  function onJoystickMove(e) {
    if (e.pointerId === joystickPointerId) { e.preventDefault(); updateJoystick(e); }
  }

  function onPointerDown(e) {
    const skill = e.target.closest('#skillbar .skill[data-k]');
    const target = e.target.closest('[data-touch-action]');
    if (!skill && !target) return;
    const compactLayout = e.pointerType === 'touch' || window.matchMedia('(max-width: 680px)').matches;
    if (!compactLayout) return;
    e.preventDefault();
    if (skill) {
      if (skill.dataset.k === 'A') {
        if (!attackHeld) { attackHeld = true; attackPointerId = e.pointerId; skill.setPointerCapture(e.pointerId); startAttackLoop(); }
      } else {
        handlers.skill && handlers.skill(Number(skill.dataset.k));
      }
    } else if (target.dataset.touchAction === 'settings') {
      handlers.escape && handlers.escape();
    }
  }

  function onPointerEnd(e) {
    if (e.pointerId === joystickPointerId) clearJoystick();
    if (e.pointerId === attackPointerId) { attackPointerId = null; stopAttackLoop(); }
  }

  function bindTouchControls() {
    const stick = document.getElementById('moveJoystick');
    // Floating joystick: the stick is no longer a fixed hit target, so we
    // listen on document (capture-phase) and let onJoystickDown decide if
    // the press is in the left-half move hot-zone. Skill buttons keep their
    // own handlers via onPointerDown below.
    document.addEventListener('pointerdown', onJoystickDown, true);
    document.addEventListener('pointermove', onJoystickMove);
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointerup', onPointerEnd);
    document.addEventListener('pointercancel', onPointerEnd);
  }

  function init(h) {
    handlers = h;
    if (initialized) return;
    initialized = true;
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', releaseAll);
    bindTouchControls();
  }

  return { init, releaseAll, keys };
})();
