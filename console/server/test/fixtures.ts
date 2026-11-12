import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Verbatim copies of real spines / tickets (test/real/) used as regression fixtures. */
export const real = (name: string) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "real", name), "utf8");

// Fixture repos shaped like the real ones on the main server: the infra repo (root spine + E5 epic ticket under
// tickets/), the code repo (EpicSpine AGENTS.md block + docs/spines/root.md), a worktree and a plain repo.

export const EPIC0 = `# EPIC-900: VPS fleet — inventory, health, and sizing

Spine profile: compact
Spine Type: root
Ticket backend: local
Ticket root: ../tickets
Spine ID: EPIC-900

## Current State

Owner: Sam (fleet steward)
Status: active
Latest (2026-10-14): E5 Fleet Observatory opened.
Waiting on: Sam decisions for P1b, P2, P4 (P0 done).
Next action: P1b weekly prune.

## Child Epics (planned)

| Epic | Ticket | Purpose | Status |
|---|---|---|---|
| E1 | [E1](../tickets/E1-inventory-health-baseline.md) | Inventory + health baseline | done |
| E5 | [E5](../tickets/E905-fleet-observatory.md) | Fleet Observatory | active |

## Definition Of Done

- [x] Inventory of MAIN
- [ ] Sizing decision

## Issue Ledger

| Ticket | Depends On |
|---|---|
| [E1](../tickets/E1-inventory-health-baseline.md) | none |
| [E5](../tickets/E905-fleet-observatory.md) | E1 |
`;

export const E5 = `# E5: Fleet Observatory (milestone "M2")

Ticket ID: E5
Status: active
Owner: delivery manager (dispatches workers); Sam approves

## Goal

One page Sam opens on the tailnet to see, at a glance: what runs on MAIN (live / paused / stopped),
what each thing consumes (CPU, memory, storage), simple host CPU and disk history.

## Acceptance

- [ ] Tabs **Now**, **CPU**, **DATA** on the existing status page (other chapters stay reachable).
- [ ] Now: every container + paused/stopped deployer apps + paused crons, with state, CPU %, mem, restarts.
- [ ] CPU: host load history (sar) and top containers by CPU over time (vps-snapshots docker-stats).
- [ ] DATA: root/data disk history (\`disk.csv\`), storage per container/volume, S3 size per bucket/prefix
      with growth over time.
- [ ] Numbers match \`df\` / \`docker stats\` / S3 listing at generation time.
- [ ] Auto-refresh (about every 10 min) behind a stable tailnet URL served by a supervised process.
- [ ] Read-only everywhere: no host, deployer, or S3 writes; no secrets in repo or page.

## Phases

| Phase | Scope | Status |
|---|---|---|
| E5.1 | Tabs from data already collected | done 2026-10-14 (88406a2) |
| E5.2 | Read-only daily S3 size listing | done 2026-10-14 |
| E5.3 | Auto-refresh + supervised server | pending E5.1 |
`;

export const E1 = `# E1: Inventory + health baseline

Ticket ID: E1
Status: done

## Acceptance

- [x] Inventory
`;

export const ROOT_SPINE = `# EPIC: Agent team

Spine ID: agent-team-root

## Current State

Owner: Delivery manager
Status: active
Phase: M2 team console
Waiting on: M2-3 + M2-2 workers; later Sam on X accounts.
Next action: integrate.
Source revision: 116d70b
Verified at: 2026-10-14

## Definition Of Done

- [x] M0 smoke
- [x] M1 routing
- [ ] M2 console

## Issue Ledger

| Issue | Role | Owner / Assignment | Title | Status |
|---|---|---|---|---|
| M2-2 | Ticket worker | seat pool | Cycle + bootstrap | dispatched |
| M2-3 | Ticket worker | seat pool | Read adapters + pickers | dispatched |
`;

export const SEATS = {
  beat: 22,
  seats: {
    seat2: {
      providerInstanceId: "claudeAgent_seat2",
      org: "Acmehomes",
      in_flight: 0,
      maxed_until: null,
      logged_in: true,
      usage: { known: false, reason: "usage endpoint HTTP 429", five_hour_pct: null, weekly_pct: null, status: "unknown", read_at: "2026-10-14T21:14:54Z" },
    },
    seat1: {
      providerInstanceId: "claudeAgent_seat1",
      org: "Acme",
      in_flight: 2,
      maxed_until: null,
      logged_in: true,
      usage: {
        known: true,
        five_hour_pct: 4,
        five_hour_resets_at: "2026-10-14T23:00:00Z",
        weekly_pct: 29,
        weekly_resets_at: "2026-10-18T00:00:00Z",
        status: "allowed",
        limited_until: null,
        read_at: "2026-10-14T21:00:00Z",
      },
    },
  },
  updated: "2026-10-14T21:14:54Z",
};

function write(root: string, rel: string, text: string) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

export function makeFixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-repos-"));
  // the infra repo
  write(root, "ops/.git/config", `[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/Acme/ops.git\n`);
  write(root, "ops/docs/EPIC-900-VPS-FLEET.md", EPIC0);
  write(root, "ops/docs/data-catalog.md", "# Data catalog\n");
  write(root, "ops/tickets/E905-fleet-observatory.md", E5);
  write(root, "ops/tickets/E1-inventory-health-baseline.md", E1);
  write(root, "ops/tickets/VH-T10-watchdog-alert-delivery.md", "# VH-T10: Watchdog alert delivery\n\nStatus: blocked — needs Sam\n");
  // the code repo
  write(root, "home_repo/.git/config", `[remote "origin"]\n\turl = git@github.com:Acme/home_repo.git\n`);
  write(root, "home_repo/AGENTS.md", "## EpicSpine — always on\nRoot spine: docs/spines/root.md\n");
  write(root, "home_repo/docs/spines/root.md", ROOT_SPINE);
  write(root, "home_repo/notes/deep/leaf.md", "# Leaf spine\n\nSpine ID: leaf-1\nStatus: blocked — waiting on vendor\n");
  write(root, "home_repo/node_modules/pkg/x.md", "# ignored\n\nSpine ID: nope\n");
  // a worktree of the code repo (its.git is a file) and a non-git dir
  write(root, "home_repo-wt-m2-3/.git", `gitdir: ${path.join(root, "home_repo/.git/worktrees/home_repo-wt-m2-3")}\n`);
  write(root, "home_repo-wt-m2-3/README.md", "# wt\n");
  write(root, "plain/.git/config", "[core]\n");
  write(root, "plain/README.md", "# plain\n");
  write(root, "notgit/README.md", "# not a repo\n");
  write(root, "seats.json", JSON.stringify(SEATS));
  return { root, write: (rel: string, text: string) => write(root, rel, text), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
