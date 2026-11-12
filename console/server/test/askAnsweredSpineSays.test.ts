import { describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { answeredInSpine, latestPerItem } from "../src/inbox/answered.js";
import { KEY_PROVIDED_ANSWER } from "../src/inbox/routes.js";
import type { WaitingItem } from "../src/inbox/waiting.js";
import { respondedIds } from "../src/status/routes.js";
import { milestoneStatus, paintTree } from "../src/status/compute.js";

//'s key paste failed (jr_7901041c: delivery failed, spine_status failed, "key not stored
// … the ask is open again") but the status kept it answered (any jordi_responses row counted), so Waiting on you was 0.
// "answered" is read from the spine only; jordi_responses is a delivery log and never counts.
type R = { id: string; item?: string; at: string; delivery: string; spine?: string | null; replaces?: string; text?: string; ms?: string | null };
const add = (db: DB, r: R) =>
  db
    .prepare(`INSERT INTO jordi_responses (id, item_id, milestone_id, item, kind, text, delivery, delivery_error, created_at, spine_status, spine_reason, replaces_id) VALUES (?, ?, ?, ?, 'answer', ?, ?, ?, ?, ?, ?, ?)`)
    .run(r.id, r.item ?? "wj_a9", r.ms ?? null, JSON.stringify({ source: "ask" }), r.text ?? "yes", r.delivery, r.delivery === "failed" ? "key not stored: no Deployer app" : null, r.at, r.spine ?? null, r.spine && r.spine !== "written" ? "key not stored: no Deployer app" : null, r.replaces ?? null);

const a9: WaitingItem = { id: "wj_a9", milestoneId: "ms_z", source: "ask", ask: "provide", code: "PLAN-0-A9", question: "Paste the Composio key", title: "Composio key", state: "open", path: "docs/spines/epic-900.md", line: 40, contextLinks: [] } as unknown as WaitingItem;
const status = (waiting: WaitingItem[]) =>
  milestoneStatus({ milestone: { id: "ms_z", paused: false }, waiting, responded: respondedIds(waiting), runs: [], assignments: [], now: Date.parse("2026-10-25T20:00:00Z") });

describe("T6-S30 / T62-S4: an ask is answered only when the spine says so", () => {
  it("a failed answer in the log: the ask is open (Waiting on you 1, needs_you, no 'already answered' note)", () => {
    const db = openDb(":memory:");
    add(db, { id: "jr_1", at: "2026-10-25T05:28:52Z", delivery: "failed", spine: "failed", text: KEY_PROVIDED_ANSWER });
    const st = status([a9]);
    expect(st.needsYou).toBe(1);
    expect(st.flow.word).toBe("needs_you");
    expect(st.items).toMatchObject([{ id: "wj_a9", kind: "ask", state: "open", code: "PLAN-0-A9" }]);
    const node = { key: "root", kind: "spine", status: "active; waiting on PLAN-0-A9", color: "yellow", flags: [], children: [], path: "docs/spines/epic-900.md" };
    const painted = paintTree({ root: node } as never, st.items);
    expect(painted.root.notes ?? []).not.toContainEqual(expect.stringContaining("already answered"));
    expect(painted.root.color).toBe("red");
  });

  it("sent, queued, skipped or pending answers in the log change nothing: the open spine ask stays open", () => {
    const db = openDb(":memory:");
    add(db, { id: "jr_1", item: "wj_a9", at: "2026-10-25T05:00:00Z", delivery: "sent", spine: "written" });
    add(db, { id: "jr_2", item: "b", at: "2026-10-25T05:00:00Z", delivery: "queued", spine: "skipped" });
    // the rule takes the spine's items only: the log is not even an input
    expect(answeredInSpine([a9]).size).toBe(0);
    expect(status([a9]).needsYou).toBe(1);
  });

  it("the spine shows the [answered] line → answered (not counted), whoever wrote it", () => {
    const answered = { ...a9, id: "wj_a9_done", state: "answered", answer: "pasted" } as WaitingItem;
    expect(status([answered]).needsYou).toBe(0);
    expect(status([answered]).items[0]).toMatchObject({ id: "wj_a9_done", state: "answered" });
  });

  it("a free-text item is answered when the same spine has an [answered] line for its question", () => {
    const free = { ...a9, id: "wj_free", source: "heuristic", signal: "waiting_on", code: undefined, question: "Pick a name" } as unknown as WaitingItem;
    const line = { ...a9, id: "wj_line", code: undefined, question: "Pick a name", state: "answered", answer: "memo" } as unknown as WaitingItem;
    expect([...answeredInSpine([free, line])]).toEqual(["wj_free"]);
    expect([...answeredInSpine([free])]).toEqual([]);
    expect([...answeredInSpine([free, { ...line, path: "docs/other.md" } as WaitingItem])]).toEqual([]);
  });

  it("the delivery log keeps the latest response per item; a change (replaces_id) wins over the answer it replaced", () => {
    const db = openDb(":memory:");
    add(db, { id: "jr_new", at: "2026-10-25T05:00:00Z", delivery: "failed", replaces: "jr_old" });
    add(db, { id: "jr_old", at: "2026-10-25T05:00:00Z", delivery: "sent" });
    const rows = db.prepare("SELECT id, item_id, replaces_id, delivery, spine_status FROM jordi_responses ORDER BY created_at DESC, rowid DESC").all() as never[];
    expect(latestPerItem(rows).get("wj_a9")).toMatchObject({ id: "jr_new" });
  });
});
