import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import type { T3Client } from "../src/t3/client.js";
import { createStore } from "../src/store.js";
import { createCycle } from "../src/cycle/service.js";
import type { Tree, TreeNode } from "../src/adapters/tree.js";
import { spineForFingerprint, spinesHash } from "../src/cycle/skipUnchanged.js";
import { STATE_RULE } from "../src/wakePrompt.js";

/**
 * a wake's own Current State re-check (Last attempted / Verified at restamped and committed) is not news, so the
 * next cadence wake skips. Modelled on whatgpt_v3 on 2026-10-25: 10 wakes, each "blocked: waits on
 * (QR scan)", each committing "docs(spine): wake re-check HH:MMZ, waits on", none skipped.
 */
const whatgptE0 = (o: { at?: string; run?: string; ask?: string; s5?: string; status?: string; waiting?: string } = {}) => `# PLAN-0: whatgpt v3

## Done means
- [x] E900-5 Repo on GitHub with this spine and the EpicSpine AGENTS.md block
- [ ] E900-7 WhatsApp linked and answering

## Current State

Owner: Delivery manager (Sam + bound agent)
Status: ${o.status ?? "active"}
Last attempted: DM re-check wakes 2026-10-24 19:13Z..${o.at ?? "2026-10-25 21:17Z"} (latest ${o.run ?? "run_9a2c0f95"}): nothing unblocked (pairing, sha 7738304).
Result: payment → credits path live; WhatsApp activation waits on the scan
Evidence: DM check: health 200 sha 7738304 at ${o.at ?? "2026-10-25 21:17Z"}
Waiting on: ${o.waiting ?? "Sam: T0-A11 (scan the QR), re-checked 2026-10-25T21:17Z"}
Approved work: PLAN-1..3 under standing approvals T0-G1..G10
Next action: after the scan: S6 live proof; re-check at 21:17Z
Source revision: 56f2a1c
Verified at: ${o.at ?? "2026-10-25 21:17"} UTC

## Waiting on

- [ask T0-A11: do @Sam since 2026-10-24 row S5] Scan the WhatsApp QR at https://admin.whatgpt.ai to link the number; recommend now.
${o.ask ?? ""}
## Ledger

| ID | Ticket | Owner | Status |
|---|---|---|---|
| S5 | WhatsApp pairing | Delivery Manager | ${o.s5 ?? "blocked"} |
| S6 | Live proof | Delivery Manager | ready |
`;

describe("T13-S12 spine fingerprint ignores bookkeeping", () => {
  const hash = (text: string) => spinesHash(new Map([["docs/PLAN-0-ROOT.md", text]]));

  it("a re-check that only restamps Last attempted / Result / Evidence / Verified at / Source revision keeps the hash", () => {
    const a = whatgptE0();
    const b = whatgptE0({ at: "2026-10-25 23:18Z", run: "run_bab8ba89" }).replace("Source revision: 56f2a1c", "Source revision: 2201295");
    expect(b).not.toBe(a);
    expect(hash(b)).toBe(hash(a));
  });

  it("time stamps in Waiting on: / Next action: do not count; their words do", () => {
    const a = whatgptE0();
    expect(hash(whatgptE0({ waiting: "Sam: T0-A11 (scan the QR), re-checked 2026-10-25T23:18:04Z" }))).toBe(hash(a));
    expect(hash(a.replace("re-check at 21:17Z", "re-check at 23:18Z"))).toBe(hash(a));
    expect(hash(whatgptE0({ waiting: "nothing from Sam" }))).not.toBe(hash(a));
  });

  it("Status, ledger rows, asks and Done means still count", () => {
    const a = hash(whatgptE0());
    expect(hash(whatgptE0({ status: "blocked" }))).not.toBe(a);
    expect(hash(whatgptE0({ s5: "done" }))).not.toBe(a);
    expect(hash(whatgptE0({ ask: "- [ask T0-A13: do @Sam since 2026-10-25] Paste the Groq key; recommend now.\n" }))).not.toBe(a);
    expect(hash(whatgptE0().replace("- [ ] E900-7", "- [x] E900-7"))).not.toBe(a);
  });

  it("bookkeeping prefixes only drop inside ## Current State (bold and bulleted forms too)", () => {
    const s = "# X\n## Current State\n- **Last attempted:** a\n**Verified at**: b\nStatus: active\n## Notes\nResult: kept\n";
    expect(spineForFingerprint(s)).toBe("# X\n## Current State\nStatus: active\n## Notes\nResult: kept\n");
  });
});

class FakeT3 implements T3Client {
  async listProjects() {
    return [{ id: "proj", title: "whatgpt_v3", workspaceRoot: "/srv/agent/github/whatgpt_v3" }];
  }
  async listScheduledTasks() { return []; }
  async updateScheduledTask() { return undefined; }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread() { return { threadId: "t" }; }
  async sendToThread() {}
  async readThreadStatus() { return { status: "idle", raw: {} }; }
}

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

const node = (id: string, p: string, children: TreeNode[] = []): TreeNode => ({
  key: id, id, kind: "spine", title: id, status: "active", color: "grey", path: p, children, flags: [],
});

