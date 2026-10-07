// Builds the curling-wave (koru / Hokusai crest) SVG symbols used as edge decoration.
const NS = 'http://www.w3.org/2000/svg';
const f = (v) => Math.round(v * 10) / 10;

function spiralPts(o) {
  const r0 = o.r0 || 80, k = o.k || 0.19, T = (o.turns || 2.1) * 2 * Math.PI;
  const a0 = o.a0 == null ? Math.PI / 2 : o.a0, s = o.s || 1;
  const tail = o.tail == null ? 120 : o.tail, bend = o.bend == null ? 0.008 : o.bend;
  const n = o.n || 240, cx = o.cx || 0, cy = o.cy || 0;
  const sp = [];
  for (let i = 0; i <= n; i++) {
    const th = T * i / n, r = r0 * Math.exp(-k * th), a = a0 + s * th;
    sp.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  let tx = sp[1][0] - sp[0][0], ty = sp[1][1] - sp[0][1];
  const l = Math.hypot(tx, ty); tx /= l; ty /= l;
  const tp = []; const m = 50; const step = tail / m;
  let x = sp[0][0], y = sp[0][1], dx = -tx, dy = -ty;
  for (let i = 0; i < m; i++) {
    const ang = s * bend * step, c = Math.cos(ang), sn = Math.sin(ang);
    const ndx = dx * c - dy * sn, ndy = dx * sn + dy * c; dx = ndx; dy = ndy;
    x += dx * step; y += dy * step; tp.push([x, y]);
  }
  tp.reverse();
  return { pts: tp.concat(sp), tailN: tp.length };
}

function ribbon(pts, wmax, wmin, peak = 0.3) {
  const L = [0];
  for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const tot = L[L.length - 1], le = [], ri = [];
  for (let i = 0; i < pts.length; i++) {
    const u = L[i] / tot;
    const w = u < peak ? wmin + (wmax - wmin) * Math.sin(u / peak * Math.PI / 2) : wmin + (wmax - wmin) * Math.pow(1 - (u - peak) / (1 - peak), 1.25);
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const tx = b[0] - a[0], ty = b[1] - a[1], tl = Math.hypot(tx, ty) || 1, nx = -ty / tl, ny = tx / tl;
    le.push(f(pts[i][0] + nx * w / 2) + ' ' + f(pts[i][1] + ny * w / 2));
    ri.push(f(pts[i][0] - nx * w / 2) + ' ' + f(pts[i][1] - ny * w / 2));
  }
  return 'M' + le.join('L') + 'L' + ri.reverse().join('L') + 'Z';
}
const line = (pts) => 'M' + pts.map((p) => f(p[0]) + ' ' + f(p[1])).join('L');

export function buildKoru(sprite) {
  const b = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
  const grow = (pts, pad) => pts.forEach((p) => { b.x0 = Math.min(b.x0, p[0] - pad); b.y0 = Math.min(b.y0, p[1] - pad); b.x1 = Math.max(b.x1, p[0] + pad); b.y1 = Math.max(b.y1, p[1] + pad); });
  const cr = spiralPts({ r0: 82, turns: 2.2, tail: 120 });
  const st = spiralPts({ r0: 82, turns: 2.0, tail: 110, k: 0.2 });
  grow(cr.pts, 24);
  let parts = `<path d="${ribbon(cr.pts, 34, 1.4, 0.28)}" class="k1"/>`;
  parts += `<path d="${ribbon(cr.pts, 20, 0.8, 0.3)}" class="k2"/>`;
  parts += `<path d="${line(st.pts.slice(10, st.pts.length - 70))}" class="kl" fill="none" stroke-width="1.4" stroke-linecap="round"/>`;
  for (let j = 0; j < 6; j++) {
    const p = cr.pts[cr.tailN + 8 + j * 13];
    const len = Math.hypot(p[0], p[1]), ox = p[0] / len, oy = p[1] / len, R = 12 - j * 1.1;
    const claw = spiralPts({ r0: R, turns: 1.25, tail: R * 0.9, bend: 0, cx: p[0] + ox * (R + 10), cy: p[1] + oy * (R + 10), a0: Math.atan2(-oy, -ox) - 0.4, n: 70, k: 0.3 });
    parts += `<path d="${ribbon(claw.pts, R * 0.55, 0.4, 0.35)}" class="k3"/>`;
    grow(claw.pts, 4);
  }
  const sym = document.createElementNS(NS, 'symbol');
  sym.setAttribute('id', 'koru');
  sym.setAttribute('viewBox', [f(b.x0), f(b.y0), f(b.x1 - b.x0), f(b.y1 - b.y0)].join(' '));
  sym.setAttribute('overflow', 'visible');
  sym.innerHTML = parts;
  sprite.appendChild(sym);
}
