---
name: house-diagram-style
description: The team's house style for post and page diagrams - the paper style (the deck's warm paper, Newsreader headline, Instrument Sans labels, fine ink boxes, one deep-green focus; colours and fonts read from the shared `paper` brand file, one source with paper-deck) plus palette, type, layout, density, words and what to avoid, and a renderer (paper by default; five other styles kept for trials) that turns the `diagram` skill's JSON spec into a clean 1600x900 PNG + editable HTML. Use whenever you make or redo a diagram for a social post, campaign draft, book page or explainer, when a diagram looks generic, cluttered or "AI-made", or when someone asks for a style trial or a diagram "in our style". Also use for the first-screen diagram or boxed summary every status page, report, proposal and review card evidence page opens with (root L-59).
---

# House diagram style

One look for every diagram the team ships, so a reader knows it is ours before reading a word. Distilled from four skills in the team library: `diagram-design` (editorial schematics, deletion first, one focal point, orthogonal connectors), `design-taste-frontend` (no-slop house rules: no gradients, shadows, glow, eyebrows or assistant palettes), `humanizer` (words that read like a person) and the marketingskills `copywriting` / `social` skills (the title is the claim, one idea per post, stop the scroll with substance, not decoration).

**Use paper unless told otherwise.** The paper style has no colours or fonts of its own: it reads them from `skills/brands/paper.json`, the same file `paper-deck` reads, so a diagram and a deck are one family. It is the renderer's default (`HOUSE_DEFAULT`), so leave `style` out of the spec. The other five styles stay in the script only for a trial someone explicitly asks for; never ship a post or page diagram in them.

## Make one

1. Write the spec, the same JSON as the `diagram` skill (`flow`, `tree` or `hub`, nodes with `label`, `sub`, `tone`). No `style` key: paper is the default.
2. Render: `python3 <this skill>/scripts/house_diagram.py spec.json out.png`. It writes `out.html` (self-contained, fonts embedded, the editable source) and `out.png` (1600x900). `--styles` lists the styles.
3. **Look at the PNG** (Read the image) before using it. Fix the spec, never the picture: shorter labels, fewer nodes. Check: no clipped or shrunken-to-tiny text, no arrow under a label, no box touching another, nothing in a corner by itself.

Layouts: `flow` (3-6 steps; more than 5 makes two rows), `tree` (`root`; up to 4 levels, 6 per level), `hub` (`center`; the rest in a left and a right column with elbow connectors; give a node `"angle"` to place it on an ellipse instead). The `diagram` skill's `"ring"` is ignored here: draw the cycle as a flow.

## Where a diagram goes: the first screen of every page

Not only posts. Every status or evidence page, review card evidence, report and proposal opens with its one-line answer
and then a diagram or boxed summary (the owner asked for "a lot more diagrams and boxes", not "heavy text"). Reach for this skill whenever a page explains how something flows, what changed (before and after), or which
parts there are. A page that truly has no shape gets a row of boxes instead: one ✓ / ✗ box per point. `python3
scripts/text_wall_check.py <page>` flags a page that still opens with prose.

## House rules (every style)

**Palette.** One ground, one ink, one muted grey, one accent. The accent goes on 1, at most 2, boxes: the thing the post is about. Everything else is ink or a tone step of the ground. No gradients, shadows, glow or glass. No indigo/violet and no cream-with-terracotta: those read as "made by an assistant". Dark is fine flat; dark with cyan or purple glow is not.

**Type.** Two faces at most: a display face for the title, one sans for labels (the style fixes both). Title 58-76px, labels up to 36px, subs about two thirds of that, nothing under 15px. Sentence case. No monospace except a real file name or command, no tiny tracked capitals, no eyebrow label above the title, no index numbers (01, 02, Step 3): position shows order.

**Layout.** 16:9, 1600x900, 80px margins. Title top-left, subtitle under it, one sentence. The diagram fills the middle; no empty band taller than a box. Connectors are straight or right-angle elbows, never diagonals; arrow labels are one or two lowercase words on a mask beside the line. No legend: if a colour needs a legend, it carries too much meaning.

**Density 4/10.** 3-7 boxes is right, 9 is the ceiling; more is two diagrams. Run the remove test before rendering: can a box go, can two merge, can an arrow go because the layout already says it, can a label go.

**Words.** The title states the claim in plain words ("Nothing goes out until I approve it"), never a topic ("Approval workflow"); it doubles as alt text. Labels 1-4 words, subs at most ~8. First person when it speaks for the owner ("Me, walking"). No ids (P-0012), no jargon the post does not explain, no "seamless", "powerful", "unlock". Only true facts: what the system does today. Run `humanizer` on the title and subtitle.

**Avoid.** Identical boxes for everything (vary tone: the human warm, the focus accent, the outcome muted). Icons and emoji as decoration. Rounded pills. 3 equal cards as filler. Dotted-grid backgrounds. A logo or URL bigger than the footer line.

## The paper style

The deck's paper: warm paper ground, a Newsreader serif headline (weight 400, like the deck's headings), Instrument Sans labels, light boxes with a fine ink border, one deep-green focus box. Tones: `accent` (the focus, deep green: one box, two at most), `warm` (the human or the start), `muted` (the outcome or a quote), `default`.

Where each value comes from (`paper_style()` in the script, never a hex copied into it): ground `--bg`, ink and arrows `--ink`, secondary text `--muted`; `default` and `warm` boxes are `--bg` mixed half with white with an `--ink` border; `accent` is `--accent-soft` with an `--accent` border and text; `muted` is `--stage` with a `--line` border and `--muted` text; headline `--serif` at `shot.title_weight`, labels `--sans` 600, text `--sans` 400; font files from the brand's `fonts` list (OFL copies in `skills/paper-deck/assets/fonts`). To change the paper, change `paper.json` (it changes decks, screenshots and clips too) and re-render; `scripts/test_house_diagram.py` checks the mapping. Samples: `examples/` (a flow, a hub, a tree; `python3 scripts/house_diagram.py examples/<name>.json examples/<name>.png`).

Trial-only styles (`--styles` lists them; only when someone asks for a style trial): `swiss` (white, heavy black grotesk, one red block), `ink` (near-black, one acid-lime focus), `field` (cobalt field, one yellow focus), `sketch` (notebook paper, hand lettering), `quiet` (white, borderless soft-grey boxes, one teal focus).

## Style trials (several agents, one comparison)

When asked to try a style on a post, never touch the post's own asset or another agent's trial:

- Files go in `data/assets/style-trials/<your task or agent>/<post id>-<style>.{json,html,png}`.
- Register each PNG as a NEW `A-<n>` row in `data/assets.md` (take the next free id right after `git pull`; Source says "style trial, <style>, for P-nnnn, <task>"). Do not add it to the post's Assets column: the Publisher posts whatever is there. Link it from the post by appending `style trial: A-<n> (<style>)` to the post's Checks cell; the post's text, Assets and status stay as they are.
- Put every variant side by side on one comparison page and serve it at a curl-checked URL.

## Where it is installed

Source: `skills/house-diagram-style` (this folder). Listed in the team skill library `skills/team-skills.json`; the `team-skills` timer links it into every agent config dir on the host ([skills/README.md](../README.md)). A persona attaches it through its `skills:` list. The paper style's colours and fonts come from `skills/brands/paper.json` in the same checkout (the script finds it through its real path, so the seat symlinks work); the trial styles' fonts are OFL-licensed copies in `assets/fonts` (see its README). Chromium: `$DIAGRAM_CHROME`, else the newest `~/.cache/ms-playwright/chromium_headless_shell-*`.
