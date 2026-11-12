import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import type { EditInput, SpineWriter } from "../src/inbox/spineWrite.js";
import { createSteps, ensureStepChanges, FILE_DELAY_MS, stepsIn, WAKE_CHECK_MS, WAKE_GIVE_UP_MS, wakeBackoffMs, type WakeAnswer } from "../src/steps/steps.js";

// a step change answers at once and files to the spine in order in the background; its wake
// is recorded with it and tried again until a run starts (a T3 down at 18:15Z lost one), at most once per change.

const SPINE = "docs/spines/epic-9.md";
const TEXT = `# PLAN-9: test

## Decisions

| Date | Outcome | Decision / Attempt | Durable Summary | Evidence | Revisit When |
|---|---|---|---|---|---|
| 2026-11-01 | accepted | first | one | x | never |
`;

let db: DB;
let repo: string;
let clock: number;
let told: string[];
let wakes: string[];
let commits: string[];
let failWrites: number;
let answers: WakeAnswer[];
let runs: Record<string, { outcome: string; summary: string }>;
let noted: { id: string; text: string }[];

const writer = (): SpineWriter =>
  ({
    edit: async (o: EditInput) => {
      if (failWrites > 0) {
        failWrites--;
        return { status: "failed", reason: "push refused" };
      }
      const file = path.join(o.repoDir, o.path);
      const e = o.edit(fs.readFileSync(file, "utf8"), "2026-11-09");
      if ("skip" in e) return { status: "skipped", reason: e.skip };
      fs.writeFileSync(file, e.text);
      commits.push(e.msg);
      return { status: "written", sha: `sha${commits.length}`, path: o.path };
    },
  }) as unknown as SpineWriter;

const make = (o: { fileDelayMs?: number; findRun?: (mid: string, since: string, note: string) => string | undefined } = {}) =>
  createSteps({
    db,
    pump: false,
    fileDelayMs: o.fileDelayMs ?? 0,
    now: () => clock,
    writer: writer(),
    repoDir: (n) => (n === "home_repo" ? repo : undefined),
    milestoneFor: async () => "ms_1",
    wake: async (_mid, note) => {
      wakes.push(note);
      return answers.length ? answers.shift() : { runId: `run_${wakes.length}` };
    },
    runOf: (id) => runs[id],
    noteRun: (id, text) => noted.push({ id, text }),
    findRun: o.findRun,
    tell: async (_w, text) => {
      told.push(text);
      return true;
    },
  });

beforeEach(() => {
  db = openDb(":memory:");
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "e87s4-"));
  fs.mkdirSync(path.join(repo, "docs/spines"), { recursive: true });
  fs.writeFileSync(path.join(repo, SPINE), TEXT);
  clock = Date.parse("2026-11-09T18:15:00Z");
  told = [];
  wakes = [];
  commits = [];
  failWrites = 0;
  answers = [];
  runs = {};
  noted = [];
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

const spine = () => fs.readFileSync(path.join(repo, SPINE), "utf8");
const T3_DOWN = "HOST3 T3 not healthy after 120 s: load 63";

describe("T87-S4 the answer comes at once, the spine follows", () => {
  it("a tick is saved and shown before the commit; the page reads 'filed' with the sha when it lands", async () => {
    const s = make({ fileDelayMs: FILE_DELAY_MS });
    const p = s.register({ title: "Your account steps", url: "http://x/", repo: "home_repo", spine: SPINE, by: "Sam" });
    const r = await s.tick(p, { step: "a", state: "done", title: "Step A", row: "T83-S5" });
    expect(r).toMatchObject({ spine: "saved", state: "done", change: { status: "saved", wake: "none" } });
    expect(spine()).toBe(TEXT);
    // a reload before the commit lands shows the saved state, filing
    expect(s.view(p)).toMatchObject({ steps: { a: { state: "done" } }, ticks: { a: {} }, changes: { a: { status: "saved" } } });
    expect(s.open()).toHaveLength(1);
    await s.drain();
    expect(commits).toHaveLength(0); // not yet: younger than FILE_DELAY_MS
    clock += FILE_DELAY_MS;
    await s.drain();
    expect(commits).toEqual(["Step done: Step A on Your account steps (T83-S5) (Sam, via steps page)"]);
    expect(stepsIn(spine(), p.id).steps.a.state).toBe("done");
    expect(s.view(p).changes.a).toMatchObject({ status: "filed", sha: "sha1", wake: "sent", wakeRun: "run_1" });
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("the Delivery manager was woken (run run_1)");
  });
});

