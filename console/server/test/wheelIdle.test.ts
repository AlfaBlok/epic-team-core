import { ledgerLines } from "../src/review/rows.js";
import { describe, expect, it } from "vitest";
import { createIdleWatch, objectivesSection, wheelVerdict } from "../src/cycle/wheelIdle.js";
import { readSpineInfo, type ScorecardNode, type SpineInfo } from "../src/scorecards.js";
import { parsePursuits, DEFAULT_OWNER } from "../src/pursuits.js";

/**
 * The owner: "It should be moving untill all green. Wheels spin until green yeah?": an objective below green with no
 * worker, no open ask and nothing in review is idle; its milestone's Delivery Manager wake lists it with the step to take
 * (iteration 2: the regular wake, no timer of its own).
 */

const info = (codes: string[], review: string[] = []): SpineInfo => ({ repo: "app", path: "docs/spines/e.md", doneMeans: { done: 0, total: 1 }, boxes: [], codes, queue: [], ...(review.length ? { review } : {}) });
const node = (o: Partial<ScorecardNode> = {}): ScorecardNode => ({
  id: "launch",
  kind: "pursuit",
  name: "Launch",
  rank: 5,
  milestoneId: "ms_1",
  greens: 0,
  total: 2,
  spines: ["app:docs/spines/e.md"],
  children: [],
  rows: [],
  owner: "Delivery Manager",
  keyResults: [
    { label: "Every login saved", state: "red", value: "0", kind: "key-result", work: [{ code: "E907-S3", repo: "app", kind: "ticket" }] },
    { label: "No login queued", state: "green", value: "0", kind: "key-result" },
  ],
  ...o,
});
const base = { spineInfo: { "app:docs/spines/e.md": info(["E907-S3", "E907-S4", "E907-A2"]) }, claims: [], asks: [], repo: "acme/app" };

describe("wheelVerdict", () => {
  it("a Low-tier wheel below green with nothing running, waiting or in review is idle", () => {
    const v = wheelVerdict({ ...base, node: node() });
    expect(v.idle).toBe(true);
    expect(v.reason).toMatch(/^idle: 1 key result not green/);
    expect(v.open).toEqual(["Every login saved"]);
  });
  it("all green is not idle", () => {
    const v = wheelVerdict({ ...base, node: node({ keyResults: [{ label: "x", state: "green", value: "1", kind: "key-result" }] }) });
    expect(v).toMatchObject({ idle: false, reason: "all green" });
  });
  it("a worker on one of its rows (spine row or key-result work) means moving", () => {
    const v = wheelVerdict({ ...base, node: node(), claims: [{ ticket: "E907-S4", repo: "app" }] });
    expect(v).toMatchObject({ idle: false, workers: ["E907-S4"] });
    expect(v.reason).toMatch(/moving: worker on E907-S4/);
    // a worker the owner started for the wheel itself names it in its summary
    expect(wheelVerdict({ ...base, node: node(), claims: [{ summary: "WHEEL-launch idle wheel: next step for Launch" }] })).toMatchObject({ idle: false, workers: ["wheel launch"] });
    expect(wheelVerdict({ ...base, node: node(), claims: [{ summary: "WHEEL-launch-two idle wheel" }] }).idle).toBe(true);
    // a row of the same code in another repo does not count
    expect(wheelVerdict({ ...base, node: node(), claims: [{ ticket: "E907-S4", repo: "other" }] }).idle).toBe(true);
  });
  it("an ask the gate holds for its dry run is on its way to the owner; held for a rewrite, the objective stays idle", () => {
    const dry = { code: "E907-A2", repo: "app", path: "docs/spines/e.md", reason: "waiting for its dry run: a fresh agent has not yet done it" };
    const v = wheelVerdict({ ...base, node: node(), held: [dry] });
    expect(v).toMatchObject({ idle: false, held: ["E907-A2: waiting for its dry run"] });
    expect(v.reason).toMatch(/waits on the ask check: E907-A2/);
    const bad = { ...dry, reason: "ask needs rewriting: step 2 names no URL (dry run)" };
    const w = wheelVerdict({ ...base, node: node(), held: [bad] });
    expect(w.idle).toBe(true);
    expect(w.reason).toMatch(/rewrite or withdraw each: E907-A2: ask needs rewriting/);
    expect(objectivesSection([w])).toMatch(/E907-A2: ask needs rewriting/);
    // another epic's held ask does not count
    expect(wheelVerdict({ ...base, node: node(), held: [{ ...dry, code: "E908-A9", path: "docs/spines/other.md" }] }).idle).toBe(true);
  });
  it("a row in monitoring on an open key result's work waits on its check; on a green one it does not count", () => {
    const kr = (state: "red" | "green") => node({ keyResults: [
      { label: "Live accounts", state, value: "2 of 7", kind: "key-result", work: [{ code: "E907-S3", repo: "app", kind: "ticket", status: "monitoring" }] },
      { label: "Minutes", state: "amber", value: "10", kind: "key-result", work: [] },
    ] });
    const v = wheelVerdict({ ...base, node: kr("red") });
    expect(v).toMatchObject({ idle: false, monitoring: ["E907-S3"] });
    expect(v.reason).toBe("waits on a scheduled check: E907-S3 in monitoring");
    expect(wheelVerdict({ ...base, node: kr("green") }).idle).toBe(true);
  });
  it("an open ask of its own or a row in review waits on the owner: not idle", () => {
    const ask = wheelVerdict({ ...base, node: node(), asks: [{ source: "ask", state: "open", code: "E907-A2", repo: "app" }] });
    expect(ask).toMatchObject({ idle: false, asks: ["E907-A2"] });
    const answered = wheelVerdict({ ...base, node: node(), asks: [{ source: "ask", state: "answered", code: "E907-A2", repo: "app" }] });
    expect(answered.idle).toBe(true);
    const review = wheelVerdict({ ...base, node: node(), spineInfo: { "app:docs/spines/e.md": info(["E907-S3"], ["E907-S3"]) } });
    expect(review).toMatchObject({ idle: false, review: ["E907-S3"] });
    expect(review.reason).toMatch(/review/);
  });
  it("an open ask filed on a key result's ticket in another epic's spine waits on the owner: not idle", () => {
    const v = wheelVerdict({
      ...base,
      node: node({ keyResults: [{ label: "1 idea is tested", state: "red", value: "0 of 1", kind: "key-result", work: [{ code: "E907-S6", repo: "app", kind: "ticket", status: "done" }] }] }),
      asks: [{ source: "ask", state: "open", code: "E907-A9", repo: "app", row: "E907-S6" }],
    });
    expect(v).toMatchObject({ idle: false, asks: ["E907-A9"] });
  });
  it("a key result's ticket in review in another epic's spine waits on the owner's review: not idle", () => {
    const v = wheelVerdict({
      ...base,
      node: node({ keyResults: [{ label: "1 idea is tested", state: "red", value: "0 of 1", kind: "key-result", work: [{ code: "E907-S5", repo: "app", kind: "ticket", status: "review" }] }] }),
    });
    expect(v).toMatchObject({ idle: false, review: ["E907-S5"] });
    expect(v.reason).toMatch(/review: E907-S5/);
  });
  it("parked and folded wheels are left alone", () => {
    expect(wheelVerdict({ ...base, node: node({ parked: true }) })).toMatchObject({ idle: false });
    expect(wheelVerdict({ ...base, node: node({ foldedInto: "other-set" }) })).toMatchObject({ idle: false });
  });
  it("the tier never decides whether it is idle: rank 1 and rank 7 alike", () => {
    expect(wheelVerdict({ ...base, node: node({ rank: 1 }) }).idle).toBe(true);
    expect(wheelVerdict({ ...base, node: node({ rank: 7 }) }).idle).toBe(true);
  });
});

