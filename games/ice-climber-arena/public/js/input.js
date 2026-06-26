// ============================================================================
//  Keyboard input → a small boolean state with an incrementing sequence id.
//  Controls: ← → move, ↑ jump, A attack (Space also jumps as a convenience).
//  Ignores keys while a text field is focused (so typing a name is safe).
// ============================================================================
export class Input {
  constructor() {
    this.state = { left: false, right: false, jump: false, attack: false };
    this.seq = 0;
    this.dirty = false;
    this.enabled = false;
    this._down = this._down.bind(this);
    this._up = this._up.bind(this);
    window.addEventListener('keydown', this._down);
    window.addEventListener('keyup', this._up);
    window.addEventListener('blur', () => this._clear());
  }

  enable(on) { this.enabled = on; if (!on) this._clear(); }

  /** Set a control from an external source (on-screen touch buttons). */
  setControl(key, on) {
    if (!this.enabled) return;
    if (key in this.state) this._set(key, on);
  }

  /** Release every held control (e.g. when the rotate-to-landscape nudge shows). */
  releaseAll() { this._clear(); }

  _typing() {
    const el = document.activeElement;
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  }

  _set(key, val) {
    if (this.state[key] !== val) { this.state[key] = val; this.dirty = true; }
  }

  _map(code) {
    switch (code) {
      case 'ArrowLeft': case 'KeyH': return 'left';
      case 'ArrowRight': case 'KeyL': return 'right';
      case 'ArrowUp': case 'Space': case 'KeyW': return 'jump';
      case 'KeyA': case 'KeyJ': return 'attack';
      default: return null;
    }
  }

  _down(e) {
    if (!this.enabled || this._typing()) return;
    const k = this._map(e.code);
    if (k) { this._set(k, true); e.preventDefault(); }
  }

  _up(e) {
    const k = this._map(e.code);
    if (k) { this._set(k, false); e.preventDefault(); }
  }

  _clear() {
    for (const k of Object.keys(this.state)) this._set(k, false);
  }

  /** Build a network message (also bumps the sequence id). */
  message() {
    this.dirty = false;
    return {
      seq: ++this.seq,
      left: this.state.left,
      right: this.state.right,
      jump: this.state.jump,
      attack: this.state.attack,
    };
  }
}
