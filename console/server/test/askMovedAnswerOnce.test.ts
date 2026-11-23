import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { makeRepo, spineText } from "./reviewFixture.js";

/**
 * E948-S182: E906-S228 moved asks E906-A12, A13 and A15 from EPIC-906 to other epics after he had answered them from the
 * console. His stored answer named the old path, so the console brought it back as a `done` card next to the moved
 * line's card: each showed twice. A stored answer is matched to its ask by repo and code, never by file.
 */
const SPINE = "docs/spines/root.md";
const OLD = "docs/spines/m906-team.md";
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.reverse()) f();
  cleanup = [];
});

function world(lines: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s182-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  makeRepo(dir, "home_repo", { [SPINE]: spineText("PLAN-0", "home_repo", [], ["Waiting on: none", "", "## Waiting on", "", ...lines, ""]) });
  const app = createApp(db, { read: { reposRoot: dir, seatsFile: path.join(dir, "seats.json"), listThreads: async () => [] } });
  const m = createStore(db).createMilestone({ title: "home_repo", repo: "home_repo", path: SPINE, owner: "Sam", paused: false });
  // his answer, given on the old path's card a few minutes ago and written there
  const at = new Date(Date.now() - 10 * 60_000).toISOString();
  db.prepare(
    `INSERT INTO jordi_responses (id, item_id, milestone_id, item, kind, text, delivery, created_at, spine_status, spine_path, spine_at) VALUES (?, ?, ?, ?, 'feedback', ?, 'sent', ?, 'written', ?, ?)`,
  ).run("jr_old", "wj_oldpath", m.id, JSON.stringify({ id: "wj_oldpath", source: "ask", ask: "approve", code: "E906-A12", repo: "home_repo", path: OLD, question: "You approve the kernel plan?", title: "Kernel plan", state: "open", milestoneId: m.id, contextLinks: [] }), "make it shorter", at, OLD, at);
  const req = async (url: string) => {
    const res = await app.request(url, {}, { incoming: { socket: { remoteAddress: "127.0.0.1" } } });
    return (await res.json()) as any[];
  };
  cleanup.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { m, items: () => req(`/api/waiting-on-owner?milestoneId=${m.id}&includeSuperseded=true`) };
}

describe("E948-S182 an answered ask that moved to another epic shows once", () => {
  it("answered at its new path: one card, never the old path's stored copy as a second", async () => {
    const w = world([`- [feedback E906-A12 2026-11-22 @Sam] You approve the kernel plan? — answer: make it shorter`]);
    const cards = (await w.items()).filter((i) => i.code === "E906-A12");
    expect(cards.map((c) => c.path), JSON.stringify(cards)).toEqual([SPINE]);
  });
  it("open again at its new path (round 2): the open card only", async () => {
    const w = world([`- [ask E906-A12: approve @Sam since 2026-11-01] You approve the kernel plan, round 2? — recommend: yes`]);
    const cards = (await w.items()).filter((i) => i.code === "E906-A12");
    expect(cards.map((c) => c.path), JSON.stringify(cards)).toEqual([SPINE]);
  });
});
