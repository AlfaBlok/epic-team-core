import { describe, expect, it } from "vitest";
import { EMPTY, filterColumns, filterRows, filtersFromSearch, pillTone, sizeOf, sortRows } from "./trackersTab";

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
