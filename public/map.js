// The infrastructure map. Pure layout and routing live at the top (no DOM, so they can be tested);
// the drawing, zoom and hover highlighting are below.
//
// Layout: things that run on something are drawn inside it. Groups are ordered so that groups that talk to each
// other sit next to each other; things on their own go in a tidy grid underneath.
// Arrows: routed on a grid around the boxes with rounded corners. Where two arrows cross, the horizontal one hops
// over the other with a tiny bump.

export const C = 8;                     // routing grid step, in pixels
const LW = 200, LH = 66, PAD = 18, HEAD = 52, GAP = 32, MARGIN = 64, GROUP_GAP = 72, MAXW = 1240;
const R = 12, HOP = 5;                  // corner radius and bump radius

export function layoutMap(items) {
  const byId = new Map(items.map((i) => [i.id, i])), kids = new Map(items.map((i) => [i.id, []])), roots = [];
  for (const i of items) (i.parentId && byId.has(i.parentId) && i.parentId !== i.id ? kids.get(i.parentId) : roots).push(i);
  // a loop in "runs on" would hide its members; show them at the top level instead
  const seen = new Set(), walk = (i) => { if (seen.has(i.id)) return; seen.add(i.id); kids.get(i.id).forEach(walk); };
  roots.forEach(walk);
  for (const i of items) if (!seen.has(i.id)) { const p = kids.get(i.parentId); if (p) p.splice(p.indexOf(i), 1); roots.push(i); walk(i); }

  const box = new Map();
  const size = (i, depth) => {
    const ch = kids.get(i.id);
    if (!ch.length) { box.set(i.id, { id: i.id, item: i, w: LW, h: LH, depth, leaf: true }); return; }
    ch.forEach((c) => size(c, depth + 1));
    const cols = Math.min(ch.length, depth === 0 ? 3 : 2), rows = [];
    for (let k = 0; k < ch.length; k += cols) rows.push(ch.slice(k, k + cols));
    const cw = Math.max(...Array.from({ length: cols }, (_, c) => Math.max(0, ...rows.map((r) => (r[c] ? box.get(r[c].id).w : 0)))));
    const rh = rows.map((r) => Math.max(...r.map((c) => box.get(c.id).h)));
    box.set(i.id, { id: i.id, item: i, w: Math.max(LW + PAD * 2, cols * cw + (cols - 1) * GAP + PAD * 2), h: HEAD + rh.reduce((a, b) => a + b, 0) + (rows.length - 1) * GAP + PAD, depth, rows, cw, rh, cols });
  };
  roots.forEach((r) => size(r, 0));
  const place = (i, x, y) => {
    const b = box.get(i.id); b.x = x; b.y = y;
    if (b.rows) { let yy = y + HEAD; b.rows.forEach((r, ri) => { r.forEach((c, ci) => place(c, x + PAD + ci * (b.cw + GAP), yy)); yy += b.rh[ri] + GAP; }); }
  };

  // order the top-level groups so that linked groups are neighbours
  const top = new Map(); const mark = (i, root) => { top.set(i.id, root); kids.get(i.id).forEach((c) => mark(c, root)); }; roots.forEach((r) => mark(r, r.id));
  const aff = new Map(); const key = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  for (const i of items) for (const l of i.links || []) { const a = top.get(i.id), b = top.get(l.to); if (a && b && a !== b) aff.set(key(a, b), (aff.get(key(a, b)) || 0) + 1); }
  const degree = (r) => roots.reduce((s, o) => s + (aff.get(key(r.id, o.id)) || 0), 0);
  const order = (list) => {
    const left = [...list], out = [];
    left.sort((a, b) => degree(b) - degree(a) || box.get(b.id).h - box.get(a.id).h);
    while (left.length) {
      let best = 0, bs = -1;
      left.forEach((c, idx) => { const s = out.reduce((t, p) => t + (aff.get(key(c.id, p.id)) || 0) * (p === out[out.length - 1] ? 2 : 1), 0); if (s > bs) { bs = s; best = idx; } });
      out.push(left.splice(best, 1)[0]);
    }
    return out;
  };
  const groups = order(roots.filter((r) => !box.get(r.id).leaf)), singles = order(roots.filter((r) => box.get(r.id).leaf));

  let x = MARGIN, y = MARGIN, rowH = 0, maxX = 0;
  for (const r of groups) {
    const b = box.get(r.id);
    if (x + b.w > MAXW && x > MARGIN) { x = MARGIN; y += rowH + GROUP_GAP; rowH = 0; }
    place(r, x, y); x += b.w + GROUP_GAP; rowH = Math.max(rowH, b.h); maxX = Math.max(maxX, x - GROUP_GAP);
  }
  const sections = [];
  if (singles.length) {
    if (groups.length) y += rowH + GROUP_GAP;
    sections.push({ label: groups.length ? 'On their own' : '', x: MARGIN, y: y - 14 });
    const cols = Math.max(1, Math.min(5, Math.floor((Math.max(maxX, MAXW * 0.7) - MARGIN + GROUP_GAP) / (LW + GROUP_GAP)))), rowsN = Math.ceil(singles.length / cols);
    singles.forEach((r, k) => place(r, MARGIN + (k % cols) * (LW + GROUP_GAP), y + Math.floor(k / cols) * (LH + GROUP_GAP)));
    maxX = Math.max(maxX, MARGIN + cols * (LW + GROUP_GAP) - GROUP_GAP); rowH = rowsN * (LH + GROUP_GAP) - GROUP_GAP;
  }
  return { box, roots, kids, sections, W: Math.max(maxX + MARGIN, 480), H: y + rowH + MARGIN };
}

