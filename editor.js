import { loadCapture } from './db.js';
import { buildPdf, PAPERS, MARGIN, FOOTER_H } from './pdf.js';
import { EMOJI } from './emoji-data.js';

const $ = (id) => document.getElementById(id);
const MAX_TILE_DIM = 16384;
const MAX_TILE_AREA = 268_000_000;

const rec = await loadCapture(new URLSearchParams(location.search).get('id'));
if (!rec) {
  $('info').textContent = 'Capture not found.';
  throw new Error('capture not found');
}

// The capture is a stack of tiles; everything below works in real image pixels
// so annotations never care about tile boundaries.
const bitmaps = await Promise.all(rec.tiles.map((b) => createImageBitmap(b)));
const tops = [];
let H = 0;
for (const b of bitmaps) {
  tops.push(H);
  H += b.height;
}
const W = bitmaps[0].width;
const LW = Math.max(2, Math.round(W / 500)); // stroke width
const BLOCK = LW * 5; // pixelate block size
const TEXT_SIZE = LW * 6;
const EMOJI_SIZE = LW * 14;
const FONTS = {
  Sans: 'system-ui, sans-serif',
  Serif: 'Georgia, serif',
  Mono: "'Courier New', monospace",
  Marker: "'Comic Sans MS', 'Comic Neue', cursive",
  Impact: "Impact, 'Arial Black', sans-serif",
};
const fontOf = (s) => `bold ${s.size}px ${s.font || FONTS.Sans}`;
const POPULAR = ['👍', '❤️', '😂', '🔥', '✅', '❌', '⚠️', '❗', '👀', '🎉'];
let curEmoji = POPULAR[3];

$('info').textContent = `${rec.title} — ${rec.url} — ${W}×${H}px`;

// --- state ---
let shapes = [];
let crop = null;
let tool = 'rect';
let sel = -1;
let draft = null; // shape being drawn
let start = null; // draw drag origin
let drag = null; // select-tool move/resize
let z = 1;
const undoStack = [];

const snapshot = () => undoStack.push(JSON.stringify({ shapes, crop }));
const undo = () => {
  if (!undoStack.length) return;
  ({ shapes, crop } = JSON.parse(undoStack.pop()));
  sel = -1;
  render();
};

// --- stage / layout ---
const stage = $('stage');
const svg = $('overlay');
const imgs = rec.tiles.map((blob) => {
  const img = new Image();
  img.src = URL.createObjectURL(blob);
  img.draggable = false;
  stage.insertBefore(img, svg);
  return img;
});

function layout() {
  z = Math.min(1, (innerWidth - 32) / W);
  stage.style.width = `${W * z}px`;
  stage.style.height = `${H * z}px`;
  imgs.forEach((img, i) => {
    img.style.top = `${tops[i] * z}px`;
    img.style.width = `${W * z}px`;
  });
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', W * z);
  svg.setAttribute('height', H * z);
}

// --- shared geometry ---
const arrowHead = (s) => {
  const a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
  const len = LW * 5;
  return [
    [s.x2, s.y2],
    [s.x2 - len * Math.cos(a - 0.4), s.y2 - len * Math.sin(a - 0.4)],
    [s.x2 - len * Math.cos(a + 0.4), s.y2 - len * Math.sin(a + 0.4)],
  ];
};

const mctx = document.createElement('canvas').getContext('2d');
const lines = (s) => s.text.split('\n');

function bbox(s) {
  if (s.type === 'arrow') {
    return { x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2), w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) };
  }
  if (s.type === 'text') {
    mctx.font = fontOf(s);
    return {
      x: s.x,
      y: s.y,
      w: Math.max(...lines(s).map((l) => mctx.measureText(l).width)),
      h: lines(s).length * s.size * 1.2,
    };
  }
  return s;
}

