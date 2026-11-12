import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createAuth, type AuthMode } from "../src/auth/identity.js";
import { isTenantSafe, judge } from "../src/auth/routeScope.js";
import type { SpinesJson } from "../src/adapters/spines.js";

/**
 * "Asked, no row yet" in other worlds. GET /api/asked-no-row answered 403 world_scope to a a social world repo
 * session on the social site (11 times in 6 min, 2026-11-01), the gap closed for /api/review-items. It is now per
 * world: each world lists only its own milestones' open Done-means lines (memoized per world), and the home world's list is unchanged.
 */
const A = "home";
const Z = "social";
const OUTSIDE = "203.0.113.7";
const spine = (code: string) => `# EPIC-${code.slice(1)}: Demo

## Done means

- [ ] ${code}-1 ${code === "E1" ? "ALPHA" : "SOCIAL"} line one.
- [x] ${code}-2 Done already.

## Current State

Status: active

## Issue Ledger

| Issue | Role | Owner / Assignment | Title | Status | Depends On | PR/Branch | Base | Latest Evidence | Last Verified | Next Action |
|---|---|---|---|---|---|---|---|---|---|---|
`;
const node = (p: string) => ({ id: p, path: p, title: "Demo", parent: null, status: "active", rollup_status: "active", dod: [], children: [], runnable: true }) as SpinesJson["nodes"][number];

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function worlds(mode: AuthMode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s9-"));
  for (const [repo, code] of [["home_repo", "E1"], ["social", "E2"]]) {
    fs.mkdirSync(path.join(dir, repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(dir, repo, "docs/spines"), { recursive: true });
    fs.writeFileSync(path.join(dir, repo, "docs/spines/root.md"), spine(code));
  }
  const db: DB = openDb(path.join(dir, "console.db"));
  const app = createApp(db, {
    auth: mode,
    read: {
      reposRoot: dir,
      seatsFile: path.join(dir, "seats.json"),
      listThreads: async () => [],
      spines: async () => ({ root: "docs/spines/root.md", orphans: [], mismatches: [], nodes: [node("docs/spines/root.md")] }),
    },
  });
  db.prepare("INSERT INTO tenants (id, name, skin, plan, created_at) VALUES (?, ?, 'social', 'internal', ?)").run(Z, Z, new Date().toISOString());
  const mA = createStore(db).createMilestone({ title: "home_repo", repo: "home_repo", path: "docs/spines/root.md", owner: "Sam", paused: false });
  const mZ = createStore(db, { tenant: Z }).createMilestone({ title: "social", repo: "social", path: "docs/spines/root.md", owner: "Sam", paused: false });
  const auth = createAuth(db);
  const zTok = auth.createToken({ tenant: Z, label: "social session" }).token;
  const aTok = auth.createToken({ tenant: A, label: "automated-checks" }).token;
  const get = async (bearer?: string) => {
    const res = await app.request("/api/asked-no-row", { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }, { incoming: { socket: { remoteAddress: bearer ? OUTSIDE : "127.0.0.1" } } });
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) };
  };
  const refusals = () => db.prepare("SELECT * FROM auth_events WHERE reason = 'world_scope'").all() as unknown[];
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { db, get, refusals, mA, mZ, zTok, aTok };
}

describe("T48-S9 route judge", () => {
  it("GET /api/asked-no-row is TENANT_SAFE; a social identity is never refused world_scope on it", () => {
    const w = worlds("shadow");
    const id = { kind: "token" as const, tenant: Z, tokenId: "tok_judge", label: "judge" };
    for (const m of ["GET", "HEAD"]) {
      expect(isTenantSafe(m, "/api/asked-no-row")).toBe(true);
      expect(judge(w.db, id, m, "/api/asked-no-row")).toEqual({ allow: true });
    }
    expect(isTenantSafe("POST", "/api/asked-no-row")).toBe(false);
    expect(isTenantSafe("GET", "/api/asked-no-row/x")).toBe(false);
  });
});

describe("T48-S9 auth on: each world lists only its own asked-no-row lines", () => {
  it("social gets 200 with its own line only, no world_scope refusal; home gets only its own", async () => {
    const w = worlds("on");
    const z = await w.get(w.zTok);
    expect(z.status).toBe(200);
    expect(z.json.items.map((i: any) => [i.milestoneId, i.id])).toEqual([[w.mZ.id, "E2-1"]]);
    expect(z.text).not.toContain("ALPHA");
    expect(z.text).not.toContain(w.mA.id);
    const a = await w.get(w.aTok);
    expect(a.status).toBe(200);
    expect(a.json.items.map((i: any) => [i.milestoneId, i.id])).toEqual([[w.mA.id, "E1-1"]]);
    expect(a.text).not.toContain("SOCIAL");
    expect(a.text).not.toContain(w.mZ.id);
    expect(w.refusals()).toEqual([]);
  });

  it("the memo is per world: home asking first never serves its list to social (and back)", async () => {
    const w = worlds("on");
    expect((await w.get(w.aTok)).json.items.map((i: any) => i.id)).toEqual(["E1-1"]);
    expect((await w.get(w.zTok)).json.items.map((i: any) => i.id)).toEqual(["E2-1"]);
    expect((await w.get(w.aTok)).json.items.map((i: any) => i.id)).toEqual(["E1-1"]);
    const [z, a] = await Promise.all([w.get(w.zTok), w.get(w.aTok)]); // concurrent reads share no in-flight list
    expect(z.json.items.map((i: any) => i.id)).toEqual(["E2-1"]);
    expect(a.json.items.map((i: any) => i.id)).toEqual(["E1-1"]);
  });

  it("home legacy trust (loopback, no token) is unchanged: home's lines only", async () => {
    const w = worlds("on");
    const l = await w.get();
    expect(l.status).toBe(200);
    expect(l.json.items.map((i: any) => i.id)).toEqual(["E1-1"]);
  });
});

describe("T48-S9 auth off: unchanged (home's milestones only)", () => {
  it("lists home's lines, never another world's", async () => {
    const w = worlds("off");
    const r = await w.get();
    expect(r.status).toBe(200);
    expect(r.json.items.map((i: any) => i.id)).toEqual(["E1-1"]);
  });
});
