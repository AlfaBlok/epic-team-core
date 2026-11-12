import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { applyChange, mountRedLineEdit, spineLine, withDecision, withSpineLines, type Reworder } from "../src/inbox/redLineEdit.js";
import { parseRedLines } from "../src/inbox/jordiPriority.js";
import { createSpineWriter } from "../src/inbox/spineWrite.js";
import { tempCheckout } from "./helpers/gitRepo.js";

// (the owner 2026-11-10 20:45Z, vn_ffa4783d: "I should have a button to edit, and when I press that button, something
// unfolds where I can type or I can leave a voice note to edit the red line. I can also delete it"): his edit and delete
// of a red line go into the repo (root L-45): docs/priorities.json, the root spine's Red line lines and an
// Decisions row quoting him, one commit each; Undo brings a deleted line back to its place.

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

const memo = { name: "Memo's first tester", sentence: "Get Memo's first real tester using it every day.", state: "agreed", ask: "E948-A6", at: "2026-11-10T07:10:00Z", items: [{ repo: "memo", ref: "E923-A1" }, { repo: "memo", ref: "T1" }] };
const flywheel = { name: "Data-product flywheel", target: "2026-11-30", sentence: "By 30 November, two or three data products run on their own.", state: "agreed", ask: "E948-A8", at: "2026-11-10T17:55:00Z", items: [{ repo: "deal-funnels", ref: "EPIC-905-A1" }] };
const FILE = JSON.stringify({ version: 1, at: "2026-11-10T13:20:00Z", by: "Prioritizer", items: [], redLines: [memo, flywheel] }, null, 2) + "\n";
const ROOT = `# EPIC: home_repo\n\nIntegration policy: main-direct\n\n## Current State\nOwner: Delivery manager\nStatus: active\n${spineLine(memo)}\n${spineLine(flywheel)}\nPhase: now\n\n## Issue Ledger\n`;
const EPIC48 =
  "# EPIC-948: Review inbox\n\nRoot spine: [root](root.md)\nIntegration policy: main-direct\n\n## Current State\nStatus: active\n\n## Decisions\n\nOne line per decision.\n\n| Date | Outcome | Decision / Attempt | Durable Summary | Evidence | Revisit When |\n|---|---|---|---|---|---|\n| 2026-11-10 | accepted | an older one | x | y | z |\n\n## Operating Learnings\n";

describe("the file change", () => {
  it("an edit rewrites the line to his words, his line now (changed), quoting him", () => {
    const r = applyChange(FILE, { how: "edit", name: "data-product flywheel", to: { name: "Data-product flywheel", sentence: "By 15 December, two data products pay.", target: "2026-12-15", why: "You moved it." }, words: "Move it to 15 December, two is enough.", note: "vn_ab12cd34", by: "Sam", at: "2026-11-10T21:00:00Z" });
    if ("skip" in r) throw new Error(r.skip);
    const lines = parseRedLines(r.text, "home_repo");
    expect(lines.map((l) => l.name)).toEqual(["Memo's first tester", "Data-product flywheel"]);
    expect(lines[1]).toMatchObject({ sentence: "By 15 December, two data products pay.", target: "2026-12-15", state: "changed", words: "Move it to 15 December, two is enough.", source: "vn_ab12cd34", said: "2026-11-10" });
    expect(JSON.parse(r.text).redLines[1]).toMatchObject({ changedBy: "Sam", changedAt: "2026-11-10T21:00:00Z", ask: "E948-A8" });
    // the items stay: his words change the line, not what is on it
    expect(lines[1].items.map((i) => i.ref)).toEqual(["EPIC-905-A1"]);
  });
  it("a day he drops is gone", () => {
    const r = applyChange(FILE, { how: "edit", name: "Data-product flywheel", to: { sentence: "Two data products pay." }, words: "no deadline", by: "Sam", at: "2026-11-10T21:00:00Z" });
    if ("skip" in r) throw new Error(r.skip);
    expect(JSON.parse(r.text).redLines[1].target).toBeUndefined();
  });
  it("a delete moves the line to removedRedLines with who, when and its place; undo puts it back there", () => {
    const d = applyChange(FILE, { how: "delete", name: "Memo's first tester", by: "Sam", at: "2026-11-10T21:01:00Z" });
    if ("skip" in d) throw new Error(d.skip);
    const f = JSON.parse(d.text);
    expect(f.redLines.map((l: { name: string }) => l.name)).toEqual(["Data-product flywheel"]);
    expect(f.removedRedLines[0]).toMatchObject({ name: "Memo's first tester", removedBy: "Sam", removedAt: "2026-11-10T21:01:00Z", place: 0 });
    const u = applyChange(d.text, { how: "undo", name: "Memo's first tester", by: "Sam", at: "2026-11-10T21:01:20Z" });
    if ("skip" in u) throw new Error(u.skip);
    const g = JSON.parse(u.text);
    expect(g.redLines.map((l: { name: string }) => l.name)).toEqual(["Memo's first tester", "Data-product flywheel"]);
    expect(g.removedRedLines).toBeUndefined();
    expect(g.redLines[0]).toMatchObject({ state: "agreed", restoredBy: "Sam" });
  });
  it("an unknown line or a second undo is skipped", () => {
    expect(applyChange(FILE, { how: "delete", name: "nope", by: "Sam", at: "x" })).toHaveProperty("skip");
    expect(applyChange(FILE, { how: "undo", name: "Memo's first tester", by: "Sam", at: "x" })).toHaveProperty("skip");
  });
  it("the root spine's Red line lines follow the file; none left takes them all out", () => {
    const d = applyChange(FILE, { how: "delete", name: "Memo's first tester", by: "Sam", at: "2026-11-10T21:01:00Z" });
    if ("skip" in d) throw new Error(d.skip);
    const one = withSpineLines(ROOT, d.text);
    expect(one.match(/^Red line:.*$/gm)).toEqual([spineLine(flywheel)]);
    expect(one).toContain("Status: active\nRed line: Data-product flywheel");
    const d2 = applyChange(d.text, { how: "delete", name: "Data-product flywheel", by: "Sam", at: "2026-11-10T21:02:00Z" });
    if ("skip" in d2) throw new Error(d2.skip);
    const none = withSpineLines(one, d2.text);
    expect(none).not.toContain("Red line:");
    expect(none).toContain("Status: active\nPhase: now");
  });
  it("the Decisions row goes after the table's last row", () => {
    const out = withDecision(EPIC48, "| new |");
    expect(out).toContain("| 2026-11-10 | accepted | an older one | x | y | z |\n| new |\n\n## Operating Learnings");
  });
});

