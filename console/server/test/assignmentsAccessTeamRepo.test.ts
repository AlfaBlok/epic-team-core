import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { cachedRunner, spinesPyRunner } from "../src/adapters/spines.js";
import { openDb, type DB } from "../src/db.js";
import { ACCESS_FILE, ASSIGNMENTS_FILE, createAssignmentRecord } from "../src/team/assignmentRecord.js";
import { createMilestoneRecord } from "../src/team/milestoneRecord.js";
import { createSpineWriter } from "../src/inbox/spineWrite.js";

/**
 * who works on which spine, how often, the owner's
 * switch, the write grant, service switches and send caps live in the team repo (state/assignments.json, state/access.json),
 * written before console.db changes; an auto-park is the scheduler's and never touches the file; a lost console.db is
 * rebuilt from the files. Temp repos only.
 */
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
const SKILL = [process.env.EPICSPINE_SKILL_DIR, path.join(os.homedir(), "github/epicspine-skill/skill/epic-spine"), path.join(os.homedir(), ".agents/skills/epic-spine")].find(
  (d) => d && fs.existsSync(path.join(d, "scripts/spines.py")),
);
let tmp: string;
let reposRoot: string;
const dbs: DB[] = [];
const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };

function repo(name: string, files: Record<string, string>) {
  const origin = path.join(tmp, "origins", `${name}.git`);
  fs.mkdirSync(path.dirname(origin), { recursive: true });
  git(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
  const dir = path.join(reposRoot, name);
  git(tmp, ["clone", "-q", origin, dir]);
  git(dir, ["checkout", "-q", "-b", "main"]);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "seed"]);
  git(dir, ["push", "-q", "origin", "main"]);
  return { dir, origin, onMain: (rel: string) => git(origin, ["show", `main:${rel}`]), head: () => git(origin, ["rev-parse", "main"]) };
}

beforeEach(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e62s5-"));
  reposRoot = path.join(tmp, "repos");
  fs.mkdirSync(reposRoot);
});
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_SYSTEM", saved.s]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function boot(dbFile = path.join(tmp, "console.db")) {
  const db = openDb(dbFile);
  dbs.push(db);
  const spines = SKILL ? { spines: cachedRunner(spinesPyRunner(SKILL, { timeoutMs: 50_000 })) } : {};
  const app = createApp(db, { read: { reposRoot, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [], ...spines }, browser: { browserUrl: "http://127.0.0.1:9" } });
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(url, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  return { db, call };
}

const list = (team: ReturnType<typeof repo>) => JSON.parse(team.onMain(ASSIGNMENTS_FILE)).assignments as any[];
const SPINE = "# PLAN-7: Seven\n\nIntegration policy: main-direct\n\n## Current State\n\nStatus: active\n";

async function seed(call: Awaited<ReturnType<typeof boot>>["call"]) {
  const m = (await call("POST", "/api/milestones", { title: "Seven", repo: "proj", path: "docs/spines/root.md" })).json;
  const p = (await call("POST", "/api/personas", { name: "Bob", remit: "Builds." })).json;
  return { m, p };
}

