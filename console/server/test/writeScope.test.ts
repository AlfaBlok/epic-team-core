import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { migrate } from "../src/db.js";
import { DEFAULT_WRITE_SCOPE, effectiveWrite } from "../src/store.js";
import { buildWakePrompt, NO_SELF_GREEN } from "../src/wakePrompt.js";
import { approvalMessage, wakeProtocol } from "../src/cycle/prompts.js";
import { tempApp } from "./helpers.js";
// this file checks the text with our own owner's name (src/identity.ts; the suite's owner is neutral, hostedSetup.ts)

const persona = { name: "Delivery Manager", remit: "Run E4.", skills: [], mayWrite: false };
const milestone = { title: "E4", repo: "Acme/poly-maker", path: "docs/E4.md", owner: "" };
const SCOPE = "git only: branches one-logger*, spine main-direct; no prod/root";

describe("M2-20 migration", () => {
  it("adds write_enabled (0) and write_scope ('') to existing assignments without touching other rows", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    // A pre- DB (user_version 6): migrate fully, then drop the two columns and rewind the version.
    migrate(db);
    expect(db.pragma("user_version", { simple: true })).toBe(24);
    db.exec("ALTER TABLE runs DROP COLUMN held_on; ALTER TABLE jordi_responses DROP COLUMN wake_status; ALTER TABLE jordi_responses DROP COLUMN wake_run_id; ALTER TABLE jordi_responses DROP COLUMN wake_reason; ALTER TABLE milestones DROP COLUMN title_set_at; ALTER TABLE runs DROP COLUMN next_check_at; ALTER TABLE runs DROP COLUMN monitor_until; ALTER TABLE runs DROP COLUMN reported_outcome; ALTER TABLE personas DROP COLUMN skip_unchanged; ALTER TABLE runs DROP COLUMN usage; ALTER TABLE runs DROP COLUMN usage_checked_at; ALTER TABLE runs DROP COLUMN usage_note; ALTER TABLE runs DROP COLUMN ask_fingerprint; ALTER TABLE jordi_responses DROP COLUMN replaces_id; ALTER TABLE runs DROP COLUMN open_asks; ALTER TABLE personas DROP COLUMN fresh_thread_each_wake; ALTER TABLE runs DROP COLUMN checks; ALTER TABLE runs DROP COLUMN instructions_by; DROP INDEX runs_thread; DROP TABLE t3_environments; ALTER TABLE runs DROP COLUMN environment_id; ALTER TABLE runs DROP COLUMN instructions; ALTER TABLE runs DROP COLUMN retry_at; ALTER TABLE assignments DROP COLUMN retry_at; ALTER TABLE assignments DROP COLUMN retry_run_id; ALTER TABLE personas DROP COLUMN host; ALTER TABLE runs DROP COLUMN kind; ALTER TABLE runs DROP COLUMN persona_id; ALTER TABLE assignments DROP COLUMN write_scope; ALTER TABLE assignments DROP COLUMN write_enabled; ALTER TABLE needs_jordi DROP COLUMN superseded_by; ALTER TABLE needs_jordi DROP COLUMN superseded_at;");
    db.pragma("user_version = 6");
    db.exec(`INSERT INTO milestones (id, title, repo, path, created_at) VALUES ('ms_1', 'E4', 'r', 'p', 'now');
             INSERT INTO personas (id, name, remit, may_write, created_at) VALUES ('pe_1', 'DM', 'x', 1, 'now');
             INSERT INTO assignments (id, milestone_id, persona_id, cadence, enabled, created_at) VALUES ('as_1', 'ms_1', 'pe_1', '{}', 1, 'now');`);
    migrate(db);
    expect(db.pragma("user_version", { simple: true })).toBe(24);
    expect(db.prepare("SELECT enabled, write_enabled, write_scope FROM assignments WHERE id = 'as_1'").get()).toEqual({ enabled: 1, write_enabled: 0, write_scope: "" });
    expect(db.prepare("SELECT may_write FROM personas WHERE id = 'pe_1'").get()).toEqual({ may_write: 1 });
  });
});