const distToSegment = (p, s) => {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const t = Math.max(0, Math.min(1, ((p.x - s.x1) * dx + (p.y - s.y1) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - (s.x1 + t * dx), p.y - (s.y1 + t * dy));
};

function hitShape(s, p) {
  const tol = Math.max(LW * 2, 8 / z);
  if (s.type === 'arrow') return distToSegment(p, s) <= tol;
  const b = bbox(s);
  return p.x >= b.x - tol / 2 && p.x <= b.x + b.w + tol / 2 && p.y >= b.y - tol / 2 && p.y <= b.y + b.h + tol / 2;
}

function handlesOf(s) {
  if (s.type === 'arrow') return [{ id: 'p1', x: s.x1, y: s.y1 }, { id: 'p2', x: s.x2, y: s.y2 }];
  const b = bbox(s);
  if (s.type === 'text') return [{ id: 'se', x: b.x + b.w, y: b.y + b.h }];
  return [
    { id: 'nw', x: b.x, y: b.y },
    { id: 'ne', x: b.x + b.w, y: b.y },
    { id: 'sw', x: b.x, y: b.y + b.h },
    { id: 'se', x: b.x + b.w, y: b.y + b.h },
  ];
}

// --- SVG rendering (editor view) ---
const esc = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

function svgShape(s) {
  switch (s.type) {
    case 'rect':
      return `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="none" stroke="${s.color}" stroke-width="${LW}"/>`;
    case 'highlight':
      return `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="${s.color}" fill-opacity="0.4"/>`;
    case 'redact':
      return s.mode === 'black'
        ? `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="#000"/>`
        : `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="#888" fill-opacity="0.85" stroke="#fff" stroke-dasharray="${LW * 3}" stroke-width="${LW / 2}"/>`;
    case 'arrow':
      return `<line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" stroke="${s.color}" stroke-width="${LW}" stroke-linecap="round"/><polygon points="${arrowHead(s).map((p) => p.join(',')).join(' ')}" fill="${s.color}"/>`;
    case 'text':
      return `<text x="${s.x}" y="${s.y}" font-size="${s.size}" font-weight="bold" font-family="${s.font || FONTS.Sans}" fill="${s.color}" dominant-baseline="hanging">${lines(s)
        .map((l, i) => `<tspan x="${s.x}" dy="${i ? '1.2em' : 0}">${esc(l) || ' '}</tspan>`)
        .join('')}</text>`;
    case 'crop':
      return `<path fill="rgba(0,0,0,0.55)" fill-rule="evenodd" d="M0 0H${W}V${H}H0Z M${s.x} ${s.y}h${s.w}v${s.h}h${-s.w}Z"/><rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="none" stroke="#fff" stroke-width="${LW / 2}" stroke-dasharray="${LW * 3}"/>`;
  }
  return '';
}

function selectionSvg() {
  const s = shapes[sel];
  if (!s || tool !== 'select') return '';
  const b = bbox(s);
  const hs = 6 / z;
  const outline =
    s.type === 'arrow'
      ? ''
      : `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="none" stroke="#2d6cdf" stroke-width="${2 / z}" stroke-dasharray="${6 / z}"/>`;
  const handles = handlesOf(s)
    .map((h) => `<rect x="${h.x - hs}" y="${h.y - hs}" width="${hs * 2}" height="${hs * 2}" fill="#fff" stroke="#2d6cdf" stroke-width="${2 / z}"/>`)
    .join('');
  return outline + handles;
}

function render() {
  const cropShown = draft?.type === 'crop' ? draft : crop && { type: 'crop', ...crop };
  svg.innerHTML =
    shapes.map(svgShape).join('') +
    (draft && draft.type !== 'crop' ? svgShape(draft) : '') +
    (cropShown ? svgShape({ ...cropShown, type: 'crop' }) : '') +
    selectionSvg();
  svg.style.cursor = tool === 'select' ? 'default' : 'crosshair';
}

// --- canvas rendering (export) ---
// Draw a region of the stitched source into ctx, scaled, across tile boundaries.
function drawSource(ctx, sx, sy, sw, sh, dx, dy, kx, ky = kx) {
  bitmaps.forEach((bmp, i) => {
    const ya = Math.max(sy, tops[i]);
    const yb = Math.min(sy + sh, tops[i] + bmp.height);
    if (yb <= ya) return;
    ctx.drawImage(bmp, sx, ya - tops[i], sw, yb - ya, dx, dy + (ya - sy) * ky, sw * kx, (yb - ya) * ky);
  });
}

function drawShape(ctx, s) {
  ctx.save();
  ctx.lineWidth = LW;
  ctx.strokeStyle = ctx.fillStyle = s.color || '#000';
  switch (s.type) {
    case 'rect':
      ctx.strokeRect(s.x, s.y, s.w, s.h);
      break;
    case 'highlight':
      ctx.globalAlpha = 0.4;
      ctx.fillRect(s.x, s.y, s.w, s.h);
      break;
    case 'redact':
      if (s.mode === 'black') {
        ctx.fillStyle = '#000';
        ctx.fillRect(s.x, s.y, s.w, s.h);
      } else {
        const tw = Math.max(1, Math.round(s.w / BLOCK));
        const th = Math.max(1, Math.round(s.h / BLOCK));
        const tmp = document.createElement('canvas');
        tmp.width = tw;
        tmp.height = th;
        drawSource(tmp.getContext('2d'), s.x, s.y, s.w, s.h, 0, 0, tw / s.w, th / s.h);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tmp, s.x, s.y, s.w, s.h);
      }
      break;
    case 'arrow':
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2, s.y2);
      ctx.stroke();
      ctx.beginPath();
      arrowHead(s).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.fill();
      break;
    case 'text':
      ctx.font = fontOf(s);
      ctx.textBaseline = 'top';
      lines(s).forEach((l, i) => ctx.fillText(l, s.x, s.y + i * s.size * 1.2));
      break;
  }
  ctx.restore();
}

