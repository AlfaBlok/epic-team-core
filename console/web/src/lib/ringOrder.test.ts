import { describe, expect, it } from "vitest";
import { byRingColour, ringRank } from "./ringOrder";

describe("byRingColour", () => {
  it("puts each colour together: green, amber, red, then no reading", () => {
    const rows = ["green", "red", "unknown", "amber", "green", "red", "amber"].map((state, i) => ({ state, i }));
    expect(byRingColour(rows).map((r) => r.state)).toEqual(["green", "green", "amber", "amber", "red", "red", "unknown"]);
  });
  it("keeps the order inside one colour and leaves the input alone", () => {
    const rows = [{ state: "green", i: 0 }, { state: "red", i: 1 }, { state: "green", i: 2 }];
    expect(byRingColour(rows).map((r) => r.i)).toEqual([0, 2, 1]);
    expect(rows.map((r) => r.i)).toEqual([0, 1, 2]);
  });
  it("sends grey, blue and a state it does not know to the end", () => {
    expect(ringRank("grey")).toBeGreaterThan(ringRank("red"));
    expect(ringRank("blue")).toBeGreaterThan(ringRank("red"));
    expect(ringRank("odd")).toBeGreaterThan(ringRank("unknown"));
  });
});