describe("M2-36 effective write: the assignment is the gate", () => {
  it("only the assignment's write_enabled + scope open writes; there is no persona argument any more", () => {
    expect(effectiveWrite()).toEqual({ mayWrite: false });
    expect(effectiveWrite({ writeEnabled: false, writeScope: SCOPE })).toEqual({ mayWrite: false });
    expect(effectiveWrite({ writeEnabled: true, writeScope: SCOPE })).toEqual({ mayWrite: true, scope: SCOPE });
    expect(effectiveWrite({ writeEnabled: true, writeScope: " " }).scope).toMatch(/no scope given/);
  });
});

describe("M2-20 wake prompt", () => {
  it("a write-enabled assignment may write only within its scope; the no-self-green rule is always there", () => {
    const scoped = buildWakePrompt(persona, milestone, { writeEnabled: true, writeScope: SCOPE });
    expect(scoped).toContain(
      `You may write, ONLY within this scope: ${SCOPE}; anything outside it (prod, root, deploys, other repos) still goes to Needs Sam.`,
    );
    expect(scoped).not.toContain("Read-only");
    for (const p of [
      scoped,
      buildWakePrompt(persona, milestone),
      buildWakePrompt(persona, milestone, { writeEnabled: false, writeScope: SCOPE }),
      buildWakePrompt({ ...persona, mayWrite: true }, milestone),
    ])
      expect(p).toContain("Never mark your own node done or green; propose done with evidence for the Delivery manager / Sam to verify.");
    expect(NO_SELF_GREEN).toMatch(/^Never mark your own node done or green/);
    expect(buildWakePrompt(persona, milestone, { writeEnabled: false, writeScope: SCOPE })).toContain("Read-only");
  });

  it("M2-36: a may_write persona does NOT write on an assignment with write off (prompt and protocol)", () => {
    const rw = { ...persona, mayWrite: true };
    const off = buildWakePrompt(rw, milestone, { writeEnabled: false, writeScope: "" });
    expect(off).toContain("Read-only");
    expect(off).not.toContain("You may make writes");
    expect(buildWakePrompt(rw, milestone)).toContain("Read-only");
    const base = { base: "http://c", run: { id: "run_1" } as any, milestone: { id: "ms_1" } as any };
    expect(wakeProtocol({ ...base, persona: rw as any, assignment: { id: "as_1", writeEnabled: false, writeScope: "" } as any })).toContain("diagnose-only");
    //... and a persona with may_write off writes when its assignment says so.
    expect(buildWakePrompt(persona, milestone, { writeEnabled: true, writeScope: SCOPE })).toContain(`ONLY within this scope: ${SCOPE}`);
  });

  it("the console protocol's Needs Sam rule follows the effective write", () => {
    const base = { base: "http://c", run: { id: "run_1" } as any, milestone: { id: "ms_1" } as any };
    const off = wakeProtocol({ ...base, persona: persona as any, assignment: { id: "as_1", writeEnabled: false, writeScope: "" } as any });
    const on = wakeProtocol({ ...base, persona: persona as any, assignment: { id: "as_1", writeEnabled: true, writeScope: SCOPE } as any });
    expect(off).toContain("diagnose-only");
    expect(on).not.toContain("diagnose-only");
    expect(on).toContain("outside your write scope");
  });

  it("an approval that grants write states the scope", () => {
    const msg = approvalMessage({ approved: true, base: "http://c", needsJordiId: "nj_1", proposedAction: "allow git", question: "write?", grantedScope: SCOPE });
    expect(msg).toContain(`Write access granted for this assignment, ONLY within this scope: ${SCOPE}`);
    expect(approvalMessage({ approved: true, base: "http://c", needsJordiId: "nj_1", proposedAction: "x", question: "y" })).not.toContain("Write access granted");
  });
});

