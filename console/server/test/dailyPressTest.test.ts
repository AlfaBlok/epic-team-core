import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { DAILY_FILE, pressTestHome, recordedDays, REOPEN_SPINE, TEST_SPINE, TWICE_ASK } from "../src/press/dailyTest.js";
import { git, makeRepo, PNG_1PX, spineText } from "./reviewFixture.js";

/**
 * the daily live test presses every review button kind on TEST rows (Snooze, Unsnooze, Approve,
 * Mark complete, Feedback, Deny, goal Reopen) through the app's own routes, checks each landed with a commit and the press
 * log counted it, puts the TEST rows back, records one line a day in the code repo, and alerts the agents on a failure
 * (the owner only after two failed days: one ask).
 */
const ROOT = "docs/spines/root.md";
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.reverse()) f();
  cleanup = [];
});

const TEST_ROOT = [
  "# EPIC-967: TEST feedback is never approval",
  "",
  "Integration policy: main-direct",
  "Project name: [TEST Epic Team](https://team.example.com/)",
  "Goal sentence: We want to see that feedback reopens work and a yes closes it.",
  "",
  "## Current State",
  "",
  "Status: superseded (TEST retired again after the E972-S1 proof, 2026-11-07)",
  "",
].join("\n");

function world(o: { testRepo?: string; day?: () => number; slowLinks?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e72s2-"));
  const writeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-e72s2-write-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  const team = makeRepo(dir, "home_repo", {
    [ROOT]: spineText("EPIC-900", "home_repo", []),
    [pressTestHome().spine]: spineText(pressTestHome().epic, "Team page buttons never fail", [{ id: pressTestHome().row, status: "active" }], ["## Waiting on", ""]),
  });
  const test = makeRepo(dir, "e67-feedback-test", { [ROOT]: TEST_ROOT, "docs/status/test.png": "" });
  fs.writeFileSync(path.join(test.dir, "docs/status/test.png"), PNG_1PX);
  // the TEST cards' link: answers, or (o.slowLinks) times out that many times first, as the overloaded console did
  let slow = o.slowLinks ?? 0;
  const live = (async () => {
    if (slow > 0) {
      slow--;
      throw new Error("The operation was aborted due to timeout");
    }
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const app = createApp(db, {
    read: { reposRoot: dir, seatsFile: path.join(dir, "seats.json"), listThreads: async () => [] },
    review: { live: { fetch: live, consoleHosts: [] } },
    // as production runs it: each press answered once saved, landed by the worker
    presses: { retryMs: [0], answerFirst: true },
    writeClones: { root: writeRoot },
    pressTest: { pollMs: 5, landingLimitMs: 60_000, recheckMs: 1, ...(o.testRepo ? { repo: o.testRepo } : {}), ...(o.day ? { now: o.day } : {}) },
  });
  const s = createStore(db);
  s.createMilestone({ title: "home_repo", repo: "home_repo", path: ROOT, owner: "Sam", paused: false });
  s.createMilestone({ title: "TEST E67 feedback proof", repo: "e67-feedback-test", path: ROOT, owner: "Sam", paused: false });
  const req = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(
      url,
      { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body === undefined ? undefined : JSON.stringify(body) },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
    );
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  };
  cleanup.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(writeRoot, { recursive: true, force: true });
  });
  const onOrigin = (repo: { bare: string }, rel: string) => {
    try {
      return git(repo.bare, "show", `main:${rel}`);
    } catch {
      return "";
    }
  };
  return { dir, db, req, team, test, onOrigin };
}

