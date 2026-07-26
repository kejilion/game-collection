(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.G = root.G || {};
    root.G.weaponSpread = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function normalize(vector) {
    const length = Math.hypot(vector[0], vector[1], vector[2]);
    if (!Number.isFinite(length) || length < 1e-9) return [0, 0, -1];
    return [vector[0] / length, vector[1] / length, vector[2] / length];
  }

  function cross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }

  function apply(direction, coneRadians, random) {
    const forward = normalize(direction);
    const cone = Math.max(0, Number(coneRadians) || 0);
    if (cone <= 0) return forward;
    const sample = typeof random === 'function' ? random : Math.random;
    const reference = Math.abs(forward[1]) > 0.98 ? [1, 0, 0] : [0, 1, 0];
    const right = normalize(cross(forward, reference));
    const up = normalize(cross(right, forward));
    const radius = Math.sqrt(Math.max(0, Math.min(1, Number(sample()) || 0))) * Math.tan(cone);
    const angle = Math.max(0, Math.min(1, Number(sample()) || 0)) * Math.PI * 2;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    return normalize([
      forward[0] + right[0] * x + up[0] * y,
      forward[1] + right[1] * x + up[1] * y,
      forward[2] + right[2] * x + up[2] * y,
    ]);
  }

  return { apply };
});
