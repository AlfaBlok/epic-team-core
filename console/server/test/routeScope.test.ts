import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { resetRepoScans } from "../src/adapters/repos.js";
import { createAuth } from "../src/auth/identity.js";
import { isOwnerOnly, isTenantSafe } from "../src/auth/routeScope.js";
import { openDb, type DB } from "../src/db.js";
import { createStore, type Milestone } from "../src/store.js";
import { serializeManifest, wakeSkillCheck, WORLD_MANIFEST, type CliRun, type TeamSkill } from "../src/teamSkills.js";

// skills per world. The team library is the base every world gets (read-only to a world); a world's
// owner adds its own skills (previewed, pinned) to the world's repo (skills/world-skills.json), removes them, and only that
// world's wakes get them: linked into the wake's checkout by `team-skills.py world-link`, never another world's or a seat dir.
const SHA = "0cf73c3fcc56667ad91a9a04c439ac6ccfabc9d1";
const SHA2 = "ca45fc496a3436251f191354091d557da31c15b5";
const LIB = {
  version: 1,
  skills: [{ name: "diagram-design", use_when: "a branded editorial diagram", source: { type: "github", repo: "cathrynlavery/diagram-design", commit: SHA, path: "skills/diagram-design" } }],
};
const PDF: TeamSkill = { name: "pdf", use_when: "Use this skill whenever the user wants to do anything with PDF files.", source: { type: "github", repo: "anthropics/skills", commit: SHA2, path: "skills/pdf" } };
const T = "es-tina-1a2b";
const O = "es-otto-3c4d";
const git = (d: string, ...args: string[]) => execFileSync("git", ["-C", d, ...args], { encoding: "utf8", env: { ...process.env, EPICSPINE_PERSONA: "" } }).trim();
const iso = () => new Date().toISOString();

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e53s6-"));
  const lib = path.join(dir, "home_repo");
  fs.mkdirSync(path.join(lib, "skills"), { recursive: true });
  fs.writeFileSync(path.join(lib, "skills/team-skills.json"), serializeManifest(LIB as any));
  const root = path.join(dir, "repos");
  // each world's own checkout (named after it); T's has an origin to push to
  for (const w of [T, O]) {
    const d = path.join(root, w);
    execFileSync("git", ["init", "-q", "-b", "main", d]);
    git(d, "config", "user.email", "t@example.com");
    git(d, "config", "user.name", "t");
    fs.writeFileSync(path.join(d, "AGENTS.md"), "# Agents\n\nIntegration policy: main-direct\n");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "init");
  }
  const origin = path.join(dir, "t-origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  git(path.join(root, T), "remote", "add", "origin", origin);
  git(path.join(root, T), "push", "-q", "origin", "main");
  resetRepoScans();
  const calls: string[][] = [];
  let linkProblems: { name: string; problem: string }[] = [];
  const cli: CliRun = async (host, args) => {
    calls.push([host, ...args]);
    if (args[0] === "add") {
      const skill = args[1].includes("diagram-design") ? (LIB.skills[0] as TeamSkill) : PDF;
      return { code: 0, json: { ok: true, action: "added", dry_run: true, skill, description: "PDF tools", skill_md_name: skill.name } };
    }
    if (args[0] === "world-link") {
      const m = JSON.parse(args[args.indexOf("--manifest-json") + 1]);
      const bad = new Set(linkProblems.map((p) => p.name));
      return { code: bad.size ? 1 : 0, json: { ok: true, green: !bad.size, linked: m.skills.map((s: TeamSkill) => s.name).filter((n: string) => !bad.has(n)), problems: linkProblems } };
    }
    if (args[0] === "check") return { code: 0, json: { ok: true, green: true, dirs: [{ dir: "~/.claude/skills", ok: ["diagram-design"], missing: [] }] } };
    return { code: 0, json: { ok: true, green: true } };
  };
  const db: DB = openDb(path.join(dir, "c.db"));
  const app = createApp(db, {
    auth: "on",
    browser: { browserUrl: "http://127.0.0.1:9" },
    read: { reposRoot: root, seatsFile: path.join(dir, "seats.json"), listThreads: async () => [] },
    teamSkills: { repoDir: lib, cli, syncHosts: ["main"] },
  });
  for (const w of [T, O]) db.prepare("INSERT INTO tenants (id, name, skin, plan, created_at) VALUES (?, ?, 'social', 'founding', ?)").run(w, w, iso());
  const ms: Record<string, Milestone> = {};
  for (const w of [T, O]) ms[w] = createStore(db, { tenant: w }).createMilestone({ title: `M-${w}`, repo: w, path: "docs/spines/root.md", owner: "Sam", paused: false });
  const auth = createAuth(db);
  const login = (email: string, w: string, role: "owner" | "member") => auth.createSession(auth.addMember({ email, tenant: w, role }), w).id;
  const who = {
    tOwner: { cookie: `console_session=${login("tina@example.com", T, "owner")}` },
    tMember: { cookie: `console_session=${login("tom@example.com", T, "member")}` },
    oOwner: { cookie: `console_session=${login("otto@example.com", O, "owner")}` },
    tAgent: { authorization: `Bearer ${auth.createToken({ tenant: T, label: "t-agent" }).token}` },
  };
  const call = async (method: string, url: string, headers: Record<string, string>, body?: unknown) => {
    const res = await app.request(url, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  const worldManifest = (w: string) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, w, WORLD_MANIFEST), "utf8"));
    } catch {
      return undefined;
    }
  };
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { dir, root, lib, db, call, calls, who, worldManifest, origin, ms, cli, setLinkProblems: (p: typeof linkProblems) => (linkProblems = p) };
}

