import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { T3Client, T3ModelSelection } from "../src/t3/client.js";
import { createStore, type OpenAsk, type Run } from "../src/store.js";
import { createCycle } from "../src/cycle/service.js";
import { rememberChecks, withPrints } from "../src/cycle/askMemory.js";
import { textHash } from "../src/cycle/skipUnchanged.js";
import { gitOut } from "../src/freshness.js";
import {
  type CheckResult,
  NEW_ASK_NOTE_BY,
  UNBLOCKER_BACKSTOP_MINUTES,
  createNewAskWaker,
  defaultCadenceFor,
  gitAuthorRun,
  readSeen,
} from "../src/cycle/newAskWake.js";

/**
 * a new open ask after a pull wakes the milestone's switched-on Unblocker within the debounce, once per batch;
 * never an off Unblocker (L-10), never for asks it wrote itself or already assessed (memory); its cadence is a
 * 6 h backstop.
 */
class FakeT3 implements T3Client {
  launches: { title: string; message?: string; modelSelection?: T3ModelSelection }[] = [];
  async listProjects() {
    return [{ id: "proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }];
  }
  async listScheduledTasks() { return []; }
  async updateScheduledTask() { return undefined; }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread(input: { title: string; message?: string; modelSelection?: T3ModelSelection }) {
    this.launches.push(input);
    return { threadId: `thread${this.launches.length}` };
  }
  async sendToThread() {}
  async readThreadStatus() { return { status: "idle", raw: {} }; }
}
const disp = { async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; }, async done() {} };

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

const ask = (code: string, line = 40): OpenAsk => ({ code, kind: "decide", path: "docs/PLAN-0-ROOT.md", line, textHash: textHash(`${code} text`) });

function setup(o: { enabled?: boolean; authorRun?: (dir: string, rel: string, line: number) => Promise<string | undefined> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e8s25-"));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  const db: DB = openDb(path.join(dir, "c.db"));
  const store = createStore(db);
  const t3 = new FakeT3();
  const state = { asks: [] as OpenAsk[] };
  const cycle = createCycle(db, store, { enabled: true, t3, dispatcher: disp, publicUrl: "http://x", openAsks: async () => state.asks, grants: async () => [], repoDir: () => repo });
  const m = store.createMilestone({ title: "M", repo: "home_repo", path: "docs/PLAN-0-ROOT.md", owner: "", paused: false });
  const p = store.createPersona({ name: "Unblocker", remit: "answer asks", skills: [], model: "claude-opus-5-5", mayWrite: true, freshThreadEachWake: true });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: defaultCadenceFor("Unblocker"), enabled: o.enabled ?? true });
  const waker = createNewAskWaker({
    db,
    store,
    openAsks: async () => state.asks,
    grants: async () => [],
    repoDir: () => repo,
    authorRun: o.authorRun,
    wake: (id, note, by) => cycle.runNow(id, { instructions: note, instructionsBy: by }),
    debounceMs: 30,
  });
  cleanup = () => {
    waker.stop();
    cycle.stop();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const runs = () => store.listRuns({ assignmentId: a.id }).filter((r) => !r.parentRunId);
  /** A pull moved the checkout; wait out the debounce and the check. */
  const pulled = async () => {
    waker.repoMoved(repo);
    await waker.settled();
  };
  /** The woken Unblocker finishes, assessing every open ask it was given (memory written as on its PATCH). */
  const finish = (run: Run) => {
    const asks = withPrints(state.asks, []);
    const ended = store.updateRun(run.id, { outcome: "idle", endedAt: new Date().toISOString(), openAsks: asks, checks: asks.map((x) => ({ code: x.code, decision: "left" as const, why: "floor" })) } as never)!;
    rememberChecks(db, ended, m.id);
  };
  return { db, store, t3, state, cycle, waker, m, p, a, repo, runs, pulled, finish };
}

describe("T8-S25 a new ask wakes the Unblocker", () => {
  it("a new ask after a pull → one Unblocker wake within the debounce, with a note naming it", async () => {
    const t = setup();
    t.state.asks = [ask("T8-A1")];
    await t.pulled();
    expect(t.runs()).toHaveLength(1);
    const run = t.runs()[0];
    expect(run.instructions).toContain("T8-A1");
    expect(run.instructionsBy).toBe(NEW_ASK_NOTE_BY);
    expect(run.wokeBecause).toBe("new asks after a pull: T8-A1");
    expect(t.t3.launches).toHaveLength(1);
    expect(readSeen(t.db, t.m.id)).toEqual([expect.objectContaining({ code: "T8-A1", reason: "woke the Unblocker", runId: run.id })]);
    // the same ask on a later pull is not news
    t.finish(run);
    await t.pulled();
    expect(t.runs()).toHaveLength(1);
  });

  it("two new asks in one pull (and several pull signals in the window) → one wake naming both", async () => {
    const t = setup();
    t.state.asks = [ask("T8-A1"), ask("T8-A2", 41)];
    t.waker.repoMoved(t.repo);
    t.waker.repoMoved(t.repo);
    t.waker.repoMoved(t.repo);
    await t.waker.settled();
    expect(t.runs()).toHaveLength(1);
    expect(t.runs()[0].instructions).toContain("T8-A1, T8-A2");
    expect(t.t3.launches).toHaveLength(1);
  });

  it("a switched-off Unblocker is never woken (L-10)", async () => {
    const t = setup({ enabled: false });
    t.state.asks = [ask("T8-A1")];
    await t.pulled();
    expect(await t.waker.check(t.m.id)).toEqual({ milestoneId: t.m.id, woke: false, reason: "no switched-on Unblocker" });
    expect(t.runs()).toHaveLength(0);
    expect(t.t3.launches).toHaveLength(0);
  });

  it("an ask already assessed (T8-S24 memory) wakes nobody; a new one beside it does", async () => {
    const t = setup();
    t.state.asks = [ask("T8-A1")];
    // assessed by an earlier (cadence) wake: its memory row exists
    const earlier = t.store.createRun({ assignmentId: t.a.id, outcome: "running", summary: "Woke on cadence" });
    t.finish(earlier);
    await t.pulled();
    expect(t.runs()).toHaveLength(1);
    t.state.asks = [ask("T8-A1"), ask("T8-A2", 41)];
    await t.pulled();
    expect(t.runs()).toHaveLength(2);
    expect(t.runs()[0].instructions).toContain("T8-A2");
    expect(t.runs()[0].instructions).not.toContain("T8-A1");
  });

  it("an ask the Unblocker wrote itself (its run's commit) wakes nobody and is remembered as its own", async () => {
    let unblockerRun = "";
    const t = setup({ authorRun: async (_d, _r, line) => (line === 50 ? unblockerRun : undefined) });
    unblockerRun = t.store.createRun({ assignmentId: t.a.id, outcome: "progressed", endedAt: new Date().toISOString(), summary: "answered 0 · split 1" }).id;
    t.state.asks = [ask("T8-A3", 50)];
    await t.pulled();
    expect(t.runs()).toHaveLength(1); // only the Unblocker's own run
    expect(readSeen(t.db, t.m.id)).toEqual([expect.objectContaining({ code: "T8-A3", reason: "written by the Unblocker" })]);
    // an ask written by another persona's run still wakes it
    const dm = t.store.createPersona({ name: "Delivery Manager", remit: "deliver", skills: [], model: "claude-opus-5-5", mayWrite: true });
    const dmA = t.store.createAssignment({ milestoneId: t.m.id, personaId: dm.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: false });
    unblockerRun = t.store.createRun({ assignmentId: dmA.id, outcome: "idle", endedAt: new Date().toISOString(), summary: "raised T8-A4" }).id;
    t.state.asks = [ask("T8-A3", 50), ask("T8-A4", 50)];
    await t.pulled();
    expect(t.runs()).toHaveLength(2);
    expect(t.runs()[0].instructions).toContain("T8-A4");
  });

  it("while a wake runs: asks it lists are not woken for again; others wait for it to end", async () => {
    const t = setup();
    t.state.asks = [ask("T8-A1")];
    const running = t.store.createRun({ assignmentId: t.a.id, outcome: "running", summary: "Woke on cadence" });
    t.store.updateRun(running.id, { openAsks: [ask("T8-A1")] } as never);
    const r = await t.waker.check(t.m.id);
    expect(r).toMatchObject({ woke: false, reason: `a wake is still running (${running.id})` });
    expect(readSeen(t.db, t.m.id)).toEqual([expect.objectContaining({ code: "T8-A1", reason: "in a running wake", runId: running.id })]);
    expect(t.runs()).toHaveLength(1);
  });

  it("a paused milestone or a milestone without new asks is left alone", async () => {
    const t = setup();
    expect(await t.waker.check(t.m.id)).toMatchObject({ woke: false, reason: "no new asks" });
    t.state.asks = [ask("T8-A1")];
    t.store.updateMilestone(t.m.id, { paused: true });
    expect(await t.waker.check(t.m.id)).toMatchObject({ woke: false, reason: "milestone paused" });
    expect(t.runs()).toHaveLength(0);
  });

  it("the HEAD watch: a checkout that moved by any pull (background sync too) triggers the check; the first read is the baseline", async () => {
    const t = setup();
    t.state.asks = [ask("T8-A1")];
    let head = "aaa";
    t.waker.watchHeads(async () => head, 20);
    await new Promise((r) => setTimeout(r, 60));
    await t.waker.settled();
    expect(t.runs()).toHaveLength(0);
    head = "bbb";
    await new Promise((r) => setTimeout(r, 60));
    await t.waker.settled();
    expect(t.runs()).toHaveLength(1);
  });
});

describe("T8-S25 cadence backstop", () => {
  it("defaults to 6 h for the Unblocker, 2 h for others", () => {
    expect(UNBLOCKER_BACKSTOP_MINUTES).toBe(360);
    expect(defaultCadenceFor("Unblocker")).toEqual({ type: "interval", everyMinutes: 360 });
    expect(defaultCadenceFor("Delivery Manager")).toEqual({ type: "interval", everyMinutes: 120 });
  });

  it("POST /assignments without a cadence gets the persona's default; a given cadence is kept (tunable)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e8s25-app-"));
    const db = openDb(path.join(dir, "c.db"));
    cleanup = () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    };
    const store = createStore(db);
    const app = createApp(db, {});
    const m = store.createMilestone({ title: "M", repo: "home_repo", path: "", owner: "", paused: false });
    const u = store.createPersona({ name: "Unblocker", remit: "r", skills: [], model: "claude-opus-5-5", mayWrite: true });
    const post = async (b: unknown) => {
      const res = await app.request("/api/assignments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
      return { status: res.status, json: await res.json() };
    };
    const a1 = await post({ milestoneId: m.id, personaId: u.id });
    expect(a1.status).toBe(201);
    expect(a1.json.cadence).toEqual({ type: "interval", everyMinutes: 360 });
    expect(a1.json.enabled).toBe(false);
    const a2 = await post({ milestoneId: m.id, personaId: u.id, cadence: { type: "interval", everyMinutes: 180 } });
    expect(a2.json.cadence).toEqual({ type: "interval", everyMinutes: 180 });
    const bad = await app.request("/api/assignments", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(bad.status).toBe(400);
  });
});

