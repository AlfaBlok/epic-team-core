import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepoPuller, gitRunner } from "../src/cycle/repoPull.js";
import { createFreshness } from "../src/freshness.js";
import { hostGit, prepareCheckout, preWakeLine } from "../src/cycle/preWake.js";
import { staleLockPath } from "../src/gitStaleLock.js";
import { milestoneStatus, type StatusInput } from "../src/status/compute.js";
import type { Run } from "../src/store.js";

/**
 * (a) a stale `.git/index.lock` (0 bytes, 4 h old, no git running) kept the console's pull of
 * memory failing ("Unable to create '.../.git/index.lock': File exists"), 32 commits behind. Every console pull now
 * deletes a lock older than 10 min when no git runs in the checkout, logs it and retries once; a young lock or a running
 * git keeps the error. (b) the status says how many workers T3 confirms live (`flow.live`) for the green dot.
 */

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
let tmp: string;
let origin: string;
let clone: string;
let lock: string;

/** origin + a clone one commit behind it, with a lock file of the given age in the clone. */
function setup(lockAgeMin: number) {
  const seed = path.join(tmp, "seed");
  fs.mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(seed, "a.txt"), "1\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "one");
  git(tmp, "clone", "-q", "--bare", seed, origin);
  git(tmp, "clone", "-q", origin, clone);
  fs.writeFileSync(path.join(seed, "a.txt"), "2\n");
  git(seed, "commit", "-qam", "two");
  git(seed, "push", "-q", origin, "main");
  fs.writeFileSync(lock, "");
  const t = (Date.now() - lockAgeMin * 60_000) / 1000;
  fs.utimesSync(lock, t, t);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e6s51-"));
  origin = path.join(tmp, "origin.git");
  clone = path.join(tmp, "clone");
  lock = path.join(clone, ".git", "index.lock");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("T6-S51 stale git lock self-heal", () => {
  it("run-end / book pull: a 4 h old index.lock with no git running is removed, logged, and the pull goes through", async () => {
    setup(240);
    const logs: string[] = [];
    const r = await createRepoPuller({ git: gitRunner(), log: (m) => logs.push(m), contentionRetryMs: 5 }).pull(clone);
    expect(r).toEqual({ ok: true });
    expect(fs.existsSync(lock)).toBe(false);
    expect(git(clone, "rev-parse", "HEAD")).toBe(git(origin, "rev-parse", "main"));
    expect(logs.join("\n")).toMatch(/removed stale \.git\/index\.lock \(240 min old, no git running in clone\), retrying the pull/);
  });

  it("a lock younger than 10 min is kept and the pull error stands", async () => {
    setup(2);
    const r = await createRepoPuller({ git: gitRunner(), log: () => {}, contentionRetryMs: 5 }).pull(clone);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/index\.lock': File exists/);
    expect(fs.existsSync(lock)).toBe(true);
  });

  it("a git process working in the checkout (git -C <dir>) keeps even an old lock", async () => {
    setup(240);
    const busy = spawn("git", ["-C", clone, "hash-object", "--stdin"], { stdio: ["pipe", "ignore", "ignore"] });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const r = await createRepoPuller({ git: gitRunner(), log: () => {}, contentionRetryMs: 5 }).pull(clone);
      expect(r.ok).toBe(false);
      expect(fs.existsSync(lock)).toBe(true);
    } finally {
      busy.stdin.end();
      busy.kill();
    }
  });

  it("freshness Refresh heals it too: no pull error left, HEAD moved", async () => {
    setup(30);
    const f = createFreshness({ log: () => {}, refreshMinMs: 0 });
    const r = await f.refresh(clone);
    expect(r.pulled).toBe(true);
    expect(r.error).toBeUndefined();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("pre-wake pull on the persona host heals it and says so on the run", async () => {
    setup(30);
    const pw = await prepareCheckout(hostGit(), "main", clone, 5);
    expect("error" in pw).toBe(false);
    if ("error" in pw) return;
    expect(pw.pull).toEqual({ ok: true });
    expect(preWakeLine("main", pw)).toMatch(/^pre-wake: removed stale \.git\/index\.lock \(30 min old, no git running in clone\), retrying the pull · pulled main \w+→\w+$/);
  });

  it("only a lock inside the checkout's .git is ever a candidate", () => {
    expect(staleLockPath("/r", "error: Unable to create '/r/.git/index.lock': File exists.")).toBe("/r/.git/index.lock");
    expect(staleLockPath("/r", "fatal: Unable to create '/r/.git/refs/remotes/origin/main.lock': File exists.")).toBe("/r/.git/refs/remotes/origin/main.lock");
    expect(staleLockPath("/r", "error: Unable to create '/other/.git/index.lock': File exists.")).toBeUndefined();
    expect(staleLockPath("/r", "error: Unable to create '/r/.git/../x.lock': File exists.")).toBeUndefined();
    expect(staleLockPath("/r", "fatal: Not possible to fast-forward, aborting.")).toBeUndefined();
  });
});

describe("T6-S51 flow.live: workers T3 confirms live", () => {
  const NOW = Date.parse("2026-11-02T05:00:00Z");
  const run = (over: Partial<Run> = {}): Run =>
    ({ id: "run_w", assignmentId: "as_1", milestoneId: "m1", parentRunId: "run_p", startedAt: "2026-11-02T04:29:00Z", outcome: "running", summary: "E9-2f worker", threadId: "t1", ...over }) as Run;
  const input = (runs: Run[], t3: StatusInput["t3State"]): StatusInput => ({
    milestone: { id: "m1", paused: false },
    status: "active",
    doneMeans: { done: 0, total: 1 },
    outcome: null,
    waiting: [],
    runs,
    assignments: [],
    t3State: t3,
    now: NOW,
  });

  it("Working with a worker T3 reads live (fresh) → live 1", () => {
    const s = milestoneStatus(input([run()], () => ({ status: "live", checkedAt: "2026-11-02T04:59:30Z" })));
    expect(s.flow).toMatchObject({ word: "working", live: 1 });
  });

  it("Working only on the 3 h guess (no T3 read, or a stale one) → no live count: grey dot", () => {
    expect(milestoneStatus(input([run()], () => undefined)).flow).toMatchObject({ word: "working" });
    expect(milestoneStatus(input([run()], () => undefined)).flow.live).toBeUndefined();
    expect(milestoneStatus(input([run()], () => ({ status: "live", checkedAt: "2026-11-02T04:40:00Z" }))).flow.live).toBeUndefined();
  });

  it("counts every confirmed live run of the milestone (the wake and its workers), like Activity's header", () => {
    const runs = [run({ id: "run_p", parentRunId: undefined, summary: "wake" }), run(), run({ id: "run_w2" })];
    const s = milestoneStatus(input(runs, (id) => (id === "run_w2" ? { status: "completed", checkedAt: "2026-11-02T04:59:00Z" } : { status: "live", checkedAt: "2026-11-02T04:59:00Z" })));
    expect(s.flow.live).toBe(2);
  });
});