describe("T53-S6 route scope", () => {
  it("a world reaches add, preview and remove; all three need its owner", () => {
    for (const [m, p] of [["POST", "/api/team-skills"], ["POST", "/api/team-skills/preview"], ["DELETE", "/api/team-skills/pdf"]]) {
      expect(isTenantSafe(m, p)).toBe(true);
      expect(isOwnerOnly(m, p)).toBe(true);
    }
    expect(isOwnerOnly("GET", "/api/team-skills")).toBe(false);
  });
});

describe("T53-S6 a world's own skills", () => {
  it("the world sees the base skills read-only and can add its own", async () => {
    const t = setup();
    const r = await t.call("GET", "/api/team-skills", t.who.tOwner);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ canEdit: true, world: { id: T, repo: T } });
    expect(r.json.syncNote).toMatch(/this world's repo/);
    expect(r.json.skills).toEqual([expect.objectContaining({ name: "diagram-design", scope: "base", removable: false, useWhen: "a branded editorial diagram" })]);
    // a member and an agent see the page, without the buttons
    expect((await t.call("GET", "/api/team-skills", t.who.tMember)).json.canEdit).toBe(false);
    expect((await t.call("GET", "/api/team-skills", t.who.tAgent)).json.canEdit).toBe(false);
  });

  it("preview reads the world's manifest; add commits it in the world's repo and pushes it, never the team manifest", async () => {
    const t = setup();
    const url = "https://github.com/anthropics/skills/tree/main/skills/pdf";
    const p = await t.call("POST", "/api/team-skills/preview", t.who.tOwner, { url });
    expect(p.status).toBe(200);
    expect(p.json).toMatchObject({ skill: { name: "pdf", source: { commit: SHA2 } }, action: "added" });
    expect(t.calls[0]).toEqual(["main", "add", url, "--dry-run", "--no-sync", "--manifest", path.join(t.root, T, WORLD_MANIFEST)]);
    expect(t.worldManifest(T)).toBeUndefined(); // a preview writes nothing

    const a = await t.call("POST", "/api/team-skills", t.who.tOwner, { url, commit: SHA2 });
    expect(a.status).toBe(201);
    expect(a.json).toMatchObject({ action: "added", push: "pushed", sync: [{ host: "main", ok: true, note: "linked in 1 checkout of this world" }, { host: "worker" }] });
    expect(t.worldManifest(T).skills.map((s: TeamSkill) => s.name)).toEqual(["pdf"]);
    expect(git(t.origin, "log", "--format=%s", "main").split("\n")[0]).toBe(`World skills: add pdf @ ${SHA2.slice(0, 12)} (owner, via console)`);
    expect(JSON.parse(fs.readFileSync(path.join(t.lib, "skills/team-skills.json"), "utf8")).skills).toHaveLength(1);
    // linked into T's own checkout only
    const links = t.calls.filter((c) => c[1] === "world-link");
    expect(links).toHaveLength(1);
    expect(links[0].slice(0, 6)).toEqual(["main", "world-link", "--world", T, "--dest", path.join(t.root, T)]);
    expect(t.calls.some((c) => c[0] !== "main" || c[1] === "sync")).toBe(false); // no seat-wide sync, no the worker server

    const mine = await t.call("GET", "/api/team-skills", t.who.tOwner);
    expect(mine.json.skills.map((s: any) => [s.name, s.scope, s.removable])).toEqual([["diagram-design", "base", false], ["pdf", "world", true]]);
    const other = await t.call("GET", "/api/team-skills", t.who.oOwner);
    expect(other.json.skills.map((s: any) => s.name)).toEqual(["diagram-design"]);
  });

  it("refuses a base skill's name, a member, an agent token, and another world's remove", async () => {
    const t = setup();
    const clash = await t.call("POST", "/api/team-skills/preview", t.who.tOwner, { url: "https://github.com/cathrynlavery/diagram-design" });
    expect(clash.status).toBe(409);
    expect(clash.json.error.code).toBe("base_skill");
    for (const h of [t.who.tMember, t.who.tAgent]) {
      const r = await t.call("POST", "/api/team-skills", h, { url: "https://github.com/anthropics/skills" });
      expect(r.status).toBe(403);
      expect(r.json.error.code).toBe("owner_only");
    }
    expect((await t.call("POST", "/api/team-skills", t.who.tOwner, { url: "https://github.com/anthropics/skills", commit: SHA2 })).status).toBe(201);
    const base = await t.call("DELETE", "/api/team-skills/diagram-design", t.who.tOwner);
    expect(base.status).toBe(403);
    expect(base.json.error.code).toBe("base_skill");
    const cross = await t.call("DELETE", "/api/team-skills/pdf?confirm=yes", t.who.oOwner);
    expect(cross.status).toBe(404);
    expect(t.worldManifest(T).skills).toHaveLength(1);
    expect(t.worldManifest(O)).toBeUndefined();
  });

  it("removing an attached world skill asks first, then takes it off the world's personas", async () => {
    const t = setup();
    await t.call("POST", "/api/team-skills", t.who.tOwner, { url: "https://github.com/anthropics/skills", commit: SHA2 });
    const w = createStore(t.db, { tenant: T }).createPersona({ name: "Writer", remit: "r", skills: ["diagram-design", "pdf"], model: "opus", mayWrite: false });
    const used = (await t.call("GET", "/api/team-skills", t.who.tOwner)).json.skills.find((s: any) => s.name === "pdf");
    expect(used.usedBy).toEqual([{ id: w.id, name: "Writer" }]);
    const first = await t.call("DELETE", "/api/team-skills/pdf", t.who.tOwner);
    expect(first.status).toBe(409);
    expect(first.json.error).toMatchObject({ code: "in_use", usedBy: [{ id: w.id, name: "Writer" }] });
    const ok = await t.call("DELETE", "/api/team-skills/pdf?confirm=yes", t.who.tOwner);
    expect(ok.status).toBe(200);
    expect(ok.json.detachedFrom).toEqual([{ id: w.id, name: "Writer" }]);
    expect(createStore(t.db).getPersona(w.id)!.skills).toEqual(["diagram-design"]);
    expect(t.worldManifest(T).skills).toEqual([]);
    // the relink after the remove carries the empty manifest, so the checkout's links go
    const last = t.calls.filter((c) => c[1] === "world-link").pop()!;
    expect(JSON.parse(last[last.indexOf("--manifest-json") + 1]).skills).toEqual([]);
  });
});

