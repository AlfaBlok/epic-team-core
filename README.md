# Epic Team core

**Run one team of AI agents on your own server, with your own AI, free.** This is the open core of
[EpicTeam](https://epicteam.app): the console for one team, the seat broker, persona templates and skills, under the
AGPL. Hosting many teams for you (sign-up, billing, our servers, backups) is the paid service built on top of it.

```
 you write an objective  ──►  personas wake on a schedule  ──►  workers run on your AI seats  ──►  cards in your inbox
     (console, web)              (console, cycle)                 (dispatcher, Claude Code)          (console, web)
```

You write what you want as an objective with key results, in an epic (a living Markdown document, the
[EpicSpine](https://epicspine.dev) method). Personas wake on a cadence, pick up its ready rows, and dispatch workers
onto the agent seats you have. Whatever needs you comes back as one card in one inbox.

## Run the console in five minutes

You need a Linux or macOS server with git, Node 22 and Python 3.10 or newer.

1. Clone this repository and go into it.
2. Install and build:

   ```sh
   cd console/server && npm ci
   cd ../web && npm ci && npm run build
   ```

3. Start it:

   ```sh
   cd ../server && PORT=8750 npm start
   ```

   It prints `console server on http://127.0.0.1:8750`. Open that address: the team home, inbox, goals and review
   cards. The database is one SQLite file, `~/team_console/console.db` (set `CONSOLE_DB` to move it).

The console listens on `127.0.0.1` only and has no login by default, so only you on that machine reach it. From your
laptop, reach it through an ssh tunnel (`ssh -L 8750:127.0.0.1:8750 you@your-server`) or a private network such as
Tailscale. Do not set `HOST=0.0.0.0` on a server open to the internet.

## Let the team wake

The console starts agent sessions; the agents are Claude Code, running on your server in your name.

| What | How |
|---|---|
| Your AI | Install Claude Code and sign it in with your own Claude subscription or Anthropic API key. Each signed-in config dir is one seat (`~/.claude_seat1`, `~/.claude_seat2`, ...). |
| Session host | [T3 Code](https://github.com/pingdotgg/t3code) runs the sessions; the console talks to its MCP endpoint (`T3_MCP_URL`, default `http://127.0.0.1:3773`). |
| Seats | In T3 Code's environment, point `EPICSPINE_DISPATCHER` at `dispatcher/t3_seat_pool.py` and list your seats in its `seats.json` ([dispatcher/README.md](dispatcher/README.md)). |
| Method | Install the [EpicSpine skill](https://epicspine.dev) so every agent reads and writes your epics the same way. |
| Skills | `python3 skills/team-skills.py sync` links the team skill library into every seat ([skills/README.md](skills/README.md)). |
| Your repo | Check your team's repo out under `~/github/<name>` and start the console with `CONSOLE_HOME_REPO=<name>`. |
| Wakes on | Start the console with `CONSOLE_CYCLE_ENABLED=true`. |

Who the console is for is set by environment: `CONSOLE_OWNER_NAME`, `CONSOLE_HOME_REPO`, `CONSOLE_HOME_ORG` and the
others in `console/server/src/identity.ts`. Voice notes and calls need `OPENAI_API_KEY`; everything else runs without it.

## What is here

| Folder | What it is |
|---|---|
| [`console/`](console/) | The console for one team: team home, desk, decks, goals, review cards, runs and wakes. `server/` is Node, Hono and SQLite; `web/` is Vite and React. A hosted layer, when one sits beside `core/`, plugs in its own parts at start; without it the server runs as one team. |
| [`dispatcher/`](dispatcher/) | The seat broker and the EpicSpine machine dispatcher for one host: which Claude Code seat runs the next worker, with usage, memory, load and session caps. |
| [`personas/`](personas/) | Generic persona templates: listener, author, responder, engager, gap-finder, and the social pack's scout, writer, publisher and reporter. They say who a persona is, never what it works on. |
| [`skills/`](skills/) | The team skill library and its installer (`team-skills.py`), with three of the team's own skills: `paper-deck` (decks and pages), `house-diagram-style` and `diagram` (post and page diagrams). Third-party skills are listed by repo and pinned commit, and fetched from their own repos at install time. |

Not here yet: a one-command installer for the wake setup above, and a memory plug (personas search "the memory MCP
server the team connects"; any MCP memory server with a `search_memory` tool fits).

## Run the tests

```sh
python3 dispatcher/test_broker.py
TEAM_SKILLS_MCP=0 python3 skills/test_team_skills.py
python3 skills/paper-deck/scripts/test_paper_deck.py
python3 skills/house-diagram-style/scripts/test_house_diagram.py   # needs a headless Chromium for the render tests
cd console/server && npx vitest run
cd console/web && npx vitest run
```

## How this repository is made

The core is developed as a `core/` folder inside the team's own repository. Each update arrives here as one commit
holding that folder's tree (the tree `git subtree split --prefix=core` yields), so this history holds only the core:
no other file, commit message or author travels. Every file of every update passes a name check and a gitleaks scan
before it is pushed. Issues and pull requests are welcome; accepted changes are carried back with
`git subtree pull --prefix=core --squash`.

## Licence

[GNU Affero General Public License v3.0](LICENSE), the same licence as EpicSpine. You can run, change and share the
core. If you offer a changed copy to users over a network, you must publish your changes. Font files carry their own
SIL Open Font License texts beside them.
