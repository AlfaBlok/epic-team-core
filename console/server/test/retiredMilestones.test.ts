import { describe, expect, it } from "vitest";
import { parsePursuits } from "../src/pursuits.js";
import { withMilestones } from "../src/pursuitRoutes.js";
import { buildScorecards } from "../src/scorecards.js";
import type { Milestone } from "../src/store.js";

/**
 * The owner's yes to a placement ask: four repo milestones retire. The objectives file names
 * each by its repo and spine under `retired.milestones`; the console lists them, so the sidebar leaves them out while
 * their pages still open by link. A repo's root milestone is never retired by another spine of that repo.
 */
const ms = (id: string, repo: string, path: string, extra: Partial<Milestone> = {}): Milestone => ({ id, title: id, repo, path, owner: "Sam", paused: false, createdAt: "2026-11-01", ...extra });

describe("retired milestones", () => {
  it("the file's retired milestones are read by repo and spine, bad paths skipped", () => {
    const doc = parsePursuits(
      JSON.stringify({
        pursuits: [{ id: "a", name: "A", greenWhen: "A.", epics: [] }],
        retired: { about: "x", milestones: [{ repo: "Acme/bots", spine: "docs/spines/root.md" }, { repo: "x", spine: "../etc.md" }, { repo: "y" }] },
      }),
    );
    expect(doc.retired).toEqual([{ repo: "Acme/bots", path: "docs/spines/root.md" }]);
    expect(parsePursuits(JSON.stringify({ pursuits: [] })).retired).toBeUndefined();
  });

  it("each names its own milestone (a paused one too), never the repo's root by fallback, and the scorecards carry them", () => {
    const store = {
      listMilestones: () => [ms("bots", "Acme/market-bots", "docs/spines/root.md", { paused: true }), ms("lab", "Acme/lab", "docs/spines/root.md"), ms("gone", "Acme/old", "a.md", { settledAt: "2026-11-02" })],
      listAssignments: () => [],
      getPersona: () => undefined,
    };
    const body = withMilestones(
      { staleDays: 3, pursuits: [], retired: [{ repo: "market-bots", path: "docs/spines/root.md" }, { repo: "lab", path: "docs/other.md" }, { repo: "old", path: "a.md" }] },
      store as never,
    );
    expect(body.retiredMilestones).toEqual(["bots"]);
    expect(buildScorecards(body, () => undefined).retired).toEqual(["bots"]);
    expect(buildScorecards(withMilestones({ staleDays: 3, pursuits: [] }, store as never), () => undefined).retired).toBeUndefined();
  });
});
