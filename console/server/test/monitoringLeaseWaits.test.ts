import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { monitoringRows, stallVerdict, type MovingEpic } from "../src/cycle/movement.js";
import { openDb, type DB } from "../src/db.js";
import { gitOut } from "../src/freshness.js";
import { createSpineWriter } from "../src/inbox/spineWrite.js";
import { createLeases, monitoringWait } from "../src/review/leases.js";
import { createStore, type Assignment, type Run } from "../src/store.js";
import { git, makeRepo, spineText } from "./reviewFixture.js";

/**
 * a worker that ends its turn monitoring a timed check (outcome monitoring, nextCheckAt ahead) leaves a row
 * that waits, not one that is idle. Its lease ending sets the row `waiting (… until <nextCheckAt>, <run>)`, never back to
 * ready; past nextCheckAt + 2 h with no new report it is a real stall and goes back to ready as before. The stall
 * watch skips a ready row whose worker run is monitoring a check still ahead.
 */
const EPIC = "docs/spines/epic-9.md";
const T0 = Date.parse("2026-11-02T22:00:00Z");
const H = 3600_000;
let tmp: string;
let db: DB;
let repo: ReturnType<typeof makeRepo>;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-monlease-"));
  repo = makeRepo(tmp, "home_repo", {
    "docs/spines/root.md": "# EPIC: home_repo\n\nIntegration policy: main-direct\n",
    [EPIC]: spineText("PLAN-9", "Things", [
      { id: "T9-S1", status: "ready" },
      { id: "T9-S2", status: "ready" },
      { id: "T9-S3", status: "ready" },
    ]),
  });
  db = openDb(path.join(tmp, "console.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function claimRow(id: string, by: string) {
  const f = path.join(repo.dir, EPIC);
  const lines = fs.readFileSync(f, "utf8").split("\n");
  const i = lines.findIndex((l) => l.startsWith(`| ${id} |`));
  const cells = lines[i].split(" | ");
  cells[2] = `${by} — claimed 2026-11-02T18:00Z, lease until 2026-11-02T20:00Z`;
  cells[4] = "active";
  lines[i] = cells.join(" | ");
  fs.writeFileSync(f, lines.join("\n"));
  git(repo.dir, "commit", "-q", "-am", `Claim ${id}: ${by} (lease until 2026-11-02T20:00Z)`, "--date", "2026-11-02T18:00:00Z");
  git(repo.dir, "push", "-q", "origin", "main");
}

describe("lease expiry leaves a monitoring row waiting", () => {
  it("monitoringWait: ahead or within 2 h past → waiting; later, not monitoring, or no nextCheckAt → undefined", () => {
    expect(monitoringWait({ outcome: "monitoring", nextCheckAt: "2026-11-03T12:40:00.000Z" }, T0)).toEqual({ until: "2026-11-03T12:40Z" });
    expect(monitoringWait({ outcome: "monitoring", nextCheckAt: new Date(T0 - 1 * H).toISOString() }, T0)).toBeDefined();
    expect(monitoringWait({ outcome: "monitoring", nextCheckAt: new Date(T0 - 3 * H).toISOString() }, T0)).toBeUndefined();
    expect(monitoringWait({ outcome: "monitoring" }, T0)).toBeUndefined();
    expect(monitoringWait({ outcome: "progressed", nextCheckAt: "2026-11-03T12:40:00.000Z" }, T0)).toBeUndefined();
    expect(monitoringWait(undefined, T0)).toBeUndefined();
  });

  it("sweep: the monitoring run's row waits with the run kept; a stale or finished run's row goes back to ready", async () => {
    claimRow("T9-S1", "run_M"); // monitoring, check ahead
    claimRow("T9-S2", "run_S"); // monitoring, check 3 h past: a real stall
    claimRow("T9-S3", "run_P"); // progressed: as before
    const store = createStore(db);
    store.createMilestone({ title: "home_repo", repo: "home_repo", path: "docs/spines/root.md", owner: "", paused: false });
    const runs: Record<string, Partial<Run>> = {
      run_M: { id: "run_M", outcome: "monitoring", nextCheckAt: "2026-11-03T12:40:00.000Z" },
      run_S: { id: "run_S", outcome: "monitoring", nextCheckAt: new Date(T0 - 3 * H).toISOString() },
      run_P: { id: "run_P", outcome: "progressed" },
    };
    const leases = createLeases({
      store: () => ({ listMilestones: (...a: Parameters<typeof store.listMilestones>) => store.listMilestones(...a), getRun: (id: string) => runs[id] as Run | undefined }),
      reposRoot: tmp, writer: createSpineWriter(), git: gitOut(), now: () => T0,
    });
    const done = await leases.sweep();
    expect(done.map((d) => [d.ref, d.status])).toEqual([["T9-S1", "written"], ["T9-S2", "written"], ["T9-S3", "written"]]);
    expect(repo.rowLine(EPIC, "T9-S1")).toContain("| run_M (monitoring until 2026-11-03T12:40Z; lease ended 2026-11-02T22:00Z) | T9-S1 work | waiting (monitoring a timed check until 2026-11-03T12:40Z, run_M) |");
    expect(repo.rowLine(EPIC, "T9-S2")).toContain("| unassigned (lease of run_S expired 2026-11-02T22:00Z: re-dispatch) | T9-S2 work | ready |");
    expect(repo.rowLine(EPIC, "T9-S3")).toContain("| unassigned (lease of run_P expired 2026-11-02T22:00Z: re-dispatch) | T9-S3 work | ready |");
    expect(repo.originLog()).toContain("Lease ended T9-S1: run_M is monitoring until 2026-11-03T12:40Z (row waiting)");
    expect(await leases.sweep()).toEqual([]); // a waiting row holds no lease to sweep again
  });
});

describe("the stall watch skips rows waiting on a timed check", () => {
  const NOW = Date.parse("2026-11-01T06:00:00Z");
  const epic = (over: Partial<MovingEpic> = {}): MovingEpic => ({
    milestoneId: "m1", repo: "Acme/x", path: "docs/spines/epic-26.md", title: "PLAN-26", status: "active",
    workers: [], doneToday: [], ready: ["T26-S1"], rows: ["T26-S1", "T26-S2"], lastCommitAt: new Date(NOW - 3 * H).toISOString(), ...over,
  });
  const dm = { id: "as_dm", milestoneId: "m1", personaId: "p_dm", enabled: true, createdAt: "2026-10-01T00:00:00Z" } as Assignment;
  const seats = [{ id: "seat1", name: "seat1", resetsAt: {}, limited: false, inFlight: 0, status: "ok" as const }];
  const run = (over: Partial<Run>): Run =>
    ({ id: "run_w", milestoneId: "m1", assignmentId: "as_w", parentRunId: "run_dm", kind: "wake", outcome: "monitoring", summary: "T26-S1: waiting on the check", startedAt: new Date(NOW - 5 * H).toISOString(), endedAt: new Date(NOW - 4 * H).toISOString(), ...over }) as Run;
  const verdict = (runs: Run[], e: Partial<MovingEpic> = {}) =>
    stallVerdict({ milestone: { id: "m1", repo: "Acme/x", paused: false }, epic: epic(e), manager: dm, managerName: "Delivery Manager", runs, seats }, NOW);

  it("a ready row whose worker run monitors a check still ahead is not a stall", () => {
    const v = verdict([run({ nextCheckAt: new Date(NOW + 6 * H).toISOString() })]);
    expect(v.verdict).toBe("skip");
    expect(v.reason).toContain("ready rows wait on a timed check (T26-S1 until");
  });
  it("a check already passed, a newer report, or no monitoring run: the row counts and the watch fires", () => {
    expect(verdict([run({ nextCheckAt: new Date(NOW - 1 * H).toISOString() })]).verdict).toBe("fire");
    expect(verdict([run({ nextCheckAt: new Date(NOW + 6 * H).toISOString() }), run({ id: "run_w2", outcome: "failed", startedAt: new Date(NOW - 4.5 * H).toISOString() })]).verdict).toBe("fire");
    expect(verdict([]).verdict).toBe("fire");
  });
  it("only the waiting row is dropped: another ready row still fires", () => {
    const v = verdict([run({ nextCheckAt: new Date(NOW + 6 * H).toISOString() })], { ready: ["T26-S1", "T26-S2"] });
    expect(v.verdict).toBe("fire");
    expect(v.reason).toMatch(/^1 ready row \(T26-S2\)/);
  });
  it("monitoringRows counts worker (child) runs only: a wake's summary naming the row does not", () => {
    expect([...monitoringRows([run({ parentRunId: undefined, nextCheckAt: new Date(NOW + H).toISOString() })], NOW).keys()]).toEqual([]);
  });
});
