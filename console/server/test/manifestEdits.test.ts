import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createAuth } from "../src/auth/identity.js";
import { isTenantSafe } from "../src/auth/routeScope.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { addToManifest, removeFromManifest, serializeManifest, sourceUrl, type CliRun, type TeamSkill } from "../src/teamSkills.js";

// the Team skills screen's API. The library is the code repo skills/team-skills.json; add/remove are the owner's, commit and push
// the manifest on main through the spine writer, then sync; used-by keeps to the caller's world; removing an attached skill asks first.
const SHA = "0cf73c3fcc56667ad91a9a04c439ac6ccfabc9d1";
const SHA2 = "ca45fc496a3436251f191354091d557da31c15b5";
const MANIFEST = {
  version: 1,
  skills: [
    { name: "diagram", use_when: "one clean diagram image", source: { type: "local", path: "skills/diagram" } },
    { name: "diagram-design", use_when: "a branded editorial diagram", source: { type: "github", repo: "cathrynlavery/diagram-design", commit: SHA, path: "skills/diagram-design" } },
  ],
};
const SAM = { "sec-fetch-site": "same-origin" };
const git = (d: string, ...args: string[]) => execFileSync("git", ["-C", d, ...args], { encoding: "utf8", env: { ...process.env, EPICSPINE_PERSONA: "" } }).trim();

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function setup(o: { auth?: "on" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e53s4-"));
  const origin = path.join(dir, "origin.git");
  const repo = path.join(dir, "home_repo");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "clone", "-q", origin, repo);
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  git(repo, "checkout", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "# Agents\n\nIntegration policy: main-direct\n");
  fs.mkdirSync(path.join(repo, "skills"));
  fs.writeFileSync(path.join(repo, "skills/team-skills.json"), serializeManifest(MANIFEST as any));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "--no-verify", "-m", "init");
  git(repo, "push", "-q", "origin", "main");
  const calls: string[][] = [];
  const pdf: TeamSkill = { name: "pdf", use_when: "Use this skill whenever the user wants to do anything with PDF files.", source: { type: "github", repo: "anthropics/skills", commit: SHA2, path: "skills/pdf" } };
  const cli: CliRun = async (host, args) => {
    calls.push([host, ...args]);
    if (args[0] === "add") {
      if (args[1].includes("nope")) return { code: 2, json: { ok: false, error: "anthropics/nope: no SKILL.md" }, err: "anthropics/nope: no SKILL.md" };
      return { code: 0, json: { ok: true, action: "added", dry_run: true, skill: pdf, description: "PDF tools", skill_md_name: "pdf" } };
    }
    if (args[0] === "sync") return host === "worker" ? { code: 2, err: "ssh: connect timed out" } : { code: 0, json: { ok: true, green: true } };
    return { code: 0, json: { ok: true } };
  };
  const db: DB = openDb(path.join(dir, "c.db"));
  const app = createApp(db, { auth: o.auth, browser: { browserUrl: "http://127.0.0.1:9" }, teamSkills: { repoDir: repo, cli, syncHosts: ["main", "worker"] } });
  const store = createStore(db);
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = SAM) => {
    const res = await app.request(url, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  const manifest = () => JSON.parse(fs.readFileSync(path.join(repo, "skills/team-skills.json"), "utf8"));
  const originLog = () => git(origin, "log", "--format=%s", "main");
  return { dir, db, repo, origin, app, store, call, calls, manifest, originLog };
}

describe("T53-S4 manifest edits", () => {
  it("serializes like the CLI (sorted, indent 2, ASCII) and adds/removes by name", () => {
    const text = serializeManifest(MANIFEST as any);
    expect(text).toBe(JSON.stringify(MANIFEST, null, 2) + "\n");
    const added = JSON.parse(addToManifest(text, { name: "café", use_when: "naïve", source: { type: "local", path: "skills/x" } }));
    expect(added.skills.map((s: TeamSkill) => s.name)).toEqual(["café", "diagram", "diagram-design"]);
    expect(addToManifest(text, { name: "é", use_when: "x", source: { type: "local", path: "p" } })).toContain('"\\u00e9"');
    expect(removeFromManifest(text, "nope")).toBeUndefined();
    expect(JSON.parse(removeFromManifest(text, "diagram")!).skills.map((s: TeamSkill) => s.name)).toEqual(["diagram-design"]);
    expect(sourceUrl(MANIFEST.skills[1].source as any)).toBe(`https://github.com/cathrynlavery/diagram-design/tree/${SHA}/skills/diagram-design`);
    expect(sourceUrl({ type: "local", path: "skills/diagram" })).toBe("https://github.com/Acme/home_repo/tree/main/skills/diagram");
  });
});

describe("T53-S4 Team skills API", () => {
  it("lists the library with use_when, pinned source, used-by, and flags persona skills the library lacks", async () => {
    const t = setup();
    const w = t.store.createPersona({ name: "Writer", remit: "r", skills: ["diagram-design", "gh"], model: "opus", mayWrite: false });
    const r = await t.call("GET", "/api/team-skills");
    expect(r.status).toBe(200);
    expect(r.json.canEdit).toBe(true);
    expect(r.json.syncNote).toMatch(/within 10 min/);
    const dd = r.json.skills.find((s: any) => s.name === "diagram-design");
    expect(dd).toMatchObject({ useWhen: "a branded editorial diagram", source: { commit: SHA }, usedBy: [{ id: w.id, name: "Writer" }] });
    expect(dd.url).toContain(`/tree/${SHA}/`);
    expect(r.json.unknown).toEqual([{ skill: "gh", persona: { id: w.id, name: "Writer" } }]);
    // A persona run's curl is not the owner: it may read but not edit.
    expect((await t.call("GET", "/api/team-skills", undefined, { "x-console-run": "run_1" })).json.canEdit).toBe(false);
  });

  it("preview shows name, description and commit; confirm commits the manifest on main, pushes and syncs (worker down: its timer)", async () => {
    const t = setup();
    const p = await t.call("POST", "/api/team-skills/preview", { url: "https://github.com/anthropics/skills/tree/main/skills/pdf" });
    expect(p.status).toBe(200);
    expect(p.json).toMatchObject({ skill: { name: "pdf", source: { commit: SHA2 } }, description: "PDF tools", action: "added" });
    expect(t.calls[0]).toEqual(["main", "add", "https://github.com/anthropics/skills/tree/main/skills/pdf", "--dry-run", "--no-sync"]);
    expect(t.manifest().skills).toHaveLength(2); // a preview writes nothing

    const a = await t.call("POST", "/api/team-skills", { url: "https://github.com/anthropics/skills/tree/main/skills/pdf", commit: SHA2 });
    expect(a.status).toBe(201);
    expect(a.json.sha).toBeTruthy();
    expect(t.manifest().skills.map((s: TeamSkill) => s.name)).toEqual(["diagram", "diagram-design", "pdf"]);
    expect(t.originLog().split("\n")[0]).toBe(`Team skills: add pdf @ ${SHA2.slice(0, 12)} (Sam, via console)`);
    expect(a.json.sync).toEqual([
      { host: "main", ok: true, note: "synced" },
      { host: "worker", ok: false, note: expect.stringMatching(/not synced now \(ssh: connect timed out\); its timer syncs it within 10 min/) },
    ]);
  });

  it("refuses a confirm whose commit moved since the preview, a bad URL, and the CLI's own error", async () => {
    const t = setup();
    const moved = await t.call("POST", "/api/team-skills", { url: "https://github.com/anthropics/skills", commit: SHA });
    expect(moved.status).toBe(409);
    expect(moved.json.error.code).toBe("moved");
    expect((await t.call("POST", "/api/team-skills/preview", { url: "http://example.com/x" })).status).toBe(400);
    const bad = await t.call("POST", "/api/team-skills/preview", { url: "https://github.com/anthropics/nope" });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toContain("no SKILL.md");
    expect(t.manifest().skills).toHaveLength(2);
  });

  it("only Sam adds or removes: a persona run, a token call and a page-less curl are refused", async () => {
    const t = setup();
    for (const h of [{ "x-console-run": "run_1" }, { authorization: "Bearer x" }, {}] as Record<string, string>[]) {
      expect((await t.call("POST", "/api/team-skills/preview", { url: "https://github.com/anthropics/skills" }, h)).status).toBe(403);
      const d = await t.call("DELETE", "/api/team-skills/diagram", undefined, h);
      expect(d.status).toBe(403);
      expect(d.json.error.code).toBe("jordi_only");
    }
    expect(t.manifest().skills).toHaveLength(2);
  });

  it("removing a skill personas attach asks first (names them); confirmed, it leaves the library and those personas", async () => {
    const t = setup();
    const w = t.store.createPersona({ name: "Writer", remit: "r", skills: ["diagram-design", "diagram"], model: "opus", mayWrite: false });
    const first = await t.call("DELETE", "/api/team-skills/diagram-design");
    expect(first.status).toBe(409);
    expect(first.json.error).toMatchObject({ code: "in_use", usedBy: [{ id: w.id, name: "Writer" }] });
    expect(first.json.error.message).toContain("Writer");
    expect(t.manifest().skills).toHaveLength(2);
    const ok = await t.call("DELETE", "/api/team-skills/diagram-design?confirm=yes");
    expect(ok.status).toBe(200);
    expect(ok.json.detachedFrom).toEqual([{ id: w.id, name: "Writer" }]);
    expect(t.manifest().skills.map((s: TeamSkill) => s.name)).toEqual(["diagram"]);
    expect(t.store.getPersona(w.id)!.skills).toEqual(["diagram"]);
    expect(t.originLog().split("\n")[0]).toBe("Team skills: remove diagram-design (Sam, via console)");
    expect((await t.call("DELETE", "/api/team-skills/diagram-design?confirm=yes")).status).toBe(404);
  });
});

describe("T53-S4 world scope", () => {
  it("GET is TENANT_SAFE (used-by of the caller's world only); a world's agent token cannot add (T53-S6: owner only)", async () => {
    expect(isTenantSafe("GET", "/api/team-skills")).toBe(true);
    const t = setup({ auth: "on" });
    t.db.prepare("INSERT INTO tenants (id, name, created_at) VALUES ('social', 'Memo', '2026-11-01')").run();
    createStore(t.db, { tenant: "social" }).createPersona({ name: "Z Writer", remit: "r", skills: ["diagram-design"], model: "opus", mayWrite: false });
    t.store.createPersona({ name: "A Writer", remit: "r", skills: ["diagram-design"], model: "opus", mayWrite: false });
    const auth = createAuth(t.db);
    const { token } = auth.createToken({ tenant: "social", label: "t", createdBy: "test" });
    const r = await t.call("GET", "/api/team-skills", undefined, { authorization: `Bearer ${token}` });
    expect(r.status).toBe(200);
    expect(r.json.skills.find((s: any) => s.name === "diagram-design").usedBy.map((u: any) => u.name)).toEqual(["Z Writer"]);
    expect(r.json.canEdit).toBe(false);
    const p = await t.call("POST", "/api/team-skills/preview", { url: "https://github.com/anthropics/skills" }, { authorization: `Bearer ${token}` });
    expect(p.status).toBe(403);
    expect(p.json.error.code).toBe("owner_only");
  });
});
