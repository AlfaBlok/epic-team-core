import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { DEFAULT_TENANT, ensureTenancy, openDb, TENANT_TABLES, type DB } from "../src/db.js";
import { createStore, forTenant, UnknownReference, UnknownTenant } from "../src/store.js";
import { tempApp } from "./helpers.js";

// tenant schema + scoped store + hosts table; the home world is the default and nothing changes for it.

const cols = (db: DB, t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
const addTenant = (db: DB, id: string) =>
  db.prepare("INSERT INTO tenants (id, name, skin, plan, created_at) VALUES (?, ?, 'social', 'founding', ?)").run(id, id, new Date().toISOString());
const cadence = { type: "interval" as const, everyMinutes: 60 };

let t: ReturnType<typeof tempApp>;
beforeEach(() => {
  t = tempApp();
});
afterEach(() => t.cleanup());

describe("schema", () => {
  it("adds tenants (home), hosts (main, worker) and tenant_id on every tenant table, schema version unchanged", () => {
    expect(t.db.prepare("SELECT id, skin, plan, owner_handle FROM tenants").all()).toEqual([
      { id: "home", skin: "console", plan: "internal", owner_handle: "Sam" },
    ]);
    expect((t.db.prepare("SELECT id, tenant_id, kind FROM hosts ORDER BY id").all() as any[]).map((h) => [h.id, h.tenant_id, h.kind])).toEqual([
      ["main", "home", "local"],
      ["worker", "home", "ephemeral"],
    ]);
    // createApp ran the module migrations, so the side tables exist and got the column too.
    for (const table of TENANT_TABLES) expect(cols(t.db, table), table).toContain("tenant_id");
    expect(t.db.pragma("user_version", { simple: true })).toBe(24);
  });

  it("is idempotent: reopening and re-running changes nothing", () => {
    const file = path.join(t.dir, "nested", "console.db");
    const snapshot = () =>
      JSON.stringify([
        t.db.prepare("SELECT * FROM tenants").all(),
        t.db.prepare("SELECT * FROM hosts").all(),
        TENANT_TABLES.map((x) => cols(t.db, x)),
        t.db.prepare("SELECT name FROM sqlite_master ORDER BY name").all(),
      ]);
    const before = snapshot();
    ensureTenancy(t.db);
    ensureTenancy(t.db, { CONSOLE_VPS3_SSH: "changed@host" });
    const again = openDb(file);
    again.close();
    expect(snapshot()).toBe(before);
  });

  it("migrates a pre-E21 database additively: existing rows become home's, values untouched", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e21s2-"));
    try {
      const file = path.join(dir, "console.db");
      const db = openDb(file);
      // Rewind to the pre-E21 shape (what live has today), then write rows the way the old code did (no tenant_id).
      db.exec(`DROP INDEX milestones_tenant; DROP INDEX personas_tenant; DROP INDEX runs_tenant; DROP INDEX needs_jordi_tenant;
        DROP TABLE tenants; DROP TABLE hosts;`);
      for (const table of ["milestones", "personas", "runs", "needs_jordi", "jordi_responses", "messages"])
        db.exec(`ALTER TABLE ${table} DROP COLUMN tenant_id`);
      const at = "2026-10-25T00:00:00.000Z";
      db.prepare("INSERT INTO milestones (id, title, repo, path, owner, paused, created_at) VALUES ('ms_1', 'Root', 'r', 'p.md', 'Sam', 0, ?)").run(at);
      db.prepare("INSERT INTO personas (id, name, remit, created_at) VALUES ('pe_1', 'DM', 'manage', ?)").run(at);
      db.prepare("INSERT INTO assignments (id, milestone_id, persona_id, cadence, created_at) VALUES ('as_1', 'ms_1', 'pe_1', '{}', ?)").run(at);
      db.prepare("INSERT INTO runs (id, assignment_id, milestone_id, started_at, outcome) VALUES ('run_1', 'as_1', 'ms_1', ?, 'idle')").run(at);
      db.prepare("INSERT INTO needs_jordi (id, milestone_id, question, created_at) VALUES ('nj_1', 'ms_1', 'q?', ?)").run(at);
      const tables = ["milestones", "personas", "assignments", "runs", "needs_jordi"];
      const rows = (d: DB) =>
        JSON.stringify(tables.map((x) => (d.prepare(`SELECT * FROM ${x} ORDER BY id`).all() as any[]).map(({ tenant_id, ...r }) => r)));
      const old = rows(db);
      db.close();

      const migrated = openDb(file);
      expect(rows(migrated)).toBe(old);
      for (const table of ["milestones", "personas", "runs", "needs_jordi"])
        expect(migrated.prepare(`SELECT DISTINCT tenant_id FROM ${table}`).all(), table).toEqual([{ tenant_id: "home" }]);
      const [all, a9] = [createStore(migrated), forTenant(migrated, "home")];
      const view = (s: typeof all) => JSON.stringify([s.listMilestones(), s.listPersonas(), s.listAssignments(), s.listRuns(), s.listNeedsJordi()]);
      expect(view(a9)).toBe(view(all));
      expect(all.listRuns()).toHaveLength(1);
      migrated.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scoped store", () => {
  function twoWorlds() {
    addTenant(t.db, "social");
    const a9 = forTenant(t.db, "home");
    const zs = forTenant(t.db, "social");
    const m1 = a9.createMilestone({ title: "home root", repo: "r1", path: "a.md", owner: "Sam", paused: false });
    const p1 = a9.createPersona({ name: "DM", remit: "r", skills: [], model: "opus", mayWrite: false });
    const as1 = a9.createAssignment({ milestoneId: m1.id, personaId: p1.id, cadence, enabled: true });
    const run1 = a9.createRun({ assignmentId: as1.id, outcome: "idle", summary: "a9" });
    const nj1 = a9.createNeedsJordi({ milestoneId: m1.id, question: "a9?", proposedAction: "", status: "open" });
    const m2 = zs.createMilestone({ title: "social", repo: "r2", path: "z.md", owner: "Sam", paused: false });
    const p2 = zs.createPersona({ name: "Author", remit: "r", skills: [], model: "opus", mayWrite: false });
    const as2 = zs.createAssignment({ milestoneId: m2.id, personaId: p2.id, cadence, enabled: true });
    const run2 = zs.createRun({ assignmentId: as2.id, outcome: "idle", summary: "zs" });
    const nj2 = zs.createNeedsJordi({ milestoneId: m2.id, question: "zs?", proposedAction: "", status: "open" });
    return { a9, zs, m1, p1, as1, run1, nj1, m2, p2, as2, run2, nj2 };
  }

  it("creates stamp the tenant; runs and asks copy their milestone's", () => {
    const w = twoWorlds();
    const tenantOf = (table: string, id: string) => (t.db.prepare(`SELECT tenant_id FROM ${table} WHERE id = ?`).get(id) as any).tenant_id;
    expect([tenantOf("milestones", w.m1.id), tenantOf("personas", w.p1.id), tenantOf("runs", w.run1.id), tenantOf("needs_jordi", w.nj1.id)]).toEqual(
      Array(4).fill("home"),
    );
    expect([tenantOf("milestones", w.m2.id), tenantOf("personas", w.p2.id), tenantOf("runs", w.run2.id), tenantOf("needs_jordi", w.nj2.id)]).toEqual(
      Array(4).fill("social"),
    );
    // The unscoped store copies the milestone's tenant too (a a social world repo run created by today's code paths stays theirs).
    expect(tenantOf("runs", createStore(t.db).createRun({ assignmentId: w.as2.id, outcome: "idle", summary: "" }).id)).toBe("social");
  });

  it("lists and gets only its own tenant's rows", () => {
    const w = twoWorlds();
    for (const [s, mine, theirs] of [
      [w.a9, w, { m: w.m2, p: w.p2, as: w.as2, run: w.run2, nj: w.nj2 }],
      [w.zs, { m1: w.m2, p1: w.p2, as1: w.as2, run1: w.run2, nj1: w.nj2 }, { m: w.m1, p: w.p1, as: w.as1, run: w.run1, nj: w.nj1 }],
    ] as const) {
      expect(s.listMilestones().map((x) => x.id)).toEqual([mine.m1.id]);
      expect(s.listPersonas().map((x) => x.id)).toEqual([mine.p1.id]);
      expect(s.listAssignments().map((x) => x.id)).toEqual([mine.as1.id]);
      expect(s.listRuns().map((x) => x.id)).toEqual([mine.run1.id]);
      expect(s.listNeedsJordi().map((x) => x.id)).toEqual([mine.nj1.id]);
      expect(s.listAssignments({ milestoneId: theirs.m.id })).toEqual([]);
      expect(s.listRuns({ milestoneId: theirs.m.id })).toEqual([]);
      expect(s.getMilestone(theirs.m.id)).toBeUndefined();
      expect(s.getPersona(theirs.p.id)).toBeUndefined();
      expect(s.getAssignment(theirs.as.id)).toBeUndefined();
      expect(s.getRun(theirs.run.id)).toBeUndefined();
      expect(s.getNeedsJordi(theirs.nj.id)).toBeUndefined();
      expect(s.listTenants().map((x) => x.id)).toEqual([s.tenant]);
    }
    const all = createStore(t.db);
    expect(all.tenant).toBeUndefined();
    expect(all.listMilestones()).toHaveLength(2);
    expect(all.listRuns()).toHaveLength(2);
    expect(all.listTenants().map((x) => x.id)).toEqual(["home", "social"]);
  });

  it("never updates or deletes another tenant's rows", () => {
    const w = twoWorlds();
    expect(w.zs.updateMilestone(w.m1.id, { title: "hijack" })).toBeUndefined();
    expect(w.zs.setSettled(w.m1.id, true)).toBeUndefined();
    expect(w.zs.updatePersona(w.p1.id, { name: "hijack" })).toBeUndefined();
    expect(w.zs.updateAssignment(w.as1.id, { enabled: false })).toBeUndefined();
    expect(w.zs.updateRun(w.run1.id, { summary: "hijack" })).toBeUndefined();
    expect(w.zs.updateNeedsJordi(w.nj1.id, { status: "approved" })).toBeUndefined();
    expect(w.zs.supersedeNeedsJordi(w.nj1.id)).toBeUndefined();
    for (const del of [
      () => w.zs.deleteAssignment(w.as1.id),
      () => w.zs.deletePersona(w.p1.id),
      () => w.zs.deleteMilestone(w.m1.id),
    ])
      expect(del()).toBe(false);
    expect(w.a9.getMilestone(w.m1.id)).toMatchObject({ title: "home root" });
    expect(w.a9.getPersona(w.p1.id)).toMatchObject({ name: "DM" });
    expect(w.a9.getAssignment(w.as1.id)).toMatchObject({ enabled: true });
    expect(w.a9.getRun(w.run1.id)).toMatchObject({ summary: "a9" });
    expect(w.a9.getNeedsJordi(w.nj1.id)).toMatchObject({ status: "open" });
  });

  it("refuses references into another tenant", () => {
    const w = twoWorlds();
    expect(() => w.zs.createAssignment({ milestoneId: w.m2.id, personaId: w.p1.id, cadence, enabled: true })).toThrow(UnknownReference);
    expect(() => w.zs.createRun({ assignmentId: w.as1.id, outcome: "idle", summary: "" })).toThrow(UnknownReference);
    expect(() => w.zs.createRun({ assignmentId: w.as2.id, outcome: "idle", summary: "", parentRunId: w.run1.id })).toThrow(UnknownReference);
    expect(() => w.zs.createNeedsJordi({ milestoneId: w.m1.id, question: "?", proposedAction: "", status: "open" })).toThrow(UnknownReference);
    expect(() => w.zs.updateAssignment(w.as2.id, { personaId: w.p1.id })).toThrow(UnknownReference);
    // Even unscoped, an assignment cannot join a milestone and a persona of two worlds.
    expect(() => createStore(t.db).createAssignment({ milestoneId: w.m1.id, personaId: w.p2.id, cadence, enabled: true })).toThrow(
      UnknownReference,
    );
  });

  it("refuses an unknown tenant", () => {
    expect(() => forTenant(t.db, "nobody")).toThrow(UnknownTenant);
  });
});

describe("API: home reads identically", () => {
  it("answers the same unscoped (today) and scoped to home (CONSOLE_TENANT=home)", async () => {
    const m = (await t.call("POST", "/api/milestones", { title: "E5", repo: "/repo", path: "tickets/E5.md", owner: "Sam" })).json;
    const p = (await t.call("POST", "/api/personas", { name: "steward", remit: "read-only", skills: [], model: "opus" })).json;
    const a = (await t.call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence })).json;
    const run = (await t.call("POST", "/api/runs", { assignmentId: a.id, outcome: "progressed", summary: "did it" })).json;
    // the needs_jordi table is the raise log (the ask itself is a spine line)
    const nj = createStore(t.db).logRaisedAsk({ milestoneId: m.id, runId: run.id, question: "ok?", proposedAction: "go", by: "repo/T5-A1" });
    expect([m.id, p.id, a.id, run.id, nj.id].every(Boolean)).toBe(true);
    // No tenant field leaks into today's responses.
    expect(m).not.toHaveProperty("tenantId");

    const scoped = createApp(t.db, { browser: { browserUrl: "http://127.0.0.1:9" }, tenant: DEFAULT_TENANT });
    const urls = [
      "/api/milestones",
      `/api/milestones/${m.id}`,
      "/api/personas",
      `/api/personas/${p.id}`,
      "/api/assignments",
      `/api/assignments/${a.id}`,
      "/api/runs",
      `/api/runs/${run.id}`,
      "/api/needs-owner",
      `/api/needs-owner/${nj.id}`,
      "/api/tenants",
      "/api/tenants/home",
    ];
    for (const url of urls) {
      const before = await t.app.request(url);
      const after = await scoped.request(url);
      expect(after.status, url).toBe(before.status);
      expect(await after.text(), url).toBe(await before.text());
    }
  });

  it("serves the tenants, and 404 for an unknown or out-of-scope one", async () => {
    expect((await t.call("GET", "/api/tenants")).json).toEqual([
      expect.objectContaining({ id: "home", name: "home", skin: "console", plan: "internal", ownerHandle: "Sam", paused: false }),
    ]);
    expect((await t.call("GET", "/api/tenants/nobody")).status).toBe(404);
    addTenant(t.db, "social");
    const scoped = createApp(t.db, { browser: { browserUrl: "http://127.0.0.1:9" }, tenant: "social" });
    expect((await scoped.request("/api/tenants/home")).status).toBe(404);
    expect(((await (await scoped.request("/api/tenants")).json()) as any[]).map((x) => x.id)).toEqual(["social"]);
  });
});
