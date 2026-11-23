import { beforeAll, describe, expect, it } from "vitest";
import { addRepoRename } from "../src/adapters/repoNames.js";
import { nextRunAfter } from "../src/cycle/nextRun.js";
import { stallVerdict, STALL_MS, type MovingEpic } from "../src/cycle/movement.js";
import { effortForSpine, effortOf, epicHeading, parkText, parsePursuits, priorityLines, ranksOf, reorderText, scaleCadence, DEFAULT_EFFORT } from "../src/pursuits.js";
import { milestoneOfEpic, paceWords, withMilestones } from "../src/pursuitRoutes.js";
import type { Assignment, Milestone } from "../src/store.js";

beforeAll(() => addRepoRename("Acme/lab_repo", "Acme/lab-repo")); // the hosted layer adds it at load

/** pursuits in the owner's order, effort follows the rank, parked ones get none, one navigable scorecard. */

const FILE = JSON.stringify(
  {
    staleDays: 3,
    effort: {
      minWakeMinutes: 15,
      tiers: [
        { name: "Top", upToRank: 1, wakeFactor: 2, maxWorkers: 10, stallHours: 1 },
        { name: "High", upToRank: 3, wakeFactor: 1, maxWorkers: 6, stallHours: 2 },
        { name: "Low", upToRank: 99, wakeFactor: 0.5, maxWorkers: 3, stallHours: 6 },
      ],
    },
    pursuits: [
      { id: "testers", name: "First testers", greenWhen: "Ten testers.", epics: [{ repo: "lab_repo", spine: "docs/spines/epic-946.md" }], lines: [], totems: [] },
      { id: "notes", name: "Notes live", greenWhen: "A payment.", epics: [{ repo: "notes", spine: "docs/EPIC-900.md" }], lines: [], totems: [] },
      { id: "vault", name: "Secrets kept", greenWhen: "All in.", parked: true, epics: [{ repo: "lab_repo", spine: "docs/spines/epic-983.md" }], lines: [], totems: [] },
      {
        id: "tenants",
        name: "Multi-tenant",
        greenWhen: "Two customers.",
        epics: [
          { repo: "Acme/lab-repo", spine: "docs/spines/epic-921.md" },
          { repo: "lab_repo", spine: "docs/spines/epic-946.md" },
          { repo: "lab_repo", spine: "../etc/passwd.md" },
        ],
        lines: [],
        totems: [],
      },
      { id: "late", name: "Later", greenWhen: "Some day.", pinned: false, epics: [{ repo: "lab_repo", spine: "docs/spines/epic-999.md" }], lines: [], totems: [] },
    ],
    checks: {},
  },
  null,
  2,
);