// ----- routing -----
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];   // right, down, left, up
const OPP = [2, 3, 0, 1];

class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(f, v) { const a = this.a; a.push([f, v]); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { let l = 2 * i + 1, r = l + 1, m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; }
}

const ancestor = (boxes, a, b) => { let p = boxes.get(b)?.item.parentId, n = 0; while (p && n++ < 50) { if (p === a) return true; p = boxes.get(p)?.item.parentId; } return false; };

// Which side of a box an arrow leaves from, and which side of the other box it arrives at.
function sides(a, c, nested) {
  if (nested === 'a-in-c') return ['top', 'top'];       // a runs inside c: leave upward, arrive at c's top edge
  if (nested === 'c-in-a') return ['top', 'top'];
  const dx = (c.x + c.w / 2) - (a.x + a.w / 2), dy = (c.y + c.h / 2) - (a.y + a.h / 2);
  const hor = Math.abs(dx) / ((a.w + c.w) / 2) > Math.abs(dy) / ((a.h + c.h) / 2);
  return hor ? (dx >= 0 ? ['right', 'left'] : ['left', 'right']) : (dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom']);
}
const SIDE_DIR = { right: 0, bottom: 1, left: 2, top: 3 };

export function routeLinks(items, boxes, W, H) {
  const links = [];
  for (const i of items) for (const l of i.links || []) { const a = boxes.get(i.id), c = boxes.get(l.to); if (a && c && a !== c) links.push({ from: i.id, to: l.to, label: l.label || '', a, c }); }
  // spread the arrows that use the same side of a box along that side
  const used = new Map(); const slot = (b, side) => { const k = b.id + side; const arr = used.get(k) || []; used.set(k, arr); return arr; };
  for (const e of links) {
    const nested = ancestor(boxes, e.from, e.to) ? 'c-in-a' : ancestor(boxes, e.to, e.from) ? 'a-in-c' : '';
    [e.sa, e.sc] = sides(e.a, e.c, nested); slot(e.a, e.sa).push(e); slot(e.c, e.sc).push(e);
  }
  const snap = (v) => Math.round(v / C) * C;
  const port = (b, side, e) => {
    const arr = slot(b, side), k = arr.indexOf(e), n = arr.length, horizontalSide = side === 'top' || side === 'bottom';
    const len = horizontalSide ? b.w : b.h, span = Math.max(0, len - 36), step = n > 1 ? Math.min(16, span / (n - 1)) : 0;
    // when the two boxes face each other, aim at the middle of where they overlap so the arrow can run straight
    const o = e.a === b ? e.c : e.a, o0 = horizontalSide ? o.x : o.y, o1 = o0 + (horizontalSide ? o.w : o.h), b0 = horizontalSide ? b.x : b.y, lo2 = Math.max(b0, o0) + 18, hi2 = Math.min(b0 + len, o1) - 18;
    const centre = hi2 >= lo2 ? (lo2 + hi2) / 2 : b0 + len / 2;
    const pos = centre + (k - (n - 1) / 2) * step;
    const lo = (horizontalSide ? b.x : b.y) + 18, hi = (horizontalSide ? b.x : b.y) + len - 18, p = Math.min(Math.max(snap(pos), Math.ceil(lo / C) * C), Math.max(Math.floor(hi / C) * C, Math.ceil(lo / C) * C));
    const edgeV = side === 'right' ? b.x + b.w : side === 'left' ? b.x : side === 'bottom' ? b.y + b.h : b.y;
    const out = side === 'right' || side === 'bottom' ? Math.floor((edgeV + 26) / C) * C : Math.ceil((edgeV - 26) / C) * C;
    return horizontalSide ? { edge: [p, edgeV], stub: [p, out] } : { edge: [edgeV, p], stub: [out, p] };
  };

  const cols = Math.ceil(W / C) + 1, rows = Math.ceil(H / C) + 1, N = cols * rows, node = (x, y) => (y / C) * cols + x / C;
  const hard = new Uint8Array(N), soft = new Uint8Array(N), usedH = new Uint8Array(N), usedV = new Uint8Array(N);
  const paint = (b, grow, arr, val) => { for (let y = Math.max(0, Math.floor((b.y - grow) / C)); y <= Math.min(rows - 1, Math.ceil((b.y + b.h + grow) / C)); y++) for (let x = Math.max(0, Math.floor((b.x - grow) / C)); x <= Math.min(cols - 1, Math.ceil((b.x + b.w + grow) / C)); x++) { const px = x * C, py = y * C; if (px > b.x - grow && px < b.x + b.w + grow && py > b.y - grow && py < b.y + b.h + grow) arr[y * cols + x] = Math.max(arr[y * cols + x], val); } };
  for (const b of boxes.values()) {
    if (b.leaf) { paint(b, 3, hard, 1); paint(b, 14, soft, 1); }
    else paint({ x: b.x, y: b.y, w: b.w, h: HEAD - 8 }, 0, soft, 2);   // keep clear of group titles
  }

  const route = (e) => {
    const A = port(e.a, e.sa, e), Z = port(e.c, e.sc, e);
    const sx = A.stub[0] / C, sy = A.stub[1] / C, gx = Z.stub[0] / C, gy = Z.stub[1] / C, d0 = SIDE_DIR[e.sa], dEnd = OPP[SIDE_DIR[e.sc]];
    const search = (x0, y0, x1, y1) => {
      const idx = (x, y, d) => (y * cols + x) * 4 + d, g = new Map(), from = new Map(), heap = new Heap(), start = idx(sx, sy, d0), goal = idx(gx, gy, dEnd);
      g.set(start, 0); heap.push(0, start);
      const h = (x, y) => (Math.abs(x - gx) + Math.abs(y - gy)) * 10;
      let guard = 0;
      while (heap.size && guard++ < 200000) {
        const [, s] = heap.pop(), d = s % 4, cell = (s - d) / 4, x = cell % cols, y = (cell - x) / cols, cur = g.get(s);
        if (s === goal) { const path = [s]; let p = s; while (from.has(p)) { p = from.get(p); path.push(p); } return path.reverse().map((q) => { const dd = q % 4, cc = (q - dd) / 4; return [(cc % cols) * C, Math.floor(cc / cols) * C, dd]; }); }
        for (const nd of [d, (d + 1) % 4, (d + 3) % 4]) {
          let nx = x, ny = y, cost;
          if (nd === d) {
            nx = x + DIRS[d][0]; ny = y + DIRS[d][1];
            if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
            const n = ny * cols + nx; if (hard[n]) continue;
            cost = 10 + (soft[n] === 1 ? 7 : soft[n] === 2 ? 22 : 0);
            if (d % 2 === 0) { if (usedH[n]) cost += 46; if (usedV[n]) cost += 20; } else { if (usedV[n]) cost += 46; if (usedH[n]) cost += 20; }
          } else cost = 26;   // a corner
          const ns = idx(nx, ny, nd), ng = cur + cost;
          if (!g.has(ns) || ng < g.get(ns)) { g.set(ns, ng); from.set(ns, s); heap.push(ng + h(nx, ny), ns); }
        }
      }
      return null;
    };
    const lo = (a, b) => Math.max(0, Math.min(a, b) - 14), hiX = (a, b) => Math.min(cols - 1, Math.max(a, b) + 14), hiY = (a, b) => Math.min(rows - 1, Math.max(a, b) + 14);
    let path = search(lo(sx, gx), lo(sy, gy), hiX(sx, gx), hiY(sy, gy)) || search(0, 0, cols - 1, rows - 1);
    let pts;
    if (path) {
      pts = [A.edge, ...path.map((p) => [p[0], p[1]]), Z.edge];
      // mark the cells used, so later arrows keep away from this one
      for (let k = 1; k < path.length; k++) { const [x0, y0] = path[k - 1], [x1, y1] = path[k]; if (x0 === x1 && y0 === y1) continue; const n = node(x1, y1); (x0 !== x1 ? usedH : usedV)[n] = 1; }
    } else pts = [A.edge, A.stub, Z.stub, Z.edge];
    // drop repeated and in-line points
    const clean = [];
    for (const p of pts) { const q = clean[clean.length - 1]; if (q && q[0] === p[0] && q[1] === p[1]) continue; clean.push(p); }
    const out = clean.filter((p, i) => { if (i === 0 || i === clean.length - 1) return true; const a = clean[i - 1], b = clean[i + 1]; return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1])); });
    return out;
  };
  // short arrows first, so long ones weave around them
  const dist = (e) => Math.abs(e.a.x - e.c.x) + Math.abs(e.a.y - e.c.y);
  [...links].sort((p, q) => dist(p) - dist(q)).forEach((e) => { e.points = route(e); });
  addHops(links);
  return links;
}

