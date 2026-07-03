'use strict';
// 键盘 + 移动端摇杆输入，变化时立即发送，另有低频保活重发。
const Input = (() => {
  const keys = { up: false, down: false, left: false, right: false, boost: false };
  const joy = { active: false, dx: 0, dy: 0 };   // 摇杆向量（-1..1）
  let touchBoost = false;
  let lastSent = '';
  let enabled = false;
  let chatFocusFn = null;
  let hornFn = null;
  let boardsFn = null;

  const KEYMAP = {
    KeyW: 'up', ArrowUp: 'up',
    KeyS: 'down', ArrowDown: 'down',
    KeyA: 'left', ArrowLeft: 'left',
    KeyD: 'right', ArrowRight: 'right',
    ShiftLeft: 'boost', ShiftRight: 'boost', Space: 'boost'
  };

  function onKey(e, down) {
    if (!enabled) return;
    const chatInput = document.getElementById('chat-input');
    const typing = document.activeElement === chatInput;

    if (down && e.code === 'Enter') {
      if (typing) { /* hud 处理发送 */ } else { chatFocusFn && chatFocusFn(); e.preventDefault(); }
      return;
    }
    if (typing) return; // 打字时不开车

    if (e.code === 'Tab') { boardsFn && boardsFn(down); e.preventDefault(); return; }
    if (down && e.code === 'KeyH') { hornFn && hornFn(); return; }
    if (down && e.code === 'KeyM') { GameAudio.toggleMute(); return; }

    const k = KEYMAP[e.code];
    if (!k) return;
    e.preventDefault();
    if (keys[k] !== down) { keys[k] = down; flush(true); }
  }

  // 摇杆向量 -> 八方向输入：推哪走哪
  function applyJoystick() {
    if (!joy.active) return;
    keys.right = joy.dx > 0.3;
    keys.left = joy.dx < -0.3;
    keys.down = joy.dy > 0.3;
    keys.up = joy.dy < -0.3;
    keys.boost = touchBoost;
  }

  function flush(force) {
    if (!enabled) return;
    const sig = `${keys.up}|${keys.down}|${keys.left}|${keys.right}|${keys.boost}`;
    if (!force && sig === lastSent) return;
    lastSent = sig;
    Net.send({ type: 'input', up: keys.up, down: keys.down, left: keys.left, right: keys.right, boost: keys.boost });
  }

  function setupTouch() {
    const ui = document.getElementById('touch-ui');
    const stick = document.getElementById('joystick');
    const knob = document.getElementById('joystick-knob');
    const bBoost = document.getElementById('btn-boost');
    const bHorn = document.getElementById('btn-horn');
    if (!('ontouchstart' in window)) return;
    ui.classList.remove('hidden');

    let joyTouch = -1;
    const R = 65;

    function center() {
      const r = stick.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    function setKnob(dx, dy) {
      knob.style.transform = `translate(calc(-50% + ${dx * R * 0.7}px), calc(-50% + ${dy * R * 0.7}px))`;
    }

    stick.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      joyTouch = t.identifier;
      joy.active = true;
      e.preventDefault();
    }, { passive: false });

    window.addEventListener('touchmove', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== joyTouch) continue;
        const c = center();
        let dx = (t.clientX - c.x) / R, dy = (t.clientY - c.y) / R;
        const m = Math.hypot(dx, dy);
        if (m > 1) { dx /= m; dy /= m; }
        joy.dx = dx; joy.dy = dy;
        setKnob(dx, dy);
        e.preventDefault();
      }
    }, { passive: false });

    window.addEventListener('touchend', (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === joyTouch) {
          joyTouch = -1;
          joy.active = true; // 保持摇杆模式，向量归零
          joy.dx = joy.dy = 0;
          keys.up = keys.down = keys.left = keys.right = false;
          setKnob(0, 0);
          flush(true);
        }
      }
    });

    bBoost.addEventListener('touchstart', (e) => { touchBoost = true; e.preventDefault(); }, { passive: false });
    bBoost.addEventListener('touchend', () => { touchBoost = false; keys.boost = false; flush(true); });
    bHorn.addEventListener('touchstart', (e) => { hornFn && hornFn(); e.preventDefault(); }, { passive: false });
  }

  window.addEventListener('keydown', (e) => onKey(e, true));
  window.addEventListener('keyup', (e) => onKey(e, false));
  window.addEventListener('blur', () => {
    for (const k in keys) keys[k] = false;
    flush(true);
  });

  // 保活重发（服务器无状态输入，断快照时防卡键）
  setInterval(() => flush(true), 350);

  return {
    keys, joy,
    enable() { enabled = true; },
    disable() { enabled = false; for (const k in keys) keys[k] = false; flush(true); },
    applyJoystick, flush, setupTouch,
    onChatFocus(fn) { chatFocusFn = fn; },
    onHorn(fn) { hornFn = fn; },
    onBoards(fn) { boardsFn = fn; }
  };
})();
