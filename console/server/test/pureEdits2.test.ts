import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import {
  addGrant,
  appendDecision,
  approvalsFor,
  citedRows,
  editGrant,
  findGrantLine,
  grantIn,
  grantLine,
  grantPrefix,
  insertGrant,
  nextGrantCode,
  revokeGrant,
} from "../src/approvals.js";
import { cachedRunner, spinesPyRunner, type SpinesJson } from "../src/adapters/spines.js";
import { openDb, type DB } from "../src/db.js";
import type { ReadConfig } from "../src/routes/read.js";
import { createStore } from "../src/store.js";

/** the milestone Approvals tab: list own + inherited grants with uses; add / edit / revoke through the spine writer. */

const ROOT = `# EPIC-900: Test root

Spine ID: EPIC-900
Root spine: self
Integration policy: main-direct

## Goal
Prove grants.

## Current State
Owner: Delivery manager
Status: active
Waiting on: none

## Standing approvals

- [grant E900-G1 @Sam since 2026-10-20] Deploy the test app — limits: no other apps — expires: never
- [revoked E900-G2 2026-10-21 @Sam] Old scope — why: done

## Issue Ledger

| ID | Status | Title |
|---|---|---|
| T-1 | active | [child](child.md) |

## Decisions

| Date | Outcome | Decision / Attempt | Durable Summary | Evidence | Revisit When |
|---|---|---|---|---|---|
| 2026-10-22 | accepted | deployed v2 under E900-G1 | ok | x | — |
`;

const CHILD = `# EPIC-903: Child

Spine ID: EPIC-903
Parent spine: [root](root.md)
Integration policy: main-direct

## Goal
Child goal.

## Current State
Owner: Delivery manager
Status: active
Waiting on: none

## Standing approvals

- [grant E903-G1 @Sam since 2026-10-23] Restart the child worker — expires: 2099-01-01

## Decisions

| Date | Outcome | Decision / Attempt | Durable Summary | Evidence | Revisit When |
|---|---|---|---|---|---|
| 2026-10-23 | accepted | restarted under E900-G1, E903-G1 | ok | x | — |
`;

const NO_SECTION = `# EPIC-905: Bare

Spine ID: EPIC-905

## Current State
Status: active
Waiting on: none

## Issue Ledger

none
`;