// Horizontal parts of an arrow hop over the vertical parts of other arrows they cross. Only real crossings count.
function addHops(links) {
  const segs = (pts) => { const out = []; for (let i = 1; i < pts.length; i++) out.push({ a: pts[i - 1], b: pts[i], h: pts[i - 1][1] === pts[i][1] }); return out; };
  links.forEach((e) => { e.segs = segs(e.points); });
  for (const e of links) {
    for (const s of e.segs) {
      s.hops = [];
      if (!s.h) continue;
      const y = s.a[1], x1 = Math.min(s.a[0], s.b[0]), x2 = Math.max(s.a[0], s.b[0]), room = R + HOP + 2;
      for (const o of links) {
        if (o === e) continue;
        for (const v of o.segs) {
          if (v.h) continue;
          const x = v.a[0], y1 = Math.min(v.a[1], v.b[1]), y2 = Math.max(v.a[1], v.b[1]);
          if (x > x1 + room && x < x2 - room && y > y1 + 1 && y < y2 - 1) s.hops.push(x);
        }
      }
      s.hops = [...new Set(s.hops)].sort((p, q) => p - q).filter((x, i, arr) => i === 0 || x - arr[i - 1] > HOP * 2 + 3);
    }
  }
}

// An SVG path through the points with rounded corners and bumps where it hops over another arrow.
export function linkPath(points, segs) {
  const f = (n) => Math.round(n * 10) / 10;
  if (points.length < 2) return '';
  let d = `M${f(points[0][0])} ${f(points[0][1])}`;
  const unit = (p, q) => { const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1; return [(q[0] - p[0]) / l, (q[1] - p[1]) / l]; };
  const run = (i, to) => {   // straight run along segment i up to `to`, with its bumps
    const s = segs?.[i], from = [curX, curY];
    if (s?.hops?.length) {
      const dir = to[0] >= from[0] ? 1 : -1, hs = dir > 0 ? s.hops : [...s.hops].reverse();
      for (const x of hs) { if ((dir > 0 && x > from[0] + HOP && x < to[0] - HOP) || (dir < 0 && x < from[0] - HOP && x > to[0] + HOP)) { d += `L${f(x - dir * HOP)} ${f(from[1])}A${HOP} ${HOP} 0 0 ${dir > 0 ? 1 : 0} ${f(x + dir * HOP)} ${f(from[1])}`; } }
    }
    d += `L${f(to[0])} ${f(to[1])}`; curX = to[0]; curY = to[1];
  };
  let curX = points[0][0], curY = points[0][1];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i - 1], v = points[i], n = points[i + 1], inn = unit(p, v), out = unit(v, n);
    const r = Math.min(R, Math.hypot(v[0] - p[0], v[1] - p[1]) / 2, Math.hypot(n[0] - v[0], n[1] - v[1]) / 2);
    run(i - 1, [v[0] - inn[0] * r, v[1] - inn[1] * r]);
    d += `Q${f(v[0])} ${f(v[1])} ${f(v[0] + out[0] * r)} ${f(v[1] + out[1] * r)}`; curX = v[0] + out[0] * r; curY = v[1] + out[1] * r;
  }
  run(points.length - 2, points[points.length - 1]);
  return d;
}

