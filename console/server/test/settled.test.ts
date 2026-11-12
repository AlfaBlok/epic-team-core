import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db.js";
import { createStore } from "../src/store.js";
import { tempApp } from "./helpers.js";

let t: ReturnType<typeof tempApp>;
afterEach(() => t?.cleanup());

/** the route settles only a marked outcome (pureEdits.test.ts); these tests set the flag directly. */
const settle = (id: string) => createStore(t.db).setSettled(id, true);

const mk = async (title: string, over: Record<string, unknown> = {}) =>
  (await t.call("POST", "/api/milestones", { title, repo: "r", path: "docs/none.md", ...over })).json;

describe("M2-21 settled flag", () => {
  it("migration is additive: existing rows are not settled", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-settled-"));
    const file = path.join(dir, "old.db");
    const old = new Database(file);
    // Simulate a DB at migration 5 (before settled_at) holding a milestone.
    migrate(old);
    old.exec("ALTER TABLE milestones DROP COLUMN settled_at");
    // and before (migration 6): drop its columns too, so the rewind re-runs it cleanly.
    old.exec("ALTER TABLE runs DROP COLUMN held_on; ALTER TABLE jordi_responses DROP COLUMN wake_status; ALTER TABLE jordi_responses DROP COLUMN wake_run_id; ALTER TABLE jordi_responses DROP COLUMN wake_reason; ALTER TABLE milestones DROP COLUMN title_set_at; ALTER TABLE runs DROP COLUMN next_check_at; ALTER TABLE runs DROP COLUMN monitor_until; ALTER TABLE runs DROP COLUMN reported_outcome; ALTER TABLE personas DROP COLUMN skip_unchanged; ALTER TABLE runs DROP COLUMN usage; ALTER TABLE runs DROP COLUMN usage_checked_at; ALTER TABLE runs DROP COLUMN usage_note; ALTER TABLE runs DROP COLUMN ask_fingerprint; ALTER TABLE jordi_responses DROP COLUMN replaces_id; ALTER TABLE runs DROP COLUMN open_asks; ALTER TABLE personas DROP COLUMN fresh_thread_each_wake; ALTER TABLE runs DROP COLUMN checks; ALTER TABLE runs DROP COLUMN instructions_by; DROP INDEX runs_thread; DROP TABLE t3_environments; ALTER TABLE runs DROP COLUMN environment_id; ALTER TABLE runs DROP COLUMN instructions; ALTER TABLE runs DROP COLUMN retry_at; ALTER TABLE assignments DROP COLUMN retry_at; ALTER TABLE assignments DROP COLUMN retry_run_id; ALTER TABLE personas DROP COLUMN host; ALTER TABLE runs DROP COLUMN kind; ALTER TABLE runs DROP COLUMN persona_id; ALTER TABLE assignments DROP COLUMN write_scope; ALTER TABLE assignments DROP COLUMN write_enabled; ALTER TABLE needs_jordi DROP COLUMN superseded_by; ALTER TABLE needs_jordi DROP COLUMN superseded_at;");
    old.pragma("user_version = 5");
    old.prepare("INSERT INTO milestones (id, title, repo, path, owner, paused, created_at) VALUES ('ms_old','Old','r','p','',0,'2026-01-01T00:00:00.000Z')").run();
    migrate(old);
    expect(old.prepare("SELECT settled_at FROM milestones WHERE id='ms_old'").get()).toEqual({ settled_at: null });
    old.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("settle is refused until the outcome is marked (T13-S2); unsettle clears settledAt; 404 on unknown ids", async () => {
    t = tempApp();
    const m = await mk("A");
    expect(m.settledAt).toBeUndefined();
    const refused = await t.call("POST", `/api/milestones/${m.id}/settle`);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatchObject({ code: "not_accomplished", details: { outcome: "not_yet" } });
    expect(refused.json.error.message).toMatch(/^not accomplished yet/);
    settle(m.id);
    const s1 = (await t.call("GET", `/api/milestones/${m.id}`)).json;
    expect(s1.settledAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    // already settled: the route is idempotent (no outcome check)
    const s2 = await t.call("POST", `/api/milestones/${m.id}/settle`);
    expect(s2.status).toBe(200);
    expect(s2.json.settledAt).toBe(s1.settledAt);
    const u = await t.call("POST", `/api/milestones/${m.id}/unsettle`);
    expect(u.json.settledAt).toBeUndefined();
    expect((await t.call("POST", "/api/milestones/nope/settle")).status).toBe(404);
    expect((await t.call("POST", "/api/milestones/nope/unsettle")).status).toBe(404);
  });

  it("lists hide settled by default; includeSettled shows them; direct GET still works", async () => {
    t = tempApp();
    const a = await mk("A");
    const b = await mk("B");
    settle(b.id);
    const ids = (r: { json: { id: string }[] }) => r.json.map((x) => x.id);
    expect(ids(await t.call("GET", "/api/milestones"))).toEqual([a.id]);
    expect(ids(await t.call("GET", "/api/milestones?includeSettled=false"))).toEqual([a.id]);
    const all = await t.call("GET", "/api/milestones?includeSettled=true");
    expect(ids(all)).toEqual([a.id, b.id]);
    expect(all.json.find((x: any) => x.id === b.id).settledAt).toBeTruthy();
    expect(ids(await t.call("GET", "/api/milestones?includeSettled=1"))).toEqual([a.id, b.id]);
    const one = await t.call("GET", `/api/milestones/${b.id}`);
    expect(one.status).toBe(200);
    expect(one.json.settledAt).toBeTruthy();
  });

  it("settling never changes the derived status or verdict, and PATCH cannot set it", async () => {
    t = tempApp();
    const m = await mk("A");
    const before = (await t.call("GET", `/api/milestones/${m.id}`)).json;
    settle(m.id);
    const after = (await t.call("GET", `/api/milestones/${m.id}`)).json;
    const { settledAt, ...rest } = after;
    expect(settledAt).toBeTruthy();
    expect(rest).toEqual(before);
    expect(after.status).toBe(before.status);
    expect(after.verdict).toEqual(before.verdict);
    expect((await t.call("PATCH", `/api/milestones/${m.id}`, { settledAt: null })).status).toBe(400);
  });

  it("waiting-on-owner hides a settled milestone's items globally, not when scoped or includeSettled", async () => {
    // asks come from the spines (no Needs the owner rows): one coded ask in each milestone's spine.
    const spine = (n: string) => `# EPIC-${n}: ${n}\n\n## Current State\n\nStatus: active\nWaiting on: Sam: E${n}-A1\n\n## Waiting on\n\n- [ask E${n}-A1: decide @Sam since 2026-11-01] q ${n}? — recommend: yes\n`;
    t = tempApp({ repos: { r: { "docs/a.md": spine("1"), "docs/b.md": spine("2") } } });
    const a = await mk("A", { path: "docs/a.md" });
    const b = await mk("B", { path: "docs/b.md" });
    const titles = (r: { json: { milestoneId: string }[] }) => r.json.map((x) => x.milestoneId).sort();
    expect(titles(await t.call("GET", "/api/waiting-on-owner"))).toEqual([a.id, b.id].sort());
    settle(b.id);
    expect(titles(await t.call("GET", "/api/waiting-on-owner"))).toEqual([a.id]);
    expect(titles(await t.call("GET", "/api/waiting-on-owner?includeSettled=true"))).toEqual([a.id, b.id].sort());
    expect(titles(await t.call("GET", `/api/waiting-on-owner?milestoneId=${b.id}`))).toEqual([b.id]);
  });
});
