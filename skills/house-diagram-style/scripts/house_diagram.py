#!/usr/bin/env python3
"""house_diagram.py: one post diagram in a house style . Same JSON spec as the `diagram` skill.

    python3 house_diagram.py spec.json out.png [--style NAME]   # writes out.html (editable, self-contained) + out.png
    python3 house_diagram.py --styles                             # list the styles

Spec: {"title", "subtitle"?, "footer"?, "style"?, "layout": "flow" | "tree" | "hub", "nodes": [...], "edges"?: [...]}
  node: {"id", "label", "sub"?, "tone"?: "default" | "accent" | "warm" | "muted", "angle"?: degrees (hub only)}
  edge: ["from", "to"] or ["from", "to", "label"]
  flow: list order, left to right (two rows above 5); edges default to each node -> the next.
  tree: "root": id; edges parent -> child.   hub: "center": id; the rest around it (edges default center -> each).
The style comes from --style, else the spec's "style", else the house default (HOUSE_DEFAULT below: paper).
Canvas 1600x900. Text is laid out by Chromium (real wrapping, fonts embedded from ../assets/fonts), labels shrink
until they fit their box. The paper style reads skills/brands/paper.json. Chromium: $DIAGRAM_CHROME, else the newest Playwright headless shell.
"""
import base64
import glob
import json
import math
import os
import subprocess
import sys
from html import escape

W, H = 1600, 900
HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.join(HERE, "..", "assets", "fonts")
HOUSE_DEFAULT = "paper"  # the house default; the rest: trials only

