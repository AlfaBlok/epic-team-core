# EPIC: M2 — Team console (milestones × personas × cadence) at agent-team.dev

Spine profile: compact
Spine dialect: v1
Spine ID: agent-team-m2
Spine Type: leaf
Root spine: docs/spines/root.md
Parent spine: docs/spines/root.md
Integration branch: main
Integration policy: main-direct (inherits root)

## Current State

Owner: Delivery manager
Status: active — scope closed by Sam 2026-10-14; M2-1 + M2-4 dispatched
Phase: scoping (M1 still in flight on seat1; M2 build starts after scope approval, UI slices can run in parallel with M1)
Last: M2-1 integrated 2026-10-14 (03f0f77; 23/23 tests + tsc clean, re-run by manager). Additive contract deviations accepted: Run.milestoneId, Assignment.createdAt, GET/PATCH /api/runs/:id, POST/GET /api/needs-owner, /api/health; unknown refs → 400 unknown_reference; weekdays 0–6 (0=Sun); host Node 18.19.1 pins (better-sqlite3@11, hono node-server@1).
Last: M2-4 integrated 2026-10-14 (22fbe91; 11/11 tests, build OK, re-run by manager); stray worker previews on 127.0.0.1:18751/8751 stopped.
Last: M2-5 integrated + deployed from main 2026-10-14 (e456440): curl 200 on http://main.tail.example:8750/ and http://10.104.206.10:8750/, /api/health 200, SPA deep link 200; listens on tailnet IP only; DB empty (Sam configures in UI). Rollback in hosted/console/README.md.
Last: M2-3 integrated + deployed 2026-10-14 (25ff88d; server 47/47, web 18/18, tsc clean, re-run by manager); live: /api/repos 16, ops docs 40 (E5 0/7), threads/tickets/seats 200. Heuristic: blocked = first clause of 'Waiting on:' names Sam/approval; threads link to milestones by repo + key in title.
M2-2 r1 (87a462d): built + e2e passed (home thread per assignment binds its own T3 scheduled task; wake stub → POST /api/assignments/:id/wake; run idle with seat + thread; task deleted after); conflicts with M2-3 in app.ts + dialogs.tsx → r2 rebase dispatched to seat1. Open risks to track: home thread pinned to one seat; run status self-reported (3 h stale → failed); fixed_time uses host local time; API unauthenticated (tailnet only); bootstrap untested with a real agent and commits on main in the shared checkout.
Last: M2-2 r2 integrated + deployed 2026-10-15 (5a10233; server 67/67, web 19/19, tsc clean, re-run by manager); live 200 on both tailnet URLs; /api/cycle enabled=false; DB empty.
Next action: Sam re-tries the UI after M2-7 (54e12ca live: sidebar clip, Add milestone modes, persona/run visibility; Run now is disabled while the cycle switch is off), then decides to switch the cycle on (~/team_console/cycle.env CONSOLE_CYCLE_ENABLED=true + restart) and sets up E5 + infra-steward in the UI → M2-6 dogfood 3 days. Was: both dispatched 2026-10-14 after Sam asked for repo/ticket pickers and create-new-on-request; M1 done (116d70b) so M2-2 is unblocked. then M2-3 adapters; M2-2 cycle after M1. Was: verify and integrate M2-4 (UI, mock data), then M2-3 (read adapters) and M2-2 (cycle, needs M1).
Verified at: 2026-10-14

## Mission

M1 routes work to seats. M2 adds the "employee" layer on top: **personas that wake on a cadence to push a milestone forward**, and one web console at **agent-team.dev** where Sam sees the whole team's state across all milestones and repos.

Test case (dogfood): milestone = ops **E5 Fleet Observatory** (`Acme/ops`, ticket `tickets/E5-fleet-observatory.md` under spine `docs/EPIC-900-VPS-FLEET.md`; health context from `docs/EPIC-900-VPS-HEALTH.md`), with one persona, **infra-steward**, on a cadence. Naming: ops also calls E5 "M2"; that is its own milestone label and is unrelated to this home_repo M2.

