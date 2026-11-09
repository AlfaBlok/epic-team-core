#!/usr/bin/env python3
"""paper_deck.py (team skill paper-deck): start a deck or page from the kit, keep its tokens on the brand.

  paper_deck.py new <dir> [--brand paper] [--force]   copy the kit (index.html, paper.css, scenes.js, fonts/) into <dir>
                                                      and write the brand's tokens into paper.css
  paper_deck.py tokens <dir> [--brand paper]          rewrite the tokens block of <dir>/paper.css from the brand file
  paper_deck.py check <dir> [--brand paper]           exit 1 if the tokens drifted from the brand, a font is missing,
                                                      or the page loads fonts from a third party

The brand is skills/brands/<name>.json (`deck.tokens`), shared with house-diagram-style; a path to a
brand JSON works too. Only the lines between `/* tokens:begin <brand> */` and `/* tokens:end */` are ever rewritten.
Exit 0 ok, 1 drift, 2 usage error. Stdlib only.
"""
import argparse
import json
import re
import shutil
import sys
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent
KIT = SKILL / "assets"
REPO = SKILL.parent.parent
KIT_FILES = ["index.html", "paper.css", "scenes.js"]
BLOCK = re.compile(r"/\* tokens:begin [^*]*\*/\n.*?/\* tokens:end \*/\n", re.S)


def load_brand(name_or_path):
    p = Path(name_or_path) if ("/" in name_or_path or name_or_path.endswith(".json")) else REPO / "skills/brands" / (name_or_path + ".json")
    if not p.exists():
        raise SystemExit("brand not found: %s" % p)
    b = json.loads(p.read_text())
    tokens = (b.get("deck") or {}).get("tokens")
    if not tokens:
        raise SystemExit("brand %s has no deck.tokens block" % b.get("name"))
    return b["name"], tokens


def block(name, tokens):
    return "/* tokens:begin %s */\n" % name + "".join("  %s: %s;\n" % kv for kv in tokens.items()) + "  /* tokens:end */\n"


def write_tokens(css, name, tokens):
    s = css.read_text()
    if not BLOCK.search(s):
        raise SystemExit("%s has no /* tokens:begin */ ... /* tokens:end */ block" % css)
    s2 = BLOCK.sub(lambda m: block(name, tokens), s, count=1)
    css.write_text(s2)
    return s2 != s


def problems(d, name, tokens):
    css = d / "paper.css"
    if not css.exists():
        return ["%s missing" % css]
    s = css.read_text()
    out = []
    m = BLOCK.search(s)
    if not m:
        out.append("paper.css has no tokens block")
    elif m.group(0) != block(name, tokens):
        out.append("paper.css tokens differ from brand %s (run: paper_deck.py tokens %s)" % (name, d))
    for f in re.findall(r'url\("(fonts/[^"]+)"\)', s):
        if not (d / f).exists():
            out.append("font missing: %s" % f)
    for page in d.glob("*.html"):
        if re.search(r"fonts\.(googleapis|gstatic)\.com", page.read_text()):
            out.append("%s loads fonts from Google: self-host them (fonts/)" % page.name)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("cmd", choices=["new", "tokens", "check"])
    ap.add_argument("dir")
    ap.add_argument("--brand", default="paper")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    d = Path(a.dir)
    name, tokens = load_brand(a.brand)
    if a.cmd == "new":
        if d.exists() and any(d.iterdir()) and not a.force:
            print("refusing: %s is not empty (--force to copy over it)" % d, file=sys.stderr)
            return 2
        d.mkdir(parents=True, exist_ok=True)
        for f in KIT_FILES:
            shutil.copy2(KIT / f, d / f)
        shutil.copytree(KIT / "fonts", d / "fonts", dirs_exist_ok=True)
        write_tokens(d / "paper.css", name, tokens)
        print("new deck in %s (brand %s): open index.html, replace every [bracket], delete the patterns you do not need" % (d, name))
        return 0
    if a.cmd == "tokens":
        changed = write_tokens(d / "paper.css", name, tokens)
        print("%s: tokens %s (brand %s)" % (d / "paper.css", "rewritten" if changed else "already match", name))
        return 0
    bad = problems(d, name, tokens)
    for p in bad:
        print("drift: " + p)
    if not bad:
        print("ok: %s matches brand %s" % (d, name))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