const cropRect = () => crop || { x: 0, y: 0, w: W, h: H };
const watermarkText = () => `${rec.url}  ·  captured ${new Date(rec.date).toLocaleString()}`;

// Render rows [top, top+h) of the cropped image with annotations; `extra` blank px below.
function renderRegion(c, top, h, extra = 0, bg = null) {
  const cv = document.createElement('canvas');
  cv.width = c.w;
  cv.height = h + extra;
  const ctx = cv.getContext('2d');
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cv.width, cv.height);
  }
  drawSource(ctx, c.x, c.y + top, c.w, h, 0, 0, 1);
  ctx.save();
  ctx.translate(-c.x, -(c.y + top));
  shapes.forEach((s) => drawShape(ctx, s));
  ctx.restore();
  return cv;
}

function stampFooter(cv, y, barH) {
  const ctx = cv.getContext('2d');
  const text = watermarkText();
  ctx.fillStyle = '#111';
  ctx.fillRect(0, y, cv.width, barH);
  let size = LW * 5;
  ctx.font = `${size}px system-ui`;
  const maxW = cv.width - LW * 4;
  const tw = ctx.measureText(text).width;
  if (tw > maxW) {
    size = Math.max(6, (size * maxW) / tw);
    ctx.font = `${size}px system-ui`;
  }
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, LW * 2, y + barH / 2);
}

const toBlob = (cv, type, q = 0.92) => new Promise((r) => cv.toBlob(r, type, q));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

async function exportImage(type) {
  const c = cropRect();
  const barH = $('wm').checked ? LW * 10 : 0;
  const tileH = Math.min(MAX_TILE_DIM, Math.floor(MAX_TILE_AREA / c.w)) - barH;
  const parts = Math.ceil(c.h / tileH);
  const ts = stamp();
  for (let n = 0; n < parts; n++) {
    const top = n * tileH;
    const h = Math.min(tileH, c.h - top);
    const last = n === parts - 1;
    const cv = renderRegion(c, top, h, last ? barH : 0, type === 'jpeg' ? '#fff' : null);
    if (last && barH) stampFooter(cv, h, barH);
    download(await toBlob(cv, `image/${type}`), `bloosnap-${ts}${parts > 1 ? `-${n + 1}` : ''}.${type === 'jpeg' ? 'jpg' : 'png'}`);
  }
}

// Row is "blank" if every pixel is (nearly) the same color as its first pixel.
function rowIsBlank(data, w, row) {
  const o = row * w * 4;
  const r = data[o], g = data[o + 1], b = data[o + 2];
  for (let i = 1; i < w; i++) {
    const p = o + i * 4;
    if (Math.abs(data[p] - r) + Math.abs(data[p + 1] - g) + Math.abs(data[p + 2] - b) > 24) return false;
  }
  return true;
}

