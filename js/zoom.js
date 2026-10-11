// 1.6.5 photo viewer gestures, with pointer events (iOS Safari 13+, Chrome): pinch to zoom, drag to pan a zoomed
// photo, double tap to zoom in/out, and a sideways swipe (at normal size) to move to the next/previous photo.
// The transform goes on the <img> only; the page itself never zooms.
const MAX = 5, SWIPE_PX = 50, TAP_MS = 300, TAP_PX = 12;

export function attachGestures(stage, { onSwipe } = {}) {
  const img = () => stage.querySelector('img');
  const pts = new Map();
  let s = 1, tx = 0, ty = 0;
  let start = null; // gesture start: { s, tx, ty, dist, cx, cy, x, y, t }
  let lastTap = 0;
  const apply = (anim) => {
    const el = img();
    if (!el) return;
    el.style.transition = anim ? 'transform .18s ease-out' : 'none';
    el.style.transform = s === 1 && !tx && !ty ? '' : `translate(${tx}px, ${ty}px) scale(${s})`;
  };
  const clampPan = () => {
    const el = img();
    if (!el || s <= 1) { tx = 0; ty = 0; return; }
    const mx = (el.clientWidth * (s - 1)) / 2, my = (el.clientHeight * (s - 1)) / 2;
    tx = Math.max(-mx, Math.min(mx, tx)); ty = Math.max(-my, Math.min(my, ty));
  };
  const two = () => { const [a, b] = [...pts.values()]; return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }; };
  const begin = (t) => {
    const p = [...pts.values()][0];
    start = { s, tx, ty, x: p.x, y: p.y, t, ...(pts.size === 2 ? two() : {}) };
  };

  stage.addEventListener('pointerdown', (ev) => {
    if (ev.target.closest('button, a')) return;
    pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    try { stage.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic pointer */ }
    begin(Date.now());
  });
  stage.addEventListener('pointermove', (ev) => {
    if (!pts.has(ev.pointerId) || !start) return;
    pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pts.size >= 2 && start.dist) {
      const g = two();
      s = Math.max(1, Math.min(MAX, start.s * (g.dist / start.dist)));
      tx = start.tx + (g.cx - start.cx); ty = start.ty + (g.cy - start.cy);
      clampPan();
      apply(false);
    } else if (pts.size === 1) {
      const p = [...pts.values()][0];
      const dx = p.x - start.x, dy = p.y - start.y;
      if (s > 1) { tx = start.tx + dx; ty = start.ty + dy; clampPan(); apply(false); }
      else if (Math.abs(dx) > Math.abs(dy)) { const el = img(); if (el) { el.style.transition = 'none'; el.style.transform = `translateX(${dx}px)`; } }
    }
  });
  const end = (ev) => {
    if (!pts.has(ev.pointerId)) return;
    const p = pts.get(ev.pointerId);
    pts.delete(ev.pointerId);
    if (!start) return;
    if (pts.size) { begin(start.t); return; } // one finger lifted from a pinch: continue as a pan from here
    const dx = p.x - start.x, dy = p.y - start.y, now = Date.now();
    const wasPinch = start.dist;
    start = null;
    if (wasPinch) { if (s < 1.05) { s = 1; tx = 0; ty = 0; } apply(true); return; }
    const tap = Math.abs(dx) < TAP_PX && Math.abs(dy) < TAP_PX;
    if (tap) {
      if (now - lastTap < TAP_MS) { lastTap = 0; if (s > 1) { s = 1; tx = 0; ty = 0; } else s = 2.5; apply(true); return; }
      lastTap = now;
      return;
    }
    if (s === 1 && Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.3 && onSwipe) {
      // Hebrew is read right to left: the next photo comes in from the left, so a finger moving right goes forward.
      if (onSwipe(dx > 0 ? 1 : -1) !== false) return;
    }
    apply(true);
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  return { reset() { s = 1; tx = 0; ty = 0; apply(false); }, get scale() { return s; } };
}