describe("the routes write the repo", () => {
  const setup = (reword: Reworder) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s39-"));
    const co = tempCheckout(root, "home_repo", { "docs/priorities.json": FILE, "docs/spines/root.md": ROOT, "docs/spines/epic-48-review-inbox.md": EPIC48 });
    cleanup = () => {
      co.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    };
    const api = new Hono();
    mountRedLineEdit(api, { writer: createSpineWriter(), reposRoot: root, reword, who: () => "Sam", now: () => new Date("2026-11-10T21:05:00Z") });
    const post = (p: string, body: unknown) => api.request(`/red-line/${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { co, post };
  };

  it("edit: his words reworded into the line, one commit with the file, the root line and a Decisions row quoting him", async () => {
    const seen: string[] = [];
    const { co, post } = setup(async (line, words, today) => {
      seen.push(`${line.name}|${words}|${today}`);
      return { name: line.name, sentence: "By 15 December, two data products pay.", target: "2026-12-15", why: "You moved the day." };
    });
    const dry = await post("edit", { name: "Data-product flywheel", words: "Move it to 15 December.", dry: true });
    expect(((await dry.json()) as { dry: boolean; line: { target: string } }).line.target).toBe("2026-12-15");
    expect(co.log()).toHaveLength(1);
    seen.length = 0;
    const r = await post("edit", { name: "Data-product flywheel", words: "Move it to 15 December.", note: "vn_ab12cd34" });
    expect(r.status).toBe(200);
    expect(seen).toEqual(["Data-product flywheel|Move it to 15 December.|2026-11-10"]);
    const f = JSON.parse(co.onMain("docs/priorities.json"));
    expect(f.redLines[1]).toMatchObject({ sentence: "By 15 December, two data products pay.", target: "2026-12-15", state: "changed", words: "Move it to 15 December.", source: "vn_ab12cd34", changedBy: "Sam" });
    expect(co.onMain("docs/spines/root.md")).toContain("Red line: Data-product flywheel: By 15 December, two data products pay. (changed, E948-A8, since 2026-11-10, by 2026-12-15;");
    const dec = co.onMain("docs/spines/epic-48-review-inbox.md");
    expect(dec).toContain("| 2026-11-10 | decided | Sam changed the red line “Data-product flywheel” on Team home (voice note vn_ab12cd34): “Move it to 15 December.” |");
    expect(co.log()[0]).toBe("Sam changed the red line “Data-product flywheel” (Team home)");
    expect(co.log()).toHaveLength(2);
  });

  it("delete then undo: two commits, the line back in its place", async () => {
    const { co, post } = setup(async () => {
      throw new Error("not called");
    });
    expect((await post("delete", { name: "Memo's first tester" })).status).toBe(200);
    let f = JSON.parse(co.onMain("docs/priorities.json"));
    expect(f.redLines.map((l: { name: string }) => l.name)).toEqual(["Data-product flywheel"]);
    expect(f.removedRedLines[0]).toMatchObject({ removedBy: "Sam", removedAt: "2026-11-10T21:05:00Z" });
    expect(co.onMain("docs/spines/root.md")).not.toContain("Red line: Memo's first tester");
    expect(co.onMain("docs/spines/epic-48-review-inbox.md")).toContain("Sam deleted the red line “Memo's first tester” on Team home at 2026-11-10T21:05:00Z");
    expect((await post("undo", { name: "Memo's first tester" })).status).toBe(200);
    f = JSON.parse(co.onMain("docs/priorities.json"));
    expect(f.redLines.map((l: { name: string }) => l.name)).toEqual(["Memo's first tester", "Data-product flywheel"]);
    expect(co.onMain("docs/spines/root.md")).toContain(spineLine(memo));
    expect(co.log()).toHaveLength(3);
  });

  it("bad input and a failed rewording save nothing", async () => {
    const { co, post } = setup(async () => {
      throw new Error("Claude did not answer (529)");
    });
    expect((await post("edit", { name: "Data-product flywheel", words: "" })).status).toBe(400);
    expect((await post("edit", { name: "", words: "x" })).status).toBe(400);
    expect((await post("edit", { name: "nope", words: "x" })).status).toBe(404);
    const r = await post("edit", { name: "Data-product flywheel", words: "Move it." });
    expect(r.status).toBe(502);
    expect(((await r.json()) as { error: { message: string } }).error.message).toContain("the line was not changed");
    expect((await post("delete", { name: "nope" })).status).toBe(409);
    expect((await post("undo", { name: "Memo's first tester" })).status).toBe(409);
    expect(co.log()).toHaveLength(1);
  });
});
