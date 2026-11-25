import { describe, expect, it } from "vitest";
import { groupText, parsePursuits } from "../src/pursuits.js";

// His voice note 25 Nov 14:34Z (Log/2026-11-25.md#^e-3941fc): "in Epic Team, the sidebar, we're going to need to develop
// groups so that I can make groups of objectives ... personal ... business ... background ... central". Each objective
// keeps its group in docs/pursuits.json (`"group"`), read back on the parsed list; a move is one edit of that field.

const p = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `Acme: ${id}`, greenWhen: `${id} is green`, ...over });
const file = (ps: Record<string, unknown>[]) => JSON.stringify({ pursuits: ps }, null, 2) + "\n";

describe("an objective's sidebar group", () => {
  it("is read from the file, and an unknown group is left out", () => {
    const doc = parsePursuits(file([p("a", { group: "central" }), p("b", { group: "nonsense" }), p("c")]));
    expect(doc.pursuits.map((x) => x.group)).toEqual(["central", undefined, undefined]);
  });

  it("moves with one edit of its group, nothing else changed", () => {
    const text = file([p("a", { group: "central" }), p("b")]);
    const moved = groupText(text, "b", "personal")!;
    expect(JSON.parse(moved).pursuits).toEqual([p("a", { group: "central" }), p("b", { group: "personal" })]);
    expect(groupText(moved, "a", "background")).toBe(file([p("a", { group: "background" }), p("b", { group: "personal" })]));
  });

  it("refuses a group he does not have and an objective not in the file", () => {
    const text = file([p("a")]);
    expect(groupText(text, "a", "research")).toBeNull();
    expect(groupText(text, "nope", "central")).toBeNull();
  });
});