describe("M2-20 assignment write fields over the API", () => {
  it("default off, patchable and revocable", async () => {
    const t = tempApp();
    try {
      const m = (await t.call("POST", "/api/milestones", { title: "E4", repo: "r", path: "p" })).json;
      const p = (await t.call("POST", "/api/personas", { name: "DM", remit: "x" })).json;
      const a = (await t.call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 240 } })).json;
      expect(a).toMatchObject({ writeEnabled: false, writeScope: "" });
      const on = (await t.call("PATCH", `/api/assignments/${a.id}`, { writeEnabled: true, writeScope: SCOPE })).json;
      expect(on).toMatchObject({ writeEnabled: true, writeScope: SCOPE, enabled: false });
      const off = (await t.call("PATCH", `/api/assignments/${a.id}`, { writeEnabled: false })).json;
      expect(off).toMatchObject({ writeEnabled: false, writeScope: SCOPE });
    } finally {
      t.cleanup();
    }
  });
});

describe("M2-19 runs keep their persona after the assignment is deleted", () => {
  it("stamps personaId at insert; the run and its persona survive detach", async () => {
    const t = tempApp();
    try {
      const m = (await t.call("POST", "/api/milestones", { title: "M4", repo: "r", path: "p" })).json;
      const p = (await t.call("POST", "/api/personas", { name: "Browser steward", remit: "x" })).json;
      const a = (await t.call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 } })).json;
      const run = (await t.call("POST", "/api/runs", { assignmentId: a.id, outcome: "idle", summary: "nothing" })).json;
      expect(run.personaId).toBe(p.id);
      expect((await t.call("DELETE", `/api/assignments/${a.id}`)).status).toBe(204);
      const runs = (await t.call("GET", `/api/runs?milestoneId=${m.id}`)).json as any[];
      expect(runs).toMatchObject([{ id: run.id, assignmentId: a.id, milestoneId: m.id, personaId: p.id }]);
    } finally {
      t.cleanup();
    }
  });

  it("migration backfills persona_id from live assignments; orphans stay null", () => {
    const db = new Database(":memory:");
    migrate(db);
    db.exec("ALTER TABLE runs DROP COLUMN held_on; ALTER TABLE jordi_responses DROP COLUMN wake_status; ALTER TABLE jordi_responses DROP COLUMN wake_run_id; ALTER TABLE jordi_responses DROP COLUMN wake_reason; ALTER TABLE milestones DROP COLUMN title_set_at; ALTER TABLE runs DROP COLUMN next_check_at; ALTER TABLE runs DROP COLUMN monitor_until; ALTER TABLE runs DROP COLUMN reported_outcome; ALTER TABLE personas DROP COLUMN skip_unchanged; ALTER TABLE runs DROP COLUMN usage; ALTER TABLE runs DROP COLUMN usage_checked_at; ALTER TABLE runs DROP COLUMN usage_note; ALTER TABLE runs DROP COLUMN ask_fingerprint; ALTER TABLE jordi_responses DROP COLUMN replaces_id; ALTER TABLE runs DROP COLUMN open_asks; ALTER TABLE personas DROP COLUMN fresh_thread_each_wake; ALTER TABLE runs DROP COLUMN checks; ALTER TABLE runs DROP COLUMN instructions_by; DROP INDEX runs_thread; DROP TABLE t3_environments; ALTER TABLE runs DROP COLUMN environment_id; ALTER TABLE runs DROP COLUMN instructions; ALTER TABLE runs DROP COLUMN retry_at; ALTER TABLE assignments DROP COLUMN retry_at; ALTER TABLE assignments DROP COLUMN retry_run_id; ALTER TABLE personas DROP COLUMN host; ALTER TABLE runs DROP COLUMN kind; ALTER TABLE runs DROP COLUMN persona_id; ALTER TABLE assignments DROP COLUMN write_scope; ALTER TABLE assignments DROP COLUMN write_enabled; ALTER TABLE needs_jordi DROP COLUMN superseded_by; ALTER TABLE needs_jordi DROP COLUMN superseded_at;");
    db.pragma("user_version = 6");
    db.exec(`INSERT INTO milestones (id, title, repo, path, created_at) VALUES ('ms_1', 'M4', 'r', 'p', 'now');
             INSERT INTO personas (id, name, remit, created_at) VALUES ('pe_1', 'DM', 'x', 'now');
             INSERT INTO assignments (id, milestone_id, persona_id, cadence, created_at) VALUES ('as_1', 'ms_1', 'pe_1', '{}', 'now');
             INSERT INTO runs (id, assignment_id, milestone_id, started_at, outcome) VALUES ('run_1', 'as_1', 'ms_1', 't', 'idle'), ('run_2', 'as_gone', 'ms_1', 't', 'idle');`);
    migrate(db);
    expect(db.prepare("SELECT id, persona_id FROM runs ORDER BY id").all()).toEqual([
      { id: "run_1", persona_id: "pe_1" },
      { id: "run_2", persona_id: null },
    ]);
  });
});

