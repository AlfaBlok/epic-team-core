import { describe, expect, it } from "vitest";
import { addLine, EMPTY, filterColumns, filterRows, filtersFromSearch, isStep, pillTone, shownCols, sizeOf, sortRows, unfoldFromSearch } from "./trackersTab";

// The owner (vn_1df1364f): the Trackers tab holds only tables; who goes first is a Wave column he filters by.
const tb = { columns: ["Name", "Wave", "Audience", "Status"], statuses: ["candidate", "contacted", "agreed"], rows: [
  ["Ana", "", "5.1K subscribers", "contacted"],
  ["Bo", "1", "110K subscribers", "candidate"],
  ["Cy", "", "", "agreed"],
  ["Di", "1", "33.6K", "candidate"],
] };
describe("sortRows", () => {
  it("keeps the written order with no sort", () => {
    expect(sortRows(tb, null).map((r) => r[0])).toEqual(["Ana", "Bo", "Cy", "Di"]);
  });
  it("sorts sizes as numbers, status in the table's order, empty cells last", () => {
    expect(sortRows(tb, { col: 2, dir: 1 }).map((r) => r[0])).toEqual(["Ana", "Di", "Bo", "Cy"]);
    expect(sortRows(tb, { col: 2, dir: -1 }).map((r) => r[0])).toEqual(["Bo", "Di", "Ana", "Cy"]);
    expect(sortRows(tb, { col: 3, dir: 1 }).map((r) => r[0])).toEqual(["Bo", "Di", "Ana", "Cy"]);
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

describe("filters", () => {
  it("offers Wave and Status with counts, skips free-text columns", () => {
    const cols = filterColumns(tb);
    expect(cols.map((c) => c.col)).toEqual(["Wave", "Status"]);
    expect(cols[0].values).toEqual([{ v: "1", n: 2 }, { v: EMPTY, n: 2 }]);
    expect(cols[1].values.map((x) => x.v)).toEqual(["candidate", "contacted", "agreed"]);
    expect(filterColumns({ ...tb, columns: ["Name", "Kind", "Note", "X"], rows: [["a", "x", "", ""], ["b", "y", "", ""]] }).map((c) => c.col)).toEqual(["Kind"]);
  });
  it("keeps the rows holding every chosen value and the search words", () => {
    expect(filterRows(tb, { Wave: "1" }).map((r) => r[0])).toEqual(["Bo", "Di"]);
    expect(filterRows(tb, { Wave: EMPTY }).map((r) => r[0])).toEqual(["Ana", "Cy"]);
    expect(filterRows(tb, { Wave: "1", Status: "candidate" }, "110k").map((r) => r[0])).toEqual(["Bo"]);
    expect(filterRows(tb, { Gone: "x" }).length).toBe(4);
  });
  it("reads filters from the link", () => {
    expect(filtersFromSearch("?tab=trackers&filter=Wave:1&filter=Status:candidate")).toEqual({ Wave: "1", Status: "candidate" });
    expect(filtersFromSearch("?filter=Wave:")).toEqual({ Wave: EMPTY });
  });
});

// The owner (vn_578b0feb): "a table capability in every wheel": every wheel says how a table is added.
describe("addLine", () => {
  it("says how a wheel gets a table, with or without tables", () => {
    expect(addLine(0)).toMatch(/^This wheel has no tables yet\. A table is asked for by the team .* your yes\.$/);
    expect(addLine(2)).toMatch(/^Another table for this wheel is asked for/);
  });
});

// The owner 2026-11-22 (vn_d99286a7): "the trackers should be expandable": tables open folded, entries unfold.
describe("folding", () => {
  it("shows a table's chosen columns on the folded line, else every column", () => {
    expect(shownCols({ columns: ["Name", "Status", "GitHub", "Where"], shown: ["Name", "GitHub", "Nope"] })).toEqual([0, 2]);
    expect(shownCols({ columns: ["Name", "Status"] })).toEqual([0, 1]);
  });
  it("opens the tables a link names", () => {
    expect(unfoldFromSearch("?tracker=testers&filter=Status:using")).toEqual(["testers"]);
    expect(unfoldFromSearch("")).toEqual([]);
  });
  it("draws yes, no and not read yet as a step disc", () => {
    expect([isStep("yes"), isStep("no"), isStep("not read yet"), isStep("yes to post")]).toEqual([true, true, true, false]);
  });
});