describe("priority and effort", () => {
  const doc = parsePursuits(FILE);

  it("ranks in file order, parked ones without a rank", () => {
    expect([...ranksOf(doc)]).toEqual([
      ["testers", 1],
      ["notes", 2],
      ["vault", null],
      ["tenants", 3],
      ["late", 4],
    ]);
    expect(doc.pursuits.find((p) => p.id === "tenants")!.epics).toHaveLength(2); // the path outside the repo is dropped
  });

  // the owner ("These are all objectives ... and they're sorted"): one list, no pinned and unpinned;
  // an old `"pinned": false` changes nothing, the objective keeps its rank and effort.
  it("keeps an old pinned: false in his one list, its rank kept", () => {
    expect(doc.pursuits.map((p) => p.id)).toContain("late");
    expect(ranksOf(doc).get("late")).toBe(4);
  });

  it("a rank buys its tier's effort, in plain words; parked buys none", () => {
    expect(effortOf(1, false, doc.effort)).toMatchObject({ tier: "Top", maxWorkers: 10, wakeFactor: 2, words: "Wakes twice as often, up to 10 workers, nudged after 1 h idle." });
    expect(effortOf(3, false, doc.effort)).toMatchObject({ tier: "High", maxWorkers: 6, words: "Wakes at the pace set, up to 6 workers, nudged after 2 h idle." });
    expect(effortOf(4, false, doc.effort)).toMatchObject({ tier: "Low", maxWorkers: 3, words: "Wakes half as often, up to 3 workers, nudged after 6 h idle." });
    expect(effortOf(null, true, doc.effort)).toMatchObject({ tier: "Parked", maxWorkers: 0, wakeFactor: 0 });
    expect(effortOf(500, false, doc.effort).tier).toBe("Low"); // past every tier: the last
  });

  it("bad or missing tiers fall back to the default rule", () => {
    expect(parsePursuits(JSON.stringify({ pursuits: [] })).effort).toEqual(DEFAULT_EFFORT);
    expect(parsePursuits(JSON.stringify({ effort: { tiers: [{ name: "x", upToRank: 0 }] }, pursuits: [] })).effort.tiers).toEqual(DEFAULT_EFFORT.tiers);
  });

  it("scales interval cadences, never under the floor; fixed times and no effort stay", () => {
    const hour = { type: "interval" as const, everyMinutes: 60 };
    expect(scaleCadence(hour, { wakeFactor: 2 })).toEqual({ type: "interval", everyMinutes: 30 });
    expect(scaleCadence(hour, { wakeFactor: 0.5 })).toEqual({ type: "interval", everyMinutes: 120 });
    expect(scaleCadence({ type: "interval", everyMinutes: 20 }, { wakeFactor: 2 }, 15)).toEqual({ type: "interval", everyMinutes: 15 });
    expect(scaleCadence({ type: "interval", everyMinutes: 10 }, { wakeFactor: 2 }, 15)).toEqual({ type: "interval", everyMinutes: 10 }); // never slower because of the floor
    expect(scaleCadence(hour, null)).toBe(hour);
    const fixed = { type: "fixed_time" as const, timeOfDay: "09:00", weekdays: [1] };
    expect(scaleCadence(fixed, { wakeFactor: 2 })).toBe(fixed);
    expect(nextRunAfter(scaleCadence(hour, { wakeFactor: 2 }), new Date("2026-11-12T10:00:00Z")).toISOString()).toBe("2026-11-12T10:30:00.000Z");
  });

  it("a spine takes its best-ranked pursuit; old and new repo names are one; parked only when all are", () => {
    expect(effortForSpine(doc, "Acme/lab_repo", "docs/spines/epic-946.md")).toMatchObject({ pursuitId: "testers", rank: 1, maxWorkers: 10 });
    expect(effortForSpine(doc, "Acme/lab-repo", "./docs/spines/epic-921.md")).toMatchObject({ pursuitId: "tenants", rank: 3, maxWorkers: 6 });
    expect(effortForSpine(doc, "lab_repo", "docs/spines/epic-983.md")).toMatchObject({ parked: true, maxWorkers: 0 });
    expect(effortForSpine(doc, "lab_repo", "docs/spines/root.md")).toBeNull();
  });

  it("the wake's priority lines list the repo's pursuit epics in rank order, parked ones none, minus other milestones' own", () => {
    const text = priorityLines(doc, "Acme/lab-repo", (p) => p === "docs/spines/epic-946.md");
    expect(text.split("\n").slice(2)).toEqual([
      "- docs/spines/epic-921.md: Multi-tenant, rank 3 (High): at most 6 workers at once.",
      "- docs/spines/epic-999.md: Later, rank 4 (Low): at most 3 workers at once.",
      "- docs/spines/epic-983.md: Secrets kept, parked: no workers.",
    ]);
    expect(priorityLines(doc, "nowhere")).toBe("");
  });

  it("rewrites the order and the park switch, refusing anything that is not one", () => {
    const moved = JSON.parse(reorderText(FILE, ["notes", "testers", "vault", "tenants", "late"])!);
    expect(moved.pursuits.map((p: { id: string }) => p.id)).toEqual(["notes", "testers", "vault", "tenants", "late"]);
    expect(moved.effort.tiers).toHaveLength(3); // the rest of the file stays
    expect(reorderText(FILE, ["notes", "testers"])).toBeNull();
    expect(reorderText(FILE, ["notes", "notes", "vault", "tenants", "late"])).toBeNull();
    expect(reorderText(FILE, ["notes", "testers", "vault", "tenants", "nope"])).toBeNull();
    expect(reorderText(FILE, ["testers", "notes", "vault", "tenants", "late"])).toBe(FILE + "\n"); // same order: same text
    const parked = JSON.parse(parkText(FILE, "late", true)!);
    expect(parked.pursuits.find((p: { id: string }) => p.id === "late").parked).toBe(true);
    const resumed = JSON.parse(parkText(FILE, "vault", false)!);
    expect("parked" in resumed.pursuits.find((p: { id: string }) => p.id === "vault")).toBe(false);
    expect(parkText(FILE, "nope", true)).toBeNull();
  });

  it("reads an epic's code and title from its heading", () => {
    expect(epicHeading("# EPIC-946: Epic Social launch\n\nbody")).toEqual({ code: "EPIC-946", title: "Epic Social launch" });
    expect(epicHeading("# EPIC-900: Notes — a paying user")).toEqual({ code: "EPIC-900", title: "Notes — a paying user" });
    expect(epicHeading("# Market bots")).toEqual({ title: "Market bots" });
  });
});

