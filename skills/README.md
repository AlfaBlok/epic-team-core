# Team skills

One library, every seat has it. [`team-skills.json`](team-skills.json) lists every team skill: the team's own live in
`skills/<name>`, third-party ones are a GitHub repo pinned to a commit, fetched from that repo at install time. Each
entry has a one-line `use_when`.

[`team-skills.py`](team-skills.py) (python3 stdlib) installs them:

| Command | Does |
|---|---|
| `sync` | fetches pinned third-party skills into one sparse checkout per repo@sha under `~/.local/share/team-skills/.repos/`, symlinks every skill into every agent config dir, removes its own links for skills no longer listed |
| `check` | exit 1 and lists drift per config dir: `missing`, `stale`, `extra`, `conflict` |
| `list` | the library |
| `add <github-url> [--path P] [--name N] [--use-when T] [--dry-run] [--no-sync]` | resolves the repo to a SHA, reads the SKILL.md name and description, writes the entry, syncs |
| `remove <name> [--no-sync]` | drops the entry and syncs |
| `install-timer` | systemd user timer `team-skills.timer`: `sync --quiet` every 10 min |

Every command takes `--json`. Exit codes: 0 green, 1 drift or conflict, 2 error.

Config dirs are found by glob on every run: `~/.claude/skills`, every `~/.claude_seat<N>/skills` (Claude Code),
`~/.agents/skills` and `~/.codex/skills`. Only symlinks pointing into this repo's `skills/` or into the cache are
the installer's; everything else is never touched.

The paper brand file [`brands/paper.json`](brands/paper.json) holds the colours and fonts `paper-deck` and
`house-diagram-style` share.

Tests: `TEAM_SKILLS_MCP=0 python3 skills/test_team_skills.py` (temp HOME with fake seat dirs and a local "GitHub").