## Model (the four nouns)

Principle (Sam 2026-10-14): nothing is hard-wired. Milestones, personas, and the links between them (assignments with a cadence) are all created, edited, paused and deleted from the UI. The infra-steward on ops E5 is test data entered through the UI, not code.


- **Milestone** = a pointer to an EpicSpine spine or epic ticket in a repo (`repo` + `path`; E5 is a ticket with an Acceptance checklist) + a title + an owner. Its status and backlog are *read from that spine* (Current State, DoD, Issue Ledger, `tickets/` dir, GitHub issues). The console never keeps a second copy of milestone truth.
  - Status shown: `active` · `blocked` (with reason + who it waits on) · `done` (all DoD boxes checked and accepted by Sam) · `paused`.
- **Persona** = a reusable role: name, prompt file, skill list, default model. Not tied to a seat (D-1). Created and edited in the UI (name, remit/prompt, skills, model), stored in SQLite; any persona can be attached to any milestone.
- **Assignment** = milestone × persona × cadence (e.g. every 2 h, or weekdays 09:00) × enabled. Backed 1:1 by a T3 `schedule_task`, so T3 stays the clock; the console only creates/edits/pauses them.
- **Run** = one wake of an assignment: started, seat (from M1 `pick`), T3 thread link, outcome `progressed` / `blocked: <reason>` / `idle: nothing to do`, one-line summary. Appended to a run log.

Test persona **infra-steward** (remit from Sam 2026-10-14). Each wake: (1) health check, read-only (watchdog/relay log, load, swap, disk, status page data); (2) read the spine, ticket and ledger: what's blocked or stalled, and why; (3) decide and act: relaunch a worker on a ticket whose blocker has cleared, or launch a service-restoration agent; (4) record the run with its actions and the child agents launched. Safety: ops rules say no production change without Sam's per-item approval, so restoration agents start in diagnose-only mode; any restart/write goes to "Needs Sam" unless it's on a pre-approved runbook list (e.g. the relay watchdog).

