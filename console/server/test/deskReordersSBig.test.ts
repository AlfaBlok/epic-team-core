import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { ReadConfig } from "../src/routes/read.js";
import { SEED_VERSION, deskSeed, endpointLines, updateMessage } from "../src/desk/desk.js";
import { BIG_ROOTS_FILE } from "../src/team/teamState.js";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
const put = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const ROOT = `# PLAN-0: team

Root spine: self
Integration policy: main-direct

## Current State
Status: active
`;

let tmp: string;
let origin: string;
let team: string;
let db: DB;
const savedEnv = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };

/** A fresh clone of origin (what is on main now). */
const onMain = (rel: string) => {
  const c = path.join(tmp, `peek-${Math.random().toString(36).slice(2)}`);
  git(tmp, ["clone", "-q", origin, c]);
  const f = path.join(c, rel);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : undefined;
};

beforeEach(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e41s5-"));
  origin = path.join(tmp, "team.git");
  git(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = path.join(tmp, "seed");
  git(tmp, ["clone", "-q", origin, seed]);
  git(seed, ["checkout", "-q", "-b", "main"]);
  put(seed, "docs/spines/root.md", ROOT);
  put(seed, "AGENTS.md", "Integration policy: main-direct\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "seed"]);
  git(seed, ["push", "-q", "origin", "main"]);
  team = path.join(tmp, "repos", "team");
  fs.mkdirSync(path.dirname(team), { recursive: true });
  git(tmp, ["clone", "-q", origin, team]);
  db = openDb(path.join(tmp, "console.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", savedEnv.g], ["GIT_CONFIG_SYSTEM", savedEnv.s]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** the Team desk keeps the owner's priority order: one call reorders his big roots in one commit and says so in one line. */
const DESK = { "X-Console-Run": "team-desk" };
const boot = () => {
  const readCfg: ReadConfig = { reposRoot: path.join(tmp, "repos"), seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] };
  const app = createApp(db, { read: readCfg });
  return async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(url, { method, headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
};
const commits = () => Number(git(tmp, ["--git-dir", origin, "rev-list", "--count", "main"]));
const lastMsg = () => git(tmp, ["--git-dir", origin, "log", "-1", "--format=%s", "main"]);

describe("T41-S5 the desk reorders Sam's big roots", () => {
  const three = async (call: ReturnType<typeof boot>) => {
    const a = (await call("POST", "/api/milestones", { title: "Social", repo: "o/s", path: "EPIC.md", bigRoot: 1 })).json;
    const b = (await call("POST", "/api/milestones", { title: "Memo", repo: "o/z", path: "EPIC.md", bigRoot: 2 })).json;
    const c = (await call("POST", "/api/milestones", { title: "House", repo: "o/h", path: "EPIC.md", bigRoot: 4 })).json;
    const plain = (await call("POST", "/api/milestones", { title: "infra", repo: "o/i", path: "EPIC.md" })).json;
    return { a, b, c, plain };
  };

  it("puts every big root in the new order in ONE commit quoting Sam, and answers the one line to say", async () => {
    const call = boot();
    const { a, b, c, plain } = await three(call);
    const before = commits();
    const r = await call("PUT", "/api/big-roots/order", { order: [b.id, a.id, c.id], why: "Memo matters most now" }, DESK);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ changed: true, line: "Priorities now: 1 Memo, 2 Social, 3 House.", teamState: { file: BIG_ROOTS_FILE, status: "written" } });
    expect(commits()).toBe(before + 1);
    expect(lastMsg()).toBe('Big roots: reordered by the Team desk: 1 Memo, 2 Social, 3 House (Sam: "Memo matters most now") (console)');
    expect(JSON.parse(onMain(BIG_ROOTS_FILE)!).bigRoots.map((e: any) => [e.position, e.title])).toEqual([[1, "Memo"], [2, "Social"], [3, "House"]]);
    // console.db follows the file: the sidebar order.
    const ms = (await call("GET", "/api/milestones")).json as any[];
    expect(Object.fromEntries(ms.map((m) => [m.title, m.bigRoot ?? null]))).toMatchObject({ Memo: 1, Social: 2, House: 3, infra: null });
    expect(plain.bigRoot ?? null).toBeNull();
  });

  it("the same order is no commit; closing a gap in the positions is a renumber", async () => {
    const call = boot();
    const { a, b, c } = await three(call);
    const r = await call("PUT", "/api/big-roots/order", { order: [a.id, b.id, c.id], why: "keep it" }, DESK);
    expect(r.json).toMatchObject({ changed: true }); // House was at 4: now 3
    expect(lastMsg()).toMatch(/^Big roots: renumbered by the Team desk: 1 Social, 2 Memo, 3 House/);
    const n = commits();
    const again = await call("PUT", "/api/big-roots/order", { order: [a.id, b.id, c.id], why: "keep it" }, DESK);
    expect(again.json).toMatchObject({ changed: false, line: "Priorities now: 1 Social, 2 Memo, 3 House." });
    expect(again.json).not.toHaveProperty("teamState");
    expect(commits()).toBe(n);
  });

  it("refuses a list that is not exactly today's big roots, no words of Sam, or a caller that is not the desk", async () => {
    const call = boot();
    const { a, b, c, plain } = await three(call);
    const before = commits();
    expect((await call("PUT", "/api/big-roots/order", { order: [b.id, a.id], why: "x" }, DESK)).json).toMatchObject({ error: { code: "not_same_roots" } });
    expect((await call("PUT", "/api/big-roots/order", { order: [b.id, a.id, c.id, plain.id], why: "x" }, DESK)).json.error.message).toMatch(/not a big root/);
    expect((await call("PUT", "/api/big-roots/order", { order: [b.id, a.id, a.id, c.id], why: "x" }, DESK)).status).toBe(400);
    expect((await call("PUT", "/api/big-roots/order", { order: [b.id, a.id, c.id] }, DESK)).json).toMatchObject({ error: { code: "validation_error" } });
    expect((await call("PUT", "/api/big-roots/order", { order: [b.id, a.id, c.id], why: "x" })).status).toBe(403);
    expect((await call("PUT", "/api/big-roots/order", { order: [b.id, a.id, c.id], why: "x" }, { ...DESK, "X-Run-Id": "run_1" })).status).toBe(403);
    expect(commits()).toBe(before);
    expect(JSON.parse(onMain(BIG_ROOTS_FILE)!).bigRoots.map((e: any) => e.title)).toEqual(["Social", "Memo", "House"]);
  });

  it("a write that does not land changes nothing in console.db (the file first, L-45)", async () => {
    const call = boot();
    const { a, b, c } = await three(call);
    git(tmp, ["--git-dir", origin, "config", "receive.denyCurrentBranch", "refuse"]);
    fs.writeFileSync(path.join(origin, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const r = await call("PUT", "/api/big-roots/order", { order: [c.id, b.id, a.id], why: "House first" }, DESK);
    expect(r.status).toBeGreaterThanOrEqual(409);
    const ms = (await call("GET", "/api/milestones")).json as any[];
    expect(Object.fromEntries(ms.map((m) => [m.title, m.bigRoot ?? null]))).toMatchObject({ Social: 1, Memo: 2, House: 4 });
  });

  it("the desk is told: rule and call in its endpoint list, seed and update (v22)", () => {
    expect(SEED_VERSION).toBeGreaterThanOrEqual(22);
    const lines = endpointLines("https://c").join("\n");
    expect(lines).toContain("Priority order");
    expect(lines).toContain("curl -sS -X PUT https://c/api/big-roots/order");
    expect(lines).toMatch(/say it in one line/);
    expect(lines).toMatch(/Never reorder on your own idea/);
    expect(updateMessage("https://c")).toContain("you keep his priority order");
    expect(deskSeed({ persona: { name: "Team desk", remit: "r" }, publicUrl: "https://c", reposRoot: "/r" })).toContain("/api/big-roots/order");
  });

  it("the remit doc carries the rule", () => {
    const remit = fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "docs", "personas", "team-desk.md"), "utf8");
    expect(remit).toContain("PRIORITY ORDER");
    expect(remit).toContain("PUT /api/big-roots/order");
  });
});
