// an ask sits on the objective where the row it blocks lives, not where its line is written.
import { describe, expect, it } from "vitest";
import type { ScorecardNode, ScorecardsBody } from "@/api/pursuit-types";
import { homeOf, indexScorecards } from "@/lib/scorecards";

const node = (id: string, spines: string[]): ScorecardNode => ({ id, kind: "pursuit", name: id, greens: 0, total: 0, spines, rows: [], children: [] }) as unknown as ScorecardNode;
const SETS = {
  nodes: [node("family", ["app:docs/spines/epic-908.md"]), node("oneoffs", ["app:docs/spines/epic-907.md"])],
  spineInfo: {
    "app:docs/spines/epic-907.md": { repo: "app", path: "docs/spines/epic-907.md", code: "EPIC-907", codes: ["E907-A29"] },
    "app:docs/spines/epic-908.md": { repo: "app", path: "docs/spines/epic-908.md", code: "EPIC-908", codes: ["E907-S3"] },
  },
} as unknown as ScorecardsBody;

describe("an ask follows its row", () => {
  const ix = indexScorecards(SETS);
  it("its row moved to another epic: the ask shows on that row's objective", () => {
    expect(homeOf(ix, SETS.nodes, { repo: "app", path: "docs/spines/epic-907.md", code: "E907-A29", row: "E907-S3" })?.pursuit.id).toBe("family");
  });
  it("no row, or a row no spine knows: by its own line, as before", () => {
    expect(homeOf(ix, SETS.nodes, { repo: "app", path: "docs/spines/epic-907.md", code: "E907-A29" })?.pursuit.id).toBe("oneoffs");
    expect(homeOf(ix, SETS.nodes, { repo: "app", path: "docs/spines/epic-907.md", code: "E907-A29", row: "row T4" })?.pursuit.id).toBe("oneoffs");
  });
});
