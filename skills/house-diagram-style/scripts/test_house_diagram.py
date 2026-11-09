#!/usr/bin/env python3
"""Tests for house_diagram.py : the paper style takes its colours and fonts from the shared paper brand file,
the trial styles keep their own. Run: python3 skills/house-diagram-style/scripts/test_house_diagram.py"""
import copy
import inspect
import json
import os
import re
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import house_diagram as hd  # noqa: E402

SPEC = {"title": "Nothing goes out until I approve it", "layout": "flow",
        "nodes": [{"id": "a", "label": "I ask"}, {"id": "b", "label": "I approve", "tone": "accent"}]}


class PaperFromBrandFile(unittest.TestCase):
    def setUp(self):
        self.brand = json.load(open(hd.PAPER_BRAND))
        self.t = self.brand["deck"]["tokens"]

    def test_paper_is_the_deck_paper(self):
        p = hd.STYLES["paper"]
        self.assertEqual((p["bg"], p["ink"], p["muted"]), (self.t["--bg"], self.t["--ink"], self.t["--muted"]))
        self.assertEqual(p["tones"]["accent"], (self.t["--accent-soft"], self.t["--accent"], self.t["--accent"]))
        self.assertEqual(p["tones"]["muted"], (self.t["--stage"], self.t["--line"], self.t["--muted"]))
        self.assertEqual((p["display"][0], p["body"][0]), ("Newsreader", "Instrument Sans"))
        self.assertEqual(hd.HOUSE_DEFAULT, "paper")

    def test_no_copied_values(self):
        src = open(hd.__file__).read()
        for old in ("#F5F3EE", "#1D2329", "#1F5F4A", "fraunces", "'inter'", '"inter"'):
            self.assertNotIn(old.lower(), src.lower(), old)
        self.assertEqual(re.findall(r"#[0-9a-fA-F]{6}", inspect.getsource(hd.paper_style)), [])

    def test_one_source_changes_follow_the_file(self):
        b = copy.deepcopy(self.brand)
        b["deck"]["tokens"]["--bg"], b["deck"]["tokens"]["--accent"] = "#000000", "#123456"
        root = tempfile.mkdtemp()
        brands = os.path.join(root, "video", "library", "brands")
        os.makedirs(brands)
        for f in b["fonts"]:  # keep the font paths resolvable from the copy
            f["file"] = os.path.join(os.path.dirname(hd.PAPER_BRAND), f["file"])
        path = os.path.join(brands, "paper.json")
        json.dump(b, open(path, "w"))
        p = hd.paper_style(path)
        self.assertEqual((p["bg"], p["tones"]["accent"][1]), ("#000000", "#123456"))
        self.assertEqual(p["tones"]["default"][0], "#808080")  # ground mixed half with white

    def test_render_embeds_the_brand_fonts(self):
        html = hd.render(SPEC, "paper")
        self.assertIn("font-family:'Newsreader'", html)
        self.assertIn("font-family:'Instrument Sans'", html)
        self.assertIn("format('truetype')", html)
        self.assertIn(f"background:{self.t['--bg']}", html)
        for (fam, w), f in hd.STYLES["paper"]["font_files"].items():
            self.assertTrue(os.path.exists(f), f)

    def test_trial_styles_keep_their_own(self):
        self.assertEqual(list(hd.STYLES), ["paper", "swiss", "ink", "field", "sketch", "quiet"])
        self.assertEqual(hd.STYLES["swiss"]["tones"]["accent"][0], "#E3241B")
        self.assertIn("woff2", hd.render(SPEC, "quiet"))


if __name__ == "__main__":
    unittest.main()
