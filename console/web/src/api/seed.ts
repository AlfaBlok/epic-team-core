import type { Assignment, Milestone, NeedsOwner, Persona, Repo, RepoDoc, Run, Seat, Thread, Ticket } from "./types";

export interface MockDb {
  milestones: Milestone[];
  personas: Persona[];
  assignments: Assignment[];
  runs: Run[];
  needsOwner: NeedsOwner[];
  threads: Thread[];
  tickets: Ticket[];
  seats: Seat[];
  repos: Repo[];
  /** Candidate milestone files per repo name. */
  docs: Record<string, RepoDoc[]>;
}

const iso = (now: number, minutesFromNow: number) => new Date(now + minutesFromNow * 60_000).toISOString();

/** Realistic example data: the infra repo E5 with infra-steward every 2 h, the memory service launch paused. */
export function seed(nowDate: Date = new Date()): MockDb {
  const now = nowDate.getTime();
  const t = (m: number) => iso(now, m);

  const milestones: Milestone[] = [
    {
      id: "ms-e5",
      title: "ops · E5 Fleet Observatory",
      repo: "Acme/ops",
      path: "tickets/E5-fleet-observatory.md",
      owner: "Sam",
      paused: false,
      createdAt: t(-3 * 1440),
      status: "active",
      waitingOn: "Sam: memory limits for the 5 largest unlimited containers on host1 (swap 4.0/4.0 GiB).",
      dod: {
        done: 3,
        total: 7,
        items: [
          { text: "Fleet inventory: every VPS listed with role, provider and owner", checked: true },
          { text: "Collector on each host reports load, swap, disk and container count every 60 s", checked: true },
          { text: "Status page shows per-host health with last-seen time", checked: true },
          { text: "Relay watchdog log and restarts shown on the status page", checked: false },
          { text: "Alert to HQ thread when a host misses 3 reports or swap > 90 %", checked: false },
          { text: "Container memory limits audited; unlimited containers listed per host", checked: false },
          { text: "Pre-approved runbook list reviewed and signed off by Sam", checked: false },
        ],
      },
      stateExcerpt:
        "Status: active — E5-4 (relay panel) in progress on seat2.\nLast attempted: E5-3 status page last-seen column merged.\nWaiting on: Sam approval for container memory limits (host1 swap full).\nNext action: finish E5-4, then E5-5 alerting.",
    },
    {
      id: "ms-memo",
      title: "Memo launch",
      repo: "memo-ai/memo",
      path: "docs/spines/launch.md",
      owner: "Sam",
      paused: true,
      createdAt: t(-1440),
      status: "paused",
      dod: {
        done: 0,
        total: 5,
        items: [
          { text: "Launch post drafted and approved", checked: false },
          { text: "X account posts daily for 7 days", checked: false },
          { text: "Reddit posts in 3 relevant subreddits", checked: false },
          { text: "Replies handled within 4 h", checked: false },
          { text: "Signup funnel instrumented", checked: false },
        ],
      },
      stateExcerpt: "Status: paused until M2 console is live (moved to M3).",
    },
  ];

  const personas: Persona[] = [
    {
      id: "p-steward",
      name: "infra-steward",
      remit:
        "Each wake:\n1. Health check, read-only: watchdog/relay log, load, swap, disk, status page data.\n2. Read the spine, ticket and ledger: what is blocked or stalled, and why.\n3. Decide and act: relaunch a worker on a ticket whose blocker has cleared, or launch a service-restoration agent.\n4. Record the run with its actions and the child agents launched.\nDrive to green: do reversible steps yourself (restart, retry, rerun), record notable ones with a rollback, ask Sam only for data loss, money, third parties, wider access or a goal change.",
      skills: ["epic-spine", "vps-health", "docker"],
      model: "claude-sonnet-5-5",
      mayWrite: false,
      createdAt: t(-3 * 1440),
    },
    {
      id: "p-pm",
      name: "milestone-pm",
      remit:
        "Read the milestone spine, pick the next unblocked ticket, dispatch a worker via the seat pool, update Current State and the Issue Ledger. Only you edit the spine.",
      skills: ["epic-spine"],
      model: "claude-opus-5-5",
      mayWrite: true,
      createdAt: t(-2 * 1440),
    },
  ];

  const assignments: Assignment[] = [
    {
      id: "as-e5-steward",
      milestoneId: "ms-e5",
      personaId: "p-steward",
      cadence: { type: "interval", everyMinutes: 120 },
      enabled: true,
      lastRunAt: t(-47),
      nextRunAt: t(73),
    },
    {
      id: "as-memo-pm",
      milestoneId: "ms-memo",
      personaId: "p-pm",
      cadence: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      enabled: false,
    },
  ];

  const a = "as-e5-steward";
  const runs: Run[] = [
    {
      id: "run-8",
      assignmentId: a,
      startedAt: t(-47),
      endedAt: t(-41),
      seat: "seat1",
      threadId: "thr-8a2c",
      outcome: "progressed",
      summary: "Health ok (load 3.1, swap 71 %). Blocker cleared; relaunched a worker on it.",
      // tokens from the run's transcript (estimate).
      usage: { model: "claude-opus-5-5", input: 40, cacheWrite: 52_000, cacheRead: 610_000, output: 8_900, turns: 14, costUsd: 0.6243, estimate: true, collectedAt: t(-38), source: "claude-code:host1" },
    },
    {
      id: "run-8c1",
      parentRunId: "run-8",
      assignmentId: a,
      startedAt: t(-43),
      seat: "seat2",
      threadId: "thr-8c1f",
      outcome: "running",
      summary: "Worker: E5-4 relay watchdog panel on the status page.",
    },
    {
      id: "run-7",
      assignmentId: a,
      startedAt: t(-167),
      endedAt: t(-158),
      seat: "seat2",
      threadId: "thr-7b10",
      outcome: "blocked",
      summary: "Swap 4.0/4.0 GiB full. Launched a diagnose-only restoration agent; container limits need Sam.",
    },
    {
      id: "run-7c1",
      parentRunId: "run-7",
      assignmentId: a,
      startedAt: t(-164),
      endedAt: t(-152),
      seat: "seat1",
      threadId: "thr-7c3d",
      outcome: "progressed",
      summary: "Diagnose: 35 containers without memory limits; top 5 hold 2.6 GiB of swap. Proposal sent to Needs Sam.",
    },
    {
      id: "run-6",
      assignmentId: a,
      startedAt: t(-287),
      endedAt: t(-284),
      seat: "seat1",
      threadId: "thr-6e44",
      outcome: "idle",
      summary: "Health ok. Still waiting on the relay log format; nothing to do.",
    },
    {
      id: "run-5",
      assignmentId: a,
      startedAt: t(-407),
      endedAt: t(-396),
      seat: "seat2",
      threadId: "thr-5d90",
      outcome: "progressed",
      summary: "Closed E5-3 (status page last-seen); ticked DoD item 3.",
    },
    {
      id: "run-5c1",
      parentRunId: "run-5",
      assignmentId: a,
      startedAt: t(-405),
      endedAt: t(-398),
      seat: "seat1",
      threadId: "thr-5c71",
      outcome: "progressed",
      summary: "Worker: E5-3 last-seen column, PR merged.",
    },
    {
      id: "run-4",
      assignmentId: a,
      startedAt: t(-527),
      endedAt: t(-526),
      outcome: "failed",
      summary: "Seat pick returned no seat (both seats unknown: tokens expired). Retry next wake.",
    },
  ];

  const needsOwner: NeedsOwner[] = [
    {
      id: "nj-1",
      runId: "run-7c1",
      milestoneId: "ms-e5",
      question: "Set memory limits on the 5 largest unlimited containers on host1?",
      proposedAction:
        "docker update --memory 512m --memory-swap 768m on memo-worker, memo-api, metabase, n8n, grafana; then watch swap for 1 h.",
      status: "open",
      createdAt: t(-152),
    },
    {
      id: "nj-2",
      runId: "run-8",
      milestoneId: "ms-e5",
      question: "Add the relay watchdog restart to the pre-approved runbook list?",
      proposedAction: "Append 't3-relay-watchdog: restart t3code' to runbooks/pre-approved.md in ops.",
      status: "open",
      createdAt: t(-41),
    },
  ];

  const threads: Thread[] = [
    { id: "thr-8a2c", title: "infra-steward · E5 wake", project: "ops", milestoneId: "ms-e5", status: "idle", updatedAt: t(-41) },
    { id: "thr-8c1f", title: "E5-4 relay watchdog panel", project: "ops", milestoneId: "ms-e5", status: "running", updatedAt: t(-3) },
    { id: "thr-7c3d", title: "Diagnose host1 swap pressure", project: "ops", milestoneId: "ms-e5", status: "idle", updatedAt: t(-152) },
    { id: "thr-hq", title: "HQ — host1 alerts", project: "home_repo", status: "idle", updatedAt: t(-90) },
    { id: "thr-m2-1", title: "M2-1 console server", project: "home_repo", status: "running", updatedAt: t(-5) },
  ];

  const tickets: Ticket[] = [
    { id: "E5-1", title: "Fleet inventory", repo: "Acme/ops", milestoneId: "ms-e5", status: "done", owner: "worker", source: "tickets-dir" },
    { id: "E5-2", title: "Host collector (load, swap, disk, containers)", repo: "Acme/ops", milestoneId: "ms-e5", status: "done", owner: "worker", source: "tickets-dir" },
    { id: "E5-3", title: "Status page last-seen column", repo: "Acme/ops", milestoneId: "ms-e5", status: "done", owner: "worker", source: "tickets-dir" },
    { id: "E5-4", title: "Relay watchdog panel", repo: "Acme/ops", milestoneId: "ms-e5", status: "in progress", owner: "seat2 worker", source: "ledger" },
    { id: "E5-5", title: "HQ alerting on missed reports / swap", repo: "Acme/ops", milestoneId: "ms-e5", status: "ready", owner: "—", source: "ledger" },
    { id: "E5-6", title: "Container memory limits audit", repo: "Acme/ops", milestoneId: "ms-e5", status: "blocked", owner: "Sam", source: "ledger" },
    { id: "#41", title: "Status page 502 after cloudflared restart", repo: "Acme/ops", milestoneId: "ms-e5", status: "open", source: "github", url: "https://github.com/Acme/ops/issues/41" },
    { id: "Z-1", title: "Launch post draft", repo: "memo-ai/memo", milestoneId: "ms-memo", status: "draft", owner: "—", source: "ledger" },
    { id: "Z-2", title: "X + Reddit account access", repo: "memo-ai/memo", milestoneId: "ms-memo", status: "waiting", owner: "Sam", source: "ledger" },
  ];

  const seats: Seat[] = [
    { id: "seat1", name: "seat1", usage5h: 18, usageWeekly: 34, resetsAt: { fiveHour: t(170), weekly: t(4 * 1440) }, limited: false, status: "ok", inFlight: 1, readAt: t(-1), org: "Memo" },
    { id: "seat2", name: "seat2", usage5h: 42, usageWeekly: 51, resetsAt: { fiveHour: t(95), weekly: t(2 * 1440) }, limited: false, status: "ok", inFlight: 2, readAt: t(-1), org: "Acmehomes" },
    { id: "seat3", name: "seat3", resetsAt: {}, limited: false, status: "unknown", reason: "usage endpoint HTTP 429", inFlight: 0, readAt: t(-1) },
  ];

  const gh = "/srv/agent/github";
  const repos: Repo[] = [
    { name: "home_repo", path: `${gh}/home_repo`, remote: "Acme/home_repo", hasEpicSpine: true },
    { name: "epicspine-skill", path: `${gh}/epicspine-skill`, remote: "Acme/epicspine-skill", hasEpicSpine: true },
    { name: "ops", path: `${gh}/ops`, remote: "Acme/ops", hasEpicSpine: true },
    { name: "sismic", path: `${gh}/sismic`, remote: "Acme/sismic", hasEpicSpine: false },
    { name: "memo", path: `${gh}/memo`, remote: "memo-ai/memo", hasEpicSpine: true },
  ];
  const docs: Record<string, RepoDoc[]> = {
    home_repo: [
      { path: "docs/spines/root.md", kind: "spine", title: "EPIC: Agent team", status: "active", dod: { done: 7, total: 9 }, via: "spines", depth: 0, parent: null, type: "root" },
      { path: "docs/spines/m2-team-console.md", kind: "spine", title: "EPIC: M2 — Team console", status: "active", dod: { done: 0, total: 6 }, via: "spines", depth: 1, parent: "docs/spines/root.md", type: "leaf" },
      { path: "docs/spines/m5-unblocked-web.md", kind: "spine", title: "M5 — Unblocked web access", status: "draft", dod: { done: 0, total: 4 }, via: "spines", depth: 1, parent: "docs/spines/root.md", type: "leaf" },
      { path: "docs/notes/old-plan.md", kind: "spine", title: "Old plan", dod: { done: 0, total: 0 }, via: "spines", orphan: "not reachable from the root" },
    ],
    "ops": [
      { path: "docs/EPIC-900-VPS-FLEET.md", kind: "spine", title: "EPIC-900: VPS fleet — inventory, health, and sizing", status: "active", dod: { done: 3, total: 8 }, via: "fallback" },
      { path: "docs/EPIC-900-VPS-HEALTH.md", kind: "spine", title: "EPIC-900: VPS health", status: "active", dod: { done: 4, total: 10 }, via: "fallback" },
      { path: "tickets/E1-inventory-health-baseline.md", kind: "ticket", title: "E1: Inventory + health baseline", status: "done", dod: { done: 6, total: 6 }, via: "fallback" },
      { path: "tickets/E5-fleet-observatory.md", kind: "ticket", title: 'E5: Fleet Observatory (milestone "M2")', status: "active", dod: { done: 0, total: 7 }, via: "fallback" },
      { path: "tickets/VH-T10-watchdog-alert-delivery.md", kind: "ticket", title: "VH-T10: Watchdog alert delivery", status: "blocked", dod: { done: 0, total: 3 }, via: "fallback" },
    ],
    memo: [{ path: "docs/spines/launch.md", kind: "spine", title: "Memo launch", status: "paused", dod: { done: 0, total: 5 } }],
    "epicspine-skill": [],
    sismic: [],
  };

  return { milestones, personas, assignments, runs, needsOwner, threads, tickets, seats, repos, docs };
}
