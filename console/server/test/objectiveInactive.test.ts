import { describe, expect, it } from "vitest";
import { activeText, parsePursuits, reorderText } from "../src/pursuits.js";
import { addCard, checkPost, dayOf, emptyDoc, listCards, type TeamCardsDoc } from "../src/inbox/teamCards.js";
import { parseObjectives } from "../src/inbox/jordiPriority.js";

// The owner, on a live call: an objective can be switched inactive or back; it stays in
// docs/pursuits.json with `"active": false` and the day, and leaves every list. Goals to set counts one card per active
// objective still needing a goal (it showed 15 while he had 14 objectives: 7 goal cards and 8 campaign questions).

const p = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `Acme: ${id}`, greenWhen: `${id} is green`, ...over });
const file = (ps: Record<string, unknown>[]) => JSON.stringify({ pursuits: ps }, null, 2) + "\n";

describe("an inactive objective", () => {
  it("is kept in the file, out of the parsed list, listed as inactive with its day", () => {
    const doc = parsePursuits(file([p("a"), p("b", { active: false, inactiveSince: "2026-11-18" }), p("c")]));
    expect(doc.pursuits.map((x) => x.id)).toEqual(["a", "c"]);
    expect(doc.inactive).toEqual([{ id: "b", name: "Acme: b", since: "2026-11-18" }]);
  });

  it("is switched off and back on with one edit of the file, nothing else changed", () => {
    const text = file([p("a"), p("b")]);
    const off = activeText(text, "b", false, "2026-11-18")!;
    expect(JSON.parse(off).pursuits[1]).toEqual({ ...p("b"), active: false, inactiveSince: "2026-11-18" });
    expect(parsePursuits(off).pursuits.map((x) => x.id)).toEqual(["a"]);
    const on = activeText(off, "b", true, "2026-11-19")!;
    expect(on).toBe(text);
    expect(activeText(text, "nope", false, "2026-11-18")).toBeNull();
  });

  it("keeps its place when he reorders the active ones", () => {
    const text = file([p("a"), p("b", { active: false }), p("c")]);
    const out = reorderText(text, ["c", "a"])!;
    expect(JSON.parse(out).pursuits.map((x: { id: string }) => x.id)).toEqual(["c", "a", "b"]);
    expect(reorderText(text, ["c"])).toBeNull(); // an active one left out is still not a reorder
  });

  it("orders nothing in his priority list", () => {
    expect(parseObjectives(file([p("a"), p("b", { active: false })])).map((o) => o.id)).toEqual(["a"]);
  });
});

describe("Goals to set counts his active objectives still needing a goal", () => {
  const now = "2026-11-18T05:00:00.000Z";
  const goal = (scorecard: string) => ({
    kind: "goal",
    by: "Gap finder",
    scorecard,
    title: `${scorecard} has no number`,
    goal: { unset: "how many by when", options: [{ goal: "10 by Dec 15", number: "10" }, { goal: "3 by Dec 1", number: "3" }] },
  });
  const docWith = (ids: string[]): TeamCardsDoc => {
    let doc = emptyDoc();
    ids.forEach((id) => {
      const ch = checkPost(goal(id), dayOf(now));
      if (!ch.ok) throw new Error(ch.message);
      const r = addCard(doc, ch.card, now);
      if ("error" in r) throw new Error(r.error.message);
      doc = r.doc;
    });
    return doc;
  };

  it("drops a goal card of an inactive or gone objective, so the count is the live objectives needing a goal", () => {
    const doc = docWith(["a", "b", "off", "retired"]);
    const live = ["a", "b", "c"];
    const r = listCards(doc, { now, objectives: { live, off: ["off"] } });
    const needing = live.filter((id) => doc.cards.some((c) => c.kind === "goal" && c.scorecard === id && !c.answer));
    expect(r.counts.goal).toBe(needing.length);
    expect(r.open.map((c) => c.scorecard)).toEqual(expect.arrayContaining(["a", "b"]));
    expect(r.goalObjectives).toEqual({ active: 3, needGoal: 2 });
  });

  it("without the objectives file every card counts, as before", () => {
    expect(listCards(docWith(["a", "gone"]), { now }).counts.goal).toBe(2);
  });
});
