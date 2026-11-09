#!/usr/bin/env python3
"""diagram.py: one clean post diagram from a small JSON spec → SVG → PNG (headless Chromium, no pip installs).

    python3 diagram.py spec.json out.png          # writes out.svg next to out.png
    python3 diagram.py spec.json out.svg          # SVG only

Spec (JSON): {"title", "subtitle"?, "footer"?, "layout": "flow" | "tree" | "hub", "nodes": [...], "edges"?: [...]}
  node:  {"id", "label", "sub"?, "tone"?: "default" | "accent" | "muted" | "warm"}
  edge:  ["from", "to"] or ["from", "to", "label"]
  flow:  nodes left to right in list order (two rows when more than 5); edges default to each node → the next.
  tree:  "root": id; edges parent → child; up to 4 levels.
  hub:   "center": id; the other nodes on a ring; edges as given (default center → each); "ring": true adds arrows
         around the ring (a cycle).
Canvas 1600×900 (16:9, reads on X and Reddit). Chromium: $DIAGRAM_CHROME, else the newest Playwright headless shell
under ~/.cache/ms-playwright.
"""
import glob
import json
import math
import os
import subprocess
import sys
from html import escape

W, H = 1600, 900
INK, MUTED_INK, BG, LINE = "#1F2937", "#6B7280", "#FAFAF7", "#94A3B8"
TONES = {  # fill, stroke, text
    "default": ("#FFFFFF", "#CBD5E1", INK),
    "accent": ("#4F46E5", "#4338CA", "#FFFFFF"),
    "muted": ("#F1F5F9", "#E2E8F0", MUTED_INK),
    "warm": ("#FEF3C7", "#F59E0B", "#78350F"),
}
FONT = "DejaVu Sans, Inter, Helvetica, Arial, sans-serif"


def wrap(text, size, width, em=0.56):
    """Greedy word wrap by an average glyph width (0.56 em regular, 0.64 em bold)."""
    per = max(4, int(width / (size * em)))
    lines, cur = [], ""
    for word in str(text).split():
        if cur and len(cur) + 1 + len(word) > per:
            lines.append(cur)
            cur = word
        else:
            cur = f"{cur} {word}".strip()
    return lines + ([cur] if cur else [])


def fit(n, w, h):
    """The largest label size (30 down to 16) whose wrapped label + sub fit the box; sub is 0.7 of it."""
    for size in range(30, 15, -2):
        sub_size = round(size * 0.7)
        label = wrap(n["label"], size, w - 36, 0.64)
        sub = wrap(n.get("sub", ""), sub_size, w - 36) if n.get("sub") else []
        block = len(label) * size * 1.2 + (8 + len(sub) * sub_size * 1.3 if sub else 0)
        longest = max([len(t) * size * 0.64 for t in label] + [len(t) * sub_size * 0.56 for t in sub])
        if block <= h - 28 and longest <= w - 24:
            break
    return size, sub_size, label, sub, block


def box(n, x, y, w, h):
    fill, stroke, color = TONES.get(n.get("tone", "default"), TONES["default"])
    size, sub_size, label, sub, block = fit(n, w, h)
    ty = y + (h - block) / 2 + size * 0.95
    out = [f'<rect x="{x:.0f}" y="{y:.0f}" width="{w:.0f}" height="{h:.0f}" rx="18" fill="{fill}" stroke="{stroke}" stroke-width="2.5"/>']
    for i, t in enumerate(label):
        out.append(f'<text x="{x + w / 2:.0f}" y="{ty + i * size * 1.2:.0f}" font-size="{size}" font-weight="700" fill="{color}" text-anchor="middle">{escape(t)}</text>')
    sy = ty + (len(label) - 1) * size * 1.2 + 8 + sub_size * 1.3
    for i, t in enumerate(sub):
        out.append(f'<text x="{x + w / 2:.0f}" y="{sy + i * sub_size * 1.3:.0f}" font-size="{sub_size}" fill="{color}" fill-opacity="0.85" text-anchor="middle">{escape(t)}</text>')
    return out


def edge_point(r, tx, ty):
    """Where the line from the box centre towards (tx, ty) leaves box r = (x, y, w, h)."""
    x, y, w, h = r
    cx, cy = x + w / 2, y + h / 2
    dx, dy = tx - cx, ty - cy
    if dx == 0 and dy == 0:
        return cx, cy
    s = min((w / 2 + 6) / abs(dx) if dx else math.inf, (h / 2 + 6) / abs(dy) if dy else math.inf)
    return cx + dx * s, cy + dy * s


def arrow(a, b, label=None, curve=0.0):
    ax, ay = edge_point(a, b[0] + b[2] / 2, b[1] + b[3] / 2)
    bx, by = edge_point(b, a[0] + a[2] / 2, a[1] + a[3] / 2)
    mx, my = (ax + bx) / 2, (ay + by) / 2
    if curve:
        nx, ny = -(by - ay), bx - ax
        ln = math.hypot(nx, ny) or 1
        mx, my = mx + nx / ln * curve, my + ny / ln * curve
    out = [f'<path d="M{ax:.0f},{ay:.0f} Q{mx:.0f},{my:.0f} {bx:.0f},{by:.0f}" fill="none" stroke="{LINE}" stroke-width="3.5" marker-end="url(#arrow)"/>']
    if label:
        if abs(bx - ax) > abs(by - ay):  # a sideways arrow: the label sits above the line, never on it
            my -= 30
        lw = len(label) * 19 * 0.56 + 20
        out.append(f'<rect x="{mx - lw / 2:.0f}" y="{my - 17:.0f}" width="{lw:.0f}" height="30" rx="8" fill="{BG}"/>')
        out.append(f'<text x="{mx:.0f}" y="{my + 5:.0f}" font-size="19" fill="{MUTED_INK}" font-style="italic" text-anchor="middle">{escape(label)}</text>')
    return out