describe("E908-S3 pure edits", () => {
  it("prefix and next code: own grants, else ask codes, else the id; highest G anywhere + 1, never reused", () => {
    expect(grantPrefix(CHILD, "EPIC-903")).toBe("E903");
    expect(grantPrefix("- [ask E909-A2: do @Sam since 2026-10-01] x", "EPIC-907")).toBe("E909");
    expect(grantPrefix(NO_SECTION, "EPIC-905")).toBe("E905");
    expect(grantPrefix("", "M2")).toBe("M2");
    expect(nextGrantCode(ROOT, "E900")).toBe("E900-G3"); // revoked G2 still counts
    expect(nextGrantCode(CHILD, "E903", ["E903-G4", "E900-G9"])).toBe("E903-G5");
    expect(nextGrantCode("a deleted line was cited under E903-G7 in Decisions", "E903")).toBe("E903-G8");
    expect(nextGrantCode("", "E905")).toBe("E905-G1");
  });

  it("grant line: doctrine tag, scope, limits, expires (never by default), context; separators stripped from input", () => {
    expect(grantLine("E903-G2", "2026-10-24", { scope: "Run the backfill — twice", limits: "staging only", expires: "2026-12-31" })).toBe(
      "- [grant E903-G2 @Sam since 2026-10-24] Run the backfill - twice — limits: staging only — expires: 2026-12-31",
    );
    expect(grantLine("E903-G2", "2026-10-24", { scope: "a\nb", context: "docs/x.md" })).toBe("- [grant E903-G2 @Sam since 2026-10-24] a b — expires: never — context: docs/x.md");
  });

  it("add: last bullet of the section + a Decisions row; a missing section is created after Current State", () => {
    const e = addGrant(CHILD, { prefix: "E903", date: "2026-10-24", grant: { scope: "Rotate the child's own key" } });
    if ("skip" in e) throw new Error(e.skip);
    expect(e.code).toBe("E903-G2");
    const lines = e.text.split("\n");
    const at = lines.indexOf(e.line);
    expect(lines[at - 1]).toContain("[grant E903-G1");
    expect(e.text).toContain("| 2026-10-24 | accepted | Sam via console: grant E903-G2 added | Rotate the child's own key | console commit | — |");
    // No `under <code>` in our own rows: they never count as uses.
    expect(citedRows(e.text, "c.md").map((r) => r.code)).toEqual(["E900-G1", "E903-G1"]);

    const bare = insertGrant(NO_SECTION, "- [grant E905-G1 @Sam since 2026-10-24] x — expires: never");
    expect(bare).toMatch(/Waiting on: none\n\n## Standing approvals\n\n- \[grant E905-G1 @Sam since 2026-10-24\] x — expires: never\n\n## Issue Ledger/);
    const withDecision = appendDecision(bare, { date: "2026-10-24", decision: "d | e", summary: "s" });
    expect(withDecision).toContain("## Decisions\n\n| Date | Outcome | Decision / Attempt | Durable Summary | Evidence | Revisit When |\n|---|---|---|---|---|---|\n| 2026-10-24 | accepted | d / e | s | console commit | — |");
  });

  it("edit keeps code, who and since; appends (edited <date>) to the scope once; refuses a revoked line", () => {
    const e = editGrant(ROOT, "E900-G1", { scope: "Deploy and roll back the test app", limits: "no other apps", expires: "2027-01-01" }, "2026-10-24");
    if ("skip" in e) throw new Error(e.skip);
    expect(e.line).toBe("- [grant E900-G1 @Sam since 2026-10-20] Deploy and roll back the test app (edited 2026-10-24) — limits: no other apps — expires: 2027-01-01");
    expect(e.text).toContain("| 2026-10-24 | accepted | Sam via console: grant E900-G1 edited |");
    const again = editGrant(e.text, "E900-G1", { scope: "Deploy and roll back the test app (edited 2026-10-24)" }, "2026-10-25");
    if ("skip" in again) throw new Error(again.skip);
    expect(again.line).toBe("- [grant E900-G1 @Sam since 2026-10-20] Deploy and roll back the test app (edited 2026-10-25) — expires: never");
    expect(editGrant(ROOT, "E900-G2", { scope: "x" }, "2026-10-24")).toEqual({ skip: "grant E900-G2 is revoked: add a new grant instead" });
    expect(editGrant(ROOT, "E900-G9", { scope: "x" }, "2026-10-24")).toMatchObject({ skip: expect.stringContaining("not under") });
  });

  it("revoke matches the doctrine form `[revoked <code> <date> @<who>] <scope> — why: <reason>`", () => {
    const e = revokeGrant(ROOT, "E900-G1", "the app is retired", "2026-10-24");
    if ("skip" in e) throw new Error(e.skip);
    expect(e.line).toBe("- [revoked E900-G1 2026-10-24 @Sam] Deploy the test app — why: the app is retired");
    expect(findGrantLine(e.text, "E900-G1")).toMatchObject({ kind: "revoked", scope: "Deploy the test app", fields: { why: "the app is retired" } });
    expect(e.text).toContain("| 2026-10-24 | accepted | Sam via console: grant E900-G1 revoked | the app is retired |");
    expect(revokeGrant(ROOT, "E900-G2", "", "2026-10-24")).toEqual({ skip: "grant E900-G2 is revoked already" });
  });

  it("input: scope required, expires YYYY-MM-DD|never and not past", () => {
    expect(grantIn({ scope: "" })).toMatch(/scope/);
    expect(grantIn({ scope: "x", expires: "soon" })).toMatch(/expires/);
    expect(grantIn({ scope: "x", expires: "2001-01-01" })).toMatch(/past/);
    expect(grantIn({ scope: " x ", limits: "", expires: "never" })).toEqual({ scope: "x", expires: "never" });
  });
});

describe("E908-S3 list from spines.py grants", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e8s3-list-"));
    fs.mkdirSync(path.join(dir, "docs/spines"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs/spines/root.md"), ROOT);
    fs.writeFileSync(path.join(dir, "docs/spines/child.md"), CHILD);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = (code: string, state: string, source: string, inherited: boolean, uses: number) => ({
    code, who: "Sam", scope: `scope ${code}`, limits: null, expires: null, context: null, since: "2026-10-20", state, revoked: null, why: null, source, inherited, uses,
  });
  const fixture: SpinesJson = {
    root: "docs/spines/root.md",
    orphans: [],
    mismatches: [],
    nodes: [
      { id: "EPIC-900", path: "docs/spines/root.md", title: "Root", parent: null, status: "active", rollup_status: "active", dod: [], children: ["docs/spines/child.md"],
        grants: [g("E900-G1", "active", "docs/spines/root.md", false, 2), g("E900-G2", "revoked", "docs/spines/root.md", false, 0)] } as never,
      { id: "EPIC-903", path: "docs/spines/child.md", title: "Child", parent: "docs/spines/root.md", status: "active", rollup_status: "active", dod: [], children: [],
        grants: [g("E903-G1", "active", "docs/spines/child.md", false, 1), g("E900-G1", "active", "docs/spines/root.md", true, 2), g("E900-G2", "revoked", "docs/spines/root.md", true, 0)] } as never,
    ],
  };

  it("own first, then inherited with source; uses linked to the Decisions rows over the tree", () => {
    const v = approvalsFor(fixture, "docs/spines/child.md", dir);
    expect(v.grants.map((x) => [x.code, x.state, x.source, x.inherited, x.uses])).toEqual([
      ["E903-G1", "active", "docs/spines/child.md", false, 1],
      ["E900-G1", "active", "docs/spines/root.md", true, 2],
      ["E900-G2", "revoked", "docs/spines/root.md", true, 0],
    ]);
    expect(v.grants[1].useRows).toEqual([
      { path: "docs/spines/root.md", line: 30, date: "2026-10-22", text: "deployed v2 under E900-G1" },
      { path: "docs/spines/child.md", line: 23, date: "2026-10-23", text: "restarted under E900-G1, E903-G1" },
    ]);
    expect(approvalsFor({ ...fixture, nodes: [{ ...fixture.nodes[1], grants: undefined } as never] }, "docs/spines/child.md", dir).note).toMatch(/does not report grants/);
  });
});

// ---------- API, against a real git origin and the real spines.py ----------

const SKILL = [process.env.EPICSPINE_SKILL_DIR, path.join(os.homedir(), "github/epicspine-skill/skill/epic-spine"), path.join(os.homedir(), ".agents/skills/epic-spine")]
  .filter((d): d is string => !!d)
  .find((d) => fs.existsSync(path.join(d, "scripts/spines.py")));
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

describe.skipIf(!SKILL)("E908-S3 API (git + spines.py)", () => {
  let tmp: string;
  let origin: string;
  let repo: string;
  let db: DB;
  const savedEnv = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };
  beforeEach(() => {
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e8s3-"));
    origin = path.join(tmp, "origin.git");
    git(tmp, "init", "-q", "--bare", "-b", "main", origin);
    const seed = path.join(tmp, "seed");
    git(tmp, "clone", "-q", origin, seed);
    git(seed, "checkout", "-q", "-b", "main");
    fs.mkdirSync(path.join(seed, "docs/spines"), { recursive: true });
    fs.writeFileSync(path.join(seed, "docs/spines/root.md"), ROOT);
    fs.writeFileSync(path.join(seed, "docs/spines/child.md"), CHILD);
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "seed");
    git(seed, "push", "-q", "origin", "main");
    repo = path.join(tmp, "demo");
    git(tmp, "clone", "-q", origin, repo);
  });
  afterEach(() => {
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const [k, v] of [["GIT_CONFIG_GLOBAL", savedEnv.g], ["GIT_CONFIG_SYSTEM", savedEnv.s]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const setup = (o: { dm?: boolean } = {}) => {
    db = openDb(path.join(tmp, "console.db"));
    const readCfg: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [], spines: cachedRunner(spinesPyRunner(SKILL!, { timeoutMs: 50_000 })) };
    const app = createApp(db, { read: readCfg });
    const store = createStore(db);
    const m = store.createMilestone({ title: "Child", repo: "demo", path: "docs/spines/child.md", owner: "", paused: false });
    if (o.dm) {
      const p = store.createPersona({ name: "Delivery Manager", remit: "run the milestone", skills: [], model: "opus", mayWrite: true });
      store.createAssignment({ personaId: p.id, milestoneId: m.id, cadence: { type: "interval", everyMinutes: 60 } as never, enabled: true });
    }
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : undefined };
    };
    return { call, m };
  };
  const spine = (rel: string) => fs.readFileSync(path.join(repo, rel), "utf8");
  const originFile = (rel: string) => git(origin, "show", `main:${rel}`);
  /** validate_spine.py --trackable advisories (grants.advisory: unreadable lines, reused codes, use after revoke). */
  const validate = (rel: string): Set<string> => {
    let out: string;
    try {
      out = execFileSync("python3", [path.join(SKILL!, "scripts/validate_spine.py"), "--trackable", "--json", rel], { cwd: repo, encoding: "utf8", env: ENV });
    } catch (e) {
      out = String((e as { stdout?: string }).stdout ?? ""); // exit 1 = not trackable; the JSON is still printed
    }
    const parsed = JSON.parse(out) as { advisory?: string[] }[] | { advisory?: string[] };
    return new Set((Array.isArray(parsed) ? parsed : [parsed]).flatMap((r) => r.advisory ?? []));
  };

  it("the validator check is live: a reused code and an unreadable line are advisories", async () => {
    const rel = "docs/spines/child.md";
    expect(validate(rel)).toEqual(new Set());
    fs.writeFileSync(path.join(repo, rel), CHILD.replace("- [grant E903-G1", "- [grant E900-G1 @Sam since 2026-10-24] dup\n- bogus line\n- [grant E903-G1"));
    const found = [...validate(rel)].join("\n");
    expect(found).toMatch(/E900-G1 is used twice/);
    expect(found).toMatch(/not a form the tools read/);
  }, 60_000);

  it("lists own + inherited with source, state and uses", async () => {
    const { call, m } = setup();
    const r = await call("GET", `/api/milestones/${m.id}/approvals`);
    expect(r.status).toBe(200);
    expect(r.json.path).toBe("docs/spines/child.md");
    expect(r.json.nextCode).toBe("E903-G2");
    expect(r.json.grants.map((g: any) => [g.code, g.state, g.source, g.inherited, g.uses, g.useRows.length])).toEqual([
      ["E903-G1", "active", "docs/spines/child.md", false, 1, 1],
      ["E900-G1", "active", "docs/spines/root.md", true, 2, 2],
      ["E900-G2", "revoked", "docs/spines/root.md", true, 0, 0],
    ]);
  }, 120_000);

  it("add writes the next code + line + Decisions row, commits and pushes; no new grant advisories", async () => {
    const { call, m } = setup();
    const before = validate("docs/spines/child.md");
    const r = await call("POST", `/api/milestones/${m.id}/approvals`, { scope: "Rotate the child's own API key", limits: "this app only", expires: "never" });
    expect(r.status).toBe(201);
    const today = new Date().toISOString().slice(0, 10);
    expect(r.json).toMatchObject({ code: "E903-G2", path: "docs/spines/child.md", line: `- [grant E903-G2 @Sam since ${today}] Rotate the child's own API key — limits: this app only — expires: never` });
    expect(r.json.wake).toBeUndefined(); // no persona assigned
    expect(spine("docs/spines/child.md")).toContain(r.json.line);
    expect(originFile("docs/spines/child.md")).toContain(r.json.line);
    expect(originFile("docs/spines/child.md")).toContain("Sam via console: grant E903-G2 added");
    expect(git(repo, "log", "-1", "--format=%s")).toBe("Standing approval E903-G2 added (Sam, via console)");
    expect(r.json.view.grants[0]).toMatchObject({ code: "E903-G1" });
    expect(r.json.view.grants.find((g: any) => g.code === "E903-G2")).toMatchObject({ state: "active", scope: "Rotate the child's own API key", limits: "this app only", since: today, inherited: false });
    const after = validate("docs/spines/child.md");
    expect([...after].filter((l) => !before.has(l))).toEqual([]);
  }, 120_000);

  it("concurrent adds go through the one lock: distinct codes, both pushed", async () => {
    const { call, m } = setup();
    const [a, b] = await Promise.all([
      call("POST", `/api/milestones/${m.id}/approvals`, { scope: "First" }),
      call("POST", `/api/milestones/${m.id}/approvals`, { scope: "Second" }),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(new Set([a.json.code, b.json.code])).toEqual(new Set(["E903-G2", "E903-G3"]));
    const text = originFile("docs/spines/child.md");
    expect(text).toContain("] First — expires: never");
    expect(text).toContain("] Second — expires: never");
    expect(git(repo, "status", "--porcelain")).toBe("");
  }, 120_000);

  it("edit keeps the code; revoke writes the doctrine form and spines.py then reports it revoked; the DM is woken", async () => {
    const { call, m } = setup({ dm: true });
    const e = await call("PUT", `/api/milestones/${m.id}/approvals/E903-G1`, { scope: "Restart and drain the child worker", expires: "2099-01-01" });
    expect(e.status).toBe(201);
    const today = new Date().toISOString().slice(0, 10);
    expect(e.json.line).toBe(`- [grant E903-G1 @Sam since 2026-10-23] Restart and drain the child worker (edited ${today}) — expires: 2099-01-01`);
    // The cycle is off in tests: the wake was tried (DM switched on) and says why it did not start.
    expect(e.json.wake).toEqual({ error: expect.stringMatching(/cycle is off/) });
    expect(e.json.view.grants.find((g: any) => g.code === "E903-G1")).toMatchObject({ state: "active", scope: `Restart and drain the child worker (edited ${today})` });

    // Revoking an inherited grant writes at its source (the parent spine).
    const r = await call("POST", `/api/milestones/${m.id}/approvals/E900-G1/revoke`, { why: "the app is retired" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ path: "docs/spines/root.md", line: `- [revoked E900-G1 ${today} @Sam] Deploy the test app — why: the app is retired` });
    expect(originFile("docs/spines/root.md")).toContain(r.json.line);
    expect(originFile("docs/spines/root.md")).toContain("Sam via console: grant E900-G1 revoked");
    const g = r.json.view.grants.find((x: any) => x.code === "E900-G1");
    expect(g).toMatchObject({ state: "revoked", revoked: today, why: "the app is retired", inherited: true });
    // Raw spines.py agrees.
    const raw = JSON.parse(execFileSync("python3", [path.join(SKILL!, "scripts/spines.py"), "--json", "--repo", repo], { encoding: "utf8" }));
    expect(raw.nodes.find((n: any) => n.path === "docs/spines/root.md").grants.find((x: any) => x.code === "E900-G1").state).toBe("revoked");

    const again = await call("POST", `/api/milestones/${m.id}/approvals/E900-G1/revoke`, {});
    expect(again.status).toBe(409);
    const edit = await call("PUT", `/api/milestones/${m.id}/approvals/E900-G2`, { scope: "x" });
    expect(edit.status).toBe(409);
    expect((await call("PUT", `/api/milestones/${m.id}/approvals/E909-G9`, { scope: "x" })).status).toBe(404);
    expect((await call("POST", `/api/milestones/${m.id}/approvals`, { scope: "" })).status).toBe(400);
    // Our edit, revoke and Decisions rows leave no grant advisories behind.
    expect(validate("docs/spines/child.md")).toEqual(new Set());
    expect(validate("docs/spines/root.md")).toEqual(new Set());
  }, 180_000);
});
