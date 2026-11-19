import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readWheel, storePersonas, wheelReader } from "../src/wheel.js";

// the wheel is one record: its objective, key results, map, trackers, plan and personas read in one place.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "wheel-"));
const w = (f: string, v: unknown) => (fs.mkdirSync(path.dirname(path.join(home, f)), { recursive: true }), fs.writeFileSync(path.join(home, f), JSON.stringify(v)));
const totem = (id: string) => ({ id, name: id, shape: "page", tab: id, lives: { note: "here" } });
w("docs/pursuits.json", {
  version: 1,
  pursuits: [
    { id: "alpha-live", name: "Alpha: 5 testers", greenWhen: "five use it", product: "alpha", epics: [{ repo: "alpha", spine: "docs/spines/root.md" }], plan: { repo: "alpha-social", path: "docs/spines/plan.md" } },
    { id: "parked-one", name: "Beta: later", greenWhen: "x", parked: true },
    { id: "gone", name: "Gone: done", greenWhen: "x", active: false },
  ],
});
w("docs/scorecards/alpha-live.json", { keyResults: [{ label: "5 testers signed in", owner: "build", work: ["E907-S3"], evidence: { what: "list", url: "https://x" } }] });
w("docs/scorecards/parked-one.json", { foldedInto: "alpha-live" });
w("docs/totems/every-product.json", { totems: [totem("lean-core")], grows: [{ name: "Ideas", from: "his words", lives: "memory" }], trackers: { tables: [{ id: "testers", name: "Testers", columns: ["Name", "Status"] }] } });
w("docs/totems/alpha.json", { product: "alpha", name: "Alpha", objectives: ["alpha-live"], totems: [totem("pricing")] });

const ms = [{ id: "ms1", title: "Alpha root", repo: "Owner/alpha", path: "docs/spines/root.md" }, { id: "ms2", title: "Other", repo: "Owner/other", path: "docs/spines/root.md" }];
const store = {
  listMilestones: () => ms as never[],
  listAssignments: ({ milestoneId }: { milestoneId: string }) => (milestoneId === "ms1" ? [{ personaId: "p1", enabled: false }] : [{ personaId: "p2", enabled: true }]) as never[],
  getPersona: (id: string) => ({ id, name: id === "p1" ? "Delivery Manager" : "Writer" }) as never,
};

describe("the wheel record", () => {
  it("joins every part of one objective, each with where it was read", () => {
    const x = readWheel(home, "alpha-live", storePersonas(store))!;
    expect([x.name, x.greenWhen, x.rank, x.parked, x.owner]).toEqual(["Alpha: 5 testers", "five use it", 1, false, "Delivery Manager"]);
    expect(x.product).toEqual({ id: "alpha", name: "Alpha" });
    expect(x.keyResults).toEqual([{ label: "5 testers signed in", owner: "build", work: ["E907-S3"], evidence: { what: "list", url: "https://x" } }]);
    expect(x.map.kernel.map((t) => t.id)).toEqual(["lean-core"]);
    expect(x.map.own.map((t) => t.id)).toEqual(["pricing"]);
    expect(x.map.grows.map((g) => g.name)).toEqual(["Ideas"]);
    expect(x.trackers.map((t) => [t.id, t.from])).toEqual([["testers", "frame"]]);
    expect(x.plan).toEqual({ repo: "alpha-social", path: "docs/spines/plan.md" });
    expect(x.personas).toEqual([{ milestoneId: "ms1", milestone: "Alpha root", persona: "Delivery Manager", enabled: false, parked: false }]);
    expect(x.turner).toBe("off");
    expect(x.sources.keyResults).toBe("docs/scorecards/alpha-live.json");
  });
  it("lists live objectives only (the one list), parked ones without a rank, and finds a wheel by its spine", () => {
    const r = wheelReader(home);
    expect(r.all().map((x) => [x.id, x.rank, x.turner])).toEqual([["alpha-live", 1, "none"], ["parked-one", null, "none"]]);
    expect(r.one("parked-one")!.foldedInto).toBe("alpha-live");
    expect(r.one("alpha-live")!.foldedInto).toBeUndefined();
    expect(r.one("gone")).toBeNull();
    expect(r.ofSpine("Owner/alpha", "docs/spines/root.md")).toBe("alpha-live");
    expect(r.ofSpine("alpha-social", "docs/spines/plan.md")).toBe("alpha-live");
    expect(r.ofSpine(undefined, "docs/spines/root.md")).toBeUndefined();
    expect(readWheel(undefined, "alpha-live")).toBeNull();
  });
});