// Pick a page break near `end` that falls in whitespace so lines/charts aren't sliced.
function findBreak(c, lo, end) {
  const search = Math.floor((end - lo) * 0.35);
  if (search < 2) return end;
  const stripTop = end - search;
  const cv = renderRegion(c, stripTop, search, 0, '#fff');
  const { data } = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
  let r1 = search - 1;
  while (r1 >= 0 && !rowIsBlank(data, cv.width, r1)) r1--;
  if (r1 < 0) return end;
  let r0 = r1;
  while (r0 > 0 && rowIsBlank(data, cv.width, r0 - 1)) r0--;
  return stripTop + Math.floor((r0 + r1) / 2) + 1;
}

async function exportPdf() {
  const c = cropRect();
  const wm = $('wm').checked;
  const paper = PAPERS[$('paper').value];
  const contentW = paper.w - 2 * MARGIN;
  const contentH = paper.h - 2 * MARGIN - (wm ? FOOTER_H : 0);
  const sliceH = Math.floor((c.w * contentH) / contentW);
  const pages = [];
  for (let y = 0; y < c.h; ) {
    let end = Math.min(c.h, y + sliceH);
    // Don't strand a sliver on its own page: the last page may run up to 15% long (the PDF shrinks it to fit).
    if (c.h - y <= sliceH * 1.15) end = c.h;
    else if (end < c.h) end = findBreak(c, y, end);
    const cv = renderRegion(c, y, end - y, 0, '#fff');
    const jpeg = new Uint8Array(await (await toBlob(cv, 'image/jpeg')).arrayBuffer());
    pages.push({ jpeg, w: cv.width, h: cv.height });
    y = end;
  }
  const url = rec.url.length > 110 ? `${rec.url.slice(0, 107)}...` : rec.url;
  const footer = wm ? `${url}  |  captured ${new Date(rec.date).toLocaleString()}` : null;
  download(buildPdf(pages, footer, paper), `bloosnap-${stamp()}.pdf`);
}

// --- interaction ---
const clamp = (v, max) => Math.min(max, Math.max(0, v));
const pt = (e) => {
  const r = svg.getBoundingClientRect();
  return { x: clamp((e.clientX - r.left) / z, W), y: clamp((e.clientY - r.top) / z, H) };
};
const rectOf = (a, b) => ({
  x: Math.round(Math.min(a.x, b.x)),
  y: Math.round(Math.min(a.y, b.y)),
  w: Math.round(Math.abs(a.x - b.x)),
  h: Math.round(Math.abs(a.y - b.y)),
});

function setTool(name) {
  tool = name;
  if (name !== 'emoji') $('emoji-panel').hidden = true;
  if (name !== 'select') sel = -1;
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === name));
  render();
}