describe("T8-S25 who wrote an ask", () => {
  it("reads the Run: trailer of the commit that last wrote the line", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e8s25-git-"));
    cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    const g = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
    g("init", "-q");
    g("config", "user.email", "t@x");
    g("config", "user.name", "t");
    fs.mkdirSync(path.join(dir, "docs"));
    fs.writeFileSync(path.join(dir, "docs/e.md"), "# E\n- [ask E-A1 decide @Sam] one\n");
    g("add", "docs/e.md");
    g("commit", "-q", "-m", "raise E-A1");
    fs.appendFileSync(path.join(dir, "docs/e.md"), "- [ask E-A2 decide @Sam] two\n");
    g("commit", "-q", "-am", "split E-A1\n\nRun: run_abc-123");
    fs.appendFileSync(path.join(dir, "docs/e.md"), "- [ask E-A3 decide @Sam] three\n");
    const author = gitAuthorRun(gitOut());
    expect(await author(dir, "docs/e.md", 2)).toBeUndefined();
    expect(await author(dir, "docs/e.md", 3)).toBe("run_abc-123");
    expect(await author(dir, "docs/e.md", 4)).toBeUndefined(); // not committed yet
  });
});

/**
 * one assessment per ask per checkout (a root and an epic under it on the same repo used to both wake their
 * Unblocker for), concurrent checks claim their codes, and each check pulls first (was answered
 * and pushed before the wake that assessed it).
 */