describe("T87-S4 a lost wake is tried again until a run starts", () => {
  it("a forced T3 failure: pending with backoff, its failed run says so, the next try starts a run, never a third", async () => {
    answers = [{ error: T3_DOWN, failedRun: "run_failed" }];
    const s = make();
    const p = s.register({ title: "Steps", url: "http://x/", repo: "home_repo", spine: SPINE, by: "Sam" });
    await s.tick(p, { step: "a", state: "done", row: "T83-S5" });
    await s.drain();
    expect(commits).toHaveLength(1);
    expect(wakes).toHaveLength(1);
    const c1 = s.view(p).changes.a;
    expect(c1).toMatchObject({ status: "filed", wake: "pending", wakeError: T3_DOWN, wakeRun: "run_failed" });
    expect(Date.parse(c1.wakeNextAt!) - clock).toBe(wakeBackoffMs(1));
    expect(told[0]).toContain("the wake is waiting (HOST3 T3 not healthy after 120 s: load 63): the console tries again until a run starts");
    expect(noted[0]).toMatchObject({ id: "run_failed", text: expect.stringContaining("tries it again at") });
    expect(s.open()).toEqual([expect.objectContaining({ step: "a", wake: "pending", page: expect.objectContaining({ id: p.id }) })]);
    // not before its time
    await s.drain();
    expect(wakes).toHaveLength(1);
    clock += wakeBackoffMs(1);
    await s.drain();
    expect(wakes).toHaveLength(2);
    expect(wakes[1]).toBe(wakes[0]); // the same note
    expect(s.view(p).changes.a).toMatchObject({ wake: "sent", wakeRun: "run_2" });
    // checked again: the run is going, so the wake is done; nothing wakes again
    runs.run_2 = { outcome: "progressed", summary: "ok" };
    clock += WAKE_CHECK_MS;
    await s.drain();
    expect(s.view(p).changes.a.wake).toBe("started");
    expect(s.open()).toEqual([]);
    clock += 24 * 3_600_000;
    await s.drain();
    expect(wakes).toHaveLength(2);
    expect(commits).toHaveLength(1);
    expect(told).toHaveLength(1);
  });

  it("a run made but failed before its wake was sent (Run now failed) is tried again; a deferred run is checked later", async () => {
    const s = make();
    const p = s.register({ title: "Steps", url: "http://x/", repo: "home_repo", spine: SPINE, by: "Sam" });
    await s.tick(p, { step: "a", state: "done" });
    await s.drain();
    expect(s.view(p).changes.a).toMatchObject({ wake: "sent", wakeRun: "run_1" });
    runs.run_1 = { outcome: "failed", summary: `Run now failed: ${T3_DOWN}` };
    clock += WAKE_CHECK_MS;
    await s.drain();
    expect(s.view(p).changes.a).toMatchObject({ wake: "pending", wakeError: T3_DOWN });
    clock += wakeBackoffMs(1);
    await s.drain();
    expect(s.view(p).changes.a).toMatchObject({ wake: "sent", wakeRun: "run_2" });
    runs.run_2 = { outcome: "deferred", summary: "Waiting for room to start" };
    clock += WAKE_CHECK_MS;
    await s.drain();
    expect(s.view(p).changes.a.wake).toBe("sent");
    runs.run_2 = { outcome: "running", summary: "working" };
    clock += WAKE_CHECK_MS;
    await s.drain();
    expect(s.view(p).changes.a.wake).toBe("started");
    expect(wakes).toHaveLength(2);
  });

  it("nobody switched on is never retried (L-10); a wake still failing after the give-up time stops and tells the desk once", async () => {
    answers = [undefined];
    const s = make();
    const p = s.register({ title: "Steps", url: "http://x/", repo: "home_repo", spine: SPINE, by: "Sam" });
    await s.tick(p, { step: "a", state: "done" });
    await s.drain();
    expect(s.view(p).changes.a.wake).toBe("off");
    expect(told[0]).toContain("nobody woken: the Delivery manager is off or paused");
    clock += 3_600_000;
    await s.drain();
    expect(wakes).toHaveLength(1);

    answers = Array.from({ length: 100 }, () => ({ error: T3_DOWN }));
    await s.tick(p, { step: "b", state: "done" });
    await s.drain();
    const start = clock;
    while (clock - start <= WAKE_GIVE_UP_MS + 3_600_000) {
      clock += 30 * 60_000;
      await s.drain();
    }
    expect(db.prepare("SELECT wake FROM step_changes WHERE step = 'b'").get()).toEqual({ wake: "gave_up" });
    const tries = wakes.length;
    expect(tries).toBeGreaterThan(20);
    expect(tries).toBeLessThan(40);
    expect(told.filter((t) => t.includes("found no run in 12 h"))).toHaveLength(1);
    clock += 3_600_000;
    await s.drain();
    expect(wakes).toHaveLength(tries);
  });

  it("a console restart mid-wake: the run it made is found (no second wake), else the wake is tried again", async () => {
    const s = make();
    const p = s.register({ title: "Steps", url: "http://x/", repo: "home_repo", spine: SPINE, by: "Sam" });
    await s.tick(p, { step: "a", state: "done" });
    await s.tick(p, { step: "b", state: "done" });
    await s.drain();
    db.prepare("UPDATE step_changes SET wake = 'waking', wake_run = NULL").run();
    const found = make({ findRun: (_m, _s, note) => (note.includes('"a"') ? "run_found" : undefined) });
    expect(found.view(p).changes.a).toMatchObject({ wake: "sent", wakeRun: "run_found" });
    expect(found.view(p).changes.b.wake).toBe("pending");
    await found.drain();
    expect(found.view(p).changes.b).toMatchObject({ wake: "sent", wakeRun: "run_3" });
    expect(wakes).toHaveLength(3);
  });
});