describe("the daily press test", () => {
  it("presses every review button kind on the TEST rows, each lands with a commit, the rows go back, one PASS line", async () => {
    const w = world();
    const run = (await w.req("POST", "/api/press-test/run?wait=1")).json;
    expect(run.failures).toEqual([]);
    expect(run.ok).toBe(true);
    expect(run.presses.map((p: any) => p.kind)).toEqual(["snooze", "unsnooze", "approve", "complete", "feedback", "deny", "reopen"]);
    for (const p of run.presses) {
      expect(p.state, `${p.kind}: ${p.reason ?? ""}`).toBe("landed");
      expect(p.sha).toMatch(/^[0-9a-f]{7,}$/);
      // the press log has it, as the console host via the press test
      const logged = (await w.req("GET", `/api/presses/${p.pressId}`)).json;
      expect(logged.state).toBe("landed");
      expect(logged.who).toContain("via press-test");
    }
    // write-health counted every press, none failed
    expect(run.health.after.presses - run.health.before.presses).toBe(7);
    expect(run.health.after.failed).toBe(run.health.before.failed);
    // the TEST rows are back at rest on origin (read by nothing)
    expect(w.onOrigin(w.test, TEST_SPINE)).toMatch(/^Status: superseded \(TEST at rest/m);
    expect(w.onOrigin(w.test, REOPEN_SPINE)).toMatch(/^Status: superseded \(TEST at rest/m);
    // the presses themselves are in the TEST repo's history (presses landing together share one commit, whose
    // message names each of them)
    const log = git(w.test.bare, "log", "--format=%B", "main");
    for (const s of ["snoozed until", "unsnoozed", "step complete", "relaunched", "denied", "Goal EPIC-974: reopened", "armed for home_repo E900-S2", "back at rest"]) expect(log).toContain(s);
    // and they name the press test, never the owner
    expect(log).toContain("Review T972-D5: denied (the daily press test, via console)");
    expect(log).not.toContain("Sam");
    // one line for the day in the code repo (the source)
    const daily = w.onOrigin(w.team, DAILY_FILE);
    expect(recordedDays(daily)).toEqual([{ day: run.day, pass: true }]);
    expect(daily).toContain("PASS: 7 of 7 presses landed (snooze, unsnooze, approve, complete, feedback, deny, reopen)");
    // nothing of it on the owner's lists
    expect((await w.req("GET", "/api/review-items")).json).toEqual([]);
    expect((await w.req("GET", "/api/review-goals/closed")).json).toEqual([]);
    // health and the GET
    expect((await w.req("GET", "/api/health")).json.pressTest).toMatchObject({ state: "ok", day: run.day, failedDaysInARow: 0 });
    const got = (await w.req("GET", "/api/press-test")).json;
    expect(got.runs).toHaveLength(1);
  }, 120_000);

  it("a TEST card whose link timed out is checked again before the closing buttons are pressed (2026-11-08 01:36Z)", async () => {
    const w = world({ slowLinks: 3 });
    const run = (await w.req("POST", "/api/press-test/run?wait=1")).json;
    expect(run.failures).toEqual([]);
    expect(run.presses.every((p: any) => p.state === "landed")).toBe(true);
  }, 120_000);

  it("is due once a day: the day's line in the repo stops another run", async () => {
    const w = world({ day: () => Date.parse("2026-11-08T05:00:00Z") });
    expect((await w.req("GET", "/api/press-test")).json.due).toBe(true);
    await w.req("POST", "/api/press-test/run?wait=1");
    // the shared checkout follows the clone (fast-forward), so the line is read from it
    git(w.team.dir, "pull", "-q", "--ff-only", "origin", "main");
    expect((await w.req("GET", "/api/press-test")).json.due).toBe(false);
  }, 120_000);

  it("a run between midnight and 04:00Z counts for the slot it fell in (no second run before the next 04:00Z)", async () => {
    let t = Date.parse("2026-11-08T00:40:00Z");
    const w = world({ testRepo: "no-such-test-repo", day: () => t });
    expect((await w.req("GET", "/api/press-test")).json.due).toBe(true);
    await w.req("POST", "/api/press-test/run?wait=1");
    git(w.team.dir, "pull", "-q", "--ff-only", "origin", "main");
    expect(recordedDays(w.onOrigin(w.team, DAILY_FILE)).map((x) => x.day)).toEqual(["2026-11-08"]);
    t = Date.parse("2026-11-08T03:50:00Z");
    expect((await w.req("GET", "/api/press-test")).json.due).toBe(false);
    t = Date.parse("2026-11-08T05:00:00Z");
    expect((await w.req("GET", "/api/press-test")).json.due).toBe(false);
    t = Date.parse("2026-11-09T04:10:00Z");
    expect((await w.req("GET", "/api/press-test")).json.due).toBe(true);
  }, 120_000);

  it("a failed day alerts the agents (health, the Delivery Manager's wake); two failed days in a row raise one ask", async () => {
    let t = Date.parse("2026-11-08T04:10:00Z");
    const w = world({ testRepo: "no-such-test-repo", day: () => t });
    const one = (await w.req("POST", "/api/press-test/run?wait=1")).json;
    expect(one.ok).toBe(false);
    expect(one.failures[0]).toContain("arming the TEST rows was skipped");
    expect(one.ask).toBeUndefined();
    expect((await w.req("GET", "/api/health")).json.pressTest).toMatchObject({ state: "failed", day: "2026-11-08" });
    git(w.team.dir, "pull", "-q", "--ff-only", "origin", "main");
    t = Date.parse("2026-11-09T04:10:00Z");
    const two = (await w.req("POST", "/api/press-test/run?wait=1")).json;
    expect(two.ok).toBe(false);
    expect(two.ask).toMatchObject({ status: "written" });
    const spine = w.onOrigin(w.team, pressTestHome().spine);
    expect(spine).toContain(TWICE_ASK);
    expect(spine).toMatch(/\[ask [\w-]+-A\d+: \w+ @\w+ since \d{4}-\d{2}-\d{2} row E900-S2\]/);
    expect(recordedDays(w.onOrigin(w.team, DAILY_FILE))).toEqual([
      { day: "2026-11-08", pass: false },
      { day: "2026-11-09", pass: false },
    ]);
    expect((await w.req("GET", "/api/health")).json.pressTest).toMatchObject({ state: "failed", failedDaysInARow: 2 });
  }, 120_000);
});