describe("T8-S31 one assessment per ask per checkout, read fresh", () => {
  const why = (r: CheckResult) => ("reason" in r ? r.reason : undefined);
  function twin(o: { wake?: (id: string, note: string, by: string) => Promise<Run & { startGuard?: string }>; pull?: (dir: string) => Promise<unknown> } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e8s31-"));
    const repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    const db: DB = openDb(path.join(dir, "c.db"));
    const store = createStore(db);
    const state = { asks: [] as OpenAsk[], reads: 0 };
    const p = store.createPersona({ name: "Unblocker", remit: "answer asks", skills: [], model: "claude-opus-5-5", mayWrite: true, freshThreadEachWake: true });
    const ms = ["docs/spines/root.md", "docs/spines/epic-34.md"].map((path) => store.createMilestone({ title: path, repo: "home_repo", path, owner: "", paused: false }));
    const as = ms.map((m) => store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: defaultCadenceFor("Unblocker"), enabled: true }));
    const woke: { id: string; note: string }[] = [];
    const wake =
      o.wake ??
      (async (id: string, note: string) => {
        woke.push({ id, note });
        await new Promise((r) => setTimeout(r, 20)); // a launch takes a while: the race window
        return store.createRun({ assignmentId: id, outcome: "running", summary: "Woke" });
      });
    const waker = createNewAskWaker({
      db,
      store,
      openAsks: async () => (state.reads++, state.asks),
      grants: async () => [],
      repoDir: () => repo,
      pull: o.pull,
      wake: async (id, note, by) => { const r = await wake(id, note, by); if (!o.wake) return r; woke.push({ id, note }); return r; },
      debounceMs: 10,
    });
    cleanup = () => {
      waker.stop();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    };
    return { db, store, state, waker, ms, as, woke, repo };
  }

  it("two milestones on one checkout, the same new ask → one wake; the sibling records who assessed it", async () => {
    const t = twin();
    t.state.asks = [ask("PLAN-34-A2")];
    expect(await t.waker.check(t.ms[1].id)).toMatchObject({ woke: true });
    expect(await t.waker.check(t.ms[0].id)).toMatchObject({ woke: false, reason: "assessed for this checkout already" });
    expect(t.woke).toHaveLength(1);
    expect(readSeen(t.db, t.ms[0].id)).toEqual([expect.objectContaining({ code: "PLAN-34-A2", reason: `assessed by the Unblocker of ${t.ms[1].id}` })]);
    // a second ask beside it on the root still wakes the root's Unblocker, naming only that one
    t.state.asks = [ask("PLAN-34-A2"), ask("PLAN-40-A2", 41)];
    expect(await t.waker.check(t.ms[0].id)).toMatchObject({ woke: true, codes: ["PLAN-40-A2"] });
  });

  it("concurrent checks of both milestones (one pull signal) → one wake", async () => {
    const t = twin();
    t.state.asks = [ask("PLAN-34-A2")];
    t.waker.repoMoved(t.repo);
    await t.waker.settled();
    expect(t.woke).toHaveLength(1);
    // and directly in parallel
    t.state.asks = [ask("PLAN-34-A2"), ask("PLAN-34-A3", 41)];
    const rs = await Promise.all([t.waker.check(t.ms[0].id), t.waker.check(t.ms[1].id)]);
    expect(rs.filter((r) => r.woke)).toHaveLength(1);
    await t.waker.settled();
    expect(t.woke).toHaveLength(2);
    expect(t.woke[1].note).toContain("PLAN-34-A3");
    expect(t.woke[1].note).not.toContain("PLAN-34-A2");
  });

  it("a failed wake (no seat) on one milestone marks nothing: the sibling's claim-skip is re-checked and wakes it", async () => {
    let fail = true;
    const t = twin({
      wake: async (id) => {
        await new Promise((r) => setTimeout(r, 20));
        if (fail) { fail = false; throw new Error("no seat"); }
        return { id: `run_${id}`, assignmentId: id, outcome: "running" } as Run;
      },
    });
    t.state.asks = [ask("PLAN-34-A2")];
    const rs = await Promise.all([t.waker.check(t.ms[0].id), t.waker.check(t.ms[1].id)]);
    expect(rs.find((r) => why(r)?.startsWith("wake failed"))).toBeTruthy();
    expect(rs.find((r) => why(r) === "being woken for by another check")).toBeTruthy();
    expect(t.woke).toHaveLength(0);
    await t.waker.settled(); // the skipped sibling looks again after the failed wake
    expect(t.woke).toHaveLength(1);
    // the failing milestone's own retry then sees it assessed by the sibling, never twice
    const failed = rs.find((r) => why(r)?.startsWith("wake failed"))!.milestoneId;
    expect(await t.waker.check(failed)).toMatchObject({ woke: false, reason: "assessed for this checkout already" });
    expect(t.woke).toHaveLength(1);
  });

  it("pulls the checkout before reading its asks; an ask answered and pushed meanwhile wakes nobody", async () => {
    const order: string[] = [];
    let pulled: string | undefined;
    const t = twin({
      pull: async (dir) => {
        order.push(`pull:${t.state.reads}`);
        pulled = dir;
        t.state.asks = []; // was turned into an answered FYI and pushed
      },
    });
    t.state.asks = [ask("PLAN-40-A2")];
    expect(await t.waker.check(t.ms[0].id)).toMatchObject({ woke: false, reason: "no new asks" });
    expect(order).toEqual(["pull:0"]);
    expect(pulled).toBe(t.repo);
    expect(t.woke).toHaveLength(0);
  });

  it("a failing pull is ignored (reads what is there); the pull's own HEAD move finds nothing new and wakes nobody", async () => {
    const t = twin({ pull: async () => { throw new Error("diverged"); } });
    t.state.asks = [ask("PLAN-40-A3")];
    expect(await t.waker.check(t.ms[0].id)).toMatchObject({ woke: true });
    t.waker.repoMoved(t.repo); // the HEAD watch sees the pull's move
    await t.waker.settled();
    expect(t.woke).toHaveLength(1);
  });
});
