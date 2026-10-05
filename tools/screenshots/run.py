#!/usr/bin/env python3
"""Regenerate docs/screenshots by driving the REAL extension in headless Brave/Chromium.

It copies the extension to a temp dir (adding host_permissions, since headless can't
grant activeTab), serves a fake demo page, runs the extension's actual capture code
against it, then scripts the editor (annotate, redact, crop, emoji, PDF, worms).

    python3 tools/screenshots/run.py [--out DIR] [--brave "CMD ..."]

Needs: python3 + `websockets`, poppler (`pdftoppm`), and Brave/Chromium
(default: the Flatpak `com.brave.Browser`, else `brave-browser`/`chromium`/`google-chrome`).
"""
import argparse
import asyncio
import base64
import hashlib
import http.server
import json
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from cdp import CDP, browser_ws

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
EXT_FILES = ['manifest.json', 'background.js', 'db.js', 'editor.html', 'editor.js', 'pdf.js', 'emoji-data.js', 'icons']


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def find_browser(override):
    if override:
        return shlex.split(override)
    if shutil.which('flatpak') and subprocess.run(['flatpak', 'info', 'com.brave.Browser'], capture_output=True).returncode == 0:
        return ['flatpak', 'run', 'com.brave.Browser']
    for name in ('brave-browser', 'brave', 'chromium', 'google-chrome'):
        if shutil.which(name):
            return [name]
    sys.exit('No Brave/Chromium found; pass --brave "CMD".')


def unpacked_ext_id(path):
    """Chrome derives an unpacked extension's id from its absolute path."""
    h = hashlib.sha256(str(path).encode()).hexdigest()[:32]
    return ''.join(chr(ord('a') + int(c, 16)) for c in h)


class Page:
    def __init__(self, c, sid):
        self.c, self.sid = c, sid

    async def send(self, method, params=None):
        return await self.c.send(method, params, self.sid)

    async def ev(self, expr):
        r = await self.send('Runtime.evaluate', {'expression': expr, 'awaitPromise': True, 'returnByValue': True})
        if 'exceptionDetails' in r:
            raise RuntimeError(json.dumps(r['exceptionDetails'])[:500])
        return r['result'].get('value')

    async def mouse(self, kind, x, y, **k):
        await self.send('Input.dispatchMouseEvent', {'type': kind, 'x': x, 'y': y, 'clickCount': 1,
                                                     'button': 'none' if kind == 'mouseMoved' else 'left', **k})

    async def click(self, x, y):
        await self.mouse('mouseMoved', x, y)
        await self.mouse('mousePressed', x, y)
        await self.mouse('mouseReleased', x, y)

    async def drag(self, x1, y1, x2, y2, steps=8):
        await self.mouse('mouseMoved', x1, y1)
        await self.mouse('mousePressed', x1, y1)
        for i in range(1, steps + 1):
            await self.mouse('mouseMoved', x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps, buttons=1)
        await self.mouse('mouseReleased', x2, y2)


async def attach(c, target_id):
    return Page(c, (await c.send('Target.attachToTarget', {'targetId': target_id, 'flatten': True}))['sessionId'])


