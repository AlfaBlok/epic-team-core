import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import type { T3Client } from "../src/t3/client.js";
import { createStore } from "../src/store.js";
import { createCycle } from "../src/cycle/service.js";
import type { Tree, TreeNode } from "../src/adapters/tree.js";
import { currentStateVerifiedAt, rollupDue, rollupPart, rollupSection, spineLags, ROLLUP_GRACE_MS } from "../src/cycle/rollup.js";

/**
 * a parent spine's Current State lagging its children wakes the Delivery Manager and its prompt names the
 * spine. Modelled on memory "the memory service launch" (2026-11-02):.md "168 h behind its children" for a
 * week, 28 DM wakes updating only, a 04:08Z wake reporting "spines unchanged".
 */
const H = 3_600_000;
const iso = (t: number) => new Date(t).toISOString();

const spine = (title: string, o: { verified?: string; last?: string; status?: string } = {}) => `# ${title}

## Current State

Status: ${o.status ?? "active"}
Last attempted: ${o.last ?? "2026-10-26 DM: foundation set up"}
Result: ok
Waiting on: nobody
Next action: keep going
${o.verified === undefined ? "" : `Verified at: ${o.verified}\n`}
## Issue Ledger

| ID | Ticket | Owner | Status |
|---|---|---|---|
| S1 | thing | Delivery Manager | active |
`;

const node = (id: string, p: string | undefined, children: TreeNode[] = [], kind: TreeNode["kind"] = "spine"): TreeNode => ({
  key: id, id, kind, title: id, status: "active", color: "grey", ...(p ? { path: p } : {}), children, flags: [],
});

const ROOT = "docs/PLAN-0-FOUNDATION-SPINE.md";
const E7 = "docs/PLAN-7-LAUNCH.md";
const E9 = "docs/PLAN-9-SOCIAL.md";
const E9T = "tickets/T9-S3.md";
const memoTree = () =>
  node("PLAN-0", ROOT, [node("S1", ROOT, [], "ticket"), node("PLAN-7", E7), node("PLAN-9", E9, [node("T9-S3", E9T, [], "ticket")])]);