describe("T62-S7 assignments and access are in the team repo first", () => {
  it("attach, switch off, cadence and detach each write state/assignments.json on main, then console.db", async () => {
    const team = repo("team", { "README.md": "team\n" });
    repo("proj", { "docs/spines/root.md": SPINE });
    const { call } = boot();
    const { m, p } = await seed(call);
    const a = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true })).json;
    expect(list(team)).toEqual([expect.objectContaining({ id: a.id, milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true })]);
    expect(git(team.origin, ["log", "-1", "--format=%s", "main"])).toBe("Assignments: attach Bob to Seven (console)");
    await call("PATCH", `/api/assignments/${a.id}`, { enabled: false, cadence: { type: "interval", everyMinutes: 120 } });
    expect(list(team)[0]).toMatchObject({ enabled: false, cadence: { type: "interval", everyMinutes: 120 } });
    expect((await call("DELETE", `/api/assignments/${a.id}`)).status).toBe(204);
    expect(list(team)).toEqual([]);
  });

  it("a write that does not land changes nothing; an auto-park leaves the file alone and the file never wakes a parked one", async () => {
    const team = repo("team", { "README.md": "team\n" });
    repo("proj", { "docs/spines/root.md": SPINE });
    const { db, call } = boot();
    const { m, p } = await seed(call);
    const a = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true })).json;
    git(team.dir, ["remote", "set-url", "--push", "origin", path.join(tmp, "nowhere.git")]);
    const head = team.head();
    const r = await call("PATCH", `/api/assignments/${a.id}`, { enabled: false });
    expect(r.status).toBe(502);
    expect(r.json.error.message).toMatch(/state\/assignments\.json not written.*nothing changed/);
    expect((await call("GET", `/api/assignments/${a.id}`)).json.enabled).toBe(true);
    expect(team.head()).toBe(head);
    git(team.dir, ["remote", "set-url", "--push", "origin", team.origin]);
    // the scheduler parks it (console.db only): the file still says the owner has it on
    db.prepare("UPDATE assignments SET enabled = 0, parked_at = '2026-11-03T00:00:00Z', parked_reason = 'nothing to do' WHERE id = ?").run(a.id);
    const second = boot(path.join(tmp, "console.db"));
    expect((await second.call("GET", `/api/assignments/${a.id}`)).json).toMatchObject({ enabled: false, parkedReason: "nothing to do" });
    expect(list(team)[0].enabled).toBe(true);
  });

  it("a lost console.db is rebuilt from the files (milestones, personas, assignments, access); carry-over writes the old ones once", async () => {
    const team = repo("team", { "README.md": "team\n" });
    repo("proj", { "docs/spines/root.md": SPINE });
    const first = boot();
    const { m, p } = await seed(first.call);
    first.db.prepare("INSERT INTO assignments (id, milestone_id, persona_id, cadence, enabled, write_enabled, write_scope, created_at) VALUES ('as_old', ?, ?, '{\"type\":\"interval\",\"everyMinutes\":30}', 1, 1, 'docs only', '2026-10-01T00:00:00Z')").run(m.id, p.id);
    first.db.prepare("INSERT INTO mail_caps (persona_id, daily_cap, updated_at) VALUES (?, 7, '2026-10-01T00:00:00Z')").run(p.id);
    first.db.prepare("INSERT INTO mcp_access (service_id, persona_id, allowed, updated_at) VALUES ('svc_x', ?, 0, '2026-10-01T00:00:00Z')").run(p.id);
    const dry = (await first.call("POST", "/api/e62s7/carry", { dry: true })).json.lines;
    expect(dry).toEqual([
      { world: "home", file: ASSIGNMENTS_FILE, action: "would write", count: 1 },
      { world: "home", file: ACCESS_FILE, action: "would write", count: 2 },
    ]);
    expect((await first.call("POST", "/api/e62s7/carry", {})).json.lines.map((l: any) => l.action)).toEqual(["written", "written"]);
    expect(list(team)).toEqual([expect.objectContaining({ id: "as_old", writeEnabled: true, writeScope: "docs only", cadence: { type: "interval", everyMinutes: 30 } })]);
    expect(JSON.parse(team.onMain(ACCESS_FILE))).toMatchObject({ mcp: [{ serviceId: "svc_x", personaId: p.id, allowed: false }], mailCaps: [{ personaId: p.id, dailyCap: 7 }] });
    const second = boot(path.join(tmp, "fresh.db"));
    expect((await second.call("GET", "/api/assignments/as_old")).json).toMatchObject({ milestoneId: m.id, personaId: p.id, enabled: true, writeEnabled: true, writeScope: "docs only" });
    expect(second.db.prepare("SELECT daily_cap FROM mail_caps WHERE persona_id = ?").get(p.id)).toEqual({ daily_cap: 7 });
    expect(second.db.prepare("SELECT allowed FROM mcp_access WHERE service_id = 'svc_x' AND persona_id = ?").get(p.id)).toEqual({ allowed: 0 });
  });

  it("a service switch and a send cap are recorded first; a refused write sets nothing", async () => {
    const team = repo("team", { "README.md": "team\n" });
    const { db, call } = boot();
    const p = (await call("POST", "/api/personas", { name: "Bob", remit: "Builds." })).json;
    const rec = createAssignmentRecord({ db, dirOf: createMilestoneRecord({ db, reposRoot, writer: createSpineWriter() }).dirOf, writer: createSpineWriter() });
    let set = 0;
    await rec.access("svc_y", p.id, true, () => set++);
    await rec.mailCap(p.id, 3, () => set++);
    expect(set).toBe(2);
    expect(JSON.parse(team.onMain(ACCESS_FILE))).toMatchObject({ mcp: [{ serviceId: "svc_y", personaId: p.id, allowed: true }], mailCaps: [{ personaId: p.id, dailyCap: 3 }] });
    fs.writeFileSync(path.join(team.dir, "dirty.txt"), "x");
    await expect(rec.mailCap(p.id, 9, () => set++)).rejects.toThrow(/state\/access\.json not written/);
    expect(set).toBe(2);
  });
});
