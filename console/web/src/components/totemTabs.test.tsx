import { describe, expect, it } from "vitest";
import { productOfObjective, totemTabs } from "@/components/totemTabs";
import type { TotemMaps } from "@/api/totem-types";

// root L-77: each hardwired totem of the objective's product is a tab; a tab the screen has stays one tab.
const maps: TotemMaps = {
  statement: "",
  every: { totems: [], grows: [] },
  products: [
    { product: "notes", name: "Notes", repos: [], objectives: ["notes-live"], grows: [], totems: [
      { id: "marketing-plan", name: "Marketing plan", shape: "page", tab: "plan", lives: {} },
      { id: "pricing", name: "Pricing", shape: "page", tab: "pricing", lives: {} },
      { id: "launch-board", name: "Launch board", shape: "table", tab: "launch", lives: {} },
    ] },
  ],
};

describe("totem tabs", () => {
  it("The notes objective gets Pricing and Launch board tabs; the marketing plan is the Plan tab it already has", () => {
    const p = productOfObjective(maps, "notes-live");
    expect(p?.product).toBe("notes");
    expect(totemTabs(p, ["table", "plan", "kit"]).map((t) => t.label)).toEqual(["Pricing", "Launch board"]);
  });
  it("an objective of no product gets no extra tab", () => {
    expect(totemTabs(productOfObjective(maps, "house"), ["table"])).toEqual([]);
  });
});
