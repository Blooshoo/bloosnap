"""Tiny Chrome DevTools Protocol client (needs the `websockets` package)."""
import asyncio
import json
import urllib.request

import websockets


class CDP:
    def __init__(self, ws):
        self.ws = ws
        self.n = 0
        self.pending = {}
        self.handlers = []

    @classmethod
    async def connect(cls, url):
        c = cls(await websockets.connect(url, max_size=None))
        c.task = asyncio.create_task(c._loop())
        return c

    async def _loop(self):
        async for raw in self.ws:
            m = json.loads(raw)
            if 'id' in m and m['id'] in self.pending:
                self.pending.pop(m['id']).set_result(m)
            else:
                for h in self.handlers:
                    asyncio.create_task(h(m))

    async def send(self, method, params=None, session=None):
        self.n += 1
        fut = asyncio.get_running_loop().create_future()
        self.pending[self.n] = fut
        msg = {'id': self.n, 'method': method, 'params': params or {}}
        if session:
            msg['sessionId'] = session
        await self.ws.send(json.dumps(msg))
        r = await fut
        if 'error' in r:
            raise RuntimeError(f"{method}: {r['error']}")
        return r.get('result', {})


def browser_ws(port):
    # bypass any HTTP proxy env vars: this is plain localhost
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return json.load(opener.open(f'http://127.0.0.1:{port}/json/version', timeout=5))['webSocketDebuggerUrl']
