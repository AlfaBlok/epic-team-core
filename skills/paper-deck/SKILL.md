---
name: paper-deck
description: The team's design style for decks and pages - warm paper, one ink, one deep green, a Newsreader serif for what you claim and Instrument Sans for what you prove, one idea per screen, real screens on a flat stage, small looping scenes that show the product doing the slide's one claim - plus a starter kit (HTML, paper.css, scenes.js, self-hosted fonts) whose colours come from the shared `paper` brand file. Use whenever you make a deck, slide pages, a one-pager, an explainer page, a proposal or a product page for any of the team's products, or when a page looks generic, templated or "AI-made". For a static diagram use house-diagram-style.
---

# Paper deck

The team's deck and page style, brand-neutral. Start from the kit in `assets/` (`paper_deck.py new <dir>`).

In one line: **warm paper, one ink, one deep green, a book serif for what you claim and a plain sans for what you
prove, one idea per screen, real screens on a flat stage, and small looping scenes that show the product doing the one
thing the slide says.**

## Which skill

| You are making | Use |
|---|---|
| a deck, slide pages, a one-pager, an explainer or proposal page, a product page | **paper-deck** (this) |
| a static diagram for a post or a page (1600x900 PNG) | `house-diagram-style`; drop the PNG onto a slide in a `.shot` |

Words on every slide: `copywriting` to draft, `humanizer` before you ship.

## Make one

1. `python3 <this skill>/scripts/paper_deck.py new <dir>`: copies the kit (`assets/`: `index.html` with one slide of
   each pattern, `paper.css`, `scenes.js`, `fonts/`) and writes the brand's tokens into `paper.css`.
2. Replace every `[bracket]` and every demo word, slide by slide; delete the patterns you do not need. Keep one idea
   per slide.
3. Serve it on the tailnet with `artifact_host.py --serve <dir> --port <n>` (never a bare `http.server`); for a link
   that must outlive the session run it under `systemd --user`. Curl the URL for 200 and put it in the spine.
4. **Look at it** at 1440x900 and at 390 px wide (headless Chromium, or `?still` for final frames): no clipped heading,
   no slide taller than a screen by accident, every scene's last frame readable.
5. `python3 <this skill>/scripts/paper_deck.py check <dir>` exits 0: tokens match the brand, fonts self-hosted.

Colours change in one place only: `skills/brands/paper.json` `deck.tokens` (shared with `house-diagram-style`). A product that needs its own accent gets its own brand file with a `deck` block and
`--brand <name>`; never edit tokens by hand in a deck, `paper_deck.py tokens <dir>` rewrites them.

## Palette

| Token | Value | Use |
|---|---|---|
| `--bg` paper | `#f6f2e9` | the ground of every slide, and the inside of a screen |
| `--stage` | `#e9e3d5` | the flat stage a screenshot, mockup or phone sits on |
| `--stage-2` | `#ded6c4` | bar tracks, a second stage step |
| `--ink` | `#18211c` | headings, body ink, the one heavy rule under a table head or a column row |
| `--muted` | `#4a554e` | sans body, captions, ledes |
| `--faint` | `#8d948c` | slide numbers, hints |
| `--line` | `#c9c1ae` | hairlines between rows and slides |
| `--accent` | `#1f4d3a` | the one colour: the focus, links in a scene, the closing band |
| `--accent-soft` | `#cfe0d4` | halos and soft fills of the focus, lede text on the band |
| `--accent-ink` | `#f6f2e9` | text on the accent |
| `--warn` | `#8a4b1c` | only the "Live" tag (what exists today) |

**Rule of one.** The accent goes on one thing per slide (the node that answers, the chosen plan, the "me" bubble) and
fills a whole slide only once, at the close. No gradients, no shadows (the chosen card gets an inset 1 px accent ring),
no glow, no second accent. Product screens keep their own colours inside the stage: they are evidence, not decoration.

## Type

Two OFL families, self-hosted in `fonts/`:

- **Newsreader**, 400 and 500: everything that claims. `h1` 400, `clamp(2.8rem, 6.4vw, 5.6rem)`, line-height 1.02,
  max 14ch. `h2` 400, `clamp(2rem, 3.8vw, 3.3rem)`, 1.08, max 22ch. Lede `clamp(1.2rem, 1.8vw, 1.45rem)`, muted, max
  40ch. Labels and column heads 500. Big numbers (a price) 400, letter-spacing -0.02em. Headings -0.015em,
  `text-wrap: balance`.
- **Instrument Sans**, 400, 500 and 600: everything that proves. Body, facts, tables, captions 0.95-1rem at 1.5,
  muted; slide numbers faint; tags 500; percentages 600.
- Page body is Newsreader 1.1875rem/1.55, so a stray paragraph still reads like a book.

Sentence case. Headings are full sentences that state the claim ("Ask, and see how strongly each item answers."),
never a topic. No monospace, no tracked capitals, no eyebrow: the small sans line above a heading is a number plus a
plain phrase ("4  Coming: retrieval that shows its strength").

## Layout

- **One idea per slide.** `min-height: 100svh`, vertically centred, scroll-snapped (`proximity`), a hairline between
  slides. Arrow keys and Page Up/Down step one slide (`scenes.js`).
- **Measure:** content max `76rem`, side edge `clamp(1.25rem, 4vw, 3rem)`, slide padding 4.5rem top, 4rem bottom.
- **Grid:** a 5/7 split (words left, figure right) or 7/5 reversed; four or three equal columns under one ink rule; a
  full-width figure under the heading. Below 900 px every grid is one column (four become two).
