import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseWhereWeAre, readWhereWeAre, whereRel } from "../src/whereWeAre.js";

// each objective's one where-we-are, docs/scorecards/<id>.md beside its key results; the Context tab opens with it.
const TEXT = `# Where we are: EpicTeam: Get multi-tenant working

Rewritten 2026-11-22T22:30Z by run_abc for E907-S3. Read first and rewritten last by every worker and wake on this objective.

## The answer now

1 of 5 key results are green.
Wakes still run on the old servers.

## Open questions

- When do wakes move?
- Who owns payments?

## What changed

- 2026-11-22 E907-S3: the Context tab shows this file
- 2026-11-21 E907-S4: data moved to its own repo
`;

describe("an objective's where-we-are", () => {
  it("reads the three parts and the stamp", () => {
    const v = parseWhereWeAre(TEXT, whereRel("epicteam-multitenant"));
    expect(v).toMatchObject({ path: "docs/scorecards/epicteam-multitenant.md", present: true, at: "2026-11-22T22:30Z", by: "run_abc", row: "E907-S3" });
    expect(v.answer).toBe("1 of 5 key results are green.\nWakes still run on the old servers.");
    expect(v.open).toEqual(["When do wakes move?", "Who owns payments?"]);
    expect(v.changed).toHaveLength(2);
    expect(v.changed[0]).toMatch(/^2026-11-22 E907-S3: /);
  });

  it("reads the file from the checkout, says where it will live when none is written, and refuses a bad id", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wwa-"));
    fs.mkdirSync(path.join(dir, "docs/scorecards"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs/scorecards/live.md"), TEXT);
    expect(readWhereWeAre(dir, "live")?.open).toHaveLength(2);
    expect(readWhereWeAre(dir, "other")).toEqual({ path: "docs/scorecards/other.md", present: false, open: [], changed: [] });
    expect(readWhereWeAre(dir, "../etc")).toBeUndefined();
  });

  it("matches the script's file shape: the parts and stamp scripts/where_we_are.py writes", () => {
    const script = fs.readFileSync(path.resolve(__dirname, "../../../../scripts/where_we_are.py"), "utf8");
    for (const part of ["The answer now", "Open questions", "What changed"]) expect(script).toContain(`"${part}"`);
    expect(script).toContain("Rewritten {at} by {by} for {row}.");
  });
});