// The point on an arrow where its label sits: the middle of its longest straight part.
export function labelSpot(points) {
  let best = null, len = -1;
  for (let i = 1; i < points.length; i++) { const l = Math.abs(points[i][0] - points[i - 1][0]) + Math.abs(points[i][1] - points[i - 1][1]); if (l > len) { len = l; best = [(points[i][0] + points[i - 1][0]) / 2, (points[i][1] + points[i - 1][1]) / 2, points[i][1] === points[i - 1][1]]; } }
  return best;
}

// ----- drawing -----
const GLYPH = {
  server: 'M3 4h18v6H3z M3 14h18v6H3z M7 7h.01 M7 17h.01',
  globe: 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z M3 12h18 M12 3c3 3 3 15 0 18 M12 3c-3 3-3 15 0 18',
  cloud: 'M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 9.5 3.5 3.5 0 0 1 17.5 18z',
  box: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12L4 7.5',
  chip: 'M7 7h10v10H7z M10 3v4 M14 3v4 M10 17v4 M14 17v4 M3 10h4 M3 14h4 M17 10h4 M17 14h4',
  db: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6 M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  net: 'M12 4v5 M5 20v-5h14v5 M12 9v6 M3 20h4 M17 20h4 M10 4h4',
  home: 'M4 11l8-7 8 7 M6 10v10h12V10',
};
const TYPE_GLYPH = { router: 'net', switch: 'net', proxmox: 'server', server: 'server', vm: 'server', container: 'box', pi: 'chip', nas: 'db', website: 'globe', service: 'box', database: 'db', cloud: 'cloud', device: 'home', other: 'box' };