describe("the stall watch follows the rank", () => {
  const now = Date.parse("2026-11-12T20:00:00Z");
  const epic: MovingEpic = { path: "docs/spines/epic-946.md", title: "Launch", status: "active", ready: ["E946-S1"], rows: ["E946-S1"], workers: [], lastCommitAt: new Date(now - 90 * 60_000).toISOString(), doneToday: [] } as unknown as MovingEpic;
  const base = {
    milestone: { id: "ms_1", repo: "lab_repo", paused: false },
    epic,
    manager: { id: "as_1", personaId: "p1", enabled: true } as Assignment,
    managerName: "Delivery manager",
    runs: [],
    seats: [{ limited: false, status: "ok" }] as never,
  };

  it("a top pursuit's idle epic is nudged after 1 h, a normal one waits the 2 h", () => {
    expect(stallVerdict({ ...base, effort: { parked: false, stallHours: 1, pursuitName: "First testers" } }, now)).toMatchObject({ verdict: "fire" });
    expect(stallVerdict({ ...base, effort: { parked: false, stallHours: 1, pursuitName: "First testers" } }, now).reason).toContain("nudged after 1 h");
    expect(stallVerdict(base, now)).toMatchObject({ verdict: "skip" });
    expect(STALL_MS).toBe(2 * 3600_000);
  });

  it("a parked pursuit's epic is never nudged", () => {
    const old = { ...epic, lastCommitAt: new Date(now - 10 * 3600_000).toISOString() };
    expect(stallVerdict({ ...base, epic: old }, now).verdict).toBe("fire");
    expect(stallVerdict({ ...base, epic: old, effort: { parked: true, stallHours: 0, pursuitName: "Secrets kept" } }, now)).toMatchObject({ verdict: "skip", reason: "pursuit Secrets kept is parked: no nudges" });
  });
});

describe("the navigable scorecard's milestones and teams", () => {
  const ms = (id: string, repo: string, p: string, extra: Partial<Milestone> = {}): Milestone => ({ id, title: id, repo, path: p, owner: "o", paused: false, createdAt: "", ...extra });
  const milestones = [ms("root", "Acme/lab-repo", "docs/spines/root.md"), ms("launch", "Acme/lab-repo", "docs/spines/epic-946.md"), ms("nts", "acme/notes", "docs/EPIC-900.md")];

  it("an epic runs under its own milestone, else its repo's root, else the repo's only one", () => {
    expect(milestoneOfEpic(milestones, "lab_repo", "docs/spines/epic-946.md")).toMatchObject({ m: { id: "launch" }, via: "own" });
    expect(milestoneOfEpic(milestones, "lab_repo", "docs/spines/epic-921.md")).toMatchObject({ m: { id: "root" }, via: "root" });
    expect(milestoneOfEpic(milestones, "notes", "docs/EPIC-907.md")).toMatchObject({ m: { id: "nts" }, via: "root" });
    expect(milestoneOfEpic(milestones, "elsewhere", "x.md")).toBeNull();
  });

  it("each pursuit carries its milestones, their teams and each team's pace as set and as run now", () => {
    const assignments: Record<string, Assignment[]> = {
      launch: [{ id: "a1", milestoneId: "launch", personaId: "dm", enabled: true, cadence: { type: "interval", everyMinutes: 60 } } as Assignment],
      root: [{ id: "a2", milestoneId: "root", personaId: "st", enabled: false, cadence: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 3] } } as Assignment],
    };
    const store = {
      listMilestones: () => milestones,
      listAssignments: (f?: { milestoneId?: string }) => assignments[f?.milestoneId ?? ""] ?? [],
      getPersona: (id: string) => ({ dm: { name: "Delivery manager" }, st: { name: "Strategist" } })[id] as never,
    };
    const body = withMilestones(
      {
        staleDays: 3,
        pursuits: [
          {
            id: "testers",
            epics: [
              { repo: "lab_repo", path: "docs/spines/epic-946.md", code: "EPIC-946" },
              { repo: "lab_repo", path: "docs/spines/epic-921.md", code: "EPIC-921" },
            ],
          } as never,
        ],
      },
      store as never,
      (m) => (m.id === "launch" ? { parked: false, wakeFactor: 2, minWakeMinutes: 15 } : null),
    );
    const p = body.pursuits[0];
    expect(p.milestones).toEqual([
      { id: "launch", title: "launch", via: "own", teams: [{ persona: "Delivery manager", enabled: true, pace: "every 60 min", paceNow: "every 30 min" }] },
      { id: "root", title: "root", via: "root", teams: [{ persona: "Strategist", enabled: false, pace: "at 09:00 on Mon, Wed", paceNow: "off" }] },
    ]);
    expect(p.epics.map((e) => (e as { milestoneId?: string }).milestoneId)).toEqual(["launch", "root"]);
    expect(paceWords({ type: "interval", everyMinutes: 240 })).toBe("every 4 h");
  });
});
