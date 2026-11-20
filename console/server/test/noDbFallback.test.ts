import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { answeredInSpine } from "../src/inbox/answered.js";
import type { WaitingItem } from "../src/inbox/waiting.js";
import { SRC, srcFiles, srcPath, srcRel } from "./helpers/fullDb.js";

/**
 * no DB fallback for a decision. A button whose repo write fails or is skipped records
 * nothing as done in the DB: the card shows the error and Retry, and the ask stays counted until the spine shows the
 * answer. The paths that break it today (docs/status/e62-s1-db-audit.md) are owned by their fix rows; their contract
 * is written here so each row turns its test on (`it.fails` → `it`, `it.todo` → a test) when it lands.
 */
let db: DB;
let n = 0;
const answer = (item: string, o: { delivery: string; spine?: string | null; job?: string | null }) =>
  db
    .prepare("INSERT INTO jordi_responses (id, item_id, kind, text, delivery, created_at, spine_status, job_state) VALUES (?, ?, 'answer', 'yes', ?, ?, ?, ?)")
    .run(`jr_${++n}`, item, o.delivery, new Date(Date.UTC(2026, 10, 2, 0, n)).toISOString(), o.spine ?? null, o.job ?? null);

beforeEach(() => {
  db = openDb(":memory:");
});
afterEach(() => db.close());

/** the spine's items for `ids`: each an open ask (the spine still shows it open), `written` ones answered. */
const spine = (open: string[], answered: string[] = []): WaitingItem[] =>
  [...open.map((id) => ({ id, state: "open" })), ...answered.map((id) => ({ id: `${id}:line`, state: "answered" }))].map(
    (x) => ({ ...x, source: "ask", question: x.id.replace(/:line$/, ""), path: "docs/x.md", milestoneId: "ms", contextLinks: [] }) as unknown as WaitingItem,
  );

