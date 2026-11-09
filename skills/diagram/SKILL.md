---
name: diagram
description: Make one clean diagram image (PNG + SVG, 1600×900) for a social post or a doc, from a small JSON spec: a flow (steps left to right), a tree (goal → children) or a hub (one centre, roles around it, optional cycle). Use whenever a post, campaign draft or explainer needs "one diagram per post", or the user asks for a diagram, flow chart, goal tree or team map. Renders with the headless Chromium already on the host; no installs.
---

# Diagram: one picture per post

One post, one idea, one diagram. The renderer gives every diagram the same look (light background, one accent, readable on a phone), so the campaign reads as one voice.

For the team's house style (palette, type, layout, what to avoid) and the paper look (the default for every post and page diagram) rendered from this same spec, use the `house-diagram-style` skill.

## Make one

1. Pick the shape that *is* the idea:
   - **flow**: a thing becomes another thing (voice note → memory → team → work). 3–6 steps.
   - **tree**: one thing splits into parts (a voice note → goals → tasks). Up to 4 levels, at most 6 boxes on a level.
   - **hub**: many roles around one centre (personas around one objective). 4–7 around; `"ring": true` when they hand work around in a cycle.
2. Write the spec (JSON) next to the post's asset, e.g. `data/assets/A-3-team.json`:

```json
{"title": "My AI rig: a voice note becomes work",
 "subtitle": "One line that says what to look at.",
 "layout": "flow",
 "nodes": [{"id": "me", "label": "Me, walking", "sub": "I record a voice note", "tone": "warm"},
           {"id": "z", "label": "Team memory", "sub": "audio + transcript", "tone": "accent"},
           {"id": "w", "label": "Work", "sub": "a URL to open", "tone": "muted"}],
 "edges": [["me", "z", "send"], ["z", "w", "do"]],
 "footer": "EpicSpine"}
```

3. Render: `python3 <this skill>/scripts/diagram.py spec.json out.png` (writes `out.svg` too).
4. **Look at the PNG** (open/Read the image) before using it: no clipped text, no arrow under a label, nothing overlapping. Fix the spec (shorter labels, fewer nodes) and re-render.

Tones: `accent` = the one thing the post is about (one or two boxes), `warm` = the human / the start, `muted` = the outcome or a quote, `default` = everything else.

## Rules that keep it clean

- Labels 1–4 words; `sub` at most ~8 words. The post text explains; the diagram shows.
- Title states the claim in plain words (it is also the image's alt text). No jargon, no ids (P-0012).
- First person when it speaks for the owner ("Me, walking"). Only true facts: what the system really does today.
- At most 11 boxes. If it needs more, it is two posts.

## In a social campaign (Pack: social)

Save the PNG under `data/assets/A-<n>-<slug>.png`, add an `A-<n>` row to `data/assets.md` (kind `diagram`, made by = your role, source = the spec file), and list `A-<n>` in the post row's Assets. The console shows the image on the post card, so the owner approves text and picture together.

## Where it is installed

Source: `skills/diagram` (this folder). Listed in the team skill library `skills/team-skills.json`; the `team-skills` timer links it into every agent config dir on the host (`~/.claude`, every `~/.claude_seatN`, `~/.agents` and `~/.codex` skills dirs), so every persona has it on whichever seat it wakes ([skills/README.md](../README.md)).

Chromium: `$DIAGRAM_CHROME`, else the newest `~/.cache/ms-playwright/chromium_headless_shell-*` (install it with `npx playwright install chromium-headless-shell`).
