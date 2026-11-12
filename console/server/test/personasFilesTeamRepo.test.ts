import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { cachedRunner, spinesPyRunner } from "../src/adapters/spines.js";
import { openDb, type DB } from "../src/db.js";
import { parsePersona, PERSONAS_DIR } from "../src/team/personaRecord.js";

/**
 * each persona is a file in its world's team repo
 * (state/personas/<name>.md), written before console.db changes; a write that does not land changes nothing; a lost
 * console.db gets every persona back from the files. Temp repos only.
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

const files = (team: ReturnType<typeof repo>) =>
  git(team.origin, ["ls-tree", "--name-only", "main", `${PERSONAS_DIR}/`]).split("\n").filter(Boolean);
const onMain = (team: ReturnType<typeof repo>, rel: string) => parsePersona(team.onMain(rel)) as any;
const REMIT = "Builds the thing.\n\n## Reads\nThe spine.\n\nWrites: code.";

describe("T62-S6 personas are files in the team repo, written first", () => {
  it("create, edit (remit, model, provider) and delete each write state/personas/<name>.md on main, then console.db", async () => {
    const team = repo("team", { "README.md": "team\n" });
    const { call } = boot();
    const p = (await call("POST", "/api/personas", { name: "Builder Bob", remit: REMIT, model: "sonnet", skills: ["x"] })).json;
    expect(files(team)).toEqual(["state/personas/builder-bob.md"]);
    expect(onMain(team, "state/personas/builder-bob.md")).toMatchObject({ id: p.id, name: "Builder Bob", remit: REMIT, model: "sonnet", skills: ["x"], mayWrite: false });
    expect(git(team.origin, ["log", "-1", "--format=%s", "main"])).toBe("Personas: add Builder Bob (console)");
    // a rename keeps the file (the id inside is the key); the remit is in git, line by line
    await call("PATCH", `/api/personas/${p.id}`, { name: "Bob", remit: "Builds the other thing." });
    expect(files(team)).toEqual(["state/personas/builder-bob.md"]);
    expect(onMain(team, "state/personas/builder-bob.md")).toMatchObject({ name: "Bob", remit: "Builds the other thing." });
    const prov = await call("PUT", `/api/personas/${p.id}/provider`, { provider: null, model: "opus" });
    expect(prov.status).toBe(200);
    expect(onMain(team, "state/personas/builder-bob.md")).toMatchObject({ model: "opus" });
    expect((await call("DELETE", `/api/personas/${p.id}`)).status).toBe(204);
    expect(files(team)).toEqual([]);
    expect((await call("GET", `/api/personas/${p.id}`)).status).toBe(404);
  });

  it("a write that does not land changes nothing in console.db", async () => {
    const team = repo("team", { "README.md": "team\n" });
    const { call } = boot();
    const p = (await call("POST", "/api/personas", { name: "Bob", remit: REMIT })).json;
    git(team.dir, ["remote", "set-url", "--push", "origin", path.join(tmp, "nowhere.git")]); // pushes fail
    const head = team.head();
    const e = await call("PATCH", `/api/personas/${p.id}`, { remit: "Something else." });
    expect(e.status).toBe(502);
    expect(e.json.error.message).toMatch(/state\/personas\/bob\.md not written.*nothing changed/);
    expect((await call("GET", `/api/personas/${p.id}`)).json.remit).toBe(REMIT);
    expect((await call("POST", "/api/personas", { name: "Ann", remit: REMIT })).status).toBe(502);
    expect((await call("GET", "/api/personas")).json.map((x: any) => x.name)).toEqual(["Bob"]);
    expect((await call("DELETE", `/api/personas/${p.id}`)).status).toBe(502);
    expect((await call("GET", `/api/personas/${p.id}`)).status).toBe(200);
    expect(team.head()).toBe(head);
  });

  it("a lost console.db gets every persona back from the files; carry-over writes the old ones once (dry run first)", async () => {
    const team = repo("team", { "README.md": "team\n" });
    const first = boot();
    first.db.prepare("INSERT INTO personas (id, name, remit, skills, model, may_write, created_at, tenant_id, provider) VALUES ('pe_old', 'Old hand', 'Does the old work.', '[\"a\"]', 'opus', 1, '2026-10-01T00:00:00Z', 'home', 'anthropic')").run();
    expect((await first.call("POST", "/api/e62s6/carry", { dry: true })).json.lines).toEqual([{ world: "home", action: "would write", count: 1 }]);
    expect(files(team)).toEqual([]);
    expect((await first.call("POST", "/api/e62s6/carry", {})).json.lines).toEqual([{ world: "home", action: "written", count: 1 }]);
    expect(onMain(team, "state/personas/old-hand.md")).toMatchObject({ id: "pe_old", remit: "Does the old work.", skills: ["a"], mayWrite: true, provider: "anthropic" });
    expect((await first.call("POST", "/api/e62s6/carry", {})).json.lines).toEqual([{ world: "home", action: "already in files", count: 1 }]);
    const p = (await first.call("POST", "/api/personas", { name: "Bob", remit: REMIT })).json;
    const second = boot(path.join(tmp, "fresh.db"));
    expect((await second.call("GET", "/api/personas")).json.map((x: any) => [x.id, x.name, x.remit])).toEqual([
      ["pe_old", "Old hand", "Does the old work."],
      [p.id, "Bob", REMIT],
    ]);
    expect((second.db.prepare("SELECT provider FROM personas WHERE id = 'pe_old'").get() as any).provider).toBe("anthropic");
  });
});