describe("M2-36 new assignments take the persona's may_write as their default", () => {
  it("may_write persona: new assignment starts write on with the default scope; read-only persona: off; explicit values win; later persona changes do not touch it", async () => {
    const t = tempApp();
    try {
      const m = (await t.call("POST", "/api/milestones", { title: "E4", repo: "r", path: "p" })).json;
      const rw = (await t.call("POST", "/api/personas", { name: "RW", remit: "x", mayWrite: true })).json;
      const ro = (await t.call("POST", "/api/personas", { name: "RO", remit: "x", mayWrite: false })).json;
      const cadence = { type: "interval", everyMinutes: 240 };
      const a1 = (await t.call("POST", "/api/assignments", { milestoneId: m.id, personaId: rw.id, cadence })).json;
      expect(a1).toMatchObject({ writeEnabled: true, writeScope: DEFAULT_WRITE_SCOPE });
      const a2 = (await t.call("POST", "/api/assignments", { milestoneId: m.id, personaId: ro.id, cadence })).json;
      expect(a2).toMatchObject({ writeEnabled: false, writeScope: "" });
      const a3 = (await t.call("POST", "/api/assignments", { milestoneId: m.id, personaId: rw.id, cadence, writeEnabled: false })).json;
      expect(a3).toMatchObject({ writeEnabled: false, writeScope: "" });
      const a4 = (await t.call("POST", "/api/assignments", { milestoneId: m.id, personaId: ro.id, cadence, writeEnabled: true, writeScope: SCOPE })).json;
      expect(a4).toMatchObject({ writeEnabled: true, writeScope: SCOPE });
      // The persona flag is not read afterwards: turning it off leaves a1 as is, turning it on leaves a2 off.
      await t.call("PATCH", `/api/personas/${rw.id}`, { mayWrite: false });
      await t.call("PATCH", `/api/personas/${ro.id}`, { mayWrite: true });
      const list = (await t.call("GET", "/api/assignments")).json as any[];
      expect(list.find((a) => a.id === a1.id).writeEnabled).toBe(true);
      expect(list.find((a) => a.id === a2.id).writeEnabled).toBe(false);
    } finally {
      t.cleanup();
    }
  });
});

