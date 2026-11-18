import { describe, expect, it } from "vitest";
import { activeText, doneText, objectiveIds, parsePursuits } from "../src/pursuits.js";
import { parseObjectives } from "../src/inbox/jordiPriority.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The owner, on a live call (call_a3e08f34): "I'm looking at the ready for testers objective ... this one we can mark as
// complete". An objective marked done stays in docs/pursuits.json with `"active": false` and `"doneOn"`, so it leaves
// every list exactly like an inactive one, and shows under Done (with an undo), not under Inactive.

const p = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `Acme: ${id}`, greenWhen: `${id} is green`, ...over });
const file = (ps: Record<string, unknown>[]) => JSON.stringify({ pursuits: ps }, null, 2) + "\n";

describe("a done objective", () => {
  it("is kept in the file, out of the parsed list, listed under done with its day (not inactive)", () => {
    const doc = parsePursuits(file([p("a"), p("b", { active: false, doneOn: "2026-11-18" }), p("c", { active: false, inactiveSince: "2026-11-17" })]));
    expect(doc.pursuits.map((x) => x.id)).toEqual(["a"]);
    expect(doc.done).toEqual([{ id: "b", name: "Acme: b", since: "2026-11-18" }]);
    expect(doc.inactive).toEqual([{ id: "c", name: "Acme: c", since: "2026-11-17" }]);
  });

  it("is marked done and undone with one edit of the file, nothing else changed", () => {
    const text = file([p("a"), p("b")]);
    const done = doneText(text, "b", true, "2026-11-18")!;
    expect(JSON.parse(done).pursuits[1]).toEqual({ ...p("b"), active: false, doneOn: "2026-11-18" });
    expect(doneText(done, "b", false, "2026-11-19")).toBe(text);
    expect(doneText(text, "nope", true, "2026-11-18")).toBeNull();
  });

  it("moves cleanly between inactive and done", () => {
    const off = activeText(file([p("a")]), "a", false, "2026-11-17")!;
    const done = doneText(off, "a", true, "2026-11-18")!;
    expect(JSON.parse(done).pursuits[0]).toEqual({ ...p("a"), active: false, doneOn: "2026-11-18" });
    expect(JSON.parse(activeText(done, "a", false, "2026-11-19")!).pursuits[0]).toEqual({ ...p("a"), active: false, inactiveSince: "2026-11-19" });
  });

  it("orders nothing in his priority list and counts as off for the inbox", () => {
    const text = file([p("a"), p("b", { active: false, doneOn: "2026-11-18" })]);
    expect(parseObjectives(text).map((o) => o.id)).toEqual(["a"]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "done-"));
    fs.mkdirSync(path.join(dir, "docs"));
    fs.writeFileSync(path.join(dir, "docs/pursuits.json"), text);
    expect(objectiveIds(dir)).toEqual({ live: ["a"], off: ["b"] });
  });
});
