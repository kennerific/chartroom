# -*- coding: utf-8 -*-
"""Bundle the downloaded Phosphor SVGs into one inline <svg> sprite.

Phosphor Icons are MIT licensed (https://github.com/phosphor-icons/core).
Run: python tools/build_icons.py   ->  writes tools/sprite.inc.svg
"""
import io, os, re, sys

sys.stdout.reconfigure(encoding="utf-8")
HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "icons_raw")

# Only the glyphs the interface actually uses.
WANTED = [
    "book-open", "crosshair", "graduation-cap", "check", "x",
    "caret-left", "caret-right", "arrow-counter-clockwise",
    "eye", "eye-slash", "lock-simple", "map-trifold", "list-checks",
    "sun", "moon",
]

def inner(svg):
    """Strip the wrapper, keep the drawing commands."""
    m = re.search(r"<svg[^>]*>(.*)</svg>", svg, re.S)
    if not m:
        raise ValueError("unexpected svg shape")
    body = m.group(1).strip()
    # currentColor is inherited from the <use> site, so drop per-path fills.
    return re.sub(r'\s*fill="currentColor"', "", body)

def main():
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">']
    missing = []
    for name in WANTED:
        path = os.path.join(RAW, name + ".svg")
        if not os.path.exists(path):
            missing.append(name)
            continue
        svg = io.open(path, encoding="utf-8").read()
        parts.append('<symbol id="i-%s" viewBox="0 0 256 256">%s</symbol>' % (name, inner(svg)))
    parts.append("</svg>")
    out = "\n".join(parts)
    dest = os.path.join(HERE, "sprite.inc.svg")
    io.open(dest, "w", encoding="utf-8").write(out)
    print("symbols: %d   bytes: %d" % (len(WANTED) - len(missing), len(out)))
    if missing:
        print("MISSING:", missing)

main()