# The paper style has no colours or fonts of its own: they come from the team's shared paper brand file, the same
# file paper-deck reads.
REPO = os.path.normpath(os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", ".."))
PAPER_BRAND = os.path.join(REPO, "skills", "brands", "paper.json")


def mix_white(hex_colour, share):
    """hex_colour mixed with white, `share` of the colour kept (0..1)."""
    c = hex_colour.lstrip("#")
    rgb = [int(c[i:i + 2], 16) for i in (0, 2, 4)]
    return "#" + "".join(f"{round(v * share + 255 * (1 - share)):02x}" for v in rgb)


def first_family(stack):
    """'"Newsreader", Georgia, serif' -> 'Newsreader'."""
    return stack.split(",")[0].strip().strip("'\"")


def paper_style(path=PAPER_BRAND):
    """STYLES["paper"] from the brand file's deck tokens and fonts. Boxes: default = ground mixed half with white and
    an ink border; accent = accent-soft fill, accent border and text; muted = the stage tone with the rule line."""
    brand = json.load(open(path))
    t = brand["deck"]["tokens"]
    base = os.path.dirname(path)  # brand font paths are relative to the brand file
    files = {(f["family"], f["weight"]): os.path.normpath(os.path.join(base, f["file"])) for f in brand["fonts"]}
    serif, sans = first_family(t["--serif"]), first_family(t["--sans"])
    title_w = brand.get("shot", {}).get("title_weight", 400)
    box = mix_white(t["--bg"], 0.5)
    return dict(
        about=f"Paper (shared brand file {brand['name']}): warm paper, {serif} headline, {sans} labels, light boxes with "
              "a fine ink border, one deep-green focus. The deck's paper, one source with paper-deck.",
        bg=t["--bg"], ink=t["--ink"], muted=t["--muted"], line=t["--ink"],
        tones={"default": (box, t["--ink"], t["--ink"]), "accent": (t["--accent-soft"], t["--accent"], t["--accent"]),
               "warm": (box, t["--ink"], t["--ink"]), "muted": (t["--stage"], t["--line"], t["--muted"])},
        display=(serif, title_w), body=(sans, 600), text=(sans, 400), font_files=files,
        title_size=66, title_track="-0.015em", radius=6, stroke=1.6, line_w=1.6, label_case="none")


# Each style: ground, ink, muted (secondary text), line (arrows), tones {tone: (fill, stroke, text)}, fonts, shape.
# font_files maps (family, weight) to a font file; without it a font is assets/fonts/<name>-<weight>.woff2.
STYLES = {
    "paper": paper_style(),
    "swiss": dict(
        about="Swiss: white, heavy black grotesk, flat grey blocks, one red block, thick black arrows.",
        bg="#FFFFFF", ink="#0A0A0A", muted="#5A5A5A", line="#0A0A0A",
        tones={"default": ("#EFEFEF", "none", "#0A0A0A"), "accent": ("#E3241B", "none", "#FFFFFF"),
               "warm": ("#FFFFFF", "#0A0A0A", "#0A0A0A"), "muted": ("#F7F7F7", "none", "#6A6A6A")},
        display=("inter-tight", 800), body=("inter-tight", 800), text=("inter-tight", 500),
        title_size=76, title_track="-0.022em", radius=0, stroke=3, line_w=4, label_case="none"),
    "ink": dict(
        about="Ink: near-black ground, light text, dark tone-step boxes, one acid-lime focus. Flat, no glow.",
        bg="#0F1115", ink="#F1F1EC", muted="#9097A0", line="#6B727C",
        tones={"default": ("#1C2027", "none", "#F1F1EC"), "accent": ("#D6FF3F", "none", "#0F1115"),
               "warm": ("#2A2F38", "none", "#F1F1EC"), "muted": ("#0F1115", "#2E333B", "#9097A0")},
        display=("space-grotesk", 700), body=("space-grotesk", 700), text=("space-grotesk", 400),
        title_size=68, title_track="-0.02em", radius=10, stroke=2, line_w=2.5, label_case="none"),
    "field": dict(
        about="Field: one whole field of cobalt, white boxes, one yellow focus, big rounded sans.",
        bg="#2343E6", ink="#FFFFFF", muted="#C9D2FF", line="#FFFFFF",
        tones={"default": ("#FFFFFF", "none", "#0B1A5C"), "accent": ("#FFD43B", "none", "#0B1A5C"),
               "warm": ("#FFFFFF", "none", "#0B1A5C"), "muted": ("#3A57EE", "none", "#FFFFFF")},
        display=("manrope", 800), body=("manrope", 800), text=("manrope", 500),
        title_size=70, title_track="-0.025em", radius=18, stroke=0, line_w=3, label_case="none"),
    "sketch": dict(
        about="Sketch: notebook paper, hand lettering, wobbly ink strokes, one highlighter-yellow focus.",
        bg="#FBFAF5", ink="#22252A", muted="#5F646B", line="#22252A",
        tones={"default": ("#FBFAF5", "#22252A", "#22252A"), "accent": ("#FFE27A", "#22252A", "#22252A"),
               "warm": ("#FBFAF5", "#22252A", "#22252A"), "muted": ("#F0EEE6", "#8D9197", "#5F646B")},
        display=("kalam", 700), body=("kalam", 700), text=("kalam", 400),
        title_size=72, title_track="0", radius=10, stroke=2.6, line_w=2.6, label_case="none", rough=True),
    "quiet": dict(
        about="Quiet: white, soft grey tone-step boxes with no borders, one teal focus, thin grey arrows, lots of air.",
        bg="#FFFFFF", ink="#202326", muted="#7A7F85", line="#B8BCC1",
        tones={"default": ("#F3F3F1", "none", "#202326"), "accent": ("#0E7C66", "none", "#FFFFFF"),
               "warm": ("#F3F3F1", "none", "#202326"), "muted": ("#FFFFFF", "#E2E3E5", "#7A7F85")},
        display=("instrument-sans", 600), body=("instrument-sans", 600), text=("instrument-sans", 400),
        title_size=58, title_track="-0.015em", radius=16, stroke=1.5, line_w=2, label_case="none"),
}


# ---- layout (box rectangles in canvas px) -----------------------------------------------------------------

def layout_flow(spec, top, bottom):
    nodes = spec["nodes"]
    rows = [nodes] if len(nodes) <= 5 else [nodes[: (len(nodes) + 1) // 2], nodes[(len(nodes) + 1) // 2:]]
    per = max(len(r) for r in rows)
    gap = 84 if per >= 5 else 110
    bw = min(340, (W - 160 - gap * (per - 1)) / per)
    bh = 320 if len(rows) == 1 else 200
    rects, total_h = {}, len(rows) * bh + (len(rows) - 1) * 110
    y0 = top + (bottom - top - total_h) / 2 - 16
    for r, row in enumerate(rows):
        x0 = (W - (len(row) * bw + (len(row) - 1) * gap)) / 2
        for i, n in enumerate(row):
            rects[n["id"]] = (x0 + i * (bw + gap), y0 + r * (bh + 110), bw, bh)
    edges = spec.get("edges") or [[a["id"], b["id"]] for a, b in zip(nodes, nodes[1:])]
    return rects, edges


def layout_tree(spec, top, bottom):
    kids = {}
    for e in spec.get("edges", []):
        kids.setdefault(e[0], []).append(e[1])
    levels, seen, cur = [], set(), [spec["root"]]
    while cur:
        levels.append(cur)
        seen.update(cur)
        cur = [k for p in cur for k in kids.get(p, []) if k not in seen]
    n = len(levels)
    vgap = 52 if n > 1 else 0
    bh = min(160, (bottom - top - (n - 1) * vgap) / n)
    y0 = top + (bottom - top - (len(levels) * bh + (len(levels) - 1) * vgap)) / 2
    rects = {}
    for li, lvl in enumerate(levels):
        gap = 48
        bw = min(320, (W - 160 - gap * (len(lvl) - 1)) / len(lvl))
        x0 = (W - (len(lvl) * bw + (len(lvl) - 1) * gap)) / 2
        for i, nid in enumerate(lvl):
            rects[nid] = (x0 + i * (bw + gap), y0 + li * (bh + vgap), bw, bh)
    return rects, spec.get("edges", [])


def layout_hub(spec, top, bottom):
    """Centre in the middle; the others in a left and a right column (first half left), or on an ellipse when
    any node gives an "angle"."""
    center = spec["center"]
    others = [n for n in spec["nodes"] if n["id"] != center]
    cx, cy = W / 2, (top + bottom) / 2
    cw, ch = 340, 190
    rects = {center: (cx - cw / 2, cy - ch / 2, cw, ch)}
    bw = 300
    if any("angle" in n for n in others):
        bh = 150
        rx, ry = (W - 160 - bw) / 2, (bottom - top - bh) / 2
        for i, n in enumerate(others):
            a = math.radians(n.get("angle", 180 + i * 360 / len(others)))
            x, y = cx + rx * math.cos(a), cy + ry * math.sin(a)
            rects[n["id"]] = (x - bw / 2, y - bh / 2, bw, bh)
    else:
        half = (len(others) + 1) // 2
        for col, x in ((others[:half], 80), (others[half:], W - 80 - bw)):
            k, gap = len(col), 28
            bh = min(170, (bottom - top - (k - 1) * gap) / max(k, 1))
            y0 = cy - (k * bh + (k - 1) * gap) / 2
            for i, n in enumerate(col):
                rects[n["id"]] = (x, y0 + i * (bh + gap), bw, bh)
    edges = spec.get("edges") or [[center, n["id"]] for n in others]
    return rects, edges


# ---- connectors -------------------------------------------------------------------------------------------

def edge_point(r, tx, ty):
    """Where the line from the box centre towards (tx, ty) leaves the box."""
    x, y, w, h = r
    cx, cy = x + w / 2, y + h / 2
    dx, dy = tx - cx, ty - cy
    if dx == 0 and dy == 0:
        return cx, cy
    s = min(w / 2 / abs(dx) if dx else 1e9, h / 2 / abs(dy) if dy else 1e9)
    return cx + dx * s, cy + dy * s


def connector(a, b, layout):
    """SVG path d + label point. Orthogonal where the boxes share a row/column or in trees; straight otherwise."""
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    acx, acy, bcx, bcy = ax + aw / 2, ay + ah / 2, bx + bw / 2, by + bh / 2
    pad = 10
    if abs(acy - bcy) < 1:  # same row
        sx, ex = (ax + aw + pad, bx - pad) if bcx > acx else (ax - pad, bx + bw + pad)
        return f"M{sx:.1f},{acy:.1f} L{ex:.1f},{bcy:.1f}", ((sx + ex) / 2, acy), "h"
    if abs(acx - bcx) < 1:  # same column
        sy, ey = (ay + ah + pad, by - pad) if bcy > acy else (ay - pad, by + bh + pad)
        return f"M{acx:.1f},{sy:.1f} L{bcx:.1f},{ey:.1f}", (acx, (sy + ey) / 2), "v"
    if layout in ("tree", "flow"):  # elbow down-across-down (tree) or across a row break (flow)
        sy, ey = ay + ah + pad, by - pad
        my = (sy + ey) / 2
        r = 12 if abs(bcx - acx) > 24 else 0
        sgn = 1 if bcx > acx else -1
        d = (f"M{acx:.1f},{sy:.1f} L{acx:.1f},{my - r:.1f} Q{acx:.1f},{my:.1f} {acx + sgn * r:.1f},{my:.1f} "
             f"L{bcx - sgn * r:.1f},{my:.1f} Q{bcx:.1f},{my:.1f} {bcx:.1f},{my + r:.1f} L{bcx:.1f},{ey:.1f}")
        return d, ((acx + bcx) / 2, my), "h"
    if layout == "hub" and abs(bcx - acx) > abs(bcy - acy):  # across-down-across elbow into a side, fanned
        sgn = 1 if bcx > acx else -1
        sx, ex = (ax + aw + pad, bx - pad) if sgn > 0 else (ax - pad, bx + bw + pad)
        lo, hi = max(ay, by) + 16, min(ay + ah, by + bh) - 16
        if hi > lo:  # the boxes share a band: one straight line through the middle of it
            y = (lo + hi) / 2
            return f"M{sx:.1f},{y:.1f} L{ex:.1f},{y:.1f}", ((sx + ex) / 2, y), "h"
        sy = min(max(bcy, ay + ah * 0.3), ay + ah * 0.7)
        ey = min(max(acy, by + bh * 0.28), by + bh * 0.72)
        if abs(sy - ey) < 1:
            return f"M{sx:.1f},{sy:.1f} L{ex:.1f},{ey:.1f}", ((sx + ex) / 2, sy), "h"
        mx = (sx + ex) / 2
        r = min(12, abs(ey - sy) / 2)
        v = 1 if ey > sy else -1
        d = (f"M{sx:.1f},{sy:.1f} L{mx - sgn * r:.1f},{sy:.1f} Q{mx:.1f},{sy:.1f} {mx:.1f},{sy + v * r:.1f} "
             f"L{mx:.1f},{ey - v * r:.1f} Q{mx:.1f},{ey:.1f} {mx + sgn * r:.1f},{ey:.1f} L{ex:.1f},{ey:.1f}")
        return d, ((sx + mx) / 2, sy), "h"
    sx, sy = edge_point(a, bcx, bcy)
    ex, ey = edge_point(b, acx, acy)
    L = math.hypot(ex - sx, ey - sy) or 1
    sx, sy = sx + (ex - sx) / L * pad, sy + (ey - sy) / L * pad
    ex, ey = ex - (ex - sx) / L * pad, ey - (ey - sy) / L * pad
    return f"M{sx:.1f},{sy:.1f} L{ex:.1f},{ey:.1f}", ((sx + ex) / 2, (sy + ey) / 2), "d"


# ---- page -------------------------------------------------------------------------------------------------

def font_face(name, weight, files=None):
    path = (files or {}).get((name, weight)) or os.path.join(FONTS, f"{name}-{weight}.woff2")
    data = base64.b64encode(open(path, "rb").read()).decode()
    mime, fmt = ("font/ttf", "truetype") if path.endswith(".ttf") else ("font/woff2", "woff2")
    return (f"@font-face{{font-family:'{name}';font-weight:{weight};font-style:normal;"
            f"src:url(data:{mime};base64,{data}) format('{fmt}');}}")


def render(spec, style_name):
    s = STYLES[style_name]
    layout = spec.get("layout", "flow")
    top = 250 if spec.get("subtitle") else 200
    bottom = H - (96 if spec.get("footer") else 60)
    rects, edges = {"flow": layout_flow, "tree": layout_tree, "hub": layout_hub}[layout](spec, top, bottom)
    faces = {s["display"], s["body"], s["text"]}
    css_fonts = "".join(font_face(n, w, s.get("font_files")) for n, w in sorted(faces))
    fam = lambda f: f"'{f[0]}', 'DejaVu Sans', sans-serif"
    rough = s.get("rough")

    svg = [f'<svg class="wires" width="{W}" height="{H}" viewBox="0 0 {W} {H}" xmlns="http://www.w3.org/2000/svg">',
           '<defs>',
           f'<marker id="head" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="{9 if s["line_w"] < 3 else 6}" '
           f'markerHeight="{9 if s["line_w"] < 3 else 6}" orient="auto-start-reverse">'
           f'<path d="M1,1 L11,6 L1,11 z" fill="{s["line"]}"/></marker>']
    if rough:
        svg.append('<filter id="rough" filterUnits="userSpaceOnUse" x="0" y="0" width="1600" height="900"><feTurbulence type="fractalNoise" '
                   'baseFrequency="0.022" numOctaves="2" seed="7"/><feDisplacementMap in="SourceGraphic" scale="5"/></filter>')
    svg.append('</defs>')
    filt = ' filter="url(#rough)"' if rough else ""
    labels = []
    for e in edges:
        if e[0] not in rects or e[1] not in rects:
            continue
        d, (lx, ly), orient = connector(rects[e[0]], rects[e[1]], layout)
        svg.append(f'<path d="{d}" fill="none" stroke="{s["line"]}" stroke-width="{s["line_w"]}" '
                   f'stroke-linecap="round" stroke-linejoin="round" marker-end="url(#head)"{filt}/>')
        if len(e) > 2 and e[2]:
            labels.append((lx, ly, orient, e[2]))
    for n in spec["nodes"]:
        if n["id"] not in rects:
            continue
        x, y, w, h = rects[n["id"]]
        fill, stroke, _ = s["tones"].get(n.get("tone", "default"), s["tones"]["default"])
        sw = s["stroke"] if stroke != "none" else 0
        svg.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="{s["radius"]}" fill="{fill}" '
                   f'stroke="{stroke}" stroke-width="{sw}"{filt}/>')
    svg.append("</svg>")

    boxes = []
    for n in spec["nodes"]:
        if n["id"] not in rects:
            continue
        x, y, w, h = rects[n["id"]]
        _, _, color = s["tones"].get(n.get("tone", "default"), s["tones"]["default"])
        sub = f'<div class="sub">{escape(n["sub"])}</div>' if n.get("sub") else ""
        boxes.append(f'<div class="box" style="left:{x:.1f}px;top:{y:.1f}px;width:{w:.1f}px;height:{h:.1f}px;color:{color}">'
                     f'<div class="fit"><div class="label">{escape(n["label"])}</div>{sub}</div></div>')
    for lx, ly, orient, text in labels:
        # beside the line, on an opaque mask with a gap: above horizontal segments, right of vertical ones
        pos = (f"left:{lx:.1f}px;top:{ly - 16:.1f}px;transform:translate(-50%,-100%)" if orient in ("h", "d")
               else f"left:{lx + 16:.1f}px;top:{ly:.1f}px;transform:translate(0,-50%)")
        boxes.append(f'<div class="elabel" style="{pos}">{escape(text)}</div>')

    sub = f'<p class="subtitle">{escape(spec["subtitle"])}</p>' if spec.get("subtitle") else ""
    foot = f'<div class="footer">{escape(spec["footer"])}</div>' if spec.get("footer") else ""
    css = f"""{css_fonts}
*{{margin:0;padding:0;box-sizing:border-box}}
html,body{{width:{W}px;height:{H}px;overflow:hidden;background:{s['bg']}}}
.canvas{{position:relative;width:{W}px;height:{H}px;background:{s['bg']};color:{s['ink']};-webkit-font-smoothing:antialiased}}
.wires{{position:absolute;left:0;top:0}}
h1{{position:absolute;left:80px;top:64px;right:80px;font-family:{fam(s['display'])};font-weight:{s['display'][1]};
  font-size:{s['title_size']}px;line-height:1.02;letter-spacing:{s['title_track']};white-space:nowrap}}
.subtitle{{position:absolute;left:80px;top:{64 + s['title_size'] * 1.02 + 22:.0f}px;right:80px;font-family:{fam(s['text'])};
  font-weight:{s['text'][1]};font-size:27px;line-height:1.3;color:{s['muted']};max-width:1250px}}
.box{{position:absolute;display:flex;align-items:center;justify-content:center;text-align:center;padding:22px 24px;overflow:hidden}}
.label{{font-family:{fam(s['body'])};font-weight:{s['body'][1]};font-size:36px;line-height:1.08;letter-spacing:-0.01em;text-wrap:balance}}
.sub{{font-family:{fam(s['text'])};font-weight:{s['text'][1]};font-size:22px;line-height:1.3;margin-top:14px;opacity:.82;text-wrap:balance}}
.elabel{{position:absolute;font-family:{fam(s['text'])};font-weight:{s['text'][1]};font-size:21px;color:{s['muted']};
  background:{s['bg']};padding:2px 8px;white-space:nowrap}}
.footer{{position:absolute;left:80px;right:80px;bottom:44px;font-family:{fam(s['text'])};font-weight:{s['text'][1]};
  font-size:21px;color:{s['muted']}}}"""
    fit_js = """<script>
document.fonts.ready.then(() => {
  const h1 = document.querySelector('h1');
  for (let f = parseFloat(getComputedStyle(h1).fontSize); h1.scrollWidth > h1.clientWidth && f > 36; f -= 2) h1.style.fontSize = f + 'px';
  for (const box of document.querySelectorAll('.box')) {
    const l = box.querySelector('.label'), s = box.querySelector('.sub');
    let f = 36;
    while (f > 16 && (box.scrollHeight > box.clientHeight || box.scrollWidth > box.clientWidth || l.scrollWidth > l.clientWidth)) {
      f -= 2; l.style.fontSize = f + 'px'; if (s) s.style.fontSize = Math.max(15, Math.round(f * 0.66)) + 'px';
    }
  }
  // one label size per row: boxes on the same line take the smallest fitted size
  const rows = {};
  for (const box of document.querySelectorAll('.box')) (rows[box.style.top] ||= []).push(box);
  for (const row of Object.values(rows)) {
    const f = Math.min(...row.map(b => parseFloat(getComputedStyle(b.querySelector('.label')).fontSize)));
    for (const b of row) { b.querySelector('.label').style.fontSize = f + 'px'; const s = b.querySelector('.sub'); if (s) s.style.fontSize = Math.max(15, Math.round(f * 0.66)) + 'px'; }
  }
  document.body.dataset.ready = '1';
});
</script>"""
    alt = escape(spec["title"] + (". " + spec["subtitle"] if spec.get("subtitle") else ""))
    return (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{escape(spec["title"])}</title>'
            f'<meta name="description" content="{alt}"><meta name="house-diagram-style" content="{style_name}">'
            f"<style>{css}</style></head><body><div class=\"canvas\" role=\"img\" aria-label=\"{alt}\">"
            + "\n".join(svg) + f'<h1>{escape(spec["title"])}</h1>{sub}' + "\n".join(boxes) + foot
            + "</div>" + fit_js + "</body></html>")


def chrome():
    if os.environ.get("DIAGRAM_CHROME"):
        return os.environ["DIAGRAM_CHROME"]
    found = sorted(glob.glob(os.path.expanduser("~/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell")))
    if not found:
        sys.exit("house_diagram.py: no headless Chromium (set DIAGRAM_CHROME or run `npx playwright install chromium-headless-shell`)")
    return found[-1]


def main(argv):
    if "--styles" in argv:
        for k, v in STYLES.items():
            print(f"{k:8} {v['about']}{'  (house default)' if k == HOUSE_DEFAULT else ''}")
        return
    style = None
    if "--style" in argv:
        i = argv.index("--style")
        style = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]
    if len(argv) != 3:
        sys.exit(__doc__)
    spec = json.load(open(argv[1]))
    style = style or spec.get("style") or HOUSE_DEFAULT
    if style not in STYLES:
        sys.exit(f"house_diagram.py: unknown style {style!r}; one of {', '.join(STYLES)}")
    out = os.path.abspath(argv[2])
    html_path = out[:-4] + ".html" if out.endswith(".png") else out
    with open(html_path, "w") as f:
        f.write(render(spec, style))
    if out.endswith(".png"):
        subprocess.run([chrome(), "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", f"--window-size={W},{H}",
                        "--virtual-time-budget=4000", "--force-device-scale-factor=1", f"--screenshot={out}",
                        f"file://{html_path}"], check=True, capture_output=True, timeout=90)
    print(out)


if __name__ == "__main__":
    main(sys.argv)