function makeShape(a, b) {
  const color = $('color').value;
  switch (tool) {
    case 'crop':
      return { type: 'crop', ...rectOf(a, b) };
    case 'black':
    case 'pixel':
      return { type: 'redact', mode: tool, ...rectOf(a, b) };
    case 'rect':
    case 'highlight':
      return { type: tool, color: tool === 'highlight' && color === '#ff2d2d' ? '#ffe600' : color, ...rectOf(a, b) };
    case 'arrow':
      return { type: 'arrow', color, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  }
}

function placeText(p, text, size, font) {
  snapshot();
  shapes.push({ type: 'text', x: p.x, y: p.y, text, size, font, color: $('color').value });
  sel = shapes.length - 1;
  setTool('select');
}

function applyMove(s, o, dx, dy) {
  if (s.type === 'arrow') {
    Object.assign(s, { x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy });
  } else {
    s.x = o.x + dx;
    s.y = o.y + dy;
  }
}

function applyResize(s, o, handle, p) {
  if (s.type === 'arrow') {
    if (handle === 'p1') Object.assign(s, { x1: p.x, y1: p.y });
    else Object.assign(s, { x2: p.x, y2: p.y });
  } else if (s.type === 'text') {
    s.size = Math.max(8, (p.y - o.y) / (lines(o).length * 1.2));
  } else {
    const opp = {
      nw: { x: o.x + o.w, y: o.y + o.h },
      ne: { x: o.x, y: o.y + o.h },
      sw: { x: o.x + o.w, y: o.y },
      se: { x: o.x, y: o.y },
    }[handle];
    Object.assign(s, rectOf(opp, p));
  }
}

svg.addEventListener('pointerdown', (e) => {
  const p = pt(e);
  if (tool === 'select') {
    const hs = 8 / z;
    const cur = shapes[sel];
    const h = cur && handlesOf(cur).find((q) => Math.abs(p.x - q.x) <= hs && Math.abs(p.y - q.y) <= hs);
    if (h) {
      drag = { mode: 'resize', handle: h.id, orig: structuredClone(cur), from: p, moved: false };
    } else {
      sel = -1;
      for (let i = shapes.length - 1; i >= 0; i--) {
        if (hitShape(shapes[i], p)) {
          sel = i;
          break;
        }
      }
      drag = sel >= 0 ? { mode: 'move', orig: structuredClone(shapes[sel]), from: p, moved: false } : null;
    }
    if (drag) svg.setPointerCapture(e.pointerId);
    render();
    return;
  }
  if (tool === 'text') {
    const text = prompt('Text:');
    if (text) placeText(p, text, TEXT_SIZE, $('font').value);
    return;
  }
  if (tool === 'emoji') {
    placeText(p, curEmoji, EMOJI_SIZE, FONTS.Sans);
    return;
  }
  start = p;
  svg.setPointerCapture(e.pointerId);
});

svg.addEventListener('pointermove', (e) => {
  const p = pt(e);
  if (drag) {
    if (!drag.moved) {
      snapshot();
      drag.moved = true;
    }
    const s = shapes[sel];
    if (drag.mode === 'move') applyMove(s, drag.orig, p.x - drag.from.x, p.y - drag.from.y);
    else applyResize(s, drag.orig, drag.handle, p);
    render();
    return;
  }
  if (!start) return;
  draft = makeShape(start, p);
  render();
});

svg.addEventListener('pointerup', (e) => {
  if (drag) {
    drag = null;
    return;
  }
  if (!start) return;
  const s = makeShape(start, pt(e));
  start = draft = null;
  const big = s.type === 'arrow' ? Math.hypot(s.x2 - s.x1, s.y2 - s.y1) > 5 : s.w > 5 && s.h > 5;
  if (big) {
    snapshot();
    if (s.type === 'crop') {
      const { type, ...r } = s;
      crop = r;
    } else shapes.push(s);
  }
  render();
});

svg.addEventListener('dblclick', (e) => {
  if (tool !== 'select') return;
  const s = shapes[sel];
  if (s?.type !== 'text' || !hitShape(s, pt(e))) return;
  const text = prompt('Text:', s.text);
  if (text) {
    snapshot();
    s.text = text;
    render();
  }
});

function deleteSelected() {
  if (sel < 0) return;
  snapshot();
  shapes.splice(sel, 1);
  sel = -1;
  render();
}

document.querySelectorAll('[data-tool]').forEach((btn) =>
  btn.addEventListener('click', () => {
    const name = btn.dataset.tool;
    // Clicking the lit-up Crop button again removes the crop.
    if (name === 'crop' && tool === 'crop' && crop) {
      snapshot();
      crop = null;
      render();
      return;
    }
    const wasEmoji = tool === 'emoji';
    setTool(name);
    if (name === 'emoji') {
      $('emoji-panel').hidden = wasEmoji ? !$('emoji-panel').hidden : false;
      if (!$('emoji-panel').hidden) {
        renderEmojiGrid();
        $('emoji-q').focus();
      }
    }
  })
);

// --- paper size ---
for (const name of Object.keys(PAPERS)) $('paper').add(new Option(name, name));

// --- drag the finished image out of the tab ---
// (relies on Chrome's DownloadURL drag type; hide it where that isn't supported)
if (navigator.userAgent.includes('Firefox')) $('dragwrap').hidden = true;
const dragImg = $('dragout');
let dragKey = '';
let dragReady = false;
let dragUrl = null;
async function prepareDrag() {
  const c = cropRect();
  const barH = $('wm').checked ? LW * 10 : 0;
  if (c.h + barH > MAX_TILE_DIM || c.w * (c.h + barH) > MAX_TILE_AREA) {
    dragReady = false;
    $('dragwrap').title = 'Too large to drag out in one piece — use Export';
    return;
  }
  const key = JSON.stringify([shapes, crop, barH]);
  if (key === dragKey && dragReady) return;
  dragReady = false;
  dragKey = key;
  const cv = renderRegion(c, 0, c.h, barH);
  if (barH) stampFooter(cv, c.h, barH);
  const blob = await toBlob(cv, 'image/png');
  if (key !== dragKey) return;
  if (dragUrl) URL.revokeObjectURL(dragUrl);
  dragUrl = URL.createObjectURL(blob);
  dragImg.src = dragUrl;
  dragReady = true;
}
$('dragwrap').addEventListener('pointerenter', prepareDrag);
dragImg.addEventListener('dragstart', (ev) => {
  if (!dragReady) return ev.preventDefault();
  ev.dataTransfer.setData('DownloadURL', `image/png:bloosnap-${stamp()}.png:${dragUrl}`);
});

// --- fonts ---
for (const [name, stack] of Object.entries(FONTS)) {
  const o = new Option(name, stack);
  o.style.fontFamily = stack;
  $('font').add(o);
}
$('font').addEventListener('change', () => {
  const s = shapes[sel];
  if (s?.type === 'text') {
    snapshot();
    s.font = $('font').value;
    render();
  }
});

// --- emoji picker: popular row, search over Unicode names ---
function renderEmojiGrid() {
  const q = $('emoji-q').value.trim().toLowerCase();
  const grid = $('emoji-grid');
  const toks = q.split(/\s+/);
  const list = q ? EMOJI.filter(([, n]) => toks.every((t) => n.includes(t))).slice(0, 90).map((e) => e[0]) : POPULAR;
  grid.replaceChildren(
    ...list.map((ch) => {
      const b = document.createElement('button');
      b.textContent = ch;
      return b;
    })
  );
  if (q && !list.length) grid.textContent = 'No matches';
}
$('emoji-q').addEventListener('input', renderEmojiGrid);
$('emoji-grid').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  curEmoji = b.textContent;
  $('emoji-btn').textContent = `Emoji ${curEmoji}`;
  $('emoji-panel').hidden = true;
});
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#emoji-wrap')) $('emoji-panel').hidden = true;
});
$('color').addEventListener('change', () => {
  const s = shapes[sel];
  if (s && 'color' in s) {
    snapshot();
    s.color = $('color').value;
    render();
  }
});
$('undo').onclick = undo;
$('reset-crop').onclick = () => {
  if (!crop) return;
  snapshot();
  crop = null;
  render();
};
$('export-png').onclick = () => exportImage('png');
$('export-jpeg').onclick = () => exportImage('jpeg');
$('export-pdf').onclick = exportPdf;
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('emoji-panel').hidden = true;
  if (e.target.matches('input, select')) return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    undo();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteSelected();
  }
});
addEventListener('resize', () => {
  layout();
  render();
});