describe("T13-S17 pure rules", () => {
  it("reads Verified at only inside ## Current State (bold and bulleted too)", () => {
    expect(currentStateVerifiedAt(spine("X", { verified: "2026-10-26T09:00Z" }))).toBe("2026-10-26T09:00Z");
    expect(currentStateVerifiedAt("# X\n## Current State\n- **Verified at:** 2026-11-01\n")).toBe("2026-11-01");
    expect(currentStateVerifiedAt("# X\n## Notes\nVerified at: 2026-11-01\n")).toBeUndefined();
  });

  it("due when a child moved after Verified at and Verified at is a lag window old; the same-wake commit order is not a lag", () => {
    const now = Date.parse("2026-11-02T04:08:00Z");
    const v = Date.parse("2026-10-26T09:00:00Z");
    expect(rollupDue(v, now - H, now)).toBe(true); // 168 h
    expect(rollupDue(v, v + ROLLUP_GRACE_MS - 1, now)).toBe(false); // root written, child committed minutes later in one wake
    expect(rollupDue(now - 3 * H, now - H, now)).toBe(false); // verified 3 h ago: not yet a day
    expect(rollupDue(now - 25 * H, now - 23 * H, now)).toBe(true); // a day old, a child moved 2 h after it
    expect(rollupDue(now - 25 * H, now - 23 * H, now, 48 * H)).toBe(false); // threshold configurable
    expect(rollupDue(v, undefined, now)).toBe(false); // no child commit
    expect(rollupDue(undefined, now - H, now)).toBe(true); // no Verified at at all
  });

  it("spineLags checks the root and every intermediate parent, root first, with their direct child spines", async () => {
    const now = Date.parse("2026-11-02T04:08:00Z");
    const tree = node("PLAN-0", ROOT, [node("PLAN-7", E7, [node("T7-S1", "tickets/T7-S1.md", [], "ticket")]), node("PLAN-9", E9)]);
    const files = new Map([
      [ROOT, spine("PLAN-0", { verified: "2026-10-26T04:00Z" })],
      [E7, spine("PLAN-7", { verified: "2026-10-31" })], // a bare date = end of that day
      [E9, spine("PLAN-9", { verified: "2026-11-01T10:00Z" })],
    ]);
    const commits: Record<string, string> = { [E7]: "2026-11-02T03:00:00Z", [E9]: "2026-11-02T02:00:00Z", "tickets/T7-S1.md": "2026-11-02T03:30:00Z" };
    const last = async (ps: string[]) => ps.map((p) => commits[p]).filter(Boolean).sort().pop();
    const lags = await spineLags(tree, files, last, now);
    expect(lags.map((l) => l.path)).toEqual([ROOT, E7]);
    expect(lags[0]).toMatchObject({ verifiedAt: "2026-10-26T04:00:00.000Z", childCommitAt: "2026-11-02T03:30:00.000Z", behindHours: 168, children: [E7, E9] });
    expect(lags[1]).toMatchObject({ verifiedAt: "2026-10-31T23:59:59.000Z", behindHours: 28, children: [] });
    expect(rollupPart([])).toBe("");
    expect(rollupPart(lags)).toBe(rollupPart([...lags].reverse())); // order-free
    expect(rollupPart(lags)).not.toBe(rollupPart([{ ...lags[0], childCommitAt: "2026-11-02T04:00:00.000Z" }, lags[1]])); // a child moved again
    expect(rollupPart(lags)).toBe(rollupPart(await spineLags(tree, files, last, now + 5 * H))); // the clock alone is not news
  });

  it("a spine without ## Current State or without children is never flagged", async () => {
    const files = new Map([[ROOT, "# PLAN-0\n\nno state here\n"]]);
    expect(await spineLags(node("PLAN-0", ROOT, [node("PLAN-7", E7)]), files, async () => "2026-11-02T03:00:00Z")).toEqual([]);
    const files2 = new Map([[ROOT, spine("PLAN-0", { verified: "2026-10-01" })]]);
    expect(await spineLags(node("PLAN-0", ROOT, [node("S1", ROOT, [], "ticket")]), files2, async () => "2026-11-02T03:00:00Z")).toEqual([]);
  });

  it("a spine repeated as an empty link node earlier in the tree is judged by its fullest node", async () => {
    const now = Date.parse("2026-11-02T05:10:00Z");
    const ALPHA = "docs/EPIC-MEMO-ALPHA-LAUNCH.md";
    const OLD = "docs/PLAN-3.7-DECOMMISSION-2X.md";
    // memory live tree 2026-11-02:.7 (done) links ALPHA (no children) before ALPHA's own node with under it.
    const tree = node("PLAN-0", ROOT, [node("PLAN-3.7", OLD, [node("ALPHA", ALPHA)]), node("ALPHA", ALPHA, [node("PLAN-7", E7)])]);
    const files = new Map([
      [ROOT, spine("PLAN-0", { verified: "2026-11-02" })],
      [OLD, spine("PLAN-3.7", { status: "done" })],
      [ALPHA, spine("ALPHA", { verified: "2026-10-25" })],
      [E7, spine("PLAN-7", { verified: "2026-11-02" })],
    ]);
    const last = async (ps: string[]) => (ps.includes(E7) ? "2026-11-02T04:36:00Z" : undefined);
    const lags = await spineLags(tree, files, last, now);
    expect(lags.map((l) => l.path)).toEqual([ALPHA]);
    expect(lags[0]).toMatchObject({ behindHours: 173, children: [E7] });
  });

  it("a finished or parked parent (done, superseded, deferred) is never flagged", async () => {
    const tree = node("PLAN-0", ROOT, [node("PLAN-7", E7)]);
    const last = async () => "2026-11-02T03:00:00Z";
    for (const status of ["done", "done — superseded (see Outcome)", "superseded", "deferred", "**closed**"])
      expect(await spineLags(tree, new Map([[ROOT, spine("PLAN-0", { status })]]), last)).toEqual([]);
    expect(await spineLags(tree, new Map([[ROOT, spine("PLAN-0", { status: "blocked" })]]), last)).toHaveLength(1);
  });

  it("the section names each lagging spine, its lag and children, and says how to roll up", () => {
    const s = rollupSection(
      [{ path: ROOT, title: "Memo launch", verifiedAt: "2026-10-26T04:00:00.000Z", childCommitAt: "2026-11-02T04:00:00.000Z", behindHours: 168, children: [E7, E9] }],
      ROOT,
    )!;
    expect(s).toContain("## Roll-up due");
    expect(s).toContain(`- ${ROOT} (milestone root: Memo launch): Verified at 2026-10-26 04:00Z, newest child commit 2026-11-02 04:00Z: 168 h behind its children; children: ${E7}, ${E9}`);
    expect(s).toMatch(/one line per child/);
    expect(s).toMatch(/plain sentence/);
    expect(s).toMatch(/`Verified at:` to now/);
    expect(s).toMatch(/not only the child you work/);
    expect(rollupSection([])).toBeUndefined();
  });
});

