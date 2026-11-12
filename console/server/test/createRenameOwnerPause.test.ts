import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { cachedRunner, spinesPyRunner } from "../src/adapters/spines.js";
import { openDb, type DB } from "../src/db.js";
import { BIG_ROOTS_FILE } from "../src/team/teamState.js";
import { MILESTONES_FILE } from "../src/team/milestoneRecord.js";
// this file checks the text with our own owner's name (src/identity.ts; the suite's owner is neutral, hostedSetup.ts)

/**
 * the milestones the console tracks and the owner's marks on them
 * (name, owner, paused, settled) live in the team repo's state/milestones.json; big-root positions in state/big-roots.json.
 * Every change is written there first; a write that does not land changes nothing in console.db, with no in-memory retry;
 * a lost console.db is rebuilt from the file. Temp repos only.
 */
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
const SPINE = [
  "# PLAN-7: Project seven",
  "",
  "Spine ID: PLAN-7",
  "Root spine: self",
  "Integration policy: main-direct",
  "",
  "## Goal",
  "Project goal.",
  "",
  "## Done means",
  "",
  "- [x] E7-1 the thing works",
  "",
  "## Current State",
  "Owner: Delivery manager",
  "Status: review",
  "Waiting on: none",
  "",
  "## Outcome",
  "",
  "Outcome: The thing works.",
  "Risk: none",
  "",
  "| Done means | Evidence |",
  "|---|---|",
  "| E7-1 the thing works | abc1234 |",
  "",
].join("\n");

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
  /** the owner marks it accomplished on the console: the mark settles it, through the team repo first. */
  const mark = async (id: string) => call("POST", `/api/milestones/${id}/mark`, { verdict: "accomplished", sentence: "The thing works." }, SAM);
  return { db, call, mark };
}

const SAM = { "Sec-Fetch-Site": "same-origin" };
const entries = (team: ReturnType<typeof repo>) => JSON.parse(team.onMain(MILESTONES_FILE)).milestones as any[];

