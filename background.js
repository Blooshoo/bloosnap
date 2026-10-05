import { saveCapture } from './db.js';

const MAX_TILE_DIM = 16384; // Chrome canvas side limit
const MAX_TILE_AREA = 268_000_000; // ~268M px canvas area limit
const CAPTURE_GAP_MS = 600; // captureVisibleTab is limited to ~2 calls/sec
const MAX_FRAMES = 120; // keeps infinite-scroll pages from running forever

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = async (tabId, func, args = []) =>
  (await chrome.scripting.executeScript({ target: { tabId }, func, args }))[0].result;

// --- functions injected into the page (must be self-contained) ---

// Decides what to scroll: the page, else the dominant inner scroller or same-origin iframe.
// Returns the scroll viewport as `rect` (CSS px, relative to the tab viewport).
function pageMeasure() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const root = document.scrollingElement || document.documentElement;
  const state = { docs: [document], fixed: [], el: root, startTop: root.scrollTop };
  window.__bloosnap = state;
  const info = { dpr: window.devicePixelRatio, viewWidth: vw };

  const frames = [];
  for (const f of document.querySelectorAll('iframe')) {
    try {
      if (f.contentDocument) {
        state.docs.push(f.contentDocument);
        frames.push(f);
      }
    } catch {} // cross-origin: can't reach inside
  }

  if (root.scrollHeight > vh * 1.05) {
    return { ...info, totalHeight: root.scrollHeight, rect: { x: 0, y: 0, w: vw, h: vh } };
  }

  let best = null;
  const offer = (el, box, total) => {
    const inside = box.x >= -1 && box.y >= -1 && box.x + box.w <= vw + 1 && box.y + box.h <= vh + 1;
    const area = box.w * box.h;
    if (inside && area >= vw * vh * 0.35 && total > box.h + 20 && (!best || area > best.area)) {
      best = { el, box, total, area };
    }
  };
  for (const el of document.querySelectorAll('*')) {
    if (el === document.body || el === document.documentElement) continue;
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 20) {
      const r = el.getBoundingClientRect();
      offer(el, { x: r.left + el.clientLeft, y: r.top + el.clientTop, w: el.clientWidth, h: el.clientHeight }, el.scrollHeight);
    }
  }
  for (const f of frames) {
    const se = f.contentDocument.scrollingElement;
    if (!se) continue;
    const r = f.getBoundingClientRect();
    offer(se, { x: r.left + f.clientLeft, y: r.top + f.clientTop, w: f.clientWidth, h: f.clientHeight }, se.scrollHeight);
  }
  if (best) {
    state.el = best.el;
    state.startTop = best.el.scrollTop;
    return { ...info, totalHeight: best.total, rect: best.box };
  }
  return { ...info, totalHeight: vh, rect: { x: 0, y: 0, w: vw, h: vh } };
}

const pageHeight = () => window.__bloosnap.el.scrollHeight;

function pageScrollTo(y) {
  const e = window.__bloosnap.el;
  e.scrollTo({ top: y, left: 0, behavior: 'instant' });
  return e.scrollTop;
}

// Fixed headers should show once at the top, fixed footers once at the bottom.
// Sticky elements that start away from the top are left alone (they sit in normal flow).
function pageCollectFixed() {
  const s = window.__bloosnap;
  for (const d of s.docs) {
    const win = d.defaultView;
    for (const e of d.querySelectorAll('*')) {
      const pos = win.getComputedStyle(e).position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      const r = e.getBoundingClientRect();
      if (pos === 'sticky' && r.top > 100) continue;
      s.fixed.push({ e, orig: e.style.visibility, bottom: r.top + r.height / 2 > win.innerHeight / 2 });
    }
  }
}

function pageSetFixed(showTop, showBottom) {
  for (const f of window.__bloosnap.fixed) {
    f.e.style.visibility = (f.bottom ? showBottom : showTop) ? f.orig : 'hidden';
  }
}

