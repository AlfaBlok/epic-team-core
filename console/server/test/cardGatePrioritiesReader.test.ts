import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parityGaps, worldParity } from "../src/review/worldParity.js";
import { makeRepo, spineText } from "./reviewFixture.js";

/**
 * EpicTeam's world and the social product's are read by one card gate and one priorities reader. The same
 * finished task in either world's repo becomes the same card; a world whose cards fail the gate, or which has no priority
 * levels, is named as a gap (what found in a social world repo: 1 of 13 finished tasks on his list, no levels).
 */
const LIVE = "https://team.example/audit";
const ROOT = "# EPIC: root\n\nRoot spine: self\nIntegration policy: main-direct\nProject name: [The test product](https://team.example/)\n\n## Current State\n\nStatus: active\n";
const spine = spineText("PLAN-7", "Finished work", [
  { id: "T7-S1", status: "review", evidence: `[the page](${LIVE})` },
  { id: "T7-S2", status: "review", evidence: `[the other page](${LIVE}/2)` },
]);
const PRIORITIES = JSON.stringify({ version: 1, items: [{ ref: "T7-S1", level: "high", why: "his first tester" }, { ref: "T7-S2", level: "low", why: "later" }] });

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e101s7-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("T101-S7: one card gate and one priorities reader for every world", () => {
  it("the same finished task in EpicTeam's repo and SocialApp's becomes the same card", () => {
    const team = makeRepo(tmp, "home_repo", { "docs/spines/root.md": ROOT, "docs/spines/epic-7.md": spine, "docs/priorities.json": PRIORITIES });
    const social = makeRepo(tmp, "social", { "docs/spines/root.md": ROOT, "docs/spines/epic-7.md": spine, "docs/priorities.json": PRIORITIES });
    const a = worldParity("acme", team.dir);
    const b = worldParity("social", social.dir);
    expect(a.finished).toEqual({ total: 2, cards: 2, byKind: { card: 2 }, stopped: [] });
    expect(b.finished).toEqual(a.finished);
    expect(b.priorities).toEqual(a.priorities);
    expect(a.priorities).toMatchObject({ file: true, levels: 2 });
    expect(parityGaps(b)).toEqual([]);
  });

  it("a world with no card files and no priority levels is named as a gap, row by row", () => {
    const social = makeRepo(tmp, "social", { "docs/spines/root.md": ROOT, "docs/spines/epic-7.md": spine }, { cards: false });
    const p = worldParity("social", social.dir);
    expect(p.finished.cards).toBe(0);
    expect(p.finished.stopped.map((s) => [s.ref, s.kind])).toEqual([
      ["T7-S1", "needs-rewriting"],
      ["T7-S2", "needs-rewriting"],
    ]);
    expect(p.priorities).toEqual({ file: false, levels: 0, redLines: 0 });
    const gaps = parityGaps(p);
    expect(gaps).toHaveLength(3);
    expect(gaps[2]).toMatch(/no docs\/priorities\.json/);
  });
});
