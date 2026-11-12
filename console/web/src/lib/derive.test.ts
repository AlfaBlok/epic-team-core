import { describe, expect, it } from "vitest";
import type { Assignment, Run } from "@/api/types";
import { assignmentRunStats, filterRunsByPersona, milestoneRunStats, personaRunStats, workedTicketIds } from "./derive";

const cad = { type: "interval", everyMinutes: 60 } as const;
const assignments: Assignment[] = [
  { id: "a1", milestoneId: "m1", personaId: "p1", cadence: cad, enabled: true },
  { id: "a2", milestoneId: "m2", personaId: "p1", cadence: cad, enabled: true },
  { id: "a3", milestoneId: "m1", personaId: "p2", cadence: cad, enabled: false },
];
const run = (id: string, assignmentId: string, startedAt: string, extra: Partial<Run> = {}): Run => ({
  id,
  assignmentId,
  startedAt,
  outcome: "progressed",
  summary: id,
  ...extra,
});
const runs: Run[] = [
  run("r1", "a1", "2026-10-15T10:00:00Z"),
  run("r2", "a1", "2026-10-14T08:00:00Z", { outcome: "blocked" }),
  run("r2c", "a1", "2026-10-14T08:05:00Z", { parentRunId: "r2" }),
  run("r3", "a2", "2026-10-15T11:00:00Z", { outcome: "idle" }),
  run("r4", "a3", "2026-10-15T09:00:00Z"),
];
const now = new Date("2026-10-15T12:00:00Z");

describe("run stats (M2-7)", () => {
  it("counts top-level runs per assignment, newest last run", () => {
    expect(assignmentRunStats("a1", runs)).toMatchObject({ count: 2, last: { id: "r1" } });
    expect(assignmentRunStats("nope", runs)).toEqual({ count: 0, last: undefined });
  });
  it("counts a persona's runs across milestones", () => {
    expect(personaRunStats("p1", assignments, runs)).toMatchObject({ count: 3, last: { id: "r3" } });
  });
  it("counts a milestone's runs in the last 24 h", () => {
    expect(milestoneRunStats("m1", assignments, runs, now)).toMatchObject({ last24h: 2, last: { id: "r1" } });
  });
  it("filters a milestone's runs by persona, keeping child runs", () => {
    expect(filterRunsByPersona(runs, assignments, "p1").map((r) => r.id)).toEqual(["r1", "r2", "r2c", "r3"]);
    expect(filterRunsByPersona(runs, assignments, "p2").map((r) => r.id)).toEqual(["r4"]);
  });
});

describe("E906-S14 workedTicketIds", () => {
  const r = (summary: string, extra: Partial<Run> = {}): Run => ({ id: summary, assignmentId: "a", startedAt: "2026-10-24T00:00:00Z", outcome: "running", summary, parentRunId: "p", ...extra });
  it("takes the leading ticket id of running child runs whose thread is not known finished", () => {
    const ids = workedTicketIds([
      r("E906-S14 keep moving"),
      r("s2 voice notes", { t3: { status: "live", checkedAt: "x" } }),
      r("S3 admin", { t3: { status: "completed", checkedAt: "x" } }),
      r("S4 done", { outcome: "progressed" }),
      r("S5 wake", { parentRunId: undefined }),
      r("no id here"),
    ]);
    expect([...ids].sort()).toEqual(["E906-S14", "S2"]);
    expect([...workedTicketIds([r("**N10-6**: brief"), r("S1, S4 batch")])].sort()).toEqual(["N10-6", "S1"]);
  });
});