$('emoji-btn').textContent = `Emoji ${curEmoji}`;
setTool('rect');
layout();
render();

// --- MASH WORMS (family lore) ---
const mashBtn = $('mash');
const wormLayer = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'worms' }));
let wormTimer = null;
let mashed = 0;

function spawnWorm() {
  const w = document.createElement('div');
  w.className = 'worm';
  w.textContent = '🪱';
  w.style.left = `${Math.random() * (innerWidth - 60)}px`;
  w.style.top = `${60 + Math.random() * (innerHeight - 120)}px`;
  w.addEventListener('pointerdown', () => {
    if (w.classList.contains('squished')) return;
    w.classList.add('squished');
    const m = document.createElement('div');
    m.className = 'mash';
    m.textContent = '*mash*';
    m.style.left = w.style.left;
    m.style.top = w.style.top;
    wormLayer.append(m);
    setTimeout(() => m.remove(), 900);
    mashBtn.textContent = `🪱 Mashed: ${++mashed}`;
  });
  wormLayer.append(w);
  setTimeout(() => {
    w.style.opacity = 0;
    setTimeout(() => w.remove(), 600);
  }, 6000);
}

mashBtn.onclick = () => {
  const on = !wormTimer;
  clearInterval(wormTimer);
  wormTimer = on ? setInterval(spawnWorm, 1000) : null;
  mashBtn.classList.toggle('active', on);
  if (!on) {
    wormLayer.replaceChildren();
    mashBtn.textContent = mashed ? `🪱 Mashed: ${mashed}` : '🪱 Mash worms';
  } else spawnWorm();
};