describe("owner", () => {
  it("pursuits.json `owner` is read, default the Delivery Manager", () => {
    const doc = parsePursuits(JSON.stringify({ pursuits: [{ id: "a", name: "A", greenWhen: "g" }, { id: "b", name: "B", greenWhen: "g", owner: "Strategist" }] }));
    expect(doc.pursuits.map((p) => p.owner)).toEqual([DEFAULT_OWNER, "Strategist"]);
  });
  it("a spine row in review is read", () => {
    const text = "# EPIC-907: X\n\n## Issue Ledger\n\n| ID | Owner | Assignment | Task | Status | Next |\n|---|---|---|---|---|---|\n| E907-S1 | w | r | Build | review (card) | x |\n| E907-S2 | w | r | More | ready | x |\n";
    expect(readSpineInfo("app", "docs/spines/e.md", text, ledgerLines(text)).review).toEqual(["E907-S1"]);
  });
});

describe("objectives in the Delivery Manager wake", () => {
  const deps = () => ({
    scorecards: async () => ({
      nodes: [node(), node({ id: "site", name: "Site", milestoneId: "ms_2" }), node({ id: "green", keyResults: [{ label: "x", state: "green" as const, value: "1", kind: "key-result" as const }] })],
      spineInfo: base.spineInfo,
    }),
    claims: () => [],
    waiting: async () => [],
    milestoneRepo: () => "acme/app",
  });
  it("forMilestone gives the wake its own milestone's objectives below green and names the idle ones", async () => {
    const w = createIdleWatch(deps());
    const one = await w.forMilestone("ms_1");
    expect(one.idle).toEqual(["launch"]);
    expect(one.section).toContain("## Objectives of this milestone below green");
    expect(one.section).toContain("[objective launch]");
    expect(one.section).not.toContain("[objective site]"); // another milestone's
    expect(one.section).toMatch(/never whether it moves/);
    expect(one.section).toMatch(/next ready row of a red or amber key result/);
    expect(await w.forMilestone("ms_9")).toEqual({ section: undefined, idle: [] });
  });
  it("decorate marks the wheels for the idle pill", async () => {
    const d = deps();
    const body = await createIdleWatch(d).decorate(await d.scorecards());
    expect(body.nodes.map((n) => n.idle?.idle)).toEqual([true, true, false]);
  });
  it("a moving objective is listed without a step; all green or parked says nothing", () => {
    const moving = wheelVerdict({ ...base, node: node(), claims: [{ ticket: "E907-S4", repo: "app" }] });
    const s = objectivesSection([moving])!;
    expect(s).toContain("Moving or waiting");
    expect(s).not.toMatch(/^Idle \(/m);
    expect(objectivesSection([wheelVerdict({ ...base, node: node({ parked: true }) })])).toBeUndefined();
    expect(objectivesSection([])).toBeUndefined();
  });
});