describe("M2-36 migration 11: assignments writing today keep writing", () => {
  it("switches on write (persona-wide scope text) for enabled assignments of may_write personas with any run in the last 7 days; nothing else", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    db.exec("ALTER TABLE runs DROP COLUMN held_on; ALTER TABLE jordi_responses DROP COLUMN wake_status; ALTER TABLE jordi_responses DROP COLUMN wake_run_id; ALTER TABLE jordi_responses DROP COLUMN wake_reason; ALTER TABLE milestones DROP COLUMN title_set_at; ALTER TABLE runs DROP COLUMN next_check_at; ALTER TABLE runs DROP COLUMN monitor_until; ALTER TABLE runs DROP COLUMN reported_outcome; ALTER TABLE personas DROP COLUMN skip_unchanged; ALTER TABLE runs DROP COLUMN usage; ALTER TABLE runs DROP COLUMN usage_checked_at; ALTER TABLE runs DROP COLUMN usage_note; ALTER TABLE runs DROP COLUMN ask_fingerprint; ALTER TABLE jordi_responses DROP COLUMN replaces_id; ALTER TABLE runs DROP COLUMN open_asks; ALTER TABLE personas DROP COLUMN fresh_thread_each_wake; ALTER TABLE runs DROP COLUMN checks; ALTER TABLE runs DROP COLUMN instructions_by; DROP INDEX runs_thread; DROP TABLE t3_environments; ALTER TABLE runs DROP COLUMN environment_id; ALTER TABLE runs DROP COLUMN instructions; ALTER TABLE runs DROP COLUMN retry_at; ALTER TABLE assignments DROP COLUMN retry_at; ALTER TABLE assignments DROP COLUMN retry_run_id;");
    db.pragma("user_version = 10"); // the live DB before
    const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    db.exec(`INSERT INTO milestones (id, title, repo, path, created_at) VALUES ('ms_1', 'E4', 'r', 'p', 'now');
             INSERT INTO personas (id, name, remit, may_write, created_at) VALUES ('pe_rw', 'RW', 'x', 1, 'now'), ('pe_ro', 'RO', 'x', 0, 'now');
             INSERT INTO assignments (id, milestone_id, persona_id, cadence, enabled, created_at, write_enabled, write_scope) VALUES
               ('as_live', 'ms_1', 'pe_rw', '{}', 1, 'now', 0, ''),
               ('as_running', 'ms_1', 'pe_rw', '{}', 1, 'now', 0, ''),
               ('as_old', 'ms_1', 'pe_rw', '{}', 1, 'now', 0, ''),
               ('as_blocked', 'ms_1', 'pe_rw', '{}', 1, 'now', 0, ''),
               ('as_disabled', 'ms_1', 'pe_rw', '{}', 0, 'now', 0, ''),
               ('as_norun', 'ms_1', 'pe_rw', '{}', 1, 'now', 0, ''),
               ('as_ro', 'ms_1', 'pe_ro', '{}', 1, 'now', 0, ''),
               ('as_scoped', 'ms_1', 'pe_rw', '{}', 1, 'now', 1, 'git only');`);
    const run = db.prepare("INSERT INTO runs (id, assignment_id, milestone_id, started_at, outcome) VALUES (?, ?, 'ms_1', ?, ?)");
    run.run("r1", "as_live", iso(1), "progressed");
    run.run("r2", "as_running", iso(0.1), "running");
    run.run("r3", "as_old", iso(9), "progressed");
    run.run("r4", "as_blocked", iso(1), "blocked");
    run.run("r7", "as_disabled", iso(1), "progressed");
    run.run("r5", "as_ro", iso(1), "progressed");
    run.run("r6", "as_scoped", iso(1), "progressed");
    migrate(db);
    expect(db.pragma("user_version", { simple: true })).toBe(24);
    const row = (id: string) => db.prepare("SELECT write_enabled, write_scope FROM assignments WHERE id = ?").get(id) as { write_enabled: number; write_scope: string };
    expect(row("as_live").write_enabled).toBe(1);
    expect(row("as_live").write_scope).toMatch(/as before M2-36.*remit requires/);
    expect(row("as_running").write_enabled).toBe(1);
    expect(row("as_old")).toEqual({ write_enabled: 0, write_scope: "" });
    expect(row("as_blocked").write_enabled).toBe(1); // blocked-only persona (health) keeps writing
    expect(row("as_disabled")).toEqual({ write_enabled: 0, write_scope: "" });
    expect(row("as_norun")).toEqual({ write_enabled: 0, write_scope: "" });
    expect(row("as_ro")).toEqual({ write_enabled: 0, write_scope: "" });
    expect(row("as_scoped")).toEqual({ write_enabled: 1, write_scope: "git only" }); // own scope kept
    // The migrated assignment now reads as write-on in the wake prompt, scoped by that text.
    const a = row("as_live");
    expect(buildWakePrompt(persona, milestone, { writeEnabled: !!a.write_enabled, writeScope: a.write_scope })).toContain("You may write, ONLY within this scope: as before M2-36");
  });
});
