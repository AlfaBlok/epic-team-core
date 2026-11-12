import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createCycle } from "../src/cycle/service.js";
import { createRepoPuller, gitRunner, type GitRunner } from "../src/cycle/repoPull.js";
import { cachedRunner, invalidateSpines, type SpinesJson } from "../src/adapters/spines.js";
import type { T3Client, T3ThreadRun } from "../src/t3/client.js";

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;
const DIR = "/srv/agent/github/whatgpt_v3";

/** Fake git: records calls; each call waits for release (or resolves at once) and may fail with a reason. */
function fakeGit() {
  const calls: { dir: string; args: string[] }[] = [];
  let fail: string | undefined;
  let gate: Promise<void> | undefined;
  let open: (() => void) | undefined;
  const git: GitRunner = async (dir, args) => {
    calls.push({ dir, args });
    if (gate) await gate;
    if (fail) throw new Error(fail);
  };
  return {
    git,
    calls,
    failWith: (r?: string) => (fail = r),
    hold: () => (gate = new Promise((r) => (open = r))),
    release: () => (open?.(), (gate = undefined)),
  };
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function setup(over: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s15-"));
  const db: DB = openDb(path.join(dir, "c.db"));
  const store = createStore(db);
  const g = fakeGit();
  const pulled: string[] = [];
  const cycle = createCycle(db, store, {
    enabled: false,
    publicUrl: "http://x",
    git: g.git,
    repoDir: () => DIR,
    onRepoPulled: (d) => pulled.push(d),
    ...over,
  });
  cleanup = () => {
    cycle.stop();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const m = store.createMilestone({ title: "M", repo: "Acme/whatgpt_v3", path: "", owner: "J", paused: false });
  const p = store.createPersona({ name: "Unblocker", remit: "r", skills: [], model: "sonnet", mayWrite: true });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true });
  return { db, store, cycle, g, pulled, m, a };
}

