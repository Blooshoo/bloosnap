#!/usr/bin/env python3
"""Draw the BlooSnap icon (blue viewfinder + a worm) and write icons/icon{16,32,48,128}.png.

    python3 tools/gen-icons.py      # needs Pillow

Drawn at 1024px and downsampled so edges stay smooth at every size.
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw

BIG = 1024
OUT = Path(__file__).resolve().parent.parent / 'icons'


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def background():
    top, bot = (74, 144, 255), (36, 90, 214)
    grad = Image.new('RGB', (BIG, BIG))
    px = grad.load()
    for y in range(BIG):
        c = lerp(top, bot, y / (BIG - 1))
        for x in range(BIG):
            px[x, y] = c
    mask = Image.new('L', (BIG, BIG), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, BIG - 1, BIG - 1), radius=int(BIG * 0.22), fill=255)
    img = grad.convert('RGBA')
    img.putalpha(mask)
    return img


def brackets(d):
    """Camera-viewfinder corners."""
    inset, arm, w = 170, 210, 58
    lo, hi = inset, BIG - inset
    for sx, x0 in ((1, lo), (-1, hi)):
        for sy, y0 in ((1, lo), (-1, hi)):
            d.line([(x0, y0 + sy * arm), (x0, y0), (x0 + sx * arm, y0)], fill='white', width=w, joint='curve')
            for cx, cy in ((x0, y0 + sy * arm), (x0 + sx * arm, y0), (x0, y0)):  # round the ends
                d.ellipse((cx - w // 2, cy - w // 2, cx + w // 2, cy + w // 2), fill='white')


def worm(img):
    d = ImageDraw.Draw(img)
    n = 240
    pts = []
    for i in range(n + 1):
        t = i / n
        x = 300 + 430 * t
        y = 560 - 120 * math.sin(2 * math.pi * t * 1.1 + 0.4)
        pts.append((x, y, t))
    light, dark = (255, 140, 178), (233, 92, 140)
    for x, y, t in pts:  # body: stamped discs, tapering toward the tail, with soft ring bands
        r = 40 + 26 * t
        band = 0.5 + 0.5 * math.sin(t * 2 * math.pi * 7)
        c = lerp(dark, light, 0.35 + 0.65 * band)
        d.ellipse((x - r, y - r, x + r, y + r), fill=c)
    hx, hy, _ = pts[-1]
    hr = 78
    d.ellipse((hx - hr, hy - hr, hx + hr, hy + hr), fill=light)
    for ex in (-30, 34):  # eyes
        d.ellipse((hx + ex - 24, hy - 28 - 24, hx + ex + 24, hy - 28 + 24), fill='white')
        d.ellipse((hx + ex - 6, hy - 34 - 6, hx + ex + 18, hy - 34 + 18), fill=(30, 30, 50))
    d.arc((hx - 36, hy - 10, hx + 36, hy + 44), 20, 160, fill=(150, 40, 80), width=9)  # smile


def main():
    img = background()
    brackets(ImageDraw.Draw(img))
    worm(img)
    OUT.mkdir(exist_ok=True)
    for size in (16, 32, 48, 128):
        img.resize((size, size), Image.LANCZOS).save(OUT / f'icon{size}.png')
        print('wrote', OUT / f'icon{size}.png')


if __name__ == '__main__':
    main()
