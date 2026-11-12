import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { ensureTenancy, openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import type { ReadConfig } from "../src/routes/read.js";
import { createSpineWriter } from "../src/inbox/spineWrite.js";
import { createPlacements, migratePlacements } from "../src/desk/placements.js";
import type { DeskMessage } from "../src/desk/session.js";
import {
  BIG_ROOTS_FILE,
  PLACEMENTS_FILE,
  appendChat,
  bigRootsText,
  createTeamState,
  parseBigRoots,
  placementsText,
  redact,
} from "../src/team/teamState.js";

/** the owner's own team state lives in its private repo; big roots and the desk's home are read and written there. */
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
const put = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const ROOT = `# EPIC-900: team

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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e41s2-"));
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

/** Commit a file to origin as if the owner (or another host) edited the repo; the console's checkout is NOT pulled here
 * (sync must fetch it itself). */
const pushFromElsewhere = (rel: string, text: string) => {
  const c = path.join(tmp, `other-${Math.random().toString(36).slice(2)}`);
  git(tmp, ["clone", "-q", origin, c]);
  put(c, rel, text);
  git(c, ["add", rel]);
  git(c, ["commit", "-q", "-m", `edit ${rel}`]);
  git(c, ["push", "-q", "origin", "main"]);
};

describe("E941-S2 file shapes", () => {
  it("parses a big-roots list by id or repo + path and refuses a broken one", () => {
    const ok = parseBigRoots(JSON.stringify({ bigRoots: [{ position: 1, title: "A", milestoneId: "ms_a" }, { position: 2, repo: "o/r", path: "EPIC.md" }] }));
    expect(ok).toEqual({ entries: [{ position: 1, title: "A", milestoneId: "ms_a" }, { position: 2, repo: "o/r", path: "EPIC.md" }] });
    expect(parseBigRoots("{nope")).toHaveProperty("error");
    expect(parseBigRoots(JSON.stringify({ bigRoots: [{ position: 0, milestoneId: "x" }] }))).toHaveProperty("error");
    expect(parseBigRoots(JSON.stringify({ bigRoots: [{ position: 1 }] }))).toHaveProperty("error");
  });

  it("writes the big roots in position order, ordinary milestones left out", () => {
    const s = createStore(db);
    const a = s.createMilestone({ title: "House", repo: "o/h", path: "EPIC.md", owner: "", paused: false, bigRoot: 2 });
    s.createMilestone({ title: "Plain", repo: "o/p", path: "EPIC.md", owner: "", paused: false });
    const b = s.createMilestone({ title: "Social", repo: "o/s", path: "EPIC.md", owner: "", paused: false, bigRoot: 1 });
    const v = JSON.parse(bigRootsText(s.listMilestones()));
    expect(v.bigRoots.map((e: any) => [e.position, e.title, e.milestoneId])).toEqual([[1, "Social", b.id], [2, "House", a.id]]);
  });

  it("the chat copy appends only new message ids, and never a pasted key", () => {
    const m = (id: string, role: "user" | "assistant", text: string, at: string): DeskMessage => ({ id, role, kind: "message", text, status: "completed", at });
    const first = appendChat("", "2026-11-01", [m("i1", "user", "hello", "2026-11-01T10:00:00Z"), m("i2", "assistant", "hi Sam", "2026-11-01T10:00:30Z")])!;
    expect(first).toContain("# Team desk chat · 2026-11-01");
    expect(first).toContain("## 10:00Z · Sam\n<!-- m:i1 -->\n\nhello");
    expect(first).toContain("## 10:00Z · Team desk\n<!-- m:i2 -->\n\nhi Sam");
    expect(appendChat(first, "2026-11-01", [m("i1", "user", "hello", "2026-11-01T10:00:00Z")])).toBeUndefined();
    const second = appendChat(first, "2026-11-01", [m("i3", "user", "key sk-ant-abcdefghijklmnopqrstuvwxyz0123", "2026-11-01T11:00:00Z")])!;
    expect(second.startsWith(first.trimEnd())).toBe(true);
    expect(second).toContain("key [redacted]");
    expect(redact("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe("[redacted]");
  });
});

describe("E941-S2 team state sync (real git, main-direct push)", () => {
  const make = (transcript?: () => Promise<DeskMessage[]>) => {
    migratePlacements(db);
    const placements = createPlacements({ db, reposRoot: path.join(tmp, "repos") });
    return { placements, ts: createTeamState({ db, reposRoot: path.join(tmp, "repos"), writer: createSpineWriter(), placements, transcript }) };
  };

  it("no checkout: everything is a no-op", async () => {
    fs.rmSync(team, { recursive: true, force: true });
    const { ts } = make();
    expect(await ts.sync()).toEqual({});
    expect(await ts.bigRootsChanged("x")).toBeUndefined();
  });

  it("the file is the source: a big root set, renamed, reordered or removed on main reaches the milestones", async () => {
    const s = createStore(db);
    const house = s.createMilestone({ title: "house_decision", repo: "Acme/house_decision", path: "EPIC.md", owner: "", paused: false });
    const hair = s.createMilestone({ title: "Hair transplant", repo: "Acme/hair_flow", path: "EPIC.md", owner: "", paused: false, bigRoot: 1 });
    pushFromElsewhere(BIG_ROOTS_FILE, JSON.stringify({ bigRoots: [{ position: 1, title: "House decision", milestoneId: house.id }, { position: 2, repo: "Acme/hair_flow", path: "EPIC.md" }] }));
    const { ts } = make();
    const r = await ts.sync();
    expect(r.bigRoots).toMatch(/^applied: /);
    expect(s.getMilestone(house.id)).toMatchObject({ bigRoot: 1, title: "House decision" });
    expect(s.getMilestone(hair.id)).toMatchObject({ bigRoot: 2, title: "Hair transplant" });
    // The same file again changes nothing; a removal makes the milestone ordinary.
    expect((await ts.sync()).bigRoots).toBeUndefined();
    pushFromElsewhere(BIG_ROOTS_FILE, JSON.stringify({ bigRoots: [{ position: 1, milestoneId: house.id }] }));
    await ts.sync();
    expect(s.getMilestone(hair.id)!.bigRoot).toBeUndefined();
    // A broken file is ignored (the milestones keep their places).
    pushFromElsewhere(BIG_ROOTS_FILE, "{broken");
    expect((await ts.sync()).bigRoots).toMatch(/^ignored: not valid JSON/);
    expect(s.getMilestone(house.id)!.bigRoot).toBe(1);
  });

  it("placements are copied to the repo after a change and come back into an empty database", async () => {
    fs.mkdirSync(path.join(tmp, "repos", "home_repo", "docs", "spines"), { recursive: true });
    put(path.join(tmp, "repos", "home_repo"), "docs/spines/epic-909.md", "# EPIC-909: Nine\n\n## Current State\nStatus: active\n");
    const { placements, ts } = make();
    const p = placements.place({ repo: "home_repo", path: "docs/spines/epic-909.md", kind: "epic" });
    const r = await ts.sync();
    expect(r.placements).toMatch(/^written /);
    const copy = onMain(PLACEMENTS_FILE)!;
    expect(copy).toBe(placementsText(placements.list()));
    expect(JSON.parse(copy).placements[0]).toMatchObject({ id: p.id, title: "EPIC-909: Nine", state: "placed" });
    expect((await ts.sync()).placements).toBeUndefined(); // unchanged: no commit

    // A new database (lost console.db) gets them back from the copy, ids and states as they were.
    const db2 = openDb(path.join(tmp, "console2.db"));
    try {
      migratePlacements(db2);
      const pl2 = createPlacements({ db: db2, reposRoot: path.join(tmp, "repos") });
      const ts2 = createTeamState({ db: db2, reposRoot: path.join(tmp, "repos"), writer: createSpineWriter(), placements: pl2 });
      expect(ts2.restorePlacements()).toBe(1);
      expect(pl2.list()).toEqual(placements.list());
      expect(ts2.restorePlacements()).toBe(0);
    } finally {
      db2.close();
    }
  });

  it("only acme's placements are copied; another world's (social) stay out, as on the world-filtered list", async () => {
    fs.mkdirSync(path.join(tmp, "repos", "home_repo", "docs", "spines"), { recursive: true });
    put(path.join(tmp, "repos", "home_repo"), "docs/spines/epic-909.md", "# EPIC-909: Nine\n\n## Current State\nStatus: active\n");
    put(path.join(tmp, "repos", "home_repo"), "docs/spines/epic-907.md", "# EPIC-907: Seven\n\n## Current State\nStatus: active\n");
    const { placements, ts } = make();
    ensureTenancy(db);
    const mine = placements.place({ repo: "home_repo", path: "docs/spines/epic-909.md", kind: "epic" });
    const theirs = placements.place({ repo: "home_repo", path: "docs/spines/epic-907.md", kind: "epic" });
    db.prepare("UPDATE desk_placement SET tenant_id = 'social' WHERE id = ?").run(theirs.id);
    expect((await ts.sync()).placements).toMatch(/^written /);
    expect(JSON.parse(onMain(PLACEMENTS_FILE)!).placements.map((p: { id: string }) => p.id)).toEqual([mine.id]);
  });

  it("the desk chat is appended to one file per day, plumbing and unfinished messages already left out by the transcript", async () => {
    let msgs: DeskMessage[] = [
      { id: "s1", role: "user", kind: "seed", text: "", status: "completed", at: "2026-10-31T23:59:00Z", session: 1 },
      { id: "a", role: "user", kind: "message", text: "add hair_flow as a milestone", page: "/team", status: "completed", at: "2026-11-01T09:00:00Z" },
      { id: "b", role: "assistant", kind: "message", text: "Added: hair_flow.", status: "completed", at: "2026-11-01T09:00:20Z" },
    ];
    const { ts } = make(async () => msgs);
    expect((await ts.sync()).chat).toMatch(/^written /);
    expect(onMain("desk/chat/2026-10-31.md")).toContain("new desk session 1");
    const day = onMain("desk/chat/2026-11-01.md")!;
    expect(day).toContain("## 09:00Z · Sam (from /team)\n<!-- m:a -->\n\nadd hair_flow as a milestone");
    expect(day).toContain("Added: hair_flow.");
    expect((await ts.sync()).chat).toBeUndefined();
    msgs = [...msgs, { id: "c", role: "user", kind: "message", text: "thanks", status: "completed", at: "2026-11-01T09:05:00Z" }];
    await ts.sync();
    const after = onMain("desk/chat/2026-11-01.md")!;
    expect(after.startsWith(day.trimEnd())).toBe(true);
    expect(after.match(/<!-- m:/g)).toHaveLength(3);
  });
});

describe("E941-S2 console big-root changes go to the team repo", () => {
  const boot = () => {
    const readCfg: ReadConfig = { reposRoot: path.join(tmp, "repos"), seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] };
    const app = createApp(db, { read: readCfg });
    return async (method: string, url: string, body?: unknown) => {
      const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : undefined };
    };
  };

  it("PATCH bigRoot, a rename of a big root, and a delete are written to state/big-roots.json on main", async () => {
    const call = boot();
    const a = (await call("POST", "/api/milestones", { title: "Social", repo: "o/s", path: "EPIC.md", bigRoot: 1 })).json;
    expect(a.teamState).toMatchObject({ file: BIG_ROOTS_FILE, status: "written" });
    const b = (await call("POST", "/api/milestones", { title: "House", repo: "o/h", path: "EPIC.md" })).json;
    expect(b.teamState).toBeUndefined(); // not a big root: nothing to write

    const p = await call("PATCH", `/api/milestones/${b.id}`, { bigRoot: 2 });
    expect(p.status).toBe(200);
    expect(p.json.teamState).toMatchObject({ status: "written" });
    const r = await call("PATCH", `/api/milestones/${b.id}`, { title: "House decision" });
    expect(r.json.teamState).toMatchObject({ status: "written" });
    let v = JSON.parse(onMain(BIG_ROOTS_FILE)!);
    expect(v.bigRoots.map((e: any) => [e.position, e.title])).toEqual([[1, "Social"], [2, "House decision"]]);

    // A paused flag on a big root touches nothing in the file.
    expect((await call("PATCH", `/api/milestones/${b.id}`, { paused: true })).json.teamState).toBeUndefined();

    expect((await call("DELETE", `/api/milestones/${a.id}`)).status).toBe(204);
    v = JSON.parse(onMain(BIG_ROOTS_FILE)!);
    expect(v.bigRoots.map((e: any) => e.title)).toEqual(["House decision"]);
  });

  it("Sam's review: make focus then remove, and a new focus milestone then remove, leave the file as it was", async () => {
    const call = boot();
    await call("POST", "/api/milestones", { title: "Social", repo: "o/s", path: "EPIC.md", bigRoot: 1 });
    await call("POST", "/api/milestones", { title: "Memo", repo: "o/z", path: "EPIC.md", bigRoot: 2 });
    const before = onMain(BIG_ROOTS_FILE)!;
    const other = (await call("POST", "/api/milestones", { title: "infra", repo: "o/i", path: "EPIC.md" })).json;

    // Make focus (the Team home's button: next position), then Remove from focus.
    expect((await call("PATCH", `/api/milestones/${other.id}`, { bigRoot: 3 })).json.teamState).toMatchObject({ status: "written" });
    expect(JSON.parse(onMain(BIG_ROOTS_FILE)!).bigRoots.map((e: any) => e.title)).toEqual(["Social", "Memo", "infra"]);
    expect((await call("PATCH", `/api/milestones/${other.id}`, { bigRoot: null })).json.teamState).toMatchObject({ status: "written" });
    expect(onMain(BIG_ROOTS_FILE)).toBe(before);

    // New focus milestone: one POST with its position; removing it (delete) restores the file.
    const made = (await call("POST", "/api/milestones", { title: "Test focus", repo: "o/t", path: "EPIC.md", bigRoot: 3 })).json;
    expect(made.teamState).toMatchObject({ status: "written" });
    expect(JSON.parse(onMain(BIG_ROOTS_FILE)!).bigRoots.map((e: any) => [e.position, e.title])).toEqual([[1, "Social"], [2, "Memo"], [3, "Test focus"]]);
    expect((await call("DELETE", `/api/milestones/${made.id}`)).status).toBe(204);
    expect(onMain(BIG_ROOTS_FILE)).toBe(before);
  });

  it("without a team checkout the answers are as before", async () => {
    fs.rmSync(team, { recursive: true, force: true });
    const call = boot();
    const a = (await call("POST", "/api/milestones", { title: "Social", repo: "o/s", path: "EPIC.md", bigRoot: 1 })).json;
    expect(a).not.toHaveProperty("teamState");
    expect((await call("PATCH", `/api/milestones/${a.id}`, { bigRoot: 2 })).json).not.toHaveProperty("teamState");
  });
});

describe("E941-S2 the desk knows its home", () => {
  it("seed v14 names the team repo, where team-level asks go, and the big-roots call", async () => {
    const { SEED_VERSION, endpointLines } = await import("../src/desk/desk.js");
    expect(SEED_VERSION).toBeGreaterThanOrEqual(14);
    const home = endpointLines("http://console.test").find((l) => l.includes("Your home"))!;
    expect(home).toContain("Acme/team");
    expect(home).toContain("## Waiting on");
    expect(home).toContain(`"bigRoot":<1..99 or null>`);
    expect(home).toContain("never edit those");
    // review: the desk says "Focus milestones" as the console does, and knows the one-POST new focus milestone.
    expect(SEED_VERSION).toBeGreaterThanOrEqual(18);
    expect(home).toContain("Focus milestones");
    expect(home).toContain(`"bigRoot":<next position>`);
  });
});
