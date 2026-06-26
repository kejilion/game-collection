// ============================================================================
//  Menu / UI helpers: the character creator (live procedural preview), the
//  leaderboard renderer and time formatting.
// ============================================================================
import {
  SKIN_TONES, OUTFIT_COLORS, HAT_COLORS, BODY_STYLES,
} from '../shared/constants.js';
import { drawClimber } from './characters.js';

const STYLE_LABELS = { beanie: '毛线帽', earflap: '护耳帽', bobble: '绒球帽' };
const RANDOM_NAMES = ['雪豹', '冰镐侠', '阿白', '企鹅', '雪团子', '北极星', '可可', '寒霜', '糯米', '小蓝'];

export function randomName() {
  return RANDOM_NAMES[(Math.random() * RANDOM_NAMES.length) | 0];
}

export function randomLook() {
  const pick = (a) => a[(Math.random() * a.length) | 0];
  return {
    skin: pick(SKIN_TONES), outfit: pick(OUTFIT_COLORS),
    hat: pick(HAT_COLORS), style: pick(BODY_STYLES),
  };
}

/** Wire up the creator rows + animated preview. Mutates `look` in place. */
export function setupCreator(previewCanvas, look) {
  buildSwatches('skin-row', SKIN_TONES, look, 'skin');
  buildSwatches('outfit-row', OUTFIT_COLORS, look, 'outfit');
  buildSwatches('hat-row', HAT_COLORS, look, 'hat');
  buildChips('style-row', BODY_STYLES, look, 'style');

  const ctx = previewCanvas.getContext('2d');
  let t0 = performance.now();
  function loop(now) {
    const t = (now - t0) / 1000;
    ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    ctx.save();
    ctx.translate(previewCanvas.width / 2, previewCanvas.height - 36);
    // a gentle wave / attack every ~4s for liveliness
    const cyc = t % 4;
    const state = { anim: 'idle', t, attack: cyc > 3.4 ? (cyc - 3.4) / 0.6 : 0 };
    drawClimber(ctx, look, state, 2.7);
    ctx.restore();
    previewCanvas._raf = requestAnimationFrame(loop);
  }
  cancelAnimationFrame(previewCanvas._raf);
  previewCanvas._raf = requestAnimationFrame(loop);
}

function buildSwatches(rowId, colors, look, key) {
  const row = document.getElementById(rowId);
  row.innerHTML = '';
  colors.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'swatch' + (look[key] === c ? ' sel' : '');
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => {
      look[key] = c;
      [...row.children].forEach((ch) => ch.classList.remove('sel'));
      b.classList.add('sel');
    });
    row.appendChild(b);
  });
}

function buildChips(rowId, styles, look, key) {
  const row = document.getElementById(rowId);
  row.innerHTML = '';
  styles.forEach((s) => {
    const b = document.createElement('button');
    b.className = 'chip' + (look[key] === s ? ' sel' : '');
    b.textContent = STYLE_LABELS[s] || s;
    b.addEventListener('click', () => {
      look[key] = s;
      [...row.children].forEach((ch) => ch.classList.remove('sel'));
      b.classList.add('sel');
    });
    row.appendChild(b);
  });
}

export function fmtTime(ms, withCs = false) {
  if (ms == null) return '--:--';
  const total = Math.max(0, ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const base = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  if (!withCs) return base;
  const cs = Math.floor((total % 1000) / 10);
  return `${base}.${String(cs).padStart(2, '0')}`;
}

export function renderLeaderboard(olEl, entries) {
  olEl.innerHTML = '';
  if (!entries || entries.length === 0) {
    olEl.innerHTML = '<li class="board-empty">尚无纪录，去创造第一个吧！</li>';
    return;
  }
  entries.forEach((e, i) => {
    const li = document.createElement('li');
    if (i < 3) li.classList.add('top' + (i + 1));
    li.innerHTML =
      `<span class="pos">${i + 1}</span>` +
      `<span class="who">${escapeHtml(e.name)}</span>` +
      `<span class="meta">${fmtTime(e.timeMs, true)} · 第${e.round}局</span>`;
    olEl.appendChild(li);
  });
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
