'use strict';

// 输入处理：键盘（方向键/WASD + 空格/J）与触屏（虚拟摇杆 + 炸弹按钮）。
// 方向采用“后按优先”栈，手感接近经典四方向游戏。

window.GameInput = (function () {
  // 方向编码与服务端一致：0 上 1 下 2 左 3 右
  const KEY_DIR = {
    ArrowUp: 0, KeyW: 0,
    ArrowDown: 1, KeyS: 1,
    ArrowLeft: 2, KeyA: 2,
    ArrowRight: 3, KeyD: 3,
  };

  function create({ onDir, onBomb, onAnyKey }) {
    const stack = []; // 当前按住的方向，后按的在末尾
    let lastSent = -1;

    function currentDir() {
      return stack.length > 0 ? stack[stack.length - 1] : -1;
    }

    function sync() {
      const d = currentDir();
      if (d !== lastSent) {
        lastSent = d;
        onDir(d);
      }
    }

    window.addEventListener('keydown', (ev) => {
      if (onAnyKey) onAnyKey();
      if (ev.target && ev.target.tagName === 'INPUT') return;
      const dir = KEY_DIR[ev.code];
      if (dir != null) {
        ev.preventDefault();
        if (!ev.repeat && !stack.includes(dir)) stack.push(dir);
        sync();
      } else if (ev.code === 'Space' || ev.code === 'KeyJ') {
        ev.preventDefault();
        if (!ev.repeat) onBomb();
      }
    });

    window.addEventListener('keyup', (ev) => {
      const dir = KEY_DIR[ev.code];
      if (dir != null) {
        const i = stack.indexOf(dir);
        if (i >= 0) stack.splice(i, 1);
        sync();
      }
    });

    window.addEventListener('blur', () => {
      stack.length = 0;
      sync();
    });

    // ---------- 触屏 ----------
    const touchUI = document.getElementById('touch-controls');
    const joy = document.getElementById('joystick');
    const knob = document.getElementById('joystick-knob');
    const bombBtn = document.getElementById('bomb-btn');
    let joyTouch = null;
    let joyOrigin = null;

    function showTouchUI() {
      touchUI.classList.remove('hidden');
    }
    window.addEventListener('touchstart', function once() {
      showTouchUI();
      window.removeEventListener('touchstart', once);
    }, { passive: true });

    function joyDir(dx, dy) {
      const dead = 14;
      if (Math.abs(dx) < dead && Math.abs(dy) < dead) return -1;
      if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 3 : 2;
      return dy > 0 ? 1 : 0;
    }

    joy.addEventListener('touchstart', (ev) => {
      ev.preventDefault();
      if (onAnyKey) onAnyKey();
      const t = ev.changedTouches[0];
      joyTouch = t.identifier;
      const rect = joy.getBoundingClientRect();
      joyOrigin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, { passive: false });

    window.addEventListener('touchmove', (ev) => {
      if (joyTouch == null) return;
      for (const t of ev.changedTouches) {
        if (t.identifier !== joyTouch) continue;
        const dx = t.clientX - joyOrigin.x;
        const dy = t.clientY - joyOrigin.y;
        const max = 42;
        const len = Math.hypot(dx, dy) || 1;
        const cl = Math.min(len, max);
        knob.style.transform =
          `translate(calc(-50% + ${(dx / len) * cl}px), calc(-50% + ${(dy / len) * cl}px))`;
        const d = joyDir(dx, dy);
        stack.length = 0;
        if (d >= 0) stack.push(d);
        sync();
      }
    }, { passive: true });

    function joyEnd(ev) {
      if (joyTouch == null) return;
      for (const t of ev.changedTouches) {
        if (t.identifier !== joyTouch) continue;
        joyTouch = null;
        knob.style.transform = 'translate(-50%, -50%)';
        stack.length = 0;
        sync();
      }
    }
    window.addEventListener('touchend', joyEnd, { passive: true });
    window.addEventListener('touchcancel', joyEnd, { passive: true });

    bombBtn.addEventListener('touchstart', (ev) => {
      ev.preventDefault();
      if (onAnyKey) onAnyKey();
      onBomb();
    }, { passive: false });

    return {
      reset() {
        stack.length = 0;
        lastSent = -1;
        sync();
      },
    };
  }

  return { create };
})();