function setup(o: { restampAfterMs?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e13s12-"));
  const repo = path.join(dir, "repo");
  const spine = path.join(repo, "docs/PLAN-0-ROOT.md");
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  fs.writeFileSync(spine, whatgptE0());
  const db: DB = openDb(path.join(dir, "c.db"));
  const store = createStore(db);
  /** What the next `git pull` brings in (the wake's own commit reaching the checkout late). */
  const remote: { pending?: () => void; pulls: number } = { pulls: 0 };
  const git = async (_dir: string, args: string[]) => {
    if (args[0] !== "pull") return;
    remote.pulls++;
    remote.pending?.();
    remote.pending = undefined;
  };
  const treeFor = async (): Promise<Tree> => ({
    milestoneId: "m",
    root: node("PLAN-0", "docs/PLAN-0-ROOT.md"),
    counts: { grey: 1, blue: 0, yellow: 0, red: 0, green: 0 },
    nonGreen: 1, closed: 0, flagged: 0, source: "spines", warnings: [],
  });
  const disp = {
    async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; },
    async done() {},
    async status() { return { name: "pool", capacity: 2, available: 0 }; },
  };
  const cycle = createCycle(db, store, {
    enabled: true, t3: new FakeT3(), dispatcher: disp, publicUrl: "http://x", treeFor, treeTodo: async () => "## To do", repoDir: () => repo,
    git, restampAfterMs: o.restampAfterMs ?? 0, wakePullMaxAgeMs: 0,
  });
  cleanup = () => { cycle.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  const m = store.createMilestone({ title: "whatgpt E0", repo: "whatgpt_v3", path: "docs/PLAN-0-ROOT.md", owner: "", paused: false });
  const p = store.createPersona({ name: "Delivery Manager", remit: "deliver", skills: [], model: "claude-opus-5-5", mayWrite: true });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 120 }, enabled: true });
  const newest = () => store.listRuns({ assignmentId: a.id }).find((r) => !r.parentRunId)!;
  const cadence = async () => (await cycle.wake(a.id, { threadId: "home" })).run?.outcome === "running";
  /** The DM ends blocked on; `edit` runs before its PATCH (spine already in the checkout). */
  const finish = async (edit?: () => void) => {
    const r = newest();
    edit?.();
    store.updateRun(r.id, { outcome: "blocked", summary: "blocked: waits on T0-A11", endedAt: new Date(Date.now() + 1).toISOString() });
    cycle.runEnded(r.id);
    await cycle.settled();
    return r;
  };
  const write = (o: Parameters<typeof whatgptE0>[0]) => () => fs.writeFileSync(spine, whatgptE0(o));
  return { db, store, cycle, remote, m, a, newest, cadence, finish, write };
}

const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("T13-S12 whatgpt E0: re-check wakes skip", () => {
  it("the wake's re-check commit lands after its run-end stamp: the next cadence wake still skips", async () => {
    const t = setup();
    expect(await t.cadence()).toBe(true);
    await t.finish();
    t.write({ at: "2026-10-25 23:18Z", run: "run_bab8ba89" })(); // the commit reaches the checkout after the stamp
    expect(await t.cadence()).toBe(false);
    expect(t.newest().summary).toMatch(/^skipped: nothing new since /);
  });

  it("a changed ledger row status or a new ask wakes", async () => {
    const t = setup();
    await t.cadence();
    await t.finish();
    t.write({ s5: "done" })();
    expect(await t.cadence()).toBe(true);
    await t.finish();
    expect(await t.cadence()).toBe(false);
    t.write({ s5: "done", ask: "- [ask T0-A13: do @Sam since 2026-10-25] Paste the Groq key; recommend now.\n" })();
    expect(await t.cadence()).toBe(true);
  });

  it("the cadence scheduler pulls before its skip check: news pushed elsewhere wakes, a pushed re-check does not", async () => {
    const t = setup();
    await t.cadence();
    await t.finish();
    const due = () => t.store.updateAssignment(t.a.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });
    t.remote.pending = t.write({ at: "2026-10-25 23:18Z", run: "run_bab8ba89" });
    due();
    expect(await t.cycle.tickCadence()).toEqual([]);
    expect(t.remote.pending).toBeUndefined(); // pulled
    expect(t.newest().summary).toMatch(/^skipped: nothing new since /);
    t.remote.pending = t.write({ s5: "done" });
    due();
    expect(await t.cycle.tickCadence()).toEqual([t.a.id]);
  });
});

describe("T13-S12 re-stamp after the wake's own commit", () => {
  it("a late commit that moved only the spine is re-stamped; the next cadence wake skips", async () => {
    const t = setup({ restampAfterMs: 20 });
    await t.cadence();
    const r = await t.finish();
    const stamp = t.store.getRun(r.id)!.askFingerprint;
    t.remote.pending = t.write({ s5: "blocked (pairing page re-verified)" }); // a real edit by the wake, pushed late
    await later(60);
    await t.cycle.settled();
    expect(t.store.getRun(r.id)!.askFingerprint).not.toBe(stamp);
    expect(await t.cadence()).toBe(false);
  });

  it("an answer saved after the stamp is not swallowed: no re-stamp, the next wake runs", async () => {
    const t = setup({ restampAfterMs: 20 });
    await t.cadence();
    const r = await t.finish();
    const stamp = t.store.getRun(r.id)!.askFingerprint;
    t.remote.pending = t.write({ s5: "blocked (pairing page re-verified)" });
    t.db.prepare("INSERT INTO jordi_responses (id, item_id, milestone_id, kind, delivery, created_at) VALUES ('jr_1', 'i', ?, 'answer', 'delivered', ?)").run(t.m.id, new Date().toISOString());
    await later(60);
    await t.cycle.settled();
    expect(t.store.getRun(r.id)!.askFingerprint).toBe(stamp);
    expect(await t.cadence()).toBe(true);
  });
});

describe("T13-S12 wake prompt", () => {
  it("tells a wake with nothing new not to commit a re-check stamp", () => {
    expect(STATE_RULE).toContain("do not edit or commit the spine just to restamp");
  });
});
