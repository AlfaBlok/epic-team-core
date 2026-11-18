import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAP_HEAD, MAP_RULE, mapSection, productFor, readMaps, sectionOf, totemView } from "../src/totemMap.js";
import { workerBriefRules } from "../src/cycle/prompts.js";

// root L-77: the map is data the personas read and the screens show (one file per product in docs/totems/).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "totems-"));
fs.mkdirSync(path.join(dir, "home/docs/totems"), { recursive: true });
fs.mkdirSync(path.join(dir, "w/data"), { recursive: true });
fs.writeFileSync(path.join(dir, "w/data/product.md"), "# P\n\n## How much it costs\n\n- Hosted: 9 a month\n\n## How you get it\n\nsign in\n");
const write = (f: string, v: unknown) => fs.writeFileSync(path.join(dir, "home/docs/totems", f), JSON.stringify(v));
write("every-product.json", { statement: "Each product's data graph is the known map its personas read from at the start and write back to at the end.", totems: [{ id: "inbox", name: "Inbox", shape: "table", tab: "inbox", lives: { note: "Waiting on" } }], grows: [{ name: "Epics", from: "his words", lives: "docs/spines/" }] });
write("b.json", { product: "beta", name: "Beta", order: 2, repos: ["home"], objectives: ["beta-live"], totems: [{ id: "plan", name: "Marketing plan", shape: "page", tab: "plan", lives: { repo: "w", path: "plan.md", section: "Plan" } }] });
write("a.json", { product: "alpha", name: "Alpha", order: 1, repos: ["w"], objectives: ["alpha-live"], totems: [
  { id: "marketing-plan", name: "Marketing plan", shape: "page", tab: "plan", lives: { repo: "w", path: "docs/spines/r.md", section: "Plan" }, read: "the offer", write: "a section a test changed" },
  { id: "pricing", name: "Pricing", shape: "page", tab: "pricing", lives: { repo: "w", path: "data/product.md", section: "How much it costs" } },
  { id: "missing", name: "Missing", shape: "page", tab: "missing", lives: { repo: "w", path: "data/none.md" } },
  { id: "launch-board", name: "Launch board", shape: "table", tab: "launch", lives: { board: "alpha" } },
  { id: "bad", name: "Bad", shape: "blob", tab: "x", lives: {} },
] });
write("c.json", { product: "gamma", name: "Gamma", order: 3, repos: [], objectives: ["gamma-live"], totems: [{ id: "marketing-plan", name: "Marketing plan", shape: "page", tab: "plan", lives: { plan: "its objective's plan entry" } }] });
write("d.json", { product: "delta", name: "Delta", order: 4, repos: [], objectives: ["delta-live"], totems: [{ id: "marketing-plan", name: "Marketing plan", shape: "page", tab: "plan", lives: { plan: "its objective's plan entry" } }] });
fs.writeFileSync(path.join(dir, "home/docs/pursuits.json"), JSON.stringify({ version: 1, pursuits: [
  { id: "gamma-live", name: "Gamma live", greenWhen: "live", plan: { repo: "w", path: "docs/spines/camp.md" } },
  { id: "delta-live", name: "Delta live", greenWhen: "live" },
] }));
const maps = readMaps(path.join(dir, "home"));
const repoDir = (r: string) => path.join(dir, r);

describe("the product map", () => {
  it("reads every product in its order, keeps only well-formed totems", () => {
    expect(maps.products.map((p) => p.product)).toEqual(["alpha", "beta", "gamma", "delta"]);
    expect(maps.products[0].totems.map((t) => t.id)).toEqual(["marketing-plan", "pricing", "missing", "launch-board"]);
    expect(maps.statement).toMatch(/read from at the start and write back to at the end/);
  });
  it("a marketing plan totem points where its objective's plan entry points, one source with the Plan tab", () => {
    const g = maps.products.find((p) => p.product === "gamma")!.totems[0];
    expect(g.lives).toEqual({ repo: "w", path: "docs/spines/camp.md", section: "Plan", plan: true });
    const d = maps.products.find((p) => p.product === "delta")!.totems[0];
    expect(d.lives.note).toMatch(/no plan named yet/);
    expect(mapSection(maps, maps.products.find((p) => p.product === "gamma"))).toContain("w docs/spines/camp.md § Plan (its objective's plan entry in docs/pursuits.json)");
  });
  it("picks the product by objective, then by repo", () => {
    expect(productFor(maps, { objective: "beta-live", repo: "w" })?.product).toBe("beta");
    expect(productFor(maps, { repo: "w" })?.product).toBe("alpha");
    expect(productFor(maps, { repo: "nowhere" })).toBeUndefined();
    // a milestone carries the full name; the map files carry the short one
    expect(productFor(maps, { repo: "Owner/w" })?.product).toBe("alpha");
  });
  it("the wake section names each totem, where it lives, read first and write back last", () => {
    const s = mapSection(maps, productFor(maps, { objective: "alpha-live" }));
    expect(s.startsWith(MAP_HEAD)).toBe(true);
    expect(s).toContain("- Marketing plan (page, tab plan): w docs/spines/r.md § Plan. Read: the offer. Write back: a section a test changed.");
    expect(s).toContain("Launch board (table, tab launch)");
    expect(s).toContain("- Inbox (table, tab inbox)");
    expect(s).toMatch(/Start: read every totem/);
    expect(s).toMatch(/End: write what you learned or changed back/);
    expect(mapSection(maps, undefined)).toBe("");
  });
  it("every worker brief carries the map rule second, right after the objectives", () => {
    expect(workerBriefRules()[1]).toBe(MAP_RULE);
    expect(MAP_RULE).toContain("scripts/totems.py for");
  });
});

describe("a totem's tab content", () => {
  it("a page totem is its section only", () => {
    const v = totemView({ maps, product: "alpha", totem: "pricing", repoDir })!;
    expect(v.empty).toBe(false);
    expect(v.markdown).toBe("- Hosted: 9 a month");
  });
  it("a totem with nothing written yet is shown empty, with where it will live", () => {
    const v = totemView({ maps, product: "alpha", totem: "missing", repoDir })!;
    expect(v.empty).toBe(true);
    expect(v.where).toBe("w data/none.md");
  });
  it("a launch board totem is its lights", () => {
    const v = totemView({ maps, product: "alpha", totem: "launch-board", repoDir, board: () => ({ products: [{ id: "alpha", lights: [{ label: "Site up", state: "green" }] }] }) })!;
    expect(v.rows).toEqual([["Site up", "green", ""]]);
  });
  it("an unknown product or totem is not found", () => {
    expect(totemView({ maps, product: "alpha", totem: "nope", repoDir })).toBeNull();
    expect(totemView({ maps, product: "zzz", totem: "pricing", repoDir })).toBeNull();
  });
  it("sectionOf stops at the next heading", () => {
    expect(sectionOf("## A\na\n## B\nb", "A")).toBe("a");
  });
});
