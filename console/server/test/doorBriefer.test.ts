import { describe, expect, it } from "vitest";
import { isDoorSafe, isTenantSafe } from "../src/auth/routeScope.js";

// On the social customer site the owner's login is a door (plain) session, judged by TENANT_SAFE and
// DOOR_SAFE. The briefer's state read was on neither, so /marketing got a 403 and drew no Call button at all.
const both = (m: string, p: string) => isTenantSafe(m, p) && isDoorSafe(m, p);

describe("the social briefer's Call reaches the door", () => {
  it("every call route of /api/voice/marketing is on both lists", () => {
    for (const [m, p] of [
      ["GET", "/api/voice/marketing/state"],
      ["GET", "/api/voice/marketing/calls"],
      ["POST", "/api/voice/marketing/calls"],
      ["POST", "/api/voice/marketing/active/end"],
      ["POST", "/api/voice/marketing/calls/vc_1/beat"],
      ["POST", "/api/voice/marketing/calls/vc_1/usage"],
      ["POST", "/api/voice/marketing/calls/vc_1/end"],
      ["POST", "/api/voice/marketing/calls/vc_1/ask"],
      ["POST", "/api/voice/marketing/calls/vc_1/tool"],
      ["POST", "/api/voice/marketing/calls/vc_1/relay"],
      ["POST", "/api/voice/marketing/calls/vc_1/lookup"],
      ["GET", "/api/voice/marketing/calls/vc_1/status"],
      ["GET", "/api/voice/marketing/calls/vc_1/ask/a_1"],
    ])
      expect(both(m, p), `${m} ${p}`).toBe(true);
  });
  it("only the briefer: the other own calls stay off the door", () => {
    for (const p of ["/api/voice/strategy/state", "/api/voice/briefing/state", "/api/voice/marketing/secret", "/api/voice/marketing/calls/a/b/end"])
      expect(both("GET", p), p).toBe(false);
  });
});

describe("the social briefer's Call in the owner's own workspace on a customer site", () => {
  const setup = async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const Database = (await import("better-sqlite3")).default;
    const { homeRepo } = await import("../src/identity.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "briefer-"));
    fs.mkdirSync(path.join(root, homeRepo(), "docs"), { recursive: true });
    fs.writeFileSync(path.join(root, homeRepo(), "docs", "workspace-data.json"), JSON.stringify({ repo: "Owner1/home-data", checkout: "home-data" }));
    process.env.REPOS_ROOT = root;
    const db = new Database(":memory:");
    db.exec("CREATE TABLE world_repos (world TEXT PRIMARY KEY, repo TEXT)");
    db.prepare("INSERT INTO world_repos VALUES (?, ?)").run("w-own", "owner1/home-data");
    db.prepare("INSERT INTO world_repos VALUES (?, ?)").run("w-other", "owner1/other-data");
    return db;
  };
  const session = (tenant: string, role = "owner", extra = {}) => ({ kind: "session", tenant, userId: "u1", email: "sam@example.com", name: "Sam", role, ...extra }) as any;

  it("the judge lets his owner login there reach every call route", async () => {
    const db = await setup();
    const { judge, isHomeDataWorld } = await import("../src/auth/routeScope.js");
    expect(isHomeDataWorld(db as any, "w-own")).toBe(true);
    expect(isHomeDataWorld(db as any, "w-other")).toBe(false);
    for (const [m, p] of [
      ["GET", "/api/voice/marketing/state"],
      ["POST", "/api/voice/marketing/calls"],
      ["POST", "/api/voice/marketing/calls/vc_1/relay"],
      // the partner's lookups (a live call once got 403 world_scope on its posts lookup from here)
      ["POST", "/api/voice/marketing/calls/vc_1/lookup"],
    ])
      expect(judge(db as any, session("w-own"), m, p).allow, `${m} ${p}`).toBe(true);
    // only the briefer: his other screens there keep their own rules
    expect(judge(db as any, session("w-own"), "GET", "/api/voice/strategy/state").allow).toBe(false);
  });

  it("the call answers there as the home world; a member, another world or the door get no call", async () => {
    const db = await setup();
    const { Hono } = await import("hono");
    const { mountOwnCall } = await import("../src/voice/routes.js");
    const { runWithAuth, currentAuth } = await import("../src/auth/identity.js");
    const { isHomeDataWorld } = await import("../src/auth/routeScope.js");
    const { homeWorld } = await import("../src/identity.js");
    const api = new Hono();
    const voice = { state: () => ({ available: true, enabled: true }) } as any;
    mountOwnCall(api, "/voice/marketing", voice, { world: () => currentAuth()?.scope, ownWorld: (w) => isHomeDataWorld(db as any, w) }, "The briefer");
    const state = async (identity: any) =>
      (await runWithAuth({ mode: "on", identity, scope: identity.tenant }, () => api.request("/voice/marketing/state"))).json() as Promise<any>;
    expect((await state(session("w-own"))).available).toBe(true);
    expect((await state(session("w-own", "member"))).available).toBe(false);
    expect((await state(session("w-other"))).available).toBe(false);
    expect((await state(session("w-own", "owner", { door: true }))).available).toBe(false);
    expect((await state(session(homeWorld()))).available).toBe(true);
  });

  it("his owner login on the social site (a declared customer login, its own world) calls; anyone else gets a link, never a call", async () => {
    const db = await setup();
    const { Hono } = await import("hono");
    const { mountOwnCall } = await import("../src/voice/routes.js");
    const { runWithAuth, currentAuth } = await import("../src/auth/identity.js");
    const { isHomeDataWorld } = await import("../src/auth/routeScope.js");
    const api = new Hono();
    const voice = { state: () => ({ available: true, enabled: true }) } as any;
    const mine = new Set(["owner-social@example.com"]);
    mountOwnCall(api, "/voice/marketing", voice, { world: () => currentAuth()?.scope, ownWorld: (w, e) => isHomeDataWorld(db as any, w) || mine.has(e.toLowerCase()), page: "/marketing" }, "The briefer");
    const state = async (identity: any) =>
      (await runWithAuth({ mode: "on", identity, scope: identity.tenant }, () => api.request("/voice/marketing/state"))).json() as Promise<any>;
    const social = (role = "owner", extra = {}) => ({ ...session("w-social", role, extra), email: "Owner-Social@example.com" });
    expect((await state(social())).available).toBe(true);
    expect((await state(social("member"))).available).toBe(false);
    expect((await state(social("owner", { door: true }))).available).toBe(false);
    const other = await state(session("w-social"));
    expect(other.available).toBe(false);
    expect(other.elsewhere).toMatch(/^https?:\/\/[^/]+\/marketing$/);
  });
});