describe.skipIf(!SKILL)("T62-S5 milestones and their marks are in the team repo first", () => {
  it("create, rename, owner, pause and settle each write state/milestones.json on main, then console.db", async () => {
    const team = repo("team", { "README.md": "team\n" });
    repo("proj", { "docs/spines/root.md": SPINE });
    const { call, mark } = boot();
    const m = (await call("POST", "/api/milestones", { title: "Project seven", repo: "proj", path: "docs/spines/root.md" })).json;
    expect(entries(team)).toEqual([expect.objectContaining({ id: m.id, repo: "proj", path: "docs/spines/root.md", title: "Project seven", titleSet: false, paused: false, settledAt: null })]);
    expect(git(team.origin, ["log", "-1", "--format=%s", "main"])).toBe("Milestones: track Project seven (console)");
    await call("PATCH", `/api/milestones/${m.id}`, { title: "Seven", owner: "Sam", paused: true });
    expect(entries(team)[0]).toMatchObject({ title: "Seven", titleSet: true, owner: "Sam", paused: true });
    const r = await mark(m.id);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.settled, JSON.stringify(r.json.status?.outcome)).toBe(true);
    const settledAt = (await call("GET", `/api/milestones/${m.id}`)).json.settledAt;
    expect(entries(team)[0].settledAt).toBe(settledAt);
    await call("POST", `/api/milestones/${m.id}/unsettle`);
    expect(entries(team)[0].settledAt).toBeNull();
    const s = await call("POST", `/api/milestones/${m.id}/settle`);
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    expect(entries(team)[0].settledAt).toBe(s.json.settledAt);
    expect((await call("DELETE", `/api/milestones/${m.id}`)).status).toBe(204);
    expect(entries(team)).toEqual([]);
  });

  it("a write that does not land changes nothing in console.db, and nothing retries it later", async () => {
    const team = repo("team", { "README.md": "team\n" });
    repo("proj", { "docs/spines/root.md": SPINE });
    const { call, mark } = boot();
    const m = (await call("POST", "/api/milestones", { title: "Project seven", repo: "proj", path: "docs/spines/root.md", bigRoot: 1 })).json;
    expect(team.onMain(BIG_ROOTS_FILE)).toContain(m.id);
    await mark(m.id);
    await call("POST", `/api/milestones/${m.id}/unsettle`);
    git(team.dir, ["remote", "set-url", "--push", "origin", path.join(tmp, "nowhere.git")]); // pushes fail
    const head = team.head();
    const settle = await call("POST", `/api/milestones/${m.id}/settle`);
    expect(settle.status).toBe(502);
    expect(settle.json.error.message).toMatch(/state\/milestones\.json not written.*nothing changed/);
    const rename = await call("PATCH", `/api/milestones/${m.id}`, { title: "Renamed" });
    expect(rename.status).toBe(502);
    const reorder = await call("PATCH", `/api/milestones/${m.id}`, { bigRoot: 3 });
    expect(reorder.status).toBe(502);
    expect(reorder.json.error.message).toMatch(/big-roots\.json not written/);
    const now = (await call("GET", `/api/milestones/${m.id}`)).json;
    expect(now).toMatchObject({ title: "Project seven", bigRoot: 1 });
    expect(now.settledAt).toBeUndefined();
    expect(team.head()).toBe(head);
    // pushes work again: no pending change goes out on its own
    git(team.dir, ["remote", "set-url", "--push", "origin", team.origin]);
    await call("POST", "/api/team-state/sync").catch(() => undefined);
    expect(team.head()).toBe(head);
  });

  it("a lost console.db is rebuilt from the file, and a change on main (another host) is applied", async () => {
    const team = repo("team", { "README.md": "team\n" });
    repo("proj", { "docs/spines/root.md": SPINE });
    const first = boot();
    const m = (await first.call("POST", "/api/milestones", { title: "Project seven", repo: "proj", path: "docs/spines/root.md" })).json;
    await first.call("PATCH", `/api/milestones/${m.id}`, { title: "Seven", paused: true });
    await first.mark(m.id);
    // a new console on an empty database: the milestone, its name, pause and settle come back from the file
    const second = boot(path.join(tmp, "fresh.db"));
    const back = (await second.call("GET", `/api/milestones/${m.id}`)).json;
    expect(back).toMatchObject({ id: m.id, title: "Seven", paused: true, repo: "proj", path: "docs/spines/root.md" });
    expect(back.settledAt).toBeTruthy();
    // another host unsettles it on main: the next console reads that
    const other = path.join(tmp, "other");
    git(tmp, ["clone", "-q", team.origin, other]);
    const f = path.join(other, MILESTONES_FILE);
    const v = JSON.parse(fs.readFileSync(f, "utf8"));
    v.milestones[0].settledAt = null;
    fs.writeFileSync(f, JSON.stringify(v, null, 2) + "\n");
    git(other, ["commit", "-qam", "T62-S5: unsettle by hand"]);
    git(other, ["push", "-q", "origin", "main"]);
    git(team.dir, ["pull", "-q", "--ff-only"]);
    const third = boot(path.join(tmp, "third.db"));
    expect((await third.call("GET", `/api/milestones/${m.id}`)).json.settledAt).toBeUndefined();
  });

  it("carry-over: dry run first, then console.db's milestones are written to the file once", async () => {
    const team = repo("team", { "README.md": "team\n" });
    repo("proj", { "docs/spines/root.md": SPINE });
    const { db, call } = boot();
    db.prepare("INSERT INTO milestones (id, title, repo, path, owner, paused, created_at, tenant_id, settled_at) VALUES ('ms_old', 'Old one', 'proj', 'docs/spines/root.md', 'Sam', 1, '2026-10-01T00:00:00Z', 'home', '2026-10-02T00:00:00Z')").run();
    const dry = await call("POST", "/api/e62s5/carry", { dry: true });
    expect(dry.json.lines).toEqual([{ world: "home", action: "would write", count: 1 }]);
    expect(() => team.onMain(MILESTONES_FILE)).toThrow();
    const run = await call("POST", "/api/e62s5/carry", {});
    expect(run.json.lines).toEqual([{ world: "home", action: "written", count: 1 }]);
    expect(entries(team)).toEqual([expect.objectContaining({ id: "ms_old", title: "Old one", owner: "Sam", paused: true, settledAt: "2026-10-02T00:00:00Z" })]);
    expect((await call("POST", "/api/e62s5/carry", {})).json.lines).toEqual([{ world: "home", action: "already in the file", count: 1 }]);
  });
});