describe("T87-S4 order and undo", () => {
  it("changes file in the order they were made; a refused write holds the ones after it until it files", async () => {
    failWrites = 1;
    const s = make();
    const p = s.register({ title: "Steps", url: "http://x/", repo: "home_repo", spine: SPINE, by: "Sam" });
    await s.tick(p, { step: "a", state: "done", comment: "Done once" }); // words: never collapsed into the next change
    await s.tick(p, { step: "a", state: "stuck", comment: "The code never came" });
    await s.tick(p, { step: "b", comment: "A note on b" });
    expect(s.view(p).steps).toEqual({ a: { state: "stuck", at: "2026-11-09", words: "The code never came" } });
    await s.drain();
    expect(commits).toHaveLength(0);
    expect(db.prepare("SELECT status, reason FROM step_changes WHERE id = 1").get()).toEqual({ status: "saved", reason: "not filed yet: push refused" });
    expect(s.view(p).changes.a.status).toBe("saved");
    clock += 60_000;
    await s.drain();
    expect(commits.map((m) => m.split(":")[0])).toEqual(["Step done", "Step stuck", "Step note"]);
    expect(told.map((t) => t.split(":")[0])).toEqual(["[step done] Done", "[step done] Stuck", "[step done] Note"]);
    expect(stepsIn(spine(), p.id)).toEqual({ steps: { a: { state: "stuck", at: "2026-11-09", words: "The code never came" } }, notes: { a: [{ at: "2026-11-09", words: "Done once" }], b: [{ at: "2026-11-09", words: "A note on b" }] } });
  });

  it("an undo before filing files nothing, tells nobody and wakes nobody", async () => {
    const s = make({ fileDelayMs: FILE_DELAY_MS });
    const p = s.register({ title: "Steps", url: "http://x/", repo: "home_repo", spine: SPINE, by: "Sam" });
    await s.tick(p, { step: "a", state: "done" });
    clock += 1_000;
    const back = await s.tick(p, { step: "a", state: "todo" });
    expect(back).toMatchObject({ spine: "saved", state: "todo" });
    clock += FILE_DELAY_MS;
    await s.drain();
    expect(commits).toEqual([]);
    expect(told).toEqual([]);
    expect(wakes).toEqual([]);
    expect(spine()).toBe(TEXT);
    expect(db.prepare("SELECT status FROM step_changes ORDER BY id").all()).toEqual([{ status: "undone" }, { status: "undone" }]);
    expect(s.view(p).steps).toEqual({});
  });

  it("an undo after filing: the done row goes, the done's wake that never started is cancelled, the undo's wake goes", async () => {
    answers = [{ error: T3_DOWN }];
    const s = make();
    const p = s.register({ title: "Steps", url: "http://x/", repo: "home_repo", spine: SPINE, by: "Sam" });
    await s.tick(p, { step: "a", state: "done" });
    await s.drain();
    expect(s.view(p).changes.a.wake).toBe("pending");
    await s.tick(p, { step: "a", state: "todo" });
    await s.drain();
    expect(spine()).toBe(TEXT);
    const rows = db.prepare("SELECT wake, wake_error FROM step_changes ORDER BY id").all() as { wake: string; wake_error: string }[];
    expect(rows[0]).toMatchObject({ wake: "cancelled", wake_error: expect.stringContaining("a newer change of the step") });
    expect(rows[1].wake).toBe("sent");
    expect(wakes).toHaveLength(2);
    expect(wakes[1]).toContain("NOT done after all");
    clock += 3_600_000;
    await s.drain();
    expect(wakes).toHaveLength(2);
  });

  it("the table is created once and survives a second start", () => {
    ensureStepChanges(db);
    ensureStepChanges(db);
    make();
    make();
    expect(db.prepare("SELECT COUNT(*) AS n FROM step_changes").get()).toEqual({ n: 0 });
  });
});
