import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NO_TURNER, TURNER_OFF, isTestWorld, milestoneGaps, objectiveGaps, turnerOf } from "../src/personaGaps.js";
import { tempApp } from "./helpers.js";

/**
 * (the owner: "a wheel without a persona is not going to turn"; the house sat 19 h
 * with none): a new milestone gets its world's Delivery Manager at once, and the console flags any milestone or
 * objective with no persona.
 */
let t: ReturnType<typeof tempApp>;
beforeEach(() => {
  t = tempApp();
});
afterEach(() => t.cleanup());

const dmIn = { name: "Delivery Manager", remit: "runs the epic", skills: [], model: "opus" };
const ms = (title: string, repo = "acme/house", path = "EPIC.md") => ({ title, repo, path, owner: "Sam" });

describe("a new milestone comes with a Delivery Manager", () => {
  it("assigns the world's Delivery Manager, switched off by default, every 2 h when on", async () => {
    const dm = (await t.call("POST", "/api/personas", dmIn)).json;
    const m = (await t.call("POST", "/api/milestones", ms("House decision"))).json;
    const as = (await t.call("GET", `/api/assignments?milestoneId=${m.id}`)).json as { personaId: string; enabled: boolean; cadence: unknown; milestoneId: string }[];
    const mine = as.filter((a) => a.milestoneId === m.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ personaId: dm.id, enabled: false, cadence: { type: "interval", everyMinutes: 120 } });
  });

  it("still makes the milestone when the world has no Delivery Manager, and the check flags it", async () => {
    const m = (await t.call("POST", "/api/milestones", ms("Hair"))).json;
    expect(m.id).toBeTruthy();
    const gaps = (await t.call("GET", "/api/persona-gaps")).json;
    expect(gaps.ok).toBe(false);
    expect(gaps.gaps).toContainEqual(expect.objectContaining({ kind: "milestone", id: m.id, turner: "none", why: NO_TURNER }));
  });

  it("the check is green once every live milestone has its Delivery Manager, even switched off (shown, not failed)", async () => {
    await t.call("POST", "/api/personas", dmIn);
    await t.call("POST", "/api/milestones", ms("A"));
    await t.call("POST", "/api/milestones", ms("B", "acme/b"));
    const gaps = (await t.call("GET", "/api/persona-gaps")).json;
    expect(gaps.ok).toBe(true);
    expect(gaps.gaps.filter((g: { kind: string; turner: string }) => g.kind === "milestone").map((g: { turner: string }) => g.turner)).toEqual(["off", "off"]);
    expect(gaps.checked.milestones).toBe(2);
  });
});

describe("the persona check", () => {
  it("leaves TEST customer workspaces out, the one rule every reader of the check uses", () => {
    for (const w of ["acme-test", "acme-test-b", "acmes9-test", "x-y-test-b-461e2b", "TEST"]) expect(isTestWorld(w), w).toBe(true);
    for (const w of ["default", "acme-social", "contest", "testers", "latest-news", "", undefined]) expect(isTestWorld(w as string), String(w)).toBe(false);
  });

  const mk = (id: string, o: Partial<{ repo: string; path: string; paused: boolean; settledAt: string }> = {}) =>
    ({ id, title: id, repo: o.repo ?? `acme/${id}`, path: o.path ?? "EPIC.md", owner: "", paused: !!o.paused, createdAt: "", ...(o.settledAt ? { settledAt: o.settledAt } : {}) }) as never;
  const store = (milestones: never[], teams: Record<string, { name: string; enabled: boolean; parkedAt?: string }[]>) => ({
    listMilestones: () => milestones,
    listAssignments: ({ milestoneId }: { milestoneId: string }) =>
      (teams[milestoneId] ?? []).map((x, i) => ({ id: `${milestoneId}-${i}`, personaId: x.name, enabled: x.enabled, ...(x.parkedAt ? { parkedAt: x.parkedAt, parkedReason: "nothing to do" } : {}) })) as never[],
    getPersona: (id: string) => ({ id, name: id }) as never,
  });
  const home = () => "default";

  it("on: a persona switched on or auto-parked; off: personas assigned, all switched off; none: no persona at all", () => {
    expect(turnerOf([{ persona: "Delivery Manager", enabled: true }])).toBe("on");
    expect(turnerOf([{ persona: "Delivery manager", enabled: false, parked: true }])).toBe("on");
    expect(turnerOf([{ persona: "Delivery Manager", enabled: false }])).toBe("off");
    expect(turnerOf([{ persona: "Writer", enabled: true }])).toBe("on");
    expect(turnerOf([{ persona: "Writer", enabled: false }])).toBe("off");
    expect(turnerOf([])).toBe("none");
    expect(turnerOf(undefined)).toBe("none");
  });

  it("flags live milestones only: paused and settled ones are left alone", () => {
    const s = store([mk("house"), mk("hair"), mk("tax"), mk("old", { settledAt: "x" }), mk("test", { paused: true })], {
      house: [{ name: "Delivery Manager", enabled: true }],
      tax: [{ name: "Delivery Manager", enabled: false }],
    });
    expect(milestoneGaps(s, home).map((g) => [g.id, g.turner, g.why])).toEqual([
      ["hair", "none", NO_TURNER],
      ["tax", "off", TURNER_OFF],
    ]);
  });

  it("an objective turns when any milestone under its epics has a Delivery Manager on; other worlds are read by repo", () => {
    const s = store([mk("house", { repo: "acme/house_decision" }), mk("team", { repo: "acme/team", path: "docs/spines/root.md" })], {
      team: [{ name: "Delivery Manager", enabled: true }],
    });
    const gaps = objectiveGaps(
      [
        { id: "social", name: "Social", epics: [{ repo: "team", path: "docs/spines/epic-46.md" }] },
        { id: "house", name: "The house", epics: [{ repo: "house_decision", spine: "EPIC.md" }] },
        { id: "nowhere", name: "Nowhere", epics: [{ repo: "ghost", path: "EPIC.md" }] },
      ],
      s,
      home,
    );
    expect(gaps.map((g) => [g.id, g.turner])).toEqual([
      ["house", "none"],
      ["nowhere", "none"],
    ]);
    expect(gaps[1].why).toMatch(/no milestone runs its epics/);
  });
});
