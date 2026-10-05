#!/usr/bin/env python3
"""Firefox smoke test: loads BlooSnap as a temporary add-on in headless Firefox (WebDriver BiDi),
runs the real capture code on a fake demo page, draws two shapes, exports PNG + PDF, and asserts.

    python3 tools/firefox-smoke/run.py [--firefox PATH]

Needs: python3 + `websockets`, Firefox >= 140, poppler (`pdfinfo`). Exits non-zero on failure.

Notes: headless drivers can't click the toolbar button or navigate to moz-extension:// pages, so the
test copy of the extension opens its own page, and the capture code (background.js) is evaluated there.
"""
import argparse
import asyncio
import http.server
import json
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import websockets

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
DEMO = REPO / 'tools' / 'screenshots' / 'demo'
UUID = '11111111-2222-4333-8444-555555555555'  # pinned so moz-extension URLs are predictable
EXT_FILES = ['manifest.json', 'background.js', 'db.js', 'editor.html', 'editor.js', 'pdf.js', 'emoji-data.js', 'icons']


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class BiDi:
    def __init__(self, ws):
        self.ws, self.n, self.pending = ws, 0, {}

    async def pump(self):
        async for raw in self.ws:
            m = json.loads(raw)
            if 'id' in m and m['id'] in self.pending:
                self.pending.pop(m['id']).set_result(m)

    async def send(self, method, params=None):
        self.n += 1
        fut = asyncio.get_running_loop().create_future()
        self.pending[self.n] = fut
        await self.ws.send(json.dumps({'id': self.n, 'method': method, 'params': params or {}}))
        r = await asyncio.wait_for(fut, 120)
        if r.get('type') == 'error':
            raise RuntimeError(f"{method}: {r.get('error')} {r.get('message')}"[:500])
        return r['result']

    async def ev(self, ctx, expr):
        """Evaluate; expression must produce a JSON string (or a promise of one)."""
        r = await self.send('script.evaluate', {'expression': expr, 'target': {'context': ctx},
                                                'awaitPromise': True, 'resultOwnership': 'none'})
        if r['type'] == 'exception':
            raise RuntimeError(json.dumps(r['exceptionDetails'])[:500])
        return json.loads(r['result']['value'])


