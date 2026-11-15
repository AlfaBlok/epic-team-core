import { describe, expect, it } from "vitest";
import type { SpineNode } from "../src/adapters/spines.js";
import { applyFolds, foldMap, parseFolds } from "../src/folds.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildScorecards, createSpineFileReader } from "../src/scorecards.js";

/**
 * View-only folds: the folds file (docs/epic-folds.json) moves no spine; the tree views draw each child inside its fold
 * parent.
 */

const node = (p: string, parent: string | null, children: string[] = []): SpineNode =>
  ({ path: p, id: p, title: p, status: "active", parent, dod: [], children }) as unknown as SpineNode;

describe("epic folds", () => {
  it("reads only well-formed folds", () => {
    expect(parseFolds(undefined)).toEqual([]);
    expect(parseFolds("not json")).toEqual([]);
    expect(parseFolds(JSON.stringify({ folds: [{ child: "./a.md", parent: "b.md", why: " x " }, { child: "c.md" }, { child: "d.md", parent: "d.md" }] }))).toEqual([
      { child: "a.md", parent: "b.md", why: "x" },
    ]);
  });

  it("skips unknown spines and folds that would loop", () => {
    const known = (p: string) => p !== "gone.md";
    const m = foldMap(
      [
        { child: "a.md", parent: "b.md" },
        { child: "b.md", parent: "a.md" },
        { child: "gone.md", parent: "b.md" },
      ],
      known,
    );
    expect([...m]).toEqual([["a.md", "b.md"]]);
  });

  it("moves a folded child under its fold parent, in tree order, and lifts its own children to the fold parent", () => {
    // root -> x -> child -> grand ; root -> y (the fold parent comes after the child in spines.py order)
    const nodes = [node("root.md", null, ["x.md", "y.md"]), node("x.md", "root.md", ["child.md"]), node("child.md", "x.md", ["grand.md"]), node("grand.md", "child.md"), node("y.md", "root.md")];
    const out = applyFolds(nodes, [{ child: "child.md", parent: "y.md" }]);
    expect(out.map((n) => [n.path, n.parent, (n as { folded_into?: string }).folded_into ?? null])).toEqual([
      ["root.md", null, null],
      ["x.md", "root.md", null],
      ["y.md", "root.md", null],
      ["child.md", "y.md", "y.md"],
      ["grand.md", "y.md", null],
    ]);
    expect(out.find((n) => n.path === "y.md")!.children).toEqual(["child.md", "grand.md"]);
    expect(out.find((n) => n.path === "x.md")!.children).toEqual([]);
    // no folds: the same nodes back
    expect(applyFolds(nodes, [])).toBe(nodes);
  });

  it("shows a folded epic only inside its fold parent's scorecard", () => {
    const FOLDS = JSON.stringify({ folds: [{ child: "docs/spines/tiktok.md", parent: "docs/spines/channels.md" }] });
    const files: Record<string, string> = {
      "docs/epic-folds.json": FOLDS,
      "docs/spines/channels.md": "# EPIC-929: Channels\nParent spine: none\n",
      "docs/spines/video.md": "# EPIC-928: Video\nParent spine: none\n\n- [EPIC-926: TikTok](tiktok.md)\n",
      "docs/spines/tiktok.md": "# EPIC-926: TikTok\nParent spine: [EPIC-928](video.md)\n",
    };
    const read = (_repo: string, rel: string) => files[rel];
    const p = {
      id: "channels",
      name: "Every channel",
      state: "amber" as const,
      greens: 0,
      total: 1,
      lines: [],
      totems: [],
      motion: "moving" as const,
      rank: 1,
      parked: false,
      effort: { tier: "Top", wakeFactor: 1, maxWorkers: 1, stallHours: 1, words: "" },
      epics: [
        { repo: "app", path: "docs/spines/channels.md" },
        { repo: "app", path: "docs/spines/video.md" },
        { repo: "app", path: "docs/spines/tiktok.md" },
      ],
    };
    const [set] = buildScorecards({ pursuits: [p], staleDays: 3 } as never, read).nodes;
    // top level: channels and video; tiktok sits inside channels and no longer inside video
    expect(set.children.map((c) => c.code)).toEqual(["EPIC-929", "EPIC-928"]);
    expect(set.children[0].children.map((c) => c.code)).toEqual(["EPIC-926"]);
    expect(set.children[1].children).toEqual([]);
  });

  it("the live spine reader opens the folds file, and no other non-spine file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "folds-"));
    fs.mkdirSync(path.join(dir, "docs"));
    fs.writeFileSync(path.join(dir, "docs/epic-folds.json"), "{}");
    fs.writeFileSync(path.join(dir, "docs/other.json"), "{}");
    const read = createSpineFileReader(() => dir);
    expect(read("app", "docs/epic-folds.json")).toBe("{}");
    expect(read("app", "docs/other.json")).toBeUndefined();
  });
});
