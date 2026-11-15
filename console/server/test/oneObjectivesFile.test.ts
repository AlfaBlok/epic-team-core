import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readRedLines } from "../src/objectives.js";
import { OBJECTIVES_FILE, PRIORITIES_FILE, redLinesFile } from "../src/inbox/jordiPriority.js";

// One objectives file every agent and the desk read: the owner's red lines live in docs/pursuits.json beside his objectives; docs/priorities.json keeps only the levels.
const checkout = (files: Record<string, unknown>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "objectives-"));
  fs.mkdirSync(path.join(dir, "docs"));
  for (const [rel, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), JSON.stringify(v));
  return dir;
};

describe("one objectives file", () => {
  it("reads the red lines from docs/pursuits.json, never a second copy in docs/priorities.json", () => {
    const dir = checkout({
      [OBJECTIVES_FILE]: { pursuits: [{ id: "acme" }], redLines: [{ name: "Acme's first team", objective: "acme", sentence: "One team." }] },
      [PRIORITIES_FILE]: { items: [], redLines: [{ name: "Stale copy", sentence: "Old." }] },
    });
    expect(redLinesFile(dir)).toBe(OBJECTIVES_FILE);
    expect(readRedLines(dir).map((r) => r.name)).toEqual(["Acme's first team"]);
  });

  it("a world with no pursuits file keeps its red lines in docs/priorities.json", () => {
    const dir = checkout({ [PRIORITIES_FILE]: { items: [], redLines: [{ name: "Its own line", sentence: "Theirs." }] } });
    expect(redLinesFile(dir)).toBe(PRIORITIES_FILE);
    expect(readRedLines(dir).map((r) => r.name)).toEqual(["Its own line"]);
  });
});
