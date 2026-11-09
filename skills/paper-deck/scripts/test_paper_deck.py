#!/usr/bin/env python3
"""python3 skills/paper-deck/scripts/test_paper_deck.py : the kit stays on the shared paper brand."""
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import paper_deck as pd  # noqa: E402


class PaperDeck(unittest.TestCase):
    def test_kit_matches_the_brand_file(self):
        name, tokens = pd.load_brand("paper")
        self.assertEqual(pd.problems(pd.KIT, name, tokens), [])
        b = json.loads((pd.REPO / "skills/brands/paper.json").read_text())
        self.assertEqual(tokens["--bg"], "#f6f2e9")
        self.assertEqual(tokens["--ink"], "#18211c")
        self.assertEqual(tokens["--accent"], "#1f4d3a")
        self.assertIn("Newsreader", tokens["--serif"])
        self.assertIn("Instrument Sans", tokens["--sans"])
        self.assertEqual(b["shot"]["ground"], tokens["--bg"])
        self.assertEqual(b["endCard"]["link"], tokens["--accent"])

    def test_kit_is_brand_neutral(self):
        for f in pd.KIT_FILES:
            self.assertNotRegex((pd.KIT / f).read_text(), re.compile(r"EpicSpine|wordmark", re.I), f)

    def test_new_copies_the_kit_and_drift_is_caught(self):
        with tempfile.TemporaryDirectory() as t:
            d = Path(t) / "deck"
            self.assertEqual(pd.main(["new", str(d)]), 0)
            self.assertEqual(pd.main(["check", str(d)]), 0)
            self.assertTrue((d / "fonts/newsreader-400.ttf").exists())
            self.assertEqual(pd.main(["new", str(d)]), 2, "never copies over a deck")
            css = d / "paper.css"
            css.write_text(css.read_text().replace("--accent: #1f4d3a;", "--accent: #6d28d9;"))
            self.assertEqual(pd.main(["check", str(d)]), 1)
            pd.main(["tokens", str(d)])
            self.assertEqual(pd.main(["check", str(d)]), 0)
            (d / "x.html").write_text('<link href="https://fonts.googleapis.com/css2?family=Inter">')
            self.assertEqual(pd.main(["check", str(d)]), 1)


if __name__ == "__main__":
    unittest.main()
