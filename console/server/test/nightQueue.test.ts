import { describe, expect, it } from "vitest";
import type { Tree, TreeNode } from "../src/adapters/tree.js";
import { treeTodoSection } from "../src/adapters/tree.js";
import { isNightMarked, nightPhase, nightQueueSection, readyRows } from "../src/adapters/nightQueue.js";

// the night queue: evening wakes mark ready rows `[night]`, night wakes start them first; nothing by day.
const row = (id: string, nextAction: string, ready = true): TreeNode => ({
  id,
  key: id,
  kind: "ticket",
  title: `${id} title`,
  status: ready ? "ready" : "draft",
  color: "grey",
  children: [],
  flags: [],
  nextAction,
  ...(ready ? { ready: true as const } : {}),
});
const tree = (rows: TreeNode[]): Tree =>
  ({
    milestoneId: "ms_t",
    root: { id: "ROOT", kind: "spine", title: "root", status: "active", color: "blue", children: rows, flags: [] },
    counts: { grey: rows.length, blue: 0, yellow: 0, red: 0, green: 0 },
    nonGreen: rows.length,
    closed: 0,
    flagged: 0,
    warnings: [],
  }) as unknown as Tree;

// Mexico City is UTC-6 (no daylight saving since 2022).
const at = (utc: string) => Date.parse(`2026-11-14T${utc}:00Z`);
const NOON = at("18:00"); // 12:00 local
const EVENING = at("02:30") + 86_400_000; // 20:30 local
const NIGHT = at("10:00"); // 04:00 local

describe("night queue", () => {
  it("phases follow Mexico City time: evening 19-22, night 22-08, day otherwise", () => {
    expect(nightPhase(NOON)).toBe("day");
    expect(nightPhase(EVENING)).toBe("evening");
    expect(nightPhase(NIGHT)).toBe("night");
    expect(nightPhase(at("04:00"))).toBe("night"); // 22:00 local
    expect(nightPhase(at("14:00"))).toBe("day"); // 08:00 local
  });

  it("reads the [night] mark from the Next action cell, ready rows only", () => {
    const t = tree([row("E907-S1", "worker [night]"), row("E907-S2", "worker"), row("E907-S3", "[night]", false)]);
    expect(readyRows(t).map((n) => n.id)).toEqual(["E907-S1", "E907-S2"]);
    expect(isNightMarked({ nextAction: "worker [Night]" })).toBe(true);
    expect(isNightMarked({ nextAction: "night queue later" })).toBe(false);
  });

  it("by day adds nothing", () => {
    expect(nightQueueSection(tree([row("E907-S1", "[night]")]), NOON)).toEqual([]);
    expect(treeTodoSection(tree([row("E907-S1", "[night]")]), 30, [], NOON)).not.toContain("Night queue");
  });

  it("in the evening asks the Delivery Manager to mark the queue and never to ready a draft", () => {
    const s = nightQueueSection(tree([row("E907-S1", "worker [night]"), row("E907-S2", "worker")]), EVENING).join("\n");
    expect(s).toContain("## Night queue: mark it now");
    expect(s).toContain("Never ready a draft");
    expect(s).toContain("Marked now: 1 of 2 ready (E907-S1).");
  });

  it("at night lists the marked rows first, then the rest", () => {
    const t = tree([row("E907-S2", "worker"), row("E907-S1", "worker [night]"), row("E907-S3", "x", false)]);
    const s = treeTodoSection(t, 30, [], NIGHT);
    expect(s).toContain("## Night queue (22:00 to 08:00 Mexico City");
    expect(s).toContain("Start these first");
    expect(s).toContain("- E907-S1 — E907-S1 title");
    expect(s).not.toContain("- E907-S2 — E907-S2 title");
    expect(s).toContain("Then the other ready rows (1)");
  });

  it("at night with nothing marked says to start rows that need no yes", () => {
    const s = nightQueueSection(tree([row("E907-S2", "worker")]), NIGHT).join("\n");
    expect(s).toContain("No row is marked `[night]`");
  });

  it("no ready row, no block", () => {
    expect(nightQueueSection(tree([row("E907-S3", "[night]", false)]), NIGHT)).toEqual([]);
  });
});
