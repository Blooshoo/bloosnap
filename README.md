# BlooSnap

Brave/Chrome (Manifest V3) extension: full-page capture with a small built-in editor.

## Install (unpacked)
1. Open `brave://extensions` (or `chrome://extensions`), enable Developer mode.
2. Load unpacked → pick this folder.
3. Click the toolbar icon or press **Alt+Shift+S** (rebind at `brave://extensions/shortcuts`).

## What it does
- Scroll-and-stitch capture; handles sticky/fixed bars, lazy-loaded content, inner scrollers and same-origin iframes. Oversized pages split into tiles (canvas limit).
- Editor: crop, redact (black / pixelate), rect, arrow, highlight, text (fonts), emoji (searchable), select/move/resize/delete, undo.
- Export PNG / JPG / PDF (A4, Letter, Legal; page breaks fall in whitespace), optional URL + date watermark, drag the image out of the tab.
- Permissions: `activeTab`, `scripting` only.

## Layout
| File | Role |
|---|---|
| `background.js` | Capture: measure, scroll, `captureVisibleTab`, stitch into tiles, store in IndexedDB |
| `db.js` | IndexedDB helpers (captures are too big for `chrome.storage`) |
| `editor.html` / `editor.js` | Editor UI; annotations in image-pixel space, flattened on export |
| `pdf.js` | Dependency-free PDF writer (one JPEG per page) |
| `emoji-data.js` | Generated emoji search list (Unicode names + aliases) |
| `bloosnap.md` | Original feature wishlist |

## Known gaps
- Cross-origin iframes can't be scrolled (`activeTab` limit).
- Scrollbars may appear in captures; PDF text isn't selectable.
- Crop can't be resized after drawing; no progress UI during export.
- Only tested by hand; no automated tests.

## Package
`./package.sh` → `dist/bloosnap-<version>.zip`
