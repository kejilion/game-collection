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

  function onKeyDown(e) {
    // chat / typing: let the field handle it (Enter/Esc managed in main)
    if (typing()) return;

    const code = e.code;
    if (MOVE[code]) { e.preventDefault(); if (!keys[MOVE[code]]) { keys[MOVE[code]] = true; sendMove(); } return; }

    if (code === 'KeyA') { e.preventDefault(); if (!attackHeld) { attackHeld = true; startAttackLoop(); } return; }
    if (/^Digit[1-5]$/.test(code)) { e.preventDefault(); handlers.skill && handlers.skill(+code.slice(5) - 1); return; }
    if (code === 'KeyB') { e.preventDefault(); handlers.toggleShop && handlers.toggleShop(); return; }
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
    keys.up = keys.down = keys.left = keys.right = false;
    stopAttackLoop(); sendMove();
  }

  function init(h) {
    handlers = h;
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', releaseAll);
  }

  return { init, releaseAll, keys };
})();
