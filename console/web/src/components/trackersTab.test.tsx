import { describe, expect, it } from "vitest";
import { trackersAnswer } from "./trackersTab";

// the wheel's Trackers tab opens on its answer: how many tables and entries, which are still empty.
const t = (id: string, rows: string[][], open = true) => ({ id, name: id[0].toUpperCase() + id.slice(1), columns: ["Name", "Status"], statuses: [], from: "frame" as const, open, rows, counts: [], file: "" });

describe("trackersAnswer", () => {
  it("says how many tables and entries, and names the empty ones", () => {
    expect(trackersAnswer({ wheel: "w", name: "W", tables: [t("influencers", [])] })).toBe("1 table, 0 entries. Still empty: Influencers.");
    expect(trackersAnswer({ wheel: "w", name: "W", tables: [t("influencers", [["Ana", "contacted"]]), t("podcasts", [], false)] })).toBe("2 tables, 1 entry. 1 asked for, waiting for your yes.");
  });
});

// click a column to sort; with no sort, the first-message yes entries sit on top (wave 1).
import { pillTone, sizeOf, sortRows } from "./trackersTab";
const tb = { columns: ["Name", "First", "Audience", "Status"], statuses: ["candidate", "contacted", "agreed"], first: "First", rows: [
  ["Ana", "no", "5.1K subscribers", "contacted"],
  ["Bo", "yes", "110K subscribers", "candidate"],
  ["Cy", "no", "", "agreed"],
  ["Di", "yes", "33.6K", "candidate"],
] };
describe("sortRows", () => {
  it("puts the yes entries first by default, keeping the written order", () => {
    expect(sortRows(tb, null).map((r) => r[0])).toEqual(["Bo", "Di", "Ana", "Cy"]);
  });
  it("sorts sizes as numbers, status in the table's order, empty cells last", () => {
    expect(sortRows(tb, { col: 2, dir: 1 }).map((r) => r[0])).toEqual(["Ana", "Di", "Bo", "Cy"]);
    expect(sortRows(tb, { col: 2, dir: -1 }).map((r) => r[0])).toEqual(["Bo", "Di", "Ana", "Cy"]);
    expect(sortRows(tb, { col: 3, dir: 1 }).map((r) => r[0])).toEqual(["Bo", "Di", "Ana", "Cy"]);
    const mixed = { ...tb, rows: [...tb.rows, ["Ed", "no", "Followers not read", "candidate"]] };
    expect(sortRows(mixed, { col: 2, dir: -1 }).map((r) => r[0])).toEqual(["Bo", "Di", "Ana", "Ed", "Cy"]);
    expect(sortRows(tb, { col: 0, dir: -1 }).map((r) => r[0])).toEqual(["Di", "Cy", "Bo", "Ana"]);
  });
  it("reads sizes and colours statuses", () => {
    expect(sizeOf("33.6K subscribers")).toBe(33600);
    expect(sizeOf("1.2M")).toBe(1200000);
    expect(sizeOf("Followers not read")).toBeNull();
    expect(pillTone("agreed")).toContain("emerald");
    expect(pillTone("declined")).toContain("rose");
    expect(pillTone("candidate")).toContain("muted");
  });
});