async def run(firefox, tmp):
    ext, prof, dl = tmp / 'ext', tmp / 'profile', tmp / 'dl'
    for d in (ext, prof, dl):
        d.mkdir()
    for n in EXT_FILES:
        src = REPO / n
        if src.is_dir():
            shutil.copytree(src, ext / n)
        else:
            shutil.copy(src, ext / n)
    m = json.loads((ext / 'manifest.json').read_text())
    m['host_permissions'] = ['<all_urls>']
    (ext / 'manifest.json').write_text(json.dumps(m, indent=2))
    with open(ext / 'background.js', 'a') as f:  # test-only: open our own page for the driver to use
        f.write("\nchrome.tabs.create({ url: chrome.runtime.getURL('editor.html?id=none'), active: false });\n")
    prefs = {
        'extensions.webextensions.uuids': json.dumps({'bloosnap@blooshoo.com': UUID}),
        'browser.download.folderList': 2, 'browser.download.dir': str(dl), 'browser.download.useDownloadDir': True,
        'browser.download.always_ask_before_handling_new_types': False,
        'browser.helperApps.neverAsk.saveToDisk': 'application/pdf,image/png,image/jpeg',
    }
    (prof / 'user.js').write_text(''.join(f'user_pref({json.dumps(k)}, {json.dumps(v)});\n' for k, v in prefs.items()))

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=str(DEMO), **k)

        def log_message(self, *a):
            pass

    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Quiet)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    demo_url = f'http://127.0.0.1:{httpd.server_address[1]}/'
    port = free_port()
    proc = subprocess.Popen([firefox, '--headless', '--no-remote', '--profile', str(prof), f'--remote-debugging-port={port}',
                             '--window-size=1400,900', 'about:blank'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    checks = []

    def check(name, ok, detail=''):
        checks.append(ok)
        print(('PASS' if ok else 'FAIL'), name, detail, flush=True)

    try:
        ws = None
        for _ in range(60):
            try:
                ws = await websockets.connect(f'ws://127.0.0.1:{port}/session', max_size=None)
                break
            except Exception:
                await asyncio.sleep(0.5)
        if not ws:
            raise RuntimeError('Firefox BiDi websocket never came up')
        b = BiDi(ws)
        asyncio.create_task(b.pump())
        await b.send('session.new', {'capabilities': {}})
        await b.send('webExtension.install', {'extensionData': {'type': 'path', 'path': str(ext)}})
        demo = (await b.send('browsingContext.getTree'))['contexts'][0]['context']
        await b.send('browsingContext.setViewport', {'context': demo, 'viewport': {'width': 1400, 'height': 800}})
        await b.send('browsingContext.navigate', {'context': demo, 'url': demo_url, 'wait': 'complete'})

        page = None
        for _ in range(40):
            for c in (await b.send('browsingContext.getTree'))['contexts']:
                if c['url'].startswith('moz-extension://'):
                    page = c['context']
            if page:
                break
            await asyncio.sleep(0.5)
        check('extension loaded and opened its page', bool(page))
        if not page:
            return checks
        await asyncio.sleep(1)

        db = (ext / 'db.js').read_text().replace('export ', '')
        bg = re.sub(r'^import .*\n', '', (ext / 'background.js').read_text(), flags=re.M)
        res = await b.ev(page, "(async()=>{" + db + "\n" + bg + """
          const tab=(await chrome.tabs.query({})).find(t=>t.url.startsWith('""" + demo_url + """'));
          const tiles=await capturePage(tab); const id=crypto.randomUUID();
          await saveCapture({id,url:'https://pawsomedaily.example/capybara-mayor',title:tab.title,date:Date.now(),tiles});
          return JSON.stringify({id,tiles:tiles.length});})()""")
        check('capture produced a tile', res['tiles'] >= 1)
        await b.ev(page, 'setTimeout(()=>{location.href="editor.html?id=' + res['id'] + '"},50); JSON.stringify(1)')
        await asyncio.sleep(3)

        st = await b.ev(page, """(async()=>{
          const id=new URLSearchParams(location.search).get('id');
          const db=await new Promise(r=>{const q=indexedDB.open('bloosnap',1);q.onsuccess=()=>r(q.result)});
          const rec=await new Promise(r=>{const q=db.transaction('captures').objectStore('captures').get(id);q.onsuccess=()=>r(q.result)});
          const bmp=await createImageBitmap(rec.tiles[0]); const vh=800;
          const cv=new OffscreenCanvas(bmp.width,Math.min(bmp.height,vh*2)); const x=cv.getContext('2d'); x.drawImage(bmp,0,0);
          const a=x.getImageData(0,0,bmp.width,60).data, c=x.getImageData(0,vh,bmp.width,60).data; let same=true;
          for(let i=0;i<a.length;i++) if(a[i]!==c[i]){same=false;break}
          const dw=document.getElementById('dragwrap');
          return JSON.stringify({w:bmp.width,h:bmp.height,repeated:same,
                                 dragHidden:getComputedStyle(dw).display==='none',
                                 info:document.getElementById('info').textContent})})()""")
        check('stitched capture has no repeated frames', st['h'] > 1600 and not st['repeated'], f"{st['w']}x{st['h']}")
        check('editor loaded the capture', 'Pawsome Daily' in st['info'])
        check('Chrome-only drag-out chip is hidden', st['dragHidden'])

        async def drag(x1, y1, x2, y2):
            acts = [{'type': 'pointer', 'id': 'm', 'parameters': {'pointerType': 'mouse'}, 'actions': [
                {'type': 'pointerMove', 'x': x1, 'y': y1}, {'type': 'pointerDown', 'button': 0},
                {'type': 'pointerMove', 'x': (x1 + x2) // 2, 'y': (y1 + y2) // 2}, {'type': 'pointerMove', 'x': x2, 'y': y2},
                {'type': 'pointerUp', 'button': 0}]}]
            await b.send('input.performActions', {'context': page, 'actions': acts})

        await drag(40, 390, 720, 520)  # rect tool is the default
        await b.ev(page, 'document.querySelector("[data-tool=highlight]").click(); JSON.stringify(1)')
        await drag(320, 575, 1030, 620)
        await b.ev(page, 'document.getElementById("wm").click(); document.getElementById("export-png").click(); JSON.stringify(1)')
        await asyncio.sleep(2)
        await b.ev(page, 'document.getElementById("export-pdf").click(); JSON.stringify(1)')
        for _ in range(20):
            if list(dl.glob('*.pdf')) and list(dl.glob('*.png')):
                break
            await asyncio.sleep(0.5)
        pngs, pdfs = list(dl.glob('*.png')), list(dl.glob('*.pdf'))
        check('PNG export downloaded', bool(pngs))
        check('PDF export downloaded', bool(pdfs))
        if pdfs:
            info = subprocess.run(['pdfinfo', str(pdfs[0])], capture_output=True, text=True).stdout
            check('PDF is valid A4', 'A4' in info, re.search(r'Pages:\s+\d+', info).group(0) if 'Pages' in info else '')
    finally:
        proc.terminate()
        subprocess.run(['pkill', '-9', '-f', f'--profile {prof}'], capture_output=True)  # only OUR profile
        httpd.shutdown()
    return checks


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--firefox', default='firefox')
    args = ap.parse_args()
    tmp = Path(tempfile.mkdtemp(prefix='bloosnap-ff-'))
    try:
        checks = asyncio.run(run(args.firefox, tmp))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    ok = bool(checks) and all(checks)
    print('ALL PASSED' if ok else 'FAILED')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
