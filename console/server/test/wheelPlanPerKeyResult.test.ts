import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { homeRepo } from "../src/identity.js";
import { keyResultLines } from "../src/objectives.js";
import type { ScorecardNode } from "../src/scorecards.js";
import { keyResultPlanText, parseWheelPlan, planSection } from "../src/wheelPlan.js";

/**
 * The owner: "we need to have the plan for each of them, man. So that when an agent reads this,
 * he gets the plan ... Don't rewrite what is already in other places." The Plan tab holds, per key result, how it gets
 * to green; the wake prompt and the worker brief carry it.
 */
const plan = {
  line: "Move the work first, then prove a stranger can join.",
  keyResults: [
    {
      kr: 1,
      how: "Move our own wakes one product at a time, the busiest first.",
      steps: [
        { do: "Give the workspace its own vault", changes: "its wakes can start there", owner: "Ticket worker", by: "2026-11-26", row: "E907-S3" },
        { do: "Run a day there", owner: "Delivery Manager", by: "2026-11-27", done: true },
      ],
      greenWhen: "a whole day of wakes ran there",
      ifStuck: "move the one product that fails back and ask for the box",
    },
  ],
};

describe("the Plan tab: per key result, how it gets to green", () => {
  it("reads the approach, steps with what they change, green when and if it stalls", () => {
    const p = parseWheelPlan("mt", JSON.stringify({ keyResults: [{ label: "All wakes there" }], plan }));
    expect(p.present).toBe(true);
    expect(p.keyResults).toHaveLength(1);
    expect(p.keyResults[0].how).toMatch(/busiest first/);
    expect(p.keyResults[0].steps[0]).toMatchObject({ do: "Give the workspace its own vault", changes: "its wakes can start there", row: "E907-S3" });
    expect(p.keyResults[0].steps[1].done).toBe(true);
    expect(p.keyResults[0].ifStuck).toMatch(/ask for the box/);
  });

  it("still reads an older flat list of steps, with no approach", () => {
    const p = parseWheelPlan("mt", JSON.stringify({ plan: { line: "x", steps: [{ kr: 2, step: "Old step", owner: "Sam" }] } }));
    expect(p.keyResults).toEqual([{ kr: 2, steps: [{ do: "Old step", owner: "Sam" }] }]);
    expect(keyResultPlanText(p.keyResults[0])).toMatch(/^How: not written yet/);
  });

  it("the wake prompt carries the whole plan under each key result's name, never its numbers", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wheelplan-"));
    fs.mkdirSync(path.join(dir, "docs/scorecards"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs/scorecards/mt.json"), JSON.stringify({ keyResults: [{ label: "All wakes there", target: "100%" }, { label: "A stranger joins" }], plan }));
    const s = planSection(dir, "mt", "Acme: Get multi-tenant working");
    expect(s).toMatch(/^## The plan: Acme: Get multi-tenant working/);
    expect(s).toMatch(/### All wakes there\nHow: Move our own wakes/);
    expect(s).toMatch(/1\. Give the workspace its own vault \(changes: its wakes can start there\), Ticket worker, by 2026-11-26, E907-S3/);
    expect(s).toMatch(/Green when: a whole day/);
    expect(s).toMatch(/### A stranger joins\nNo plan written for this key result yet/);
    expect(s).not.toMatch(/100%/);
    expect(planSection(dir, undefined, "x")).toBe("");
  });

  it("the worker brief carries the plan of the key result its row hangs under", () => {
    const node: ScorecardNode = { id: "mt", kind: "pursuit", name: "Acme: Get multi-tenant working", greens: 0, total: 1, spines: [], children: [], rows: [], keyResults: [{ label: "All wakes there", kind: "key-result", state: "red", value: "0", work: [{ code: "E907-S3", repo: homeRepo(), kind: "ticket", state: "amber" }] }] };
    const text = keyResultLines({ nodes: [node] } as never, "E907-S3", homeRepo(), (id, n) => keyResultPlanText(parseWheelPlan(id, JSON.stringify({ plan })).keyResults.find((k) => k.kr === n)));
    expect(text).toMatch(/Key result: Acme: Get multi-tenant working: All wakes there/);
    expect(text).toMatch(/The plan for this key result[^\n]*\nHow: Move our own wakes/);
  });
});