async def drive(cdp_port, demo_url, ext_dir, dl_dir, out):
    sleep = asyncio.sleep
    c = await CDP.connect(browser_ws(cdp_port))
    await c.send('Browser.setDownloadBehavior', {'behavior': 'allow', 'downloadPath': str(dl_dir)})
    ext_id = unpacked_ext_id(ext_dir)

    demo_t = (await c.send('Target.createTarget', {'url': demo_url}))['targetId']
    demo = await attach(c, demo_t)
    await demo.send('Page.enable')
    await demo.send('Emulation.setFocusEmulationEnabled', {'enabled': True})
    await sleep(1.5)
    geo = await demo.ev("""(()=>{const g=e=>{const r=e.getBoundingClientRect();return {x:r.left,y:r.top+scrollY,w:r.width,h:r.height}};
      const q=s=>g(document.querySelector(s));
      return {p1:q('main p'),bars:q('.bars'),card:q('.card'),
              codes:[...document.querySelectorAll('.card code')].map(g),vh:innerHeight}})()""")

    # --- real capture: run the extension's own background.js source in its service worker ---
    async def find_sw():
        for t in (await c.send('Target.getTargets'))['targetInfos']:
            if t['type'] == 'service_worker' and ext_id in t['url']:
                return t

    sw = await find_sw()
    if not sw:  # MV3 workers sleep; wake it with a message from an extension page
        poke_t = (await c.send('Target.createTarget', {'url': f'chrome-extension://{ext_id}/editor.html?id=none'}))['targetId']
        poke = await attach(c, poke_t)
        await poke.send('Runtime.enable')
        await poke.ev('chrome.runtime.sendMessage({ping:1}).catch(()=>1)')
        for _ in range(20):
            sw = await find_sw()
            if sw:
                break
            await sleep(0.5)
        await c.send('Target.closeTarget', {'targetId': poke_t})
    if not sw:
        raise RuntimeError('extension service worker not found (did the extension load?)')
    swp = await attach(c, sw['targetId'])
    db = (ext_dir / 'db.js').read_text().replace('export ', '')
    bg = re.sub(r'^import .*\n', '', (ext_dir / 'background.js').read_text(), flags=re.M)
    await c.send('Target.activateTarget', {'targetId': demo_t})
    await demo.send('Page.bringToFront')
    await sleep(1)
    res = await swp.ev("(async()=>{" + db + "\n" + bg + """
      const tab=(await chrome.tabs.query({url:'""" + demo_url + """*'}))[0];
      const tiles=await capturePage(tab); const id=crypto.randomUUID();
      await saveCapture({id,url:'https://pawsomedaily.example/capybara-mayor',title:tab.title,date:Date.now(),tiles});
      return {id,tiles:tiles.length};})()""")
    print('captured', res, flush=True)

    # --- editor ---
    ed_t = (await c.send('Target.createTarget', {'url': f'chrome-extension://{ext_id}/editor.html?id={res["id"]}'}))['targetId']
    ed = await attach(c, ed_t)
    await ed.send('Page.enable')
    await ed.send('Runtime.enable')
    dialog_text = ['']

    async def on_msg(m):
        if m.get('method') == 'Page.javascriptDialogOpening' and m.get('sessionId') == ed.sid:
            await ed.send('Page.handleJavaScriptDialog', {'accept': True, 'promptText': dialog_text[0]})
    c.handlers.append(on_msg)
    await sleep(2)

    # Guard: headless sometimes serves stale frames; every viewport-sized band would then repeat.
    fresh = await ed.ev("""(async()=>{const id=new URLSearchParams(location.search).get('id');
      const db=await new Promise(r=>{const q=indexedDB.open('bloosnap',1);q.onsuccess=()=>r(q.result)});
      const rec=await new Promise(r=>{const q=db.transaction('captures').objectStore('captures').get(id);q.onsuccess=()=>r(q.result)});
      const bmp=await createImageBitmap(rec.tiles[0]); const vh=%d; if(bmp.height<vh*2) return true;
      const cv=new OffscreenCanvas(bmp.width,vh*2); const x=cv.getContext('2d'); x.drawImage(bmp,0,0);
      const a=x.getImageData(0,0,bmp.width,60).data, b=x.getImageData(0,vh,bmp.width,60).data;
      for(let i=0;i<a.length;i++) if(a[i]!==b[i]) return true; return false})()""" % geo['vh'])
    if not fresh:
        raise RuntimeError('capture contains repeated frames (headless rendering went stale); re-run')

    async def shot(name):
        r = await ed.send('Page.captureScreenshot', {'format': 'png'})
        (out / f'{name}.png').write_bytes(base64.b64decode(r['data']))
        print('shot', name, flush=True)

    async def geom():
        return await ed.ev("(()=>{const s=document.getElementById('overlay'),r=s.getBoundingClientRect(),vb=s.viewBox.baseVal;"
                           "return {l:r.left,t:r.top,sx:r.width/vb.width,sy:r.height/vb.height,y0:scrollY}})()")

    async def scroll_to(y, margin=125):
        g = await geom()
        await ed.ev(f"window.scrollTo(0,{g['t'] + g['y0'] + y * g['sy'] - margin})")
        await sleep(0.3)

    async def pt(x, y):
        g = await geom()
        return g['l'] + x * g['sx'], g['t'] + y * g['sy']

    async def tool(name):
        await ed.ev(f"document.querySelector('[data-tool={name}]').click()")
        await sleep(0.15)

    async def drag_img(x1, y1, x2, y2):
        await ed.drag(*await pt(x1, y1), *await pt(x2, y2))
        await sleep(0.15)

    async def click_img(x, y):
        await ed.click(*await pt(x, y))
        await sleep(0.3)

    p1, bars, card, codes = geo['p1'], geo['bars'], geo['card'], geo['codes']
    await shot('capture')

    # annotate
    await scroll_to(200)
    await tool('highlight')
    await drag_img(p1['x'] - 6, p1['y'] - 4, p1['x'] + p1['w'] + 6, p1['y'] + p1['h'] + 2)
    await tool('rect')
    await drag_img(bars['x'] - 12, bars['y'] - 10, bars['x'] + bars['w'] + 12, bars['y'] + bars['h'] + 12)
    await tool('arrow')
    await drag_img(1010, 345, 690, 320)
    await tool('emoji')
    await click_img(bars['x'] + 260, bars['y'] - 64)
    dialog_text[0] = 'GERALD FOR MAYOR!'
    await ed.ev("document.getElementById('color').value='#fff200'")  # no change event: only affects new shapes
    await tool('text')
    await click_img(800, 262)
    await sleep(0.4)
    await shot('annotate')

    # redact
    await scroll_to(card['y'] - 110)
    await tool('black')
    await drag_img(codes[0]['x'] - 6, codes[0]['y'] - 4, codes[0]['x'] + codes[0]['w'] + 6, codes[0]['y'] + codes[0]['h'] + 4)
    await tool('pixel')
    await drag_img(codes[1]['x'] - 6, codes[1]['y'] - 4, codes[1]['x'] + codes[1]['w'] + 6, codes[1]['y'] + codes[1]['h'] + 4)
    await tool('select')
    await click_img(codes[0]['x'] + 20, codes[0]['y'] + 10)
    await sleep(0.3)
    await shot('redact')

    # crop, then un-crop by clicking the lit Crop button again
    await tool('crop')
    await drag_img(280, card['y'] - 90, 1120, card['y'] + card['h'] + 70)
    await sleep(0.3)
    await shot('crop')
    await tool('crop')

    # emoji picker
    await scroll_to(0)
    await tool('emoji')
    await ed.ev("document.getElementById('emoji-q').focus()")
    await ed.send('Input.insertText', {'text': 'heart'})
    await sleep(0.4)
    await shot('emoji-picker')
    await ed.send('Input.dispatchKeyEvent', {'type': 'keyDown', 'key': 'Escape', 'code': 'Escape', 'windowsVirtualKeyCode': 27})
    await tool('select')

    # PDF with watermark
    await ed.ev("document.getElementById('wm').click()")
    before = {p.name for p in dl_dir.iterdir()}
    await ed.ev("document.getElementById('export-pdf').click()")
    pdf = None
    for _ in range(40):
        new = [p for p in dl_dir.iterdir() if p.name not in before and p.suffix == '.pdf']
        if new:
            pdf = new[0]
            break
        await sleep(0.5)
    if not pdf:
        raise RuntimeError('PDF download never appeared')
    subprocess.run(['pdftoppm', '-png', '-singlefile', '-r', '100', '-f', '1', '-l', '1', str(pdf), str(out / 'pdf-watermark')], check=True)
    print('shot pdf-watermark', flush=True)

    # mash worms
    await ed.ev('window.scrollTo(0,0)')
    await ed.ev("document.getElementById('mash').click()")
    await sleep(3.4)
    worms = await ed.ev("[...document.querySelectorAll('.worm')].map(w=>{const r=w.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})")
    for x, y in worms[:3]:
        await ed.click(x, y)
    await sleep(0.12)
    await shot('mash-worms')
    await c.send('Browser.close')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', default=str(REPO / 'docs' / 'screenshots'), help='output directory')
    ap.add_argument('--brave', help='browser command, e.g. "flatpak run com.brave.Browser"')
    args = ap.parse_args()
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    browser = find_browser(args.brave)

    # temp dir under ~ so a Flatpak'd browser can be granted access to it
    base = Path.home() / '.cache' / 'bloosnap-shots'
    base.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(dir=base))
    ext_dir, profile, dl = tmp / 'ext', tmp / 'profile', tmp / 'dl'
    for d in (ext_dir, profile, dl):
        d.mkdir()
    for name in EXT_FILES:
        src = REPO / name
        if src.is_dir():
            shutil.copytree(src, ext_dir / name)
        else:
            shutil.copy(src, ext_dir / name)
    manifest = json.loads((ext_dir / 'manifest.json').read_text())
    manifest['host_permissions'] = ['<all_urls>']  # headless can't grant activeTab
    (ext_dir / 'manifest.json').write_text(json.dumps(manifest, indent=2))

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=str(HERE / 'demo'), **k)

        def log_message(self, *a):
            pass

    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Quiet)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    demo_url = f'http://127.0.0.1:{httpd.server_address[1]}/'

    cdp_port = free_port()
    cmd = list(browser)
    if cmd[0] == 'flatpak':
        cmd[2:2] = [f'--filesystem={tmp}']
    cmd += ['--headless=new', '--window-size=1400,900', f'--remote-debugging-port={cdp_port}', f'--user-data-dir={profile}',
            f'--load-extension={ext_dir}', '--no-first-run', '--no-default-browser-check',
            # headless otherwise serves stale frames after scrolling
            '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion',
            '--run-all-compositor-stages-before-draw', 'about:blank']
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        for _ in range(60):
            try:
                browser_ws(cdp_port)
                break
            except Exception:
                time.sleep(0.5)
        else:
            sys.exit('browser did not start')
        asyncio.run(drive(cdp_port, demo_url, ext_dir, dl, out))
        print('done ->', out)
    finally:
        proc.terminate()
        # Flatpak'd browsers outlive the launcher; match only OUR profile dir
        subprocess.run(['pkill', '-9', '-f', f'user-data-dir={profile}'], capture_output=True)
        httpd.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    main()