describe("T62-S3 a decision whose spine write did not land is not counted as done", () => {
  it("a failed spine write, or a failed answer job, leaves the ask open", () => {
    answer("ask:a", { delivery: "failed", spine: "failed", job: "done" });
    answer("ask:b", { delivery: "queued", spine: "skipped", job: "failed" });
    answer("ask:c", { delivery: "sent", spine: "written", job: "done" });
    // ask:c's line is answered in the spine; a and b are still open there, whatever their jordi_responses rows say
    const items = spine(["ask:a", "ask:b"], ["ask:c"]);
    expect([...answeredInSpine(items)]).toEqual([]);
    expect(items.filter((i) => i.state === "open").map((i) => i.id)).toEqual(["ask:a", "ask:b"]);
  });

  // turned this on: "answered" is the spine's alone (inbox/answered.ts answeredInSpine takes the spine's items, not
  // console.db), so a skipped write and a still-pending job leave the ask open.
  it("T62-S4: a skipped or still-pending spine write leaves the ask open; only `written` counts", () => {
    answer("ask:skipped", { delivery: "queued", spine: "skipped", job: "done" });
    answer("ask:pending", { delivery: "queued", spine: null, job: "pending" });
    answer("ask:written", { delivery: "sent", spine: "written", job: "done" });
    const items = spine(["ask:skipped", "ask:pending"], ["ask:written"]);
    expect(items.filter((i) => i.state === "open" && !answeredInSpine(items).has(i.id)).map((i) => i.id).sort()).toEqual(["ask:pending", "ask:skipped"]);
  });

  it("T62-S4: an answer is read from the spine only: no DB copy of an unwritten answer reaches a wake prompt, a count or the read model", () => {
    expect(fs.existsSync(path.join(SRC, "inbox/unwritten.ts"))).toBe(false);
    const reads = (f: string, table: string) => new RegExp(`\\b(FROM|JOIN)\\s+${table}\\b`, "i").test(fs.readFileSync(f, "utf8"));
    const bad = srcFiles()
      // the wake prompt (app.ts treeTodo, cycle/prompts.ts), the counts (status/), the cache (readModel/) and the inbox's
      // answered rule; change detectors elsewhere (skip-unchanged, the Unblocker memo) only notice that an answer came in
      .filter((f) => /\/(status|readModel)\//.test(f) || /cycle\/prompts\.ts$|inbox\/(waiting|answered|asker)\.ts$/.test(f) || f.endsWith("/app.ts"))
      .filter((f) => reads(f, "jordi_responses"));
    expect(bad.map((f) => srcRel(f))).toEqual([]);
  });

  it("T62-S4: an ask raised through POST /needs-owner lives in the spine: the inbox and the read model never read needs_jordi", () => {
    const bad = srcFiles()
      .filter((f) => /\/(status|readModel)\//.test(f) || /inbox\/(waiting|answered|asker|routes)\.ts$/.test(f))
      .filter((f) => /listNeedsJordi|getNeedsJordi|\b(FROM|JOIN)\s+needs_jordi\b/i.test(fs.readFileSync(f, "utf8")));
    // asker.ts keeps one read for a response stored before (item.source needs_jordi): its run, for the wake
    expect(bad.map((f) => srcRel(f))).toEqual(["inbox/asker.ts"]);
    // the answer path itself (failed write keeps the ask open, Retry writes it) is pureCodeLineWaiting.test.ts
  });
  // the Unblocker rubric, a monitoring report and a placement's state live in the repo. The write paths
  // (a refused write answers 409 and changes nothing, a rebuilt console reads the same) are unblockerRubricLivesRepo.test.ts; these hold the line.
  it("T62-S8: no rubric table, no status read of a run's monitoring fields, no stored placement state", () => {
    const text = (rel: string) => fs.readFileSync(srcPath(rel), "utf8");
    const code = (rel: string) => text(rel).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    // only the one-time carry reads the old rubric table (then drops it)
    expect(srcFiles().filter((f) => /\brubric_settings\b/.test(fs.readFileSync(f, "utf8"))).map((f) => srcRel(f))).toEqual(["repoState/carryE62s8.ts"]);
    // status takes monitoring from the spine's Monitoring line only
    // (every date read there is a Monitoring item's `m.`, never a run's or an assignment's)
    expect([...code("status/compute.ts").matchAll(/(\w+)\.(nextCheckAt|until|retryAt)\b/g)].map((x) => x[1]).filter((v) => v !== "m")).toEqual([]);
    expect(code("status/compute.ts")).not.toMatch(/outcome === "monitoring"/);
    // placements: the state is read from the spine; no column holds it
    expect(code("desk/placements.ts")).not.toMatch(/\b(SET state|closed_at)\b/);
  });

  // turned this on; the behaviour (a refused or failed write leaves the row, console.db and the list unchanged) is
  // test/rowsTs.test.ts. Here: the review code has no DB store left to fall back to.
  it("T62-S2: Approve / Relaunch / Snooze on a review card write the ledger row only; review code writes nothing to console.db (audit V1)", () => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables.filter((t) => /^review_/.test(t))).toEqual([]);
    const bad = srcFiles()
      .filter((f) => /\/review\//.test(f))
      // review_live is a cache of the link checks, review_inbox_since a cache of git's answer for each card's inbox
      // time and review_agent_wake the dedupe of the gate's wakes (ops, not a decision): their writes are
      // the only ones allowed
      .filter((f) => /\b(INSERT\s+(OR\s+\w+\s+)?INTO\s+(?!review_live\b|review_inbox_since\b|review_agent_wake\b)\w+|UPDATE\s+(?!review_live\b|review_inbox_since\b|review_agent_wake\b)\w+\s+SET|DELETE\s+FROM\s+(?!review_live\b|review_inbox_since\b|review_agent_wake\b)\w+)/i.test(fs.readFileSync(f, "utf8")));
    expect(bad.map((f) => srcRel(f))).toEqual([]);
  });
  // turned this on; the behaviour (each change on main first, a failed write changes nothing, a lost DB rebuilt from
  // the file) is test/createRenameOwnerPause.test.ts. Here: no in-memory retry is left, and the milestone routes write through the record.
  it("T62-S5: Settle / Pause / Rename and a big-root reorder write the team repo first; a failed write records nothing, no in-memory retry (audit V2, V3)", () => {
    const code = (rel: string) => fs.readFileSync(srcPath(rel), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(code("team/teamState.ts")).not.toMatch(/bigRootsPending/);
    const app = code("app.ts");
    expect(app).not.toMatch(/store\.(setSettled|createMilestone|deleteMilestone)\(/);
    expect(app).toMatch(/recordFirst\(\(\) => recordedMilestones\(\)\.setSettled/);
    expect(code("social/campaigns.ts")).not.toMatch(/\bts\.(setSettled|createMilestone)\(/);
  });
  // turned this on; the behaviour is test/assignmentsAccessTeamRepo.test.ts. Here: the grant goes through the spine and the record.
  it("T62-S7: a write grant from Approve (grantWrite) is a Standing approvals line written first; a failed write grants nothing (audit V5)", () => {
    const src = fs.readFileSync(path.join(SRC, "inbox/routes.ts"), "utf8");
    const at = src.indexOf("the grant is a `## Standing approvals` line in the asker's spine first");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, src.indexOf("const raced = byKey()", at));
    expect(block.indexOf("addGrant(")).toBeGreaterThan(-1);
    expect(block.indexOf("addGrant(")).toBeLessThan(block.indexOf("updateAssignment("));
    expect(src).not.toMatch(/\bstore\.updateAssignment\(grantAssignmentId/);
  });
});
