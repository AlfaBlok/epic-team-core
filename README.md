# Epic Team core

**Not public yet.** This repository is private while the core takes shape. It will be opened when the owner decides;
until then, do not share it, fork it publicly or copy it elsewhere.

Epic Team runs a team of AI agents on your own server. You write what you want in an epic (a living Markdown
document, the [EpicSpine](https://epicspine.dev) method). Personas wake on a cadence, pick up
its ready rows, and dispatch workers onto the agent seats you have. The core is what one team needs on one server.
The hosted service (many teams, sign-up, billing, hosting a customer's server) is built on top of it and lives
elsewhere.

## What is here

| Folder | What it is |
|---|---|
| [`personas/`](personas/) | Generic persona templates: listener, author, responder, engager, gap-finder, and the social pack's scout, writer, publisher and reporter. They say who a persona is, never what it works on. |
| [`dispatcher/`](dispatcher/) | The seat broker and the EpicSpine machine dispatcher for one host: which Claude Code seat runs the next worker, with usage, memory, load and session caps. |
| [`console/`](console/) | The console for one team: team home, desk, decks, goals, review cards, runs and wakes. `server/` is Node, Hono and SQLite; `web/` is Vite and React. A hosted layer, when one sits beside `core/`, plugs in its own parts at start; without it the server runs as one team. |
| [`skills/`](skills/) | The team skill library and its installer (`team-skills.py`), with three of the team's own skills: `paper-deck` (decks and pages), `house-diagram-style` and `diagram` (post and page diagrams). Third-party skills are listed by repo and pinned commit, and fetched from their own repos at install time. |

## Not here yet

- **The console's web client on its own.** The server builds and runs without the hosted layer; the web client still
  reaches a few social number modules of the hosted layer (types and the dev mock), so it builds only with that layer
  beside it for now.
- **A memory plug.** Personas search "the memory MCP server the team connects"; any MCP memory server with a
  `search_memory` tool fits.

## Run the tests

```sh
python3 dispatcher/test_broker.py
TEAM_SKILLS_MCP=0 python3 skills/test_team_skills.py
python3 skills/paper-deck/scripts/test_paper_deck.py
python3 skills/house-diagram-style/scripts/test_house_diagram.py   # needs a headless Chromium for the render tests
```

Python 3.10 or newer, standard library only. The console needs Node 22:

```sh
cd console/server && npm ci && npx vitest run
cd console/web && npm ci && npx vitest run
```

## How this repository is made

The core is developed as a `core/` folder inside the team's private repository. Each update arrives here as one
commit holding that folder's tree (the tree `git subtree split --prefix=core` yields), so this history holds only
the core: no other file, commit message or author travels. Every file passes a name check and a gitleaks scan before
it is pushed. Changes made here are carried back with `git subtree pull --prefix=core --squash`.

## Licence

[GNU Affero General Public License v3.0](LICENSE), the same licence as EpicSpine. You can run, change and share the
core. If you offer a changed copy to users over a network, you must publish your changes. Font files carry their own
SIL Open Font License texts beside them.