function pageRestore() {
  const s = window.__bloosnap;
  if (!s) return;
  for (const f of s.fixed) f.e.style.visibility = f.orig;
  s.el.scrollTo({ top: s.startTop, left: 0, behavior: 'instant' });
  delete window.__bloosnap;
}

// --- capture + stitch ---

async function capturePage(tab) {
  const m = await run(tab.id, pageMeasure);
  const step = Math.max(1, Math.floor(m.rect.h));
  let layout = null; // created from the first frame, once the real pixel scale is known
  let last = 0;

  const place = (bitmap, y) => {
    if (!layout) {
      const scale = bitmap.width / m.viewWidth;
      const width = Math.round(m.rect.w * scale);
      const totalPx = Math.round(m.totalHeight * scale);
      const tileH = Math.min(MAX_TILE_DIM, Math.floor(MAX_TILE_AREA / width));
      const canvases = [];
      for (let top = 0; top < totalPx; top += tileH) {
        canvases.push({ top, h: Math.min(tileH, totalPx - top), cv: new OffscreenCanvas(width, Math.min(tileH, totalPx - top)) });
      }
      layout = { scale, width, canvases };
    }
    const { scale, width, canvases } = layout;
    const dy = Math.round(y * scale);
    const sh = m.rect.h * scale;
    for (const t of canvases) {
      if (dy + sh <= t.top || dy >= t.top + t.h) continue;
      t.cv.getContext('2d').drawImage(bitmap, m.rect.x * scale, m.rect.y * scale, m.rect.w * scale, sh, 0, dy - t.top, width, sh);
    }
  };

  try {
    // Warm-up pass so lazy-loaded content appears (and the real height is known) before capturing.
    let probeMax = Math.max(0, Math.ceil(m.totalHeight) - step);
    for (let y = step; y < probeMax; y += step) {
      await run(tab.id, pageScrollTo, [y]);
      await sleep(120);
    }
    if (probeMax > 0) {
      await run(tab.id, pageScrollTo, [0]);
      await sleep(300);
      m.totalHeight = await run(tab.id, pageHeight);
    }

    let maxY = Math.max(0, Math.ceil(m.totalHeight) - step);
    if (maxY > (MAX_FRAMES - 1) * step) {
      maxY = (MAX_FRAMES - 1) * step;
      m.totalHeight = maxY + step;
    }
    const ys = [];
    for (let y = 0; y < maxY; y += step) ys.push(y);
    ys.push(maxY);

    await run(tab.id, pageCollectFixed);
    let prevY = -1;
    for (let i = 0; i < ys.length; i++) {
      const actualY = await run(tab.id, pageScrollTo, [ys[i]]);
      await run(tab.id, pageSetFixed, [i === 0, i === ys.length - 1]);
      chrome.action.setBadgeText({ tabId: tab.id, text: `${i + 1}/${ys.length}` });
      await sleep(Math.max(150, CAPTURE_GAP_MS - (Date.now() - last)));
      last = Date.now();
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
      if (actualY !== prevY) place(bitmap, actualY);
      prevY = actualY;
      bitmap.close();
    }
  } finally {
    await run(tab.id, pageRestore);
    chrome.action.setBadgeText({ tabId: tab.id, text: '' });
  }

  const tiles = [];
  for (const t of layout.canvases) tiles.push(await t.cv.convertToBlob({ type: 'image/png' }));
  return tiles;
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    const tiles = await capturePage(tab);
    const id = crypto.randomUUID();
    await saveCapture({ id, url: tab.url, title: tab.title, date: Date.now(), tiles });
    await chrome.tabs.create({ url: chrome.runtime.getURL(`editor.html?id=${id}`) });
  } catch (err) {
    console.error('BlooSnap capture failed', err);
    chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#d33' });
    chrome.action.setBadgeText({ tabId: tab.id, text: 'ERR' });
    chrome.action.setTitle({ tabId: tab.id, title: `BlooSnap failed: ${err.message}` });
    setTimeout(() => {
      chrome.action.setBadgeText({ tabId: tab.id, text: '' });
      chrome.action.setTitle({ tabId: tab.id, title: 'BlooSnap: capture full page' });
    }, 10_000);
  }
});
