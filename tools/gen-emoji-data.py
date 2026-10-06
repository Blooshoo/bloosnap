#!/usr/bin/env python3
"""Regenerate emoji-data.js (the emoji picker's search list) from Unicode character names.

    python3 tools/gen-emoji-data.py [--out emoji-data.js]

Each entry is [emoji, "unicode name + a few hand-written aliases"]. Names come from Python's
`unicodedata`, so the exact list depends on the Python/Unicode version (checked in with Unicode 15.0).
The output is plain, unminified JS. Nothing else in the extension is generated or bundled.
"""
import argparse
import json
import unicodedata
from pathlib import Path

# Code point ranges that are (almost) all real emoji
RANGES = [
    (0x1F300, 0x1F320), (0x1F32D, 0x1F335), (0x1F337, 0x1F37C), (0x1F37E, 0x1F393), (0x1F3A0, 0x1F3CA),
    (0x1F3CF, 0x1F3D3), (0x1F3E0, 0x1F3F0), (0x1F400, 0x1F43E), (0x1F440, 0x1F440), (0x1F442, 0x1F4FC),
    (0x1F4FF, 0x1F53D), (0x1F54B, 0x1F54E), (0x1F550, 0x1F567), (0x1F595, 0x1F596), (0x1F5A4, 0x1F5A4),
    (0x1F5FB, 0x1F64F), (0x1F680, 0x1F6C5), (0x1F6CC, 0x1F6CC), (0x1F6D0, 0x1F6D2), (0x1F6EB, 0x1F6EC),
    (0x1F90C, 0x1F93A), (0x1F93C, 0x1F945), (0x1F947, 0x1F9FF), (0x1FA70, 0x1FA7C), (0x1FA80, 0x1FA88),
    (0x1FA90, 0x1FABD), (0x1FABF, 0x1FAC5), (0x1FACE, 0x1FADB), (0x1FAE0, 0x1FAE8), (0x1FAF0, 0x1FAF8),
]
# BMP symbols that render as emoji by default
BMP_DEFAULT = [
    0x231A, 0x231B, 0x23E9, 0x23EA, 0x23EB, 0x23EC, 0x23F0, 0x23F3, 0x25FD, 0x25FE, 0x2614, 0x2615,
    *range(0x2648, 0x2654), 0x267F, 0x2693, 0x26A1, 0x26AA, 0x26AB, 0x26BD, 0x26BE, 0x26C4, 0x26C5, 0x26CE,
    0x26D4, 0x26EA, 0x26F2, 0x26F3, 0x26F5, 0x26FA, 0x26FD, 0x2705, 0x270A, 0x270B, 0x2728, 0x274C, 0x274E,
    0x2753, 0x2754, 0x2755, 0x2757, 0x2795, 0x2796, 0x2797, 0x27B0, 0x27BF, 0x2B1B, 0x2B1C, 0x2B50, 0x2B55,
]
# BMP symbols that need U+FE0F (variation selector) to render as emoji
BMP_VS16 = [
    0x2764, 0x26A0, 0x2714, 0x2716, 0x27A1, 0x2B05, 0x2B06, 0x2B07, 0x2139, 0x2600, 0x2601, 0x2602, 0x260E,
    0x2618, 0x261D, 0x263A, 0x2639, 0x2620, 0x2622, 0x2623, 0x2640, 0x2642, 0x2660, 0x2663, 0x2665, 0x2666,
    0x267B, 0x2699, 0x2694, 0x2696, 0x2697, 0x26D1, 0x270F, 0x2712, 0x2733, 0x2734, 0x2744, 0x2747, 0x2763,
]
ALIASES = {
    '👍': 'like yes ok good approve', '👎': 'dislike no bad', '❌': 'x no wrong close',
    '✅': 'check done yes correct tick', '❗': 'important alert exclamation', '⚠️': 'warning caution alert',
    '😂': 'lol laugh funny', '🔥': 'fire hot lit', '👀': 'eyes look see', '🎉': 'party celebrate congrats tada',
    '❤️': 'love heart', '💡': 'idea bulb', '📌': 'pin location', '➡️': 'arrow right', '⬅️': 'arrow left',
    '⬆️': 'arrow up', '⬇️': 'arrow down', '⭐': 'star favorite', '❓': 'question help', '🐛': 'bug', '💀': 'dead skull',
}


def entries():
    def add(cp, vs16=False):
        try:
            name = unicodedata.name(chr(cp)).lower()
        except ValueError:
            return None
        ch = chr(cp) + ('️' if vs16 else '')
        return [ch, (name + ' ' + ALIASES.get(ch, '')).strip()]

    out = []
    for a, b in RANGES:
        out += [e for cp in range(a, b + 1) if (e := add(cp))]
    out += [e for cp in BMP_DEFAULT if (e := add(cp))]
    out += [e for cp in BMP_VS16 if (e := add(cp, True))]
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', default=str(Path(__file__).resolve().parent.parent / 'emoji-data.js'))
    args = ap.parse_args()
    data = entries()
    Path(args.out).write_text(
        '// [emoji, search text] — generated from Unicode character names + a few aliases\n'
        'export const EMOJI = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n'
    )
    print(f'{len(data)} emoji -> {args.out}')


if __name__ == '__main__':
    main()