describe("T53-S6 wake check covers the world's own skills", () => {
  it("links them into the wake's checkout on its host; another world's persona never gets them", async () => {
    const t = setup();
    await t.call("POST", "/api/team-skills", t.who.tOwner, { url: "https://github.com/anthropics/skills", commit: SHA2 });
    const own = JSON.parse(fs.readFileSync(path.join(t.root, T, WORLD_MANIFEST), "utf8")).skills as TeamSkill[];
    const worldSkills = (m: Milestone) => (m.id === t.ms[T].id ? { world: T, skills: own } : { world: O, skills: [] });
    const check = wakeSkillCheck({ repoDir: t.lib, cli: t.cli, worldSkills });
    const p = { name: "Writer", skills: ["diagram-design", "pdf"], host: "worker" as const };
    t.calls.length = 0;
    // Run now, before the host is up: membership only
    expect(await check(p, { milestone: t.ms[T] })).toMatchObject({ ok: true, world: ["pdf"], use: { pdf: PDF.use_when, "diagram-design": "a branded editorial diagram" } });
    expect(t.calls.some((c) => c[1] === "world-link")).toBe(false);
    // the wake: linked on the worker server into the worker server's checkout of the milestone repo
    const link = { host: "worker" as const, checkout: async () => "/srv/agent/github/" + T };
    expect(await check(p, { milestone: t.ms[T], link })).toMatchObject({ ok: true, world: ["pdf"] });
    expect(t.calls.find((c) => c[1] === "world-link")!.slice(0, 6)).toEqual(["worker", "world-link", "--world", T, "--dest", "/srv/agent/github/" + T]);
    // not linked (a clash in the checkout) or no checkout there: the wake fails with why
    t.setLinkProblems([{ name: "pdf", problem: ".claude/skills/pdf exists and is not this world's link (left alone)" }]);
    expect(await check(p, { milestone: t.ms[T], link })).toMatchObject({ ok: false, reason: expect.stringContaining("pdf is not linked in /srv/agent/github/" + T + " on worker (.claude/skills/pdf exists") });
    t.setLinkProblems([]);
    expect(await check(p, { milestone: t.ms[T], link: { host: "worker", checkout: async () => undefined } })).toMatchObject({ ok: false, reason: expect.stringContaining("has no checkout on worker") });
    // another world (or the home world) naming it: not in its library, so its wake fails and nothing is linked for it
    t.calls.length = 0;
    expect(await check(p, { milestone: t.ms[O], link })).toMatchObject({ ok: false, reason: expect.stringContaining("pdf is not in the team skills library") });
    expect(await check(p)).toMatchObject({ ok: false });
    expect(t.calls.some((c) => c[1] === "world-link")).toBe(false);
  });
});

