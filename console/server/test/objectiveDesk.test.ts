import { describe, expect, it } from "vitest";
import { parsePursuits } from "../src/pursuits.js";
import { deskOfPursuit, withMilestones } from "../src/pursuitRoutes.js";
import { buildScorecards } from "../src/scorecards.js";
import type { Milestone } from "../src/store.js";

/**
 * the Chat chapter of an objective asks GET /pursuits/:id/desk before it says "no team runs this objective".
 * The answer names the same milestone the scorecards give it (Buy a new phone talks to the One-offs desk through its
 * repo's root spine), and null only when no milestone runs any of its epics.
 */
const ms = (id: string, repo: string, path: string, extra: Partial<Milestone> = {}): Milestone => ({ id, title: id, repo, path, owner: "Sam", paused: false, createdAt: "2026-11-01", ...extra });
const store = (list: Milestone[]) => ({ listMilestones: () => list, listAssignments: () => [], getPersona: () => undefined }) as never;
const doc = parsePursuits(
  JSON.stringify({
    pursuits: [
      { id: "phone", name: "Personal: Buy a new phone", greenWhen: "Bought.", epics: [{ repo: "one-offs", spine: "docs/spines/phone.md" }] },
      { id: "lonely", name: "Personal: Nobody runs it", greenWhen: "Never.", epics: [{ repo: "nowhere", spine: "docs/spines/x.md" }] },
    ],
  }),
);

describe("an objective's desk, read fresh", () => {
  it("names the milestone the scorecards name, and null only when none runs it", () => {
    const body = withMilestones(doc as never, store([ms("ms_oneoffs", "Acme/one-offs", "docs/spines/root.md")]));
    const of = (id: string) => deskOfPursuit(body.pursuits.find((p) => p.id === id)!);
    expect(of("phone")).toBe("ms_oneoffs");
    expect(of("lonely")).toBeNull();
    const cards = buildScorecards(body, () => undefined);
    expect(cards.nodes.find((n) => n.id === "phone")?.milestoneId).toBe(of("phone"));
    expect(cards.nodes.find((n) => n.id === "lonely")?.milestoneId).toBeUndefined();
  });
});