export function infraMap(items, types, onOpen, deps) {
  const { h, iconIdOf, colors } = deps;
  const NS = 'http://www.w3.org/2000/svg', mk = (t, a = {}, ...k) => { const e = document.createElementNS(NS, t); for (const [x, v] of Object.entries(a)) e.setAttribute(x, v); for (const c of k) if (c != null) e.append(c); return e; };
  const L = layoutMap(items), box = L.box;
  const links = routeLinks(items, box, L.W, L.H);
  // the drawing may need a little more room than the boxes, for arrows that go around them
  let W = L.W, H = L.H; for (const e of links) for (const p of e.points) { W = Math.max(W, p[0] + 24); H = Math.max(H, p[1] + 24); }
  const svgEl = mk('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': 'Map of your infrastructure', class: 'mapsvg', style: `max-width:${W}px;height:auto` });
  const head = (id, fill) => mk('marker', { id, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '9', markerHeight: '9', markerUnits: 'userSpaceOnUse', orient: 'auto' }, mk('path', { d: 'M0 0L10 5L0 10z', style: `fill:${fill}` }));
  svgEl.append(mk('defs', {}, head('arr', 'var(--muted)'), head('arrOn', 'var(--accent)')));
  const stroke = (i) => (i.status ? (i.status.ok ? colors.ok : colors.bad) : colors.none);

  // text is shrunk (down to a minimum size) and then shortened with ... so it never leaves its box; the full text is a tooltip
  const cx2 = document.createElement('canvas').getContext('2d');
  const width = (t, s, w) => { cx2.font = `${w} ${s}px Inter, system-ui, sans-serif`; return cx2.measureText(t).width; };
  const fit = (t, maxW, s, min, w) => { t = String(t); maxW *= 0.95; let sz = s; while (sz > min && width(t, sz, w) > maxW) sz -= 0.5; if (width(t, sz, w) <= maxW) return { t, sz }; let n = t.length; while (n > 1 && width(t.slice(0, n) + '…', sz, w) > maxW) n--; return { t: t.slice(0, n).trimEnd() + '…', sz }; };
  const txt = (t, x, y, fill, s = 13, w = 400, maxW = Infinity, min = s) => { const f = Number.isFinite(maxW) ? fit(t, maxW, s, min, w) : { t: String(t), sz: s }; const e = mk('text', { x, y, style: `fill:${fill};font:${w} ${f.sz}px Inter,system-ui,sans-serif` }); e.textContent = f.t; return e; };

  for (const s of L.sections) if (s.label) svgEl.append(txt(s.label.toUpperCase(), s.x, s.y, 'var(--muted)', 11, 600));

  // arrows go under the boxes' text but over the group backgrounds: groups first, then arrows, then the boxes you can click
  const order = [...items].sort((a, b) => box.get(a.id).depth - box.get(b.id).depth);
  const nodes = new Map(), edges = [];
  const drawBox = (i) => {
    const b = box.get(i.id), g = mk('g', { class: 'node' + (b.leaf ? '' : ' group'), tabindex: '0', role: 'button', 'aria-label': `${i.name}, ${types[i.type] || i.type}${i.state === 'proposed' ? ', waiting for your confirmation' : ''}`, style: 'cursor:pointer' });
    const tested = !!i.status;
    g.append(mk('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: b.leaf ? 12 : 16, style: `fill:${b.leaf ? 'var(--surface)' : 'var(--surface2)'};stroke:${tested ? stroke(i) : 'var(--line)'};stroke-width:${tested ? 1.8 : 1.2};${i.state === 'proposed' ? 'stroke-dasharray:5 4' : ''}` }));
    const sub = [types[i.type] || i.type, i.address].filter(Boolean).join(' · '), tag = i.state === 'proposed' ? 74 : 0;
    g.append(mk('title', {}, document.createTextNode(`${i.name}${sub ? '\n' + sub : ''}${tested ? '\nLast test: ' + (i.status.ok ? 'worked' : 'failed') : ''}`)));
    // icon tile: the real logo when there is one, otherwise a small drawing for the kind of thing it is
    const ic = iconIdOf(i), ix = b.x + 12, iy = b.y + 13;
    g.append(mk('rect', { x: ix, y: iy, width: 26, height: 26, rx: 7, style: 'fill:var(--accent-soft)' }));
    const glyph = mk('path', { d: GLYPH[TYPE_GLYPH[i.type] || 'box'], transform: `translate(${ix + 5} ${iy + 5}) scale(.67)`, style: 'fill:none;stroke:var(--accent-text);stroke-width:2;stroke-linecap:round;stroke-linejoin:round' }); g.append(glyph);
    if (ic) { const im = mk('image', { x: ix + 3, y: iy + 3, width: 20, height: 20, href: `/api/library/icon/${ic}` }); im.addEventListener('load', () => glyph.remove()); im.addEventListener('error', () => im.remove()); g.append(im); }
    const tx = ix + 36, right = b.x + b.w - 14 - (tested ? 14 : 0) - tag;
    g.append(txt(i.name, tx, b.y + 27, 'var(--text)', 14, 600, right - tx, 10.5));
    g.append(txt(sub, tx, b.y + 44, 'var(--muted)', 11.5, 400, b.x + b.w - 14 - tx, 9));
    if (tested) g.append(mk('circle', { cx: b.x + b.w - 16, cy: b.y + 21, r: 4.5, style: `fill:${stroke(i)}` }));
    if (i.state === 'proposed') g.append(txt('to confirm', b.x + b.w - 16 - 62, b.y + 27, 'var(--accent-text)', 11, 600));
    g.addEventListener('click', () => onOpen(i)); g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(i); } });
    nodes.set(i.id, g); return g;
  };
  const groupsFirst = order.filter((i) => !box.get(i.id).leaf), leaves = order.filter((i) => box.get(i.id).leaf);
  groupsFirst.forEach((i) => svgEl.append(drawBox(i)));
  const layer = mk('g', { class: 'edges' }); svgEl.append(layer);
  leaves.forEach((i) => svgEl.append(drawBox(i)));
  // group boxes sit under the arrows, so their children are drawn after them: move leaf children above the arrows already (leaves come last)
  links.forEach((e) => {
    const g = mk('g', { class: 'edge', 'data-from': e.from, 'data-to': e.to });
    const d = linkPath(e.points, e.segs), a = box.get(e.from).item, c = box.get(e.to).item, tip = `${a.name} → ${c.name}${e.label ? ': ' + e.label : ''}`;
    g.append(mk('path', { d, class: 'hit', style: 'fill:none;stroke:transparent;stroke-width:12' }, mk('title', {}, document.createTextNode(tip))));
    g.append(mk('path', { d, class: 'line', 'marker-end': 'url(#arr)', style: 'fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round' }));
    if (e.label) { const s = labelSpot(e.points); if (s) { const lt = txt(e.label, s[0], s[1] + (s[2] ? -6 : 4), 'var(--muted)', 11, 500, 150, 9); lt.setAttribute('text-anchor', 'middle'); lt.style.cssText += ';paint-order:stroke;stroke:var(--surface);stroke-width:4px;stroke-linejoin:round'; g.append(lt); } }
    layer.append(g); edges.push({ g, from: e.from, to: e.to });
  });
  // hover or focus a box and its arrows light up while the rest fade
  const light = (id) => {
    const on = new Set([id]); edges.forEach((e) => { const hit = e.from === id || e.to === id; e.g.classList.toggle('on', hit); if (hit) { on.add(e.from); on.add(e.to); } });
    nodes.forEach((g, k) => g.classList.toggle('dim', !on.has(k))); svgEl.classList.add('hl');
  };
  const unlight = () => { svgEl.classList.remove('hl'); edges.forEach((e) => e.g.classList.remove('on')); nodes.forEach((g) => g.classList.remove('dim')); };
  nodes.forEach((g, id) => { g.addEventListener('mouseenter', () => light(id)); g.addEventListener('mouseleave', unlight); g.addEventListener('focus', () => light(id)); g.addEventListener('blur', unlight); });

  // move and zoom: the map sits in a scrollable window. Drag to move, slider or Ctrl + scroll to zoom
  const MIN = 0.3, MAX = 2, clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  let zoom = 1;
  const scroller = h('div', { class: 'mapscroll', tabindex: '0', role: 'region', 'aria-label': 'Infrastructure map. Drag to move around, use the slider to zoom.' }, svgEl);
  const pct = h('span', { class: 'mono', style: 'min-width:3.2em;text-align:right' }, '100%');
  const slider = h('input', { type: 'range', min: String(MIN * 100), max: String(MAX * 100), step: '5', value: '100', 'aria-label': 'Zoom' });
  const apply = (z, fx = 0, fy = 0) => {
    z = clamp(z, MIN, MAX); const r = z / zoom, px = scroller.scrollLeft + fx, py = scroller.scrollTop + fy; zoom = z;
    svgEl.setAttribute('width', String(W * z)); svgEl.setAttribute('height', String(H * z)); svgEl.style.maxWidth = 'none';
    scroller.scrollLeft = px * r - fx; scroller.scrollTop = py * r - fy;
    scroller.style.height = clamp(H * z + 4, 220, Math.max(320, Math.min(window.innerHeight * 0.74, 800))) + 'px';
    slider.value = String(Math.round(z * 100)); pct.textContent = Math.round(z * 100) + '%';
  };
  const mid = () => [scroller.clientWidth / 2, scroller.clientHeight / 2];
  slider.addEventListener('input', () => apply(Number(slider.value) / 100, ...mid()));
  const fitAll = () => { apply(clamp(Math.min((scroller.clientWidth - 4) / W, (scroller.clientHeight - 4) / H), MIN, 1)); scroller.scrollTo(0, 0); };
  scroller.addEventListener('wheel', (e) => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); const r = scroller.getBoundingClientRect(); apply(zoom * Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  scroller.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    const sx = e.clientX, sy = e.clientY, sl = scroller.scrollLeft, st = scroller.scrollTop; let moved = false;
    const mv = (ev) => { const dx = ev.clientX - sx, dy = ev.clientY - sy; if (!moved && Math.hypot(dx, dy) < 5) return; moved = true; scroller.classList.add('drag'); scroller.scrollLeft = sl - dx; scroller.scrollTop = st - dy; };
    const up = () => {
      window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); scroller.classList.remove('drag');
      if (moved) { const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); }; scroller.addEventListener('click', stop, { capture: true, once: true }); setTimeout(() => scroller.removeEventListener('click', stop, true), 0); }
    };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  });
  const step = (d) => () => apply(zoom + d, ...mid());
  const bar = h('div', { class: 'mapbar' }, h('button', { class: 'btn', type: 'button', 'aria-label': 'Zoom out', onclick: step(-0.1) }, '−'), slider, h('button', { class: 'btn', type: 'button', 'aria-label': 'Zoom in', onclick: step(0.1) }, '+'), pct,
    h('button', { class: 'btn', type: 'button', onclick: fitAll }, 'Fit all'), h('button', { class: 'btn', type: 'button', onclick: () => apply(1, ...mid()) }, '100%'),
    h('span', { class: 'hint' }, 'Drag to move · Ctrl + scroll to zoom · Hover a box to follow its arrows'));
  requestAnimationFrame(() => { if (scroller.clientWidth) apply(clamp((scroller.clientWidth - 4) / W, 0.5, 1)); });
  return { el: h('div', {}, bar, scroller), links: links.length };
}