The cycle per wake: persona reads the milestone spine → picks the next unblocked item for its role → dispatches/does it via the seat pool → records the run → updates the spine (single writer per D-3: only the milestone's PM persona edits the spine; others report to it). `blocked` that needs Sam → HQ thread (D-6).

## Console (Tailwind + shadcn, simple)

- **Sidebar**: "Team" (home) · Milestones (each with a status dot) · "+ New milestone" · bottom: Threads, Tickets, Seats.
- **Team (home, agent-team.dev/)**: one card per milestone — status, DoD progress (x/y), blocked reason, last run + next wake, active threads count. "Needs Sam" list at the top.
- **Milestone page**, tabs:
  - Overview — goal, DoD checklist (from spine), blocked items, Current State excerpt.
  - Personas — attached personas with cadence, enabled toggle, model, last/next run, "Run now"; "+ Attach persona".
  - Backlog — tickets/issues behind the milestone (from spine ledger + tickets dir + GitHub issues), status, owner.
  - Activity — run log + linked T3 threads.
  - Settings — repo, spine path, title, pause/archive.
- **Threads** — all active T3 threads across projects (via T3 MCP `t3_thread_list`), grouped by milestone when linked.
- **Tickets** — all open tickets/issues across milestone repos in one table.
- **Seats** — per-seat usage from M1 (read-only).

## Data contract (shared by M2-1 server and M2-4 UI)

App lives in `core/console/` (`core/console/server` = Node + Hono + better-sqlite3, TypeScript; `core/console/web` = Vite + React + Tailwind + shadcn). JSON over `/api`, ids are strings, times ISO-8601 UTC.

- Milestone `{id, title, repo, path, owner, paused, createdAt}`; repo = local checkout path or `owner/name`; path = spine or epic ticket file in it. Derived (read-only, M2-3): `status: active|blocked|done|paused`, `dod: {done, total, items[{text, checked}]}`, `blockedReason?`, `stateExcerpt`.
- Persona `{id, name, remit, skills: string[], model, mayWrite: false, createdAt}`; remit = the prompt. mayWrite=false means restoration/ops actions diagnose only and send writes to Needs Sam.
- Assignment `{id, milestoneId, personaId, cadence: {type:"interval", everyMinutes} | {type:"fixed_time", timeOfDay, weekdays[]}, enabled, t3ScheduledTaskId?, lastRunAt?, nextRunAt?}`.
- Run `{id, assignmentId, startedAt, endedAt?, seat?, threadId?, outcome: "running"|"progressed"|"blocked"|"idle"|"failed", summary, parentRunId?}`; child agents a persona launches are Runs with parentRunId.
- NeedsSam `{id, runId, milestoneId, question, proposedAction, status: open|approved|denied, createdAt}`.

Endpoints: CRUD `/api/milestones`, `/api/personas`, `/api/assignments` (+ `POST /api/assignments/:id/run-now`), `GET/POST /api/runs`, `GET/PATCH /api/needs-owner`. Read-only later (M2-3): `/api/threads`, `/api/tickets`, `/api/seats`. The T3 schedule sync behind assignments is M2-2; in M2-1 the field stays empty.

## Architecture (smallest thing that works)

- One small Node app on main (Vite/React + Tailwind + shadcn front, tiny API server, e.g. Hono). No separate DB server: SQLite file for milestones, assignments, runs.
- Read adapters: spine parser (markdown sections), `tickets/` dir, `gh issue list`, T3 MCP (same `.t3token` the watchdog uses), M1 `seats.json`.
- Write path: create/edit milestone + assignment → T3 `schedule_task` / `update_scheduled_task` / `delete_scheduled_task`.
- Exposure (M2): tailnet only, http://main.tail.example:8750/ and http://10.104.206.10:8750/ (IP fallback for the Mac MagicDNS IPv6 issue), supervised systemd --user service. Public agent-team.dev with auth (Cloudflare Tunnel + Access) is deferred past M2.

## Definition Of Done

- [ ] M2-1 Generic model: milestone/persona/assignment/run schema in SQLite on main, plus a generic wake prompt that injects persona remit + milestone pointer. No persona or milestone in code.
- [ ] M2-2 Cycle: an assignment's T3 scheduled task wakes the persona with milestone context, picks a seat via M1 `pick`, records a Run with outcome; blocked-for-Sam goes to HQ.
- [ ] M2-3 Read API: milestones (status/DoD/backlog from spines), runs, T3 threads, open tickets across repos, seat usage.
- [ ] M2-4 UI: sidebar + Team home + Milestone tabs (Overview, Personas, Backlog, Activity, Settings) + Personas library page + Threads + Tickets; full create/edit/attach/detach/pause from the UI.
- [ ] M2-5 Console served on the tailnet at port 8750 (both URLs above, curl 200 from main), supervised and restart-safe.
- [x] M2-7 UX polish from Sam's first use (2026-10-15): sidebar titles clip (long title covered the Personas tab), "Add milestone" with explicit track-existing vs create-new-epic, persona remit is generic (milestone injected at wake), personas/cadence/run counts visible on Overview, Activity and Team.
- [ ] M2-8 Parsing for real spines (2026-10-16): backlog = the doc's own ledger + Queue-style tables (not every Ticket-root file; EPIC-902 showed all 38 repo tickets), linked ticket files enrich rows, free-text status normalised; Exit Test / Success criteria recognised, non-checkbox criteria shown as untracked; Spine shape hint.
- [ ] M2-6 Dogfood: Sam creates milestone ops E5 + persona infra-steward + cadence entirely in the UI; it runs 3 days on cadence; the console shows each run, the backlog moving, and any block, with no manual edits to the run log.

Non-goals for M2: public domain + auth (later), answerer persona, Memo as shared memory, social persona / Memo launch (→ M3), seats 3–8, multi-user, mobile polish, editing spines from the UI.

## Open Questions (Sam)

Answered by Sam 2026-10-14: Q1 status derived from the spine: yes. Q2 tailnet only for now (phone + Mac on Tailscale); public domain with auth later. Q3 SQLite on main. Q4 one persona, infra-steward (remit above), against ops E5.

## Issue Ledger

| Issue | Role | Owner / Assignment | Title | Status | Depends On | PR/Branch | Next Action |
|---|---|---|---|---|---|---|---|
| M2-1 | Ticket worker | seat1 (done) | Server: SQLite schema + CRUD API + parseDod + generic wake prompt | done | — | merged 03f0f77 | — |
| M2-2 | Ticket worker | seat1 (done, 2 rounds) | Cycle (home thread per assignment, T3 scheduled task, wake endpoint, run-now, approve/deny follow-up, limited-seat note) + bootstrap "+ New epic" | done | — | merged 5a10233 | deployed; cycle switch off |
| M2-3 | Ticket worker | seat1 (done) | Read adapters + repo/doc pickers; real status/DoD/backlog, threads, tickets, seats | done | — | merged 25ff88d | deployed |
| M2-4 | Ticket worker | seat2 (done) | shadcn UI on mock data (VITE_API=mock\|real) | done | — | merged 22fbe91 | — |
| M2-5 | Ticket worker | seat1 (done) | Served on tailnet 10.104.206.10:8750 (systemd --user agent-team-console, deploy via hosted/console/scripts/deploy.sh) | done | — | merged e456440 | redeploy after each console merge |
| M2-7 | worker seat1 | worker | Console UX polish (sidebar clip, add-milestone modes, persona/run visibility) | done 54e12ca, deployed 2026-10-15 | M2-4 | — | — |
| M2-8 | worker seat2 | worker | Spine parsing: own backlog only, Exit Test criteria, shape hint | dispatched 2026-10-16 | M2-3 | m2-8 | — |
| M2-6 | Delivery manager | manager | Dogfood infra-steward on ops E5, 3 days | draft | M2-2..M2-5 | — | — |

## Decisions

| Date | Outcome | Decision | Summary | Evidence |
|---|---|---|---|---|
| 2026-10-14 | accepted | D-13 (root): M2 = team console + persona cycle; Memo launch → M3 | Sam: M2 adds persona + cycle and the UI to manage milestones/personas/cadence at agent-team.dev; test with "Stabilize MAIN" on ops | user chat 2026-10-14 |
| 2026-10-14 | proposed | Milestone = pointer to a spine in a repo | Avoids duplicate truth; EpicSpine already holds state, DoD, ledger | manager proposal |
| 2026-10-14 | accepted | Q1–Q4: status from spine; tailnet-only at :8750 (public agent-team.dev + auth later); SQLite on main; test persona infra-steward on ops E5 | Sam's answers | user chat 2026-10-14 |
| 2026-10-14 | proposed | Restoration agents are diagnose-only by default; restarts/writes need Sam's approval unless on a pre-approved runbook list | ops non-goal: no production change without per-item approval | ops docs/EPIC-900-VPS-FLEET.md Non-Goals |
| 2026-10-14 | accepted | M2 scope closed; restoration default diagnose-only (persona.mayWrite=false) | Sam: "close the scope so we can start"; the UX configures repo + spine + persona/job + cadence links | user chat 2026-10-14 |
| 2026-10-14 | accepted | New-milestone dialog picks repo (git checkouts in ~/github) and spine/epic file from lists; "+ New epic" bootstraps the file via an agent in that repo (not written by the server) | Sam request with screenshot; agent follows each repo's own EpicSpine conventions | user chat 2026-10-14 |