def layout_flow(spec, top, bottom):
    nodes = spec["nodes"]
    rows = [nodes] if len(nodes) <= 5 else [nodes[: math.ceil(len(nodes) / 2)], nodes[math.ceil(len(nodes) / 2):]]
    rects, gap = {}, 90
    rh = (bottom - top - gap * (len(rows) - 1)) / len(rows)
    h = min(280, rh)
    for r, row in enumerate(rows):
        w = min(330, (W - 120 - gap * (len(row) - 1)) / len(row))
        x0 = (W - (w * len(row) + gap * (len(row) - 1))) / 2
        y = top + r * (rh + gap) + (rh - h) / 2
        for i, n in enumerate(row):
            rects[n["id"]] = (x0 + i * (w + gap), y, w, h)
    edges = spec.get("edges") or [[a["id"], b["id"]] for a, b in zip(nodes, nodes[1:])]
    return rects, edges


def layout_tree(spec, top, bottom):
    kids, levels, seen = {}, [[spec["root"]]], {spec["root"]}
    for e in spec.get("edges", []):
        kids.setdefault(e[0], []).append(e[1])
    while True:
        nxt = [c for p in levels[-1] for c in kids.get(p, []) if c not in seen]
        if not nxt:
            break
        seen.update(nxt)
        levels.append(nxt)
    rects, gap_y = {}, 60
    lh = (bottom - top - gap_y * (len(levels) - 1)) / len(levels)
    for li, level in enumerate(levels):
        gap = 36
        w = min(540 if len(level) == 1 else 340, (W - 100 - gap * (len(level) - 1)) / len(level))
        x0 = (W - (w * len(level) + gap * (len(level) - 1))) / 2
        for i, nid in enumerate(level):
            rects[nid] = (x0 + i * (w + gap), top + li * (lh + gap_y), w, lh)
    return rects, spec.get("edges", [])


def layout_hub(spec, top, bottom):
    center = spec["center"]
    others = [n for n in spec["nodes"] if n["id"] != center]
    cx, cy = W / 2, (top + bottom) / 2
    rx, ry = W / 2 - 250, (bottom - top) / 2 - 85
    rects = {center: (cx - 190, cy - 95, 380, 190)}
    for i, n in enumerate(others):
        a = -math.pi / 2 + 2 * math.pi * i / len(others)
        rects[n["id"]] = (cx + rx * math.cos(a) - 165, cy + ry * math.sin(a) - 75, 330, 150)
    edges = spec.get("edges") or [[center, n["id"]] for n in others]
    if spec.get("ring"):
        edges = edges + [[a["id"], b["id"], None, 60] for a, b in zip(others, others[1:] + others[:1])]
    return rects, edges


def render(spec):
    top = 190 if spec.get("subtitle") else 150
    bottom = H - (70 if spec.get("footer") else 40)
    rects, edges = {"flow": layout_flow, "tree": layout_tree, "hub": layout_hub}[spec.get("layout", "flow")](spec, top, bottom)
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="{FONT}">',
        f'<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{LINE}"/></marker></defs>',
        f'<rect width="{W}" height="{H}" fill="{BG}"/>',
        f'<text x="70" y="92" font-size="46" font-weight="800" fill="{INK}">{escape(spec["title"])}</text>',
    ]
    if spec.get("subtitle"):
        out.append(f'<text x="70" y="140" font-size="26" fill="{MUTED_INK}">{escape(spec["subtitle"])}</text>')
    for e in edges:
        if e[0] in rects and e[1] in rects:
            out += arrow(rects[e[0]], rects[e[1]], e[2] if len(e) > 2 else None, e[3] if len(e) > 3 else 0.0)
    for n in spec["nodes"]:
        if n["id"] in rects:
            out += box(n, *rects[n["id"]])
    if spec.get("footer"):
        out.append(f'<text x="{W - 70}" y="{H - 32}" font-size="20" fill="{MUTED_INK}" text-anchor="end">{escape(spec["footer"])}</text>')
    return "\n".join(out + ["</svg>"])


def chrome():
    if os.environ.get("DIAGRAM_CHROME"):
        return os.environ["DIAGRAM_CHROME"]
    found = sorted(glob.glob(os.path.expanduser("~/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell")))
    if not found:
        sys.exit("diagram.py: no headless Chromium (set DIAGRAM_CHROME or run `npx playwright install chromium-headless-shell`)")
    return found[-1]


def main(argv):
    if len(argv) != 3:
        sys.exit(__doc__)
    spec = json.load(open(argv[1]))
    out = os.path.abspath(argv[2])
    svg_path = out[:-4] + ".svg" if out.endswith(".png") else out
    with open(svg_path, "w") as f:
        f.write(render(spec))
    if out.endswith(".png"):
        subprocess.run([chrome(), "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", f"--window-size={W},{H}",
                        f"--screenshot={out}", f"file://{svg_path}"], check=True, capture_output=True, timeout=60)
    print(out)


if __name__ == "__main__":
    main(sys.argv)
