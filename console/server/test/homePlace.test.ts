import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPlacer, placeOf, readPlaceMaps } from "../src/homePlace.js";

// The owner's ask: "place the older files on their objectives".
const home = fs.mkdtempSync(path.join(os.tmpdir(), "homeplace-"));
const put = (rel: string, v: unknown) => {
  fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
  fs.writeFileSync(path.join(home, rel), JSON.stringify(v));
};
const R = "home-repo";
put("docs/pursuits.json", { pursuits: [{ id: "understand" }, { id: "health" }, { id: "social" }] });
put("docs/scorecards/understand.json", { keyResults: [{ work: ["E907-S3", `${R}:E908-S1`] }] });
put("docs/scorecards/health.json", { keyResults: [{ work: [] }] });
put("docs/pages/registry.json", {
  objectiveByEpic: { [`${R}:EPIC-907`]: "health", [`${R}:EPIC-909`]: "retired-one", [`${R}:EPIC-910`]: "social" },
  objectiveByPath: { [`${R}:docs/status/finder/`]: "understand", [`${R}:docs/status/`]: "health" },
  notPlacedByPath: { [`${R}:docs/old/`]: "its milestone was retired" },
});
const m = readPlaceMaps(home);

describe("older files go to the objective they were made for", () => {
  it("a key result listing the row wins over the row's epic", () => {
    expect(placeOf(m, { repo: R, path: "docs/status/e907-s3", row: "E907-S3" })).toEqual({ objective: "understand", placedBy: "kr" });
    expect(placeOf(m, { repo: `acme/${R}`, path: "x", row: "E908-S1" })).toEqual({ objective: "understand", placedBy: "kr" });
  });
  it("else the row's epic, an ask's too", () => {
    expect(placeOf(m, { repo: R, path: "docs/status/e907-s1", row: "E907-S1" })).toEqual({ objective: "health", placedBy: "epic" });
    expect(placeOf(m, { repo: R, path: "docs/status/x.md", row: "E910-A1" })).toEqual({ objective: "social", placedBy: "epic" });
  });
  it("a retired objective places nothing: the path then decides", () => {
    expect(placeOf(m, { repo: R, path: "docs/status/e909-s2", row: "E909-S2" })).toEqual({ objective: "health", placedBy: "path" });
  });
  it("a file no row made goes by its longest path", () => {
    expect(placeOf(m, { repo: R, path: "docs/status/finder/2026-11-21.md" })).toEqual({ objective: "understand", placedBy: "path" });
  });
  it("none places it: its reason, or nothing", () => {
    expect(placeOf(m, { repo: R, path: "docs/old/a.md" })).toEqual({ notPlaced: "its milestone was retired" });
    expect(placeOf(m, { repo: "other-repo", path: "docs/a.md" })).toEqual({});
  });
  it("the placer stamps every entry and keeps its fields", () => {
    const out = createPlacer(() => home)([{ repo: R, path: "docs/status/e907-s9", row: "E907-S9", title: "t" }]);
    expect(out[0]).toMatchObject({ title: "t", objective: "health", placedBy: "epic" });
  });
  it("no home repo: no placement", () => {
    expect(placeOf(readPlaceMaps(undefined), { repo: R, path: "a", row: "E907-S1" })).toEqual({});
  });
});