describe("T6-S15 (c) run-end pull", () => {
  it("a run that ends pulls its repo once with --ff-only and invalidates the spines cache", async () => {
    const t = setup();
    const run = t.store.createRun({ assignmentId: t.a.id, outcome: "progressed", endedAt: ago(0), summary: "answered T0-A6" });
    t.cycle.runEnded(run.id);
    await t.cycle.settled();
    expect(t.g.calls).toEqual([{ dir: DIR, args: ["pull", "-q", "--ff-only"] }]);
    expect(t.pulled).toEqual([DIR]);
  });

  it("a run still running does not pull", async () => {
    const t = setup();
    const run = t.store.createRun({ assignmentId: t.a.id, outcome: "running", summary: "Woke" });
    t.cycle.runEnded(run.id);
    await t.cycle.settled();
    expect(t.g.calls).toEqual([]);
  });

  it("concurrent ends share one pull", async () => {
    const t = setup();
    t.g.hold();
    for (let i = 0; i < 3; i++)
      t.cycle.runEnded(t.store.createRun({ assignmentId: t.a.id, outcome: "progressed", endedAt: ago(0), summary: `r${i}` }).id);
    await new Promise((r) => setTimeout(r, 10));
    t.g.release();
    await t.cycle.settled();
    expect(t.g.calls).toHaveLength(1);
    expect(t.pulled).toEqual([DIR]);
  });

  it("a failed pull is logged with its reason, nothing reset, cache kept", async () => {
    const logs: string[] = [];
    const g = fakeGit();
    g.failWith("Not possible to fast-forward, aborting.");
    const pulled: string[] = [];
    const p = createRepoPuller({ git: g.git, onPulled: (d) => pulled.push(d), log: (m) => logs.push(m) });
    expect(await p.pull(DIR)).toEqual({ ok: false, reason: "Not possible to fast-forward, aborting." });
    expect(g.calls.map((c) => c.args)).toEqual([["pull", "-q", "--ff-only"]]); // no reset, no stash
    expect(pulled).toEqual([]);
    expect(logs[0]).toMatch(/whatgpt_v3 failed .*nothing reset.*fast-forward/);
  });

  it("the reconciler closing a run pulls too", async () => {
    const t3 = {
      async readThreadStatus() {
        const runs: T3ThreadRun[] = [{ status: "completed", requestedAt: ago(10 * MIN), startedAt: ago(10 * MIN), completedAt: ago(1 * MIN) }];
        return { status: "completed", runs, raw: {} };
      },
    } as unknown as T3Client;
    const t = setup({ enabled: true, t3 });
    t.store.createRun({ assignmentId: t.a.id, outcome: "running", summary: "Woke", threadId: "th", startedAt: ago(9 * MIN) });
    await t.cycle.reconcile();
    await t.cycle.settled();
    expect(t.g.calls).toHaveLength(1);
  });

  it("a wake pulls first when the last pull is older than 60 s, not when fresh", async () => {
    const t = setup({ enabled: true, t3: {} as unknown as T3Client });
    await t.cycle.wake(t.a.id);
    expect(t.g.calls).toHaveLength(1);
    await t.cycle.wake(t.a.id); // pulled a moment ago: no second pull
    expect(t.g.calls).toHaveLength(1);
  });

  it("PATCH /runs/:id with endedAt pulls the milestone's repo", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s15-app-"));
    const db = openDb(path.join(dir, "c.db"));
    const g = fakeGit();
    const app = createApp(db, { cycle: { enabled: false, publicUrl: "http://x", git: g.git, repoDir: () => DIR }, browser: { browserUrl: "http://127.0.0.1:9" } });
    cleanup = () => (db.close(), fs.rmSync(dir, { recursive: true, force: true }));
    const store = createStore(db);
    const m = store.createMilestone({ title: "M", repo: "Acme/whatgpt_v3", path: "", owner: "J", paused: false });
    const p = store.createPersona({ name: "Unblocker", remit: "r", skills: [], model: "sonnet", mayWrite: true });
    const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true });
    const run = store.createRun({ assignmentId: a.id, outcome: "running", summary: "Woke" });
    const res = await app.request(`/api/runs/${run.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome: "progressed", summary: "answered T0-A6", endedAt: new Date().toISOString() }),
    });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(g.calls).toHaveLength(1));
  });

  it("real git: fast-forwards a clean clone, refuses a diverged one and leaves it untouched", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s15-git-"));
    cleanup = () => fs.rmSync(root, { recursive: true, force: true });
    const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
    const origin = path.join(root, "origin.git");
    sh(root, "init", "-q", "--bare", "-b", "main", origin);
    const w = path.join(root, "w");
    sh(root, "clone", "-q", origin, w);
    const cfg = ["-c", "user.email=t@t", "-c", "user.name=t"];
    fs.writeFileSync(path.join(w, "a"), "1");
    sh(w, "add", "a");
    sh(w, ...cfg, "commit", "-qm", "1");
    sh(w, "push", "-q", "origin", "HEAD:main");
    const c = path.join(root, "c");
    sh(root, "clone", "-q", "-b", "main", origin, c);
    fs.writeFileSync(path.join(w, "a"), "2");
    sh(w, ...cfg, "commit", "-qam", "2");
    sh(w, "push", "-q", "origin", "HEAD:main");
    const p = createRepoPuller({ git: gitRunner(), log: () => {} });
    expect(await p.pull(c)).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(c, "a"), "utf8")).toBe("2");
    // diverge: local commit + remote commit
    fs.writeFileSync(path.join(c, "b"), "local");
    sh(c, "add", "b");
    sh(c, ...cfg, "commit", "-qm", "local");
    const head = sh(c, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(w, "a"), "3");
    sh(w, ...cfg, "commit", "-qam", "3");
    sh(w, "push", "-q", "origin", "HEAD:main");
    const r = await p.pull(c);
    expect(r.ok).toBe(false);
    expect(sh(c, "rev-parse", "HEAD")).toBe(head);
  });
});

describe("T6-S15 spines cache invalidation", () => {
  const out = (title: string): SpinesJson => ({ root: null, nodes: [{ id: "x", path: "a.md", title, parent: null, status: "", rollup_status: "", dod: [], children: [] }], orphans: [], mismatches: [] });
  it("after invalidate the next read waits for a run that started after it", async () => {
    let title = "old";
    let release: (() => void) | undefined;
    let n = 0;
    const run = async () => {
      n++;
      const v = title;
      if (n === 2) await new Promise<void>((r) => (release = r)); // a refresh in flight while the checkout changes
      return out(v);
    };
    let t = 0;
    const cached = cachedRunner(run, 1_000, () => t, () => {});
    expect((await cached("/r")).nodes[0].title).toBe("old");
    t = 2_000; // stale: starts refresh #2 (reads "old"), held
    expect((await cached("/r")).nodes[0].title).toBe("old");
    title = "new"; // the pull lands
    invalidateSpines(cached, "/r");
    const next = cached("/r");
    release!();
    expect((await next).nodes[0].title).toBe("new");
    expect(n).toBe(3);
    expect((await cached("/r")).nodes[0].title).toBe("new");
  });
});