class FakeT3 implements T3Client {
  async listProjects() {
    return [{ id: "proj", title: "memo", workspaceRoot: "/srv/agent/github/memo" }];
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

function setup(o: { persona?: string } = {}) {
  const now = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e13s17-"));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  fs.mkdirSync(path.join(repo, "tickets"), { recursive: true });
  const write = (p: string, text: string) => fs.writeFileSync(path.join(repo, p), text);
  // Root verified a week ago; its children verified and committed today.
  write(ROOT, spine("PLAN-0", { verified: iso(now - 170 * H) }));
  write(E7, spine("PLAN-7", { verified: iso(now - 3 * H) }));
  write(E9, spine("PLAN-9", { verified: iso(now - 3 * H) }));
  write(E9T, "# T9-S3\n");
  /** Newest commit per path (what `git log -1 -- <paths>` would say). */
  const commits: Record<string, number> = { [E7]: now - 170 * H + 2 * H, [E9]: now - 170 * H + 2 * H };
  const lastCommitAt = async (_d: string, ps: string[]) => {
    const t = Math.max(...ps.map((p) => commits[p] ?? 0));
    return t > 0 ? iso(t) : undefined;
  };
  const db: DB = openDb(path.join(dir, "c.db"));
  const store = createStore(db);
  const treeFor = async (): Promise<Tree> => ({
    milestoneId: "m", root: memoTree(), counts: { grey: 4, blue: 0, yellow: 0, red: 0, green: 0 }, nonGreen: 4, closed: 0, flagged: 0, source: "spines", warnings: [],
  });
  const disp = {
    async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; },
    async done() {},
    async status() { return { name: "pool", capacity: 2, available: 0 }; },
  };
  const cycle = createCycle(db, store, {
    enabled: true, t3: new FakeT3(), dispatcher: disp, publicUrl: "http://x", treeFor, treeTodo: async () => "## To do", repoDir: () => repo,
    lastCommitAt, restampAfterMs: 0, wakePullMaxAgeMs: 0,
  });
  cleanup = () => { cycle.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  const m = store.createMilestone({ title: "Memo launch", repo: "memo", path: ROOT, owner: "", paused: false });
  const p = store.createPersona({ name: o.persona ?? "Delivery Manager", remit: "deliver; update Current State", skills: [], model: "claude-opus-5-5", mayWrite: true });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 120 }, enabled: true });
  const newest = () => store.listRuns({ assignmentId: a.id }).find((r) => !r.parentRunId)!;
  const cadence = () => cycle.wake(a.id, { threadId: "home" });
  const finish = async (edit?: () => void) => {
    const r = newest();
    edit?.();
    store.updateRun(r.id, { outcome: "progressed", summary: "progressed: PLAN-9 moved", endedAt: new Date(Date.now() + 1).toISOString() });
    cycle.runEnded(r.id);
    await cycle.settled();
    return r;
  };
  return { store, cycle, write, commits, now, newest, cadence, finish };
}

describe("T13-S17 Delivery Manager wake: roll-up override and prompt", () => {
  it("a bookkeeping-only child commit while the root lags is not skipped, and the prompt names the root with its lag", async () => {
    const t = setup();
    // Before the lag: the root is a week old but no child moved more than an hour after it... until does.
    t.commits[E7] = t.commits[E9] = t.now - 170 * H + 10 * 60_000;
    expect((await t.cadence()).run?.outcome).toBe("running");
    await t.finish();
    expect((await t.cadence()).skipped).toBe(true); // nothing new, no lag

    //'s worker restamps only Last attempted / Verified at (bookkeeping: the spines part does not move).
    t.write(E9, spine("PLAN-9", { verified: iso(t.now), last: "2026-11-02 worker: T9-S3 done" }));
    t.commits[E9] = t.now - 30 * 60_000;
    const w = await t.cadence();
    expect(w.skipped).toBeFalsy();
    expect(w.run?.wokeBecause ?? t.newest().wokeBecause).toContain("a Current State lag changed");
    expect(w.prompt).toContain("## Roll-up due");
    expect(w.prompt).toMatch(new RegExp(`- ${ROOT} \\(milestone root: PLAN-0\\): Verified at .* 170 h behind its children; children: ${E7}, ${E9}`));
    expect(w.prompt.indexOf("## Roll-up due")).toBeLessThan(w.prompt.indexOf("## To do"));
  });

  it("bounded: a wake that was told and did not roll up is not re-woken for the same lag; a roll-up clears the section", async () => {
    const t = setup();
    expect((await t.cadence()).prompt).toContain("## Roll-up due");
    await t.finish(); // ignored the roll-up
    expect((await t.cadence()).skipped).toBe(true);

    t.commits[E7] = t.now - 10 * 60_000; // a child moved again: news
    const w = await t.cadence();
    expect(w.skipped).toBeFalsy();
    await t.finish(() => t.write(ROOT, spine("PLAN-0", { verified: iso(Date.now()), last: "PLAN-7 launch prep on track; PLAN-9 T9-S3 done" })));
    const after = await t.cadence();
    expect(after.prompt ?? "").not.toContain("## Roll-up due");
  });

  it("only the Delivery Manager gets the section and the part", async () => {
    const t = setup({ persona: "Writer" });
    const w = await t.cadence();
    expect(w.prompt).not.toContain("## Roll-up due");
    expect(t.newest().wakeParts?.rollup).toBe("");
  });

  it("the run's wake parts record the lag (wake-check shows it)", async () => {
    const t = setup();
    await t.cadence();
    expect(t.newest().wakeParts?.rollup).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("T13-S17 one-line Current State fields", () => {
  it("the state rule says Waiting on and the others are one line each", async () => {
    const { STATE_RULE } = await import("../src/wakePrompt.js");
    expect(STATE_RULE).toContain("Write each on ONE line (several items separated by ` ; `");
  });
});