describe("T53-S6 a world persona's wake in the cycle", () => {
  it("links the world's skill into the checkout the wake runs in and says so in the prompt", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e53s6c-"));
    const lib = path.join(dir, "home_repo");
    fs.mkdirSync(path.join(lib, "skills"), { recursive: true });
    fs.writeFileSync(path.join(lib, "skills/team-skills.json"), serializeManifest(LIB as any));
    const root = path.join(dir, "repos");
    const wdir = path.join(root, T);
    execFileSync("git", ["init", "-q", wdir]);
    fs.mkdirSync(path.join(wdir, "skills"));
    fs.writeFileSync(path.join(wdir, WORLD_MANIFEST), serializeManifest({ version: 1, skills: [PDF] }));
    resetRepoScans();
    const calls: string[][] = [];
    const cli: CliRun = async (host, args) => {
      calls.push([host, ...args]);
      if (args[0] === "world-link") return { code: 0, json: { ok: true, green: true, linked: ["pdf"], problems: [] } };
      return { code: 0, json: { ok: true, green: true, dirs: [] } };
    };
    const t3 = {
      listProjects: async () => [{ id: "main:w", title: T, workspaceRoot: wdir }],
      listScheduledTasks: async () => [],
      updateScheduledTask: async () => undefined,
      deleteScheduledTask: async () => undefined,
      runScheduledTaskNow: async () => undefined,
      launchThread: async () => ({ threadId: "thread1" }),
      sendToThread: async () => undefined,
      readThreadStatus: async () => ({ status: "running", raw: {} }),
    } as any;
    const db: DB = openDb(path.join(dir, "c.db"));
    const app = createApp(db, {
      read: { reposRoot: root, seatsFile: path.join(dir, "seats.json"), listThreads: async () => [] },
      cycle: { enabled: true, t3, dispatcher: { pick: async () => ({ seat: "seat1", providerInstanceId: "claudeAgent_seat1" }), done: async () => undefined } as any, publicUrl: "http://x", worldHold: () => undefined },
      teamSkills: { repoDir: lib, cli, wakeCheck: true },
    });
    cleanup = () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    };
    db.prepare("INSERT INTO tenants (id, name, skin, plan, created_at) VALUES (?, ?, 'social', 'founding', ?)").run(T, T, iso());
    const s = createStore(db, { tenant: T });
    const m = s.createMilestone({ title: "M", repo: T, path: "docs/spines/root.md", owner: "Sam", paused: false });
    const p = s.createPersona({ name: "Writer", remit: "r", skills: ["diagram-design", "pdf"], model: "sonnet", mayWrite: false });
    const a = s.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 240 }, enabled: true });
    const res = await app.request(`/api/assignments/${a.id}/wake`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const text = await res.text();
    expect(text).toContain("- Use `pdf` whenever the user wants to do anything with PDF files");
    expect(text).toContain("`pdf` is this world's own skill, linked in this checkout's .claude/skills");
    expect(calls.find((c) => c[1] === "world-link")!.slice(0, 6)).toEqual(["main", "world-link", "--world", T, "--dest", wdir]);
  });
});