- **Rules, not boxes.** Structure is a 1 px ink rule over a column row or under a table head and `--line` hairlines
  between items. Boxes only for a stage (6 px radius), a screen in it (4 px), a plan card (6 px) and pills.
- About 80-140 words a slide. More is two slides.

## Slide patterns (one of each in the kit)

1. **Cover:** the claim as `h1`, one lede, a small meta line (what the deck is, what Live and Coming mean), the
   signature figure on a stage at right.
2. **The spine:** the product in four verbs under one ink rule, each with a Live or Coming tag.
3. **Live screen:** split; a facts list left, a real screen or a scene right, a caption starting "Live." or "Coming.".
4. **Two screens:** the heading, two stages side by side.
5. **Today against next:** a ruled table, serif first column.
6. **Coming scene:** a mockup of the next feature as a looping scene.
7. **Plan:** numbered steps in a ruled list (number in serif accent, what, how you check it, effort).
8. **Risks:** two or three columns, a serif label and one sans paragraph each.
9. **Price, near the end:** three cards at most, the chosen one with the accent ring, after what the product does and
   before the ask.
10. **Close:** the only full-accent slide; what we propose next and how the reader checks it; one box, one action.
11. **Foot:** one sans line of sources: which frames are real, which are demo data, where each number comes from.

Tags: `Live` (`.tag.today`, warn border) for what runs today, `Coming` (`.tag.soon`, accent border) for what does not
exist yet. Every product claim on a slide is one or the other.

## Animation

Scenes show the product doing the slide's one claim, then loop. Plain HTML and CSS plus `scenes.js` (about 90 lines,
no library). A scene is an element with `class="scene"` and `data-len` (loop in ms). Inside it, `data-at="<ms>"` adds
`.go` at that time (CSS says what `.go` looks like), `data-off` removes it again (typing dots), `data-type` types a
query letter by letter, `data-p` counts a percentage up. SVG figures are static markup; a scene only toggles classes.

| Move | Duration | Easing |
|---|---|---|
| A step appears (bubble, row, panel line) | 450 ms, opacity 0 to 1 and 8 px up | `ease` |
| Typing dots before a reply | 1.3-1.6 s, dots cycle 1 s, staggered 150 ms | `ease` |
| Query typing | 45 ms a letter, from 300 ms | linear |
| A link draws itself | 900 ms, `stroke-dashoffset` from its length (`--len`) to 0 | `ease` |
| A new node fades in, a ring pulses | 600 ms; ring 1.6 s, scale 0.4 to 1.6, repeating | `ease`, `ease-out` |
| A node lights up | fill 400 ms, halo 500-600 ms from scale 0.3 | `ease-out` |
| Results in rank order | one every 500 ms or so, a row 100 ms after its node | |
| Strength bar fills | 900 ms | `cubic-bezier(.2, .7, .2, 1)` |
| Percentage counts up | 700 ms | ease-out cubic |
| End of loop | content fades over the last 600 ms, then replays | `ease` |

Loops run 8-14 s, long enough to read the final frame for about 3 s. Pace follows the real product (a reply comes
when the product would reply).

**Visibility, reduced motion, no script.** A scene plays while 35% of it is on screen, restarts each time it comes
back, and rests on its final frame off screen, so a screenshot or a print never catches a half-built frame. With
`prefers-reduced-motion: reduce`, `?still` in the URL or no IntersectionObserver, every scene shows its final frame and
nothing moves; smooth scrolling is off too. Without the script nothing is hidden (CSS hides steps only under
`.scene.js`). Every scene has an `aria-label` that says what it shows.

## Screenshots and figures

- **Real screens on a flat stage:** `.shot` (`--stage` ground, 6 px radius), the image at 3 px. No fake browser
  chrome, no shadows, no tilt, no device mockups except the one phone frame (`.phone`) for a messaging product.
- **A caption under every screen**, sans 0.88rem muted, starting "Live." or "Coming." and saying what it proves.
- **Demo data only**, invented names and notes, never a real user's data. Product wording stays word for word.
- Capture at 1440x900 or the product's own width; `?still` gives clean final frames for evidence and review cards.
- A diagram from `house-diagram-style` sits in a `.shot` like a screen.

## Do and don't

Do: state the claim in the heading and prove it in sans under it; put the accent on the one thing the slide is about;
show the product doing it; mark every claim Live or Coming and source every number in the foot; put the price after
the product and before the ask; check every slide at 1440x900 and 390 px.

Don't: gradients, shadows, glow, glass, a second accent, indigo or violet; three equal cards as filler, icons or emoji
as decoration, dotted grids; eyebrow labels, tracked capitals, monospace, ids or jargon on a slide (no row codes on a
slide); animation that loops without meaning, motion under reduced motion, a scene that hides content when the script
fails; fake browser chrome or tilted device mockups; fonts from a third-party CDN.

## Relation to the diagram paper style

`house-diagram-style`'s paper style reads its colours and fonts from the same `paper.json`, so a diagram dropped on a deck slide is the same paper, ink, green,
Newsreader and Instrument Sans. Change the paper in `paper.json` only; decks and diagrams follow.

## Where it is installed

Source: `skills/paper-deck` (this folder). Listed in `skills/team-skills.json`; the `team-skills` timer links
it into every agent config dir on the host. The tokens live in `skills/brands/paper.json`. Fonts: OFL copies in `assets/fonts` (licences
beside them).
