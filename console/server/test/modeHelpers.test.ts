import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { forTenant } from "../src/store.js";
import { authModeFromEnv, createAuth, hashPassword, runWithAuth, trustedPeer, verifyPassword, type AuthMode, type Identity } from "../src/auth/identity.js";
import { ensureAuth } from "../src/auth/schema.js";
import { isTenantSafe, judge } from "../src/auth/routeScope.js";
import { notJordi } from "../src/status/mark.js";
import { setHostToken } from "../src/auth/owner.js";

const HOST = "ho_e21s3-host-owner-token-0123456789abcdef";

// login, sessions, agent tokens, CONSOLE_AUTH off/shadow/on, cross-tenant refusal over every route.

const A = "home";
const B = "social";
const cadence = { type: "interval" as const, everyMinutes: 60 };
const HOST1 = "100.64.0.10"; // tailnet
const HOST3 = "100.64.0.63";
const OUTSIDE = "203.0.113.7"; // e.g. Traefik's container or the internet

interface World {
  milestone: string;
  persona: string;
  assignment: string;
  run: string;
  ask: string;
  title: string;
}

function makeApp(mode: AuthMode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e21s3-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  db.prepare("INSERT INTO tenants (id, name, skin, plan, created_at) VALUES (?, ?, 'social', 'founding', ?)").run(B, B, new Date().toISOString());
  const seed = (t: string, title: string): World => {
    const s = forTenant(db, t);
    const m = s.createMilestone({ title, repo: `repo-${t}`, path: "docs/x.md", owner: "Sam", paused: false });
    const p = s.createPersona({ name: `persona-${t}`, remit: "r", skills: [], model: "opus", mayWrite: false });
    const as = s.createAssignment({ milestoneId: m.id, personaId: p.id, cadence, enabled: false });
    const run = s.createRun({ assignmentId: as.id, outcome: "idle", summary: `summary-${t}` });
    const ask = s.createNeedsJordi({ milestoneId: m.id, question: `question-${t}?`, proposedAction: "", status: "open" });
    return { milestone: m.id, persona: p.id, assignment: as.id, run: run.id, ask: ask.id, title };
  };
  const a = seed(A, "home-secret-milestone");
  const b = seed(B, "social-milestone");
  const app = createApp(db, { auth: mode, browser: { browserUrl: "http://127.0.0.1:9" } });
  const auth = createAuth(db);
  const req = async (method: string, url: string, o: { peer?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const res = await app.request(
      url,
      { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) },
      o.peer ? { incoming: { socket: { remoteAddress: o.peer } } } : {},
    );
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text, headers: res.headers };
  };
  /** Log in through the API; returns the Cookie header for later calls. */
  const login = async (email: string, password: string, tenant?: string, peer = OUTSIDE) => {
    const r = await req("POST", "/api/access/login", { peer, body: { email, password, ...(tenant ? { tenant } : {}) } });
    const set = r.headers.get("set-cookie") ?? "";
    return { r, cookie: set.split(";")[0] };
  };
  const user = (email: string, tenant: string, role: "owner" | "member" = "owner", password = "correct horse battery") => {
    const id = auth.addMember({ email, tenant, role });
    db.prepare("UPDATE users SET pw_hash = ? WHERE id = ?").run(hashPassword(password), id);
    return { email, password };
  };
  const events = () => db.prepare("SELECT * FROM auth_events ORDER BY id").all() as any[];
  const cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { app, db, auth, a, b, req, login, user, events, cleanup };
}
type T = ReturnType<typeof makeApp>;

let t: T;
afterEach(() => t?.cleanup());

describe("mode and helpers", () => {
  it("CONSOLE_AUTH defaults to off; only shadow and on switch it", () => {
    expect(authModeFromEnv({})).toBe("off");
    expect(authModeFromEnv({ CONSOLE_AUTH: "" })).toBe("off");
    expect(authModeFromEnv({ CONSOLE_AUTH: "yes" })).toBe("off");
    expect(authModeFromEnv({ CONSOLE_AUTH: "Shadow" })).toBe("shadow");
    expect(authModeFromEnv({ CONSOLE_AUTH: "on" })).toBe("on");
  });

  it("legacy trust: loopback and the tailnet only", () => {
    for (const p of ["127.0.0.1", "::1", "::ffff:127.0.0.1", HOST1, HOST3, "100.64.0.1", "100.127.255.254", "fd7a:115c:a1e0::1"]) expect(trustedPeer(p), p).toBe(true);
    for (const p of [undefined, "", OUTSIDE, "10.0.1.5", "172.17.0.1", "100.63.0.1", "100.128.0.1", "192.168.1.2"]) expect(trustedPeer(p), String(p)).toBe(false);
  });

  it("passwords: scrypt, salted, verified in constant time", () => {
    const h = hashPassword("correct horse battery");
    expect(h).toMatch(/^scrypt\$/);
    expect(h).not.toContain("correct");
    expect(hashPassword("correct horse battery")).not.toBe(h);
    expect(verifyPassword("correct horse battery", h)).toBe(true);
    expect(verifyPassword("wrong", h)).toBe(false);
    expect(verifyPassword("x", null)).toBe(false);
  });

  it("schema is additive and idempotent", () => {
    t = makeApp("off");
    const names = () => (t.db.prepare("SELECT name FROM sqlite_master ORDER BY name").all() as any[]).map((r) => r.name).join(",");
    const before = names();
    ensureAuth(t.db);
    ensureAuth(t.db);
    expect(names()).toBe(before);
    for (const table of ["users", "memberships", "sessions", "agent_tokens", "auth_setups", "auth_events"]) expect(before).toContain(table);
    expect(t.db.pragma("user_version", { simple: true })).toBe(24);
  });
});

describe("CONSOLE_AUTH=off (default): behaviour unchanged", () => {
  it("every caller is served as today, nothing is logged", async () => {
    t = makeApp("off");
    for (const peer of [undefined, OUTSIDE, "127.0.0.1"]) {
      const r = await t.req("GET", "/api/milestones", { peer });
      expect(r.status).toBe(200);
      expect(r.json.map((m: any) => m.id).sort()).toEqual([t.a.milestone, t.b.milestone].sort()); // unscoped, as before
    }
    expect((await t.req("GET", `/api/runs/${t.b.run}`, { peer: OUTSIDE })).status).toBe(200);
    expect(t.events()).toEqual([]);
  });

  it("createApp without the option reads CONSOLE_AUTH, unset = off", async () => {
    const prev = process.env.CONSOLE_AUTH;
    delete process.env.CONSOLE_AUTH;
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e21s3-env-"));
      const db = openDb(path.join(dir, "c.db"));
      const app = createApp(db, { browser: { browserUrl: "http://127.0.0.1:9" } });
      const r = await app.request("/api/milestones", {}, { incoming: { socket: { remoteAddress: OUTSIDE } } });
      expect(r.status).toBe(200);
      expect((await app.request("/api/me")).status).toBe(200);
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    } finally {
      if (prev !== undefined) process.env.CONSOLE_AUTH = prev;
    }
  });

  it("/api/me answers home and mode off", async () => {
    t = makeApp("off");
    const r = await t.req("GET", "/api/me");
    expect(r.json).toMatchObject({ mode: "off", identity: { kind: "legacy", tenantId: A }, tenant: { id: A, skin: "console" }, worlds: [] });
  });
});

describe("login and sessions", () => {
  beforeEach(() => {
    t = makeApp("on");
  });

  it("logs in with email + password: HttpOnly SameSite=Lax cookie, /api/me shows the session's world", async () => {
    const u = t.user("sam+memory@example.com", B);
    const { r, cookie } = await t.login(u.email, u.password);
    expect(r.status).toBe(200);
    const set = r.headers.get("set-cookie")!;
    expect(set).toMatch(/^console_session=/);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).toMatch(/Max-Age=2592000/);
    expect(r.json).toMatchObject({ mode: "on", identity: { kind: "session", tenantId: B, email: u.email, role: "owner" }, tenant: { id: B, skin: "social" } });
    const me = await t.req("GET", "/api/me", { peer: OUTSIDE, headers: { cookie } });
    expect(me.json.identity).toMatchObject({ kind: "session", tenantId: B });
    expect(me.json.worlds).toEqual([{ tenantId: B, tenantName: B, role: "owner" }]);
    // The raw session id is never stored.
    const raw = cookie.split("=")[1];
    expect(JSON.stringify(t.db.prepare("SELECT * FROM sessions").all())).not.toContain(raw);
  });

  it("Secure behind https (x-forwarded-proto)", async () => {
    const u = t.user("a@example.com", A);
    const r = await t.req("POST", "/api/access/login", { peer: OUTSIDE, headers: { "x-forwarded-proto": "https" }, body: { email: u.email, password: u.password } });
    expect(r.headers.get("set-cookie")).toMatch(/Secure/);
  });

  it("wrong password and unknown user get the same 401; 10 failures throttle", async () => {
    const u = t.user("a@example.com", A);
    const bad = await t.req("POST", "/api/access/login", { peer: OUTSIDE, body: { email: u.email, password: "nope" } });
    const unknown = await t.req("POST", "/api/access/login", { peer: OUTSIDE, body: { email: "who@example.com", password: "nope" } });
    expect([bad.status, unknown.status]).toEqual([401, 401]);
    expect(bad.json.error).toEqual(unknown.json.error);
    for (let i = 0; i < 9; i++) await t.req("POST", "/api/access/login", { peer: OUTSIDE, body: { email: u.email, password: "nope" } });
    const locked = await t.req("POST", "/api/access/login", { peer: OUTSIDE, body: { email: u.email, password: u.password } });
    expect(locked.status).toBe(429);
  });

  it("a login in two worlds picks one; switch issues a new session bound to the other world", async () => {
    const u = t.user("sam@example.com", A);
    t.auth.addMember({ email: u.email, tenant: B, role: "owner" });
    const choose = await t.req("POST", "/api/access/login", { peer: OUTSIDE, body: { email: u.email, password: u.password } });
    expect(choose.json.choose.map((w: any) => w.tenantId).sort()).toEqual([A, B].sort());
    expect(choose.headers.get("set-cookie")).toBeNull();
    const { cookie } = await t.login(u.email, u.password, B);
    expect((await t.req("GET", "/api/milestones", { peer: OUTSIDE, headers: { cookie } })).json.map((m: any) => m.id)).toEqual([t.b.milestone]);
    const sw = await t.req("POST", "/api/access/switch", { peer: OUTSIDE, headers: { cookie }, body: { tenant: A } });
    expect(sw.status).toBe(200);
    const cookie2 = sw.headers.get("set-cookie")!.split(";")[0];
    expect((await t.req("GET", "/api/milestones", { peer: OUTSIDE, headers: { cookie: cookie2 } })).json.map((m: any) => m.id)).toEqual([t.a.milestone]);
    // the old session ended
    expect((await t.req("GET", "/api/milestones", { peer: OUTSIDE, headers: { cookie } })).status).toBe(401);
    // a world the user is not in
    t.db.prepare("INSERT INTO tenants (id, name, created_at) VALUES ('other', 'other', ?)").run(new Date().toISOString());
    expect((await t.req("POST", "/api/access/switch", { peer: OUTSIDE, headers: { cookie: cookie2 }, body: { tenant: "other" } })).status).toBe(403);
  });

  it("logout ends the session", async () => {
    const u = t.user("a@example.com", A);
    const { cookie } = await t.login(u.email, u.password);
    expect((await t.req("GET", "/api/milestones", { peer: OUTSIDE, headers: { cookie } })).status).toBe(200);
    await t.req("POST", "/api/access/logout", { peer: OUTSIDE, headers: { cookie } });
    expect((await t.req("GET", "/api/milestones", { peer: OUTSIDE, headers: { cookie } })).status).toBe(401);
  });

  it("expired, disabled or membership-less sessions stop working", async () => {
    const u = t.user("a@example.com", B);
    const { cookie } = await t.login(u.email, u.password);
    t.db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await t.req("GET", "/api/milestones", { peer: OUTSIDE, headers: { cookie } })).status).toBe(401);
    const { cookie: c2 } = await t.login(u.email, u.password);
    t.db.prepare("DELETE FROM memberships").run();
    expect((await t.req("GET", "/api/milestones", { peer: OUTSIDE, headers: { cookie: c2 } })).status).toBe(401);
  });

  it("a one-time setup link sets the password (24 h, single use, 12+ characters)", async () => {
    t.auth.addMember({ email: "new@example.com", tenant: B });
    const { token } = t.auth.createSetup("new@example.com");
    expect((await t.req("POST", "/api/access/setup", { peer: OUTSIDE, body: { token, password: "short" } })).status).toBe(400);
    const ok = await t.req("POST", "/api/access/setup", { peer: OUTSIDE, body: { token, password: "a long enough password" } });
    expect(ok.json).toEqual({ email: "new@example.com" });
    expect((await t.req("POST", "/api/access/setup", { peer: OUTSIDE, body: { token, password: "another long password" } })).status).toBe(400);
    expect((await t.login("new@example.com", "a long enough password")).r.status).toBe(200);
    const late = t.auth.createSetup("new@example.com");
    t.db.prepare("UPDATE auth_setups SET expires_at = '2000-01-01T00:00:00.000Z' WHERE used_at IS NULL").run();
    expect((await t.req("POST", "/api/access/setup", { peer: OUTSIDE, body: { token: late.token, password: "a long enough password" } })).status).toBe(400);
  });

  it("the login page is open; other pages redirect to it; the API answers 401", async () => {
    const page = await t.req("GET", "/login", { peer: OUTSIDE });
    expect(page.status).toBe(200);
    expect(page.text).toContain("/api/access/login");
    const redirect = await t.req("GET", "/milestones/x", { peer: OUTSIDE });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("/login?next=%2Fmilestones%2Fx");
    const api = await t.req("GET", "/api/milestones", { peer: OUTSIDE });
    expect(api.status).toBe(401);
    expect(api.json.error.code).toBe("login_required");
    expect((await t.req("GET", "/api/health", { peer: OUTSIDE })).status).toBe(200);
    expect((await t.req("GET", "/api/me", { peer: OUTSIDE })).json.identity).toEqual({ kind: "none" });
  });
});

describe("agent tokens", () => {
  beforeEach(() => {
    t = makeApp("on");
  });

  it("a bearer token acts in its own world only, from any address; revoke ends it", async () => {
    const { token, info } = t.auth.createToken({ tenant: B, label: "memory personas" });
    expect(token).toMatch(/^at_/);
    expect(JSON.stringify(t.db.prepare("SELECT * FROM agent_tokens").all())).not.toContain(token);
    const h = { authorization: `Bearer ${token}` };
    const list = await t.req("GET", "/api/milestones", { peer: OUTSIDE, headers: h });
    expect(list.json.map((m: any) => m.id)).toEqual([t.b.milestone]);
    expect((await t.req("GET", `/api/milestones/${t.a.milestone}`, { peer: OUTSIDE, headers: h })).status).toBe(404);
    const run = await t.req("POST", "/api/runs", { peer: OUTSIDE, headers: h, body: { assignmentId: t.b.assignment, outcome: "idle", summary: "token run" } });
    expect(run.status).toBe(201);
    expect(t.db.prepare("SELECT tenant_id FROM runs WHERE id = ?").get(run.json.id)).toEqual({ tenant_id: B });
    expect(t.auth.revokeToken(B, info.id)).toBe(true);
    expect((await t.req("GET", "/api/milestones", { peer: OUTSIDE, headers: h })).status).toBe(401);
  });

  it("a bad bearer is refused even from loopback (no fall-back to legacy trust)", async () => {
    expect((await t.req("GET", "/api/milestones", { peer: "127.0.0.1", headers: { authorization: "Bearer at_nope" } })).status).toBe(401);
  });

  it("owners manage their world's tokens over the API; members and tokens cannot", async () => {
    const owner = t.user("o@example.com", B);
    const member = t.user("m@example.com", B, "member");
    const { cookie } = await t.login(owner.email, owner.password);
    const made = await t.req("POST", "/api/access/tokens", { peer: OUTSIDE, headers: { cookie }, body: { label: "box" } });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ tenantId: B, label: "box", createdBy: owner.email });
    expect(made.json.token).toMatch(/^at_/);
    const listed = await t.req("GET", "/api/access/tokens", { peer: OUTSIDE, headers: { cookie } });
    expect(listed.json.map((x: any) => x.id)).toEqual([made.json.id]);
    expect(JSON.stringify(listed.json)).not.toContain(made.json.token);
    const { cookie: mc } = await t.login(member.email, member.password);
    expect((await t.req("GET", "/api/access/tokens", { peer: OUTSIDE, headers: { cookie: mc } })).status).toBe(403);
    expect((await t.req("POST", "/api/access/tokens", { peer: OUTSIDE, headers: { authorization: `Bearer ${made.json.token}` }, body: { label: "x" } })).status).toBe(403);
    // bare legacy trust mints nothing; the console host manages the home world's tokens with its host owner token.
    // A the home world token id is not B's to revoke.
    expect((await t.req("POST", "/api/access/tokens", { peer: "127.0.0.1", body: { label: "mac sync" } })).status).toBe(403);
    setHostToken(HOST);
    const a9 = await t.req("POST", "/api/access/tokens", { peer: "127.0.0.1", headers: { authorization: `Bearer ${HOST}` }, body: { label: "mac sync" } });
    setHostToken(undefined);
    expect(a9.json.tenantId).toBe(A);
    expect((await t.req("DELETE", `/api/access/tokens/${a9.json.id}`, { peer: OUTSIDE, headers: { cookie } })).status).toBe(404);
    expect((await t.req("DELETE", `/api/access/tokens/${made.json.id}`, { peer: OUTSIDE, headers: { cookie } })).status).toBe(200);
  });
});

/** What today's agents send: personas' curls, the DM, desks, milestone chats, the watchdog, DM wakes from the worker server. */
const agentCalls = (w: World): [string, string, { peer: string; headers?: Record<string, string>; body?: unknown }][] => [
  ["GET", "/api/milestones", { peer: "127.0.0.1", headers: { "user-agent": "curl/8.5.0" } }],
  ["GET", "/api/health", { peer: "127.0.0.1" }],
  ["GET", `/api/milestones/${w.milestone}`, { peer: HOST1, headers: { "user-agent": "curl/8.5.0" } }],
  ["GET", "/api/personas", { peer: HOST3 }],
  ["GET", "/api/assignments", { peer: "::ffff:127.0.0.1" }],
  ["GET", `/api/runs?milestoneId=${w.milestone}`, { peer: "127.0.0.1", headers: { "x-run-id": w.run } }],
  ["POST", "/api/runs", { peer: HOST1, body: { assignmentId: w.assignment, outcome: "running", summary: "worker" } }],
  ["PATCH", `/api/runs/${w.run}`, { peer: HOST3, headers: { "x-run-id": w.run }, body: { outcome: "monitoring", summary: "x", nextCheckAt: "2026-10-28T00:30:00.000Z" } }],
  ["POST", "/api/needs-owner", { peer: "127.0.0.1", body: { milestoneId: w.milestone, question: "agent q?", proposedAction: "", status: "open" } }],
  ["GET", "/api/needs-owner?status=open", { peer: "127.0.0.1" }],
  ["GET", "/api/waiting-on-owner", { peer: "127.0.0.1", headers: { "x-console-run": "team-desk" } }],
  ["GET", "/api/desk/messages", { peer: "127.0.0.1", headers: { "x-console-run": "team-desk" } }],
  ["GET", `/api/milestones/${w.milestone}/chat/messages`, { peer: "127.0.0.1", headers: { "x-console-run": `milestone-chat:${w.milestone}` } }],
  ["GET", "/api/moving-now", { peer: HOST1 }],
  ["GET", "/api/status", { peer: HOST1 }],
  ["GET", "/api/hosts", { peer: "127.0.0.1" }],
  ["GET", "/api/secrets", { peer: "127.0.0.1" }],
  ["GET", "/api/usage", { peer: "127.0.0.1" }],
];

describe("agents are never locked out", () => {
  it("shadow: today's agent calls produce no would-deny line; behaviour is identical to off", async () => {
    const off = makeApp("off");
    const shadow = makeApp("shadow");
    try {
      const offStatuses = [];
      for (const [m, u, o] of agentCalls(off.a)) offStatuses.push(`${m} ${u.replace(off.a.milestone, "M").replace(off.a.run, "R")} ${(await off.req(m, u, o)).status}`);
      const shadowStatuses = [];
      for (const [m, u, o] of agentCalls(shadow.a)) shadowStatuses.push(`${m} ${u.replace(shadow.a.milestone, "M").replace(shadow.a.run, "R")} ${(await shadow.req(m, u, o)).status}`);
      expect(shadowStatuses).toEqual(offStatuses);
      expect(shadow.events()).toEqual([]);
    } finally {
      off.cleanup();
      shadow.cleanup();
    }
  });

  it("on: the same agent calls answer exactly as with auth off", async () => {
    const off = makeApp("off");
    const on = makeApp("on");
    try {
      const run = async (x: T) => {
        const out = [];
        for (const [m, u, o] of agentCalls(x.a)) out.push(`${m} ${u.replace(x.a.milestone, "M").replace(x.a.run, "R")} ${(await x.req(m, u, o)).status}`);
        return out;
      };
      expect(await run(on)).toEqual(await run(off));
      expect(on.events()).toEqual([]);
    } finally {
      off.cleanup();
      on.cleanup();
    }
  });

  it("shadow logs what on would refuse, refuses nothing, and splits agents from browsers", async () => {
    t = makeApp("shadow");
    // a curl from outside the tailnet with no token (would be 401), a browser through the proxy (would be 401)
    expect((await t.req("GET", "/api/milestones", { peer: OUTSIDE, headers: { "user-agent": "curl/8" } })).status).toBe(200);
    expect((await t.req("GET", "/api/milestones", { peer: "127.0.0.1", headers: { "x-forwarded-for": "1.2.3.4", "sec-fetch-site": "same-origin" } })).status).toBe(200);
    // a memory token reading the home world id (would be 404) and a world-scoped route (would be 403)
    const { token } = t.auth.createToken({ tenant: B, label: "z" });
    expect((await t.req("GET", `/api/milestones/${t.a.milestone}`, { peer: OUTSIDE, headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect((await t.req("GET", "/api/desk/messages", { peer: OUTSIDE, headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    const ev = t.events().map((e) => [e.mode, e.status, e.reason, e.kind, e.agent]);
    expect(ev).toEqual([
      ["shadow", 401, "login_required", "none", 1],
      ["shadow", 401, "login_required", "none", 0],
      ["shadow", 404, "cross_tenant", "token", 1],
      ["shadow", 403, "world_scope", "token", 1],
    ]);
    setHostToken(HOST); // the access log is an owner power (the console host's own token)
    const summary = await t.req("GET", "/api/access/events", { peer: "127.0.0.1", headers: { authorization: `Bearer ${HOST}` } });
    setHostToken(undefined);
    expect(summary.json).toMatchObject({ mode: "shadow", total: 4, agent: 3 });
    expect(JSON.stringify(summary.json)).not.toContain(token);
  });
});

describe("cross-tenant refusal over every route (E22-1 evidence)", () => {
  /** Fill a route's params with world A's ids; B calls it. */
  const fill = (p: string, a: World) =>
    p
      .replace(/^\/api\/milestones\/:id/, `/api/milestones/${a.milestone}`)
      .replace(/^\/api\/personas\/:id/, `/api/personas/${a.persona}`)
      .replace(/^\/api\/assignments\/:id/, `/api/assignments/${a.assignment}`)
      .replace(/^\/api\/runs\/:id/, `/api/runs/${a.run}`)
      .replace(/^\/api\/needs-owner\/:id/, `/api/needs-owner/${a.ask}`)
      .replace(/^\/api\/tenants\/:id/, `/api/tenants/${A}`)
      .replace(/^\/api\/hosts\/host3/, "/api/hosts/host3")
      .replace(/:code/g, "A-1")
      .replace(/:name/g, `repo-${A}`)
      .replace(/:token/g, "tok")
      .replace(/:file/g, "x.sh")
      .replace(/:id/g, "x");
  const snapshotA = (db: DB) =>
    JSON.stringify(
      ["milestones", "personas", "runs", "needs_jordi"].map((x) => db.prepare(`SELECT * FROM ${x} WHERE tenant_id = '${A}' ORDER BY id`).all()).concat([
        db.prepare(`SELECT * FROM assignments ORDER BY id`).all(),
      ]),
    );

  for (const kind of ["session", "token"] as const)
    it(`world B (${kind}) gets 404, 403 or only its own data on every registered route; A's rows never change`, async () => {
      t = makeApp("on");
      let h: Record<string, string>;
      if (kind === "session") {
        const u = t.user("sam+memory@example.com", B);
        h = { cookie: (await t.login(u.email, u.password)).cookie };
      } else h = { authorization: `Bearer ${t.auth.createToken({ tenant: B, label: "b" }).token}` };
      const routes = [...new Map(t.app.routes.filter((r) => r.method !== "ALL").map((r) => [`${r.method} ${r.path}`, r])).values()];
      routes.sort((x, y) => Number(x.path === "/api/access/logout") - Number(y.path === "/api/access/logout")); // logout last
      expect(routes.length).toBeGreaterThan(100);
      const before = snapshotA(t.db);
      const leaks: string[] = [];
      const statuses: Record<string, number> = {};
      for (const r of routes) {
        const url = fill(r.path, t.a);
        const res = await t.req(r.method, url, { peer: OUTSIDE, headers: h, body: ["GET", "DELETE"].includes(r.method) ? undefined : {} });
        statuses[`${r.method} ${r.path}`] = res.status;
        for (const secret of [t.a.milestone, t.a.persona, t.a.assignment, t.a.run, t.a.ask, t.a.title, `question-${A}`, `summary-${A}`, `repo-${A}`])
          if (res.status < 300 && res.text.includes(secret) && !url.includes(secret)) leaks.push(`${r.method} ${url} → ${res.status} leaks ${secret}`);
        if (res.status < 300 && url !== r.path && /\/(milestones|personas|assignments|runs|needs-owner|tenants)\//.test(url) && !/\/(health|me)$/.test(url))
          leaks.push(`${r.method} ${url} → ${res.status} (A's id answered)`);
      }
      expect(leaks).toEqual([]);
      expect(snapshotA(t.db)).toBe(before);
      // Every route B may reach is one's scoped store serves (or auth's own); everything else is 403 world_scope.
      expect(Object.entries(statuses).filter(([k, s]) => s === 401 && k !== "POST /api/access/login")).toEqual([]);
      const reachable = Object.entries(statuses).filter(([, s]) => s !== 403 && s !== 404).map(([k]) => k).sort();
      expect(reachable).toEqual(
        [
          "GET /api/health",
          "GET /landing", // a bare 302 to /landing/, which answers 404 to any world but the home world (landing.ts)
          "POST /api/public/testers", // the open signup form (writes only tester_signups, answers nothing of a world)
          "GET /api/public/pv", // epicspine.dev's page-view counter (a 1x1 image; counts known pages only, answers nothing of a world)
          "GET /api/inbox/team-cards", // B is the social world, a card world: its own idea cards only (empty here), never A's
          // B's owner logged in answers B's own idea cards (400 on an empty body); A's card ids are a 404; a token never (403)
          ...(kind === "session" ? ["POST /api/inbox/team-cards/:id/answer"] : []),
          "GET /api/public/steps-keep.js", // the steps kit's recorder keep (voice/keepJs.ts): a static script, no data
          "POST /api/public/stripe/tester", // the Stripe webhook (signature-checked; 503 here: no signing secret in tests)
          "POST /api/public/stripe/team", // Epic Team's Stripe webhook (signature-checked; 503 here: no signing secret in tests)
          "GET /api/me",
          "GET /api/milestones",
          "POST /api/milestones",
          "GET /api/personas",
          "POST /api/personas",
          "GET /api/assignments",
          "POST /api/assignments",
          "GET /api/runs",
          "POST /api/runs",
          "GET /api/runs/stats", // the Team home's wake counts, from the caller's world's runs only
          "GET /api/runs/active", // the Runs page's Active agents chart, from the caller's world's runs only
          "GET /api/runs/hosts", // the Runs page's Live runs by host chart, from the caller's world's runs only
          "GET /api/red-line", // the Team home's red line, from the caller's world's milestones only (null here)
          "GET /api/needs-owner",
          "POST /api/needs-owner",
          "GET /api/tenants",
          // read views scoped by world (perWorldRoutesConsole.test.ts: each world sees only its rows on each of them)
          "GET /api/desk/placements",
          "GET /api/owner-activity",
          "GET /api/owner-responses",
          "GET /api/messages",
          "GET /api/moving-now",
          "GET /api/next-wake",
          "GET /api/repos",
          "GET /api/status",
          "GET /api/threads",
          "GET /api/tickets",
          "GET /api/usage",
          "GET /api/waiting-on-owner",
          "POST /api/access/login",
          "POST /api/access/logout",
          "POST /api/access/setup",
          "POST /api/access/handoff", // open like setup; a bad link is 400, a good one only signs its own login in
          "POST /api/access/handoff/peek", // reads a link (who, which world) without spending it, same refusals
          // which sign-in buttons a site shows (no world in it), and the world chooser of a Google or GitHub sign-in
          // (400 without its one-time link, which names only the signed-in login's own worlds)
          "GET /api/access/oauth/providers",
          "GET /api/access/oauth/youtube/enable", // open: the team's one YouTube Allow (names only)
          "GET /api/access/oauth/youtube/finish", // open: the team's one YouTube Allow (names only)
          "GET /api/access/oauth/youtube/start", // open: the team's one YouTube Allow (names only)
          "GET /api/access/oauth/youtube/status", // open: the team's one YouTube Allow (names only)
          "POST /api/access/oauth/pick",
          "POST /api/access/oauth/pick/peek",
          // an owner session manages its world's tokens, a token never (403); switch with no world given is 403 for both
          ...(kind === "session" ? ["GET /api/access/tokens", "POST /api/access/tokens"] : []),
          // many humans: the roster and lists are read from the caller's own world's repos (none for B here: empty);
          // /people is a page with no data in it. The board, the time-limit sweep and invites are an owner's: B's owner
          // session reaches them for its own world (empty; an invite with no body is 400), its token never (403).
          "GET /api/people",
          "GET /people",
          ...(kind === "session" ? ["GET /api/people/board", "POST /api/people/escalate-due", "POST /api/people/invite"] : []),
          // the Mac's open token URLs answer 404 for a token the console never minted ("tok" here), so they are
          // no longer in this list; e21s9 and e59s6 prove a minted token still works.
          // the browser routes go to the caller's world's own instance (none for B here: 503, never the home world's)
          "POST /api/auth-sync",
          "GET /api/auth/sites",
          "GET /api/auth/reach",
          "GET /api/auth/egress",
          "GET /api/persona-templates",
          "GET /api/auth/sites/:id/audit",
          "DELETE /api/auth/sites/:id",
          "GET /api/team-browser/mcp",
          "GET /api/team-skills",
          "POST /api/team-browser/mcp",
          "DELETE /api/team-browser/mcp",
          // B's own secret backend (names of B's keys only; worldStoreEncryptedPer.test.ts)
          "GET /api/secrets",
          "POST /api/secrets",
          "POST /api/secrets/check",
          "POST /api/waiting-on-owner/:id/secret",
          // the Repo desk's links and answers (400 here: no query / empty body; routeList2.test.ts)
          "GET /api/desk/links",
          "POST /api/waiting-on-owner/:id/respond",
          "POST /api/waiting-on-owner/:id/snooze",
          // the social skin's reads and inbox writes, through the request-scoped store (B's own or empty; 400 on an
          // empty body/query; routeList3.test.ts). Its campaigns, social writes and per-milestone writes name A's id here: 404.
          "GET /api/cycle",
          "GET /api/freshness",
          "GET /api/spine-tree",
          "GET /api/tickets/sessions",
          "GET /api/unblocker-stats",
          "POST /api/owner-responses/:id/change",
          "POST /api/messages",
          "POST /api/waiting-on-owner/request-asks",
          // B's own review list (empty here); 400 on an empty body (relaunch's feedback is checked before the id;
          // another world's item id is a 404: routeJudge.test.ts)
          "GET /api/review-items",
          "POST /api/review-items",
          "POST /api/review-items/:id/relaunch",
          // B's own goal headers (empty here)
          "GET /api/review-goals",
          "GET /api/review-goals/closed",
          // Q3: 400 on an empty body (A's goal key is a 404)
          "POST /api/review-goals/reopen",
          // snooze checks its body (hours, days or until) before the id, as relaunch: 400 here
          "POST /api/review-items/:id/snooze",
          // B's own closed cards (its world's presses only); comment and reopen check the body (400 on an empty one)
          // and act only on a repo B's milestones read (A's repo is a 404, undoWindowCardPress.test.ts)
          "GET /api/closed-cards",
          "POST /api/closed-cards/comment",
          "POST /api/review-items/reopen",
          // B's own asked-no-row list (its own milestones only: routeJudge2.test.ts)
          "GET /api/asked-no-row",
          // B's own orphan commits (its own milestones' repos only, as asked-no-row)
          "GET /api/orphan-commits",
          // Play on a desk reply (400 on an empty body); stateless, it reads and writes no world's rows
          "POST /api/voice/speak",
          // B's own pills (its status, review rows and chats only); chat/seen 400 on an empty body (A's milestone
          // id is a 404: unreadRule.test.ts)
          "GET /api/counts",
          // the world switcher: B's own world, plus the worlds B's login is a member of (never A's: getApiCountsWorlds.test.ts)
          "GET /api/counts/worlds",
          "GET /api/desk/inbox", // B's own repos' notes only
          "POST /api/chat/seen",
          // rework: B's own Services list (empty here); its owner may add (400 on an empty body), a token never (403);
          // the services hub hub answers B's runs only (A's service and run ids: 404 / unknown run). reworkServicesRowsPer.test.ts
          "GET /api/mcp/services",
          ...(kind === "session" ? ["POST /api/mcp/services"] : []),
          "POST /api/mcp/hub",
          // option A: B's own Voice notes from the memory service card (not connected here); its owner's writes act on B only
          // (connect 503: switched off; settings 400 and test/disconnect "not connected"; the callback finds no sign-in of
          // B's and redirects), a token gets the card only (403 on writes). voiceNotesMemorySign.test.ts. Backfill acts on B's
          // own notes only (503 here: forwarding off). connectMemoryAsksVoice.test.ts
          "GET /api/connections/memory",
          ...(kind === "session"
            ? ["GET /api/connections/memory/callback", "POST /api/connections/memory/connect", "PUT /api/connections/memory/settings", "POST /api/connections/memory/test", "POST /api/connections/memory/disconnect", "POST /api/connections/memory/backfill"]
            : []),
          "GET /login",
        ].sort(),
      );
      // B's own lists hold only B (the sweep logged the session out last: log in again)
      if (kind === "session") h = { cookie: (await t.login("sam+memory@example.com", "correct horse battery")).cookie };
      const own = await t.req("GET", "/api/runs", { peer: OUTSIDE, headers: h });
      expect(own.json.map((r: any) => r.id)).toEqual([t.b.run]);
      const asks = await t.req("GET", "/api/needs-owner", { peer: OUTSIDE, headers: h });
      expect(asks.json.map((r: any) => r.id)).toEqual([t.b.ask]);
      expect((await t.req("GET", "/api/tenants", { peer: OUTSIDE, headers: h })).json.map((x: any) => x.id)).toEqual([B]);
      // social data (was posts): B reads its own world's, A's is a 404 (the sweep above)
      expect((await t.req("GET", `/api/tenants/${B}/social`, { peer: OUTSIDE, headers: h })).json).toMatchObject({ tenantId: B });
      expect(statuses["GET /api/tenants/:id/social"]).toBe(404);
    });

  it("home (legacy trust or session) gets 404 on B's ids, and sees only its own lists", async () => {
    t = makeApp("on");
    for (const path of [`/api/milestones/${t.b.milestone}`, `/api/milestones/${t.b.milestone}/tree`, `/api/runs/${t.b.run}`, `/api/personas/${t.b.persona}`, `/api/assignments/${t.b.assignment}/run-now`, `/api/needs-owner/${t.b.ask}`])
      expect((await t.req("GET", path, { peer: "127.0.0.1" })).status, path).toBe(404);
    expect((await t.req("POST", `/api/assignments/${t.b.assignment}/run-now`, { peer: "127.0.0.1", body: {} })).status).toBe(404);
    expect((await t.req("GET", "/api/milestones", { peer: "127.0.0.1" })).json.map((m: any) => m.id)).toEqual([t.a.milestone]);
    const u = t.user("sam+home@example.com", A);
    const { cookie } = await t.login(u.email, u.password);
    expect((await t.req("GET", `/api/runs/${t.b.run}`, { peer: OUTSIDE, headers: { cookie } })).status).toBe(404);
    expect((await t.req("GET", "/api/runs", { peer: OUTSIDE, headers: { cookie } })).json.map((r: any) => r.id)).toEqual([t.a.run]);
    // the home world keeps every other route (the platform's world)
    expect((await t.req("GET", "/api/desk/messages", { peer: OUTSIDE, headers: { cookie } })).status).toBe(200);
  });

  it("the tenant-safe list is exactly the scoped routes", () => {
    expect(isTenantSafe("GET", "/api/milestones")).toBe(true);
    expect(isTenantSafe("POST", "/api/milestones/x/mark")).toBe(true); // the path milestone only (rule 3)
    expect(isTenantSafe("POST", "/api/milestones/bootstrap")).toBe(false); // launches on any checkout: the home world-only
    expect(isTenantSafe("GET", "/api/desk/messages")).toBe(false); // made /waiting-on-owner world-scoped; the desk chat stays the home world's
    expect(isTenantSafe("GET", "/api/secrets")).toBe(true); // the world's own secret backend
    expect(isTenantSafe("GET", "/api/secrets/whatever")).toBe(false);
    t = makeApp("on");
    const legacy: Identity = { kind: "legacy", tenant: A, peer: "127.0.0.1" };
    expect(judge(t.db, legacy, "POST", "/api/milestones/bootstrap")).toEqual({ allow: true }); // a literal, not an id
    expect(judge(t.db, legacy, "GET", "/api/milestones/no-such-id")).toEqual({ allow: true }); // the handler's own 404
  });
});

describe("Sam-only guards map onto the session", () => {
  const page = { "sec-fetch-site": "same-origin" };
  const h = (o: Record<string, string>) => (n: string) => o[n.toLowerCase()];
  const sess = (role: "owner" | "member"): Identity => ({ kind: "session", tenant: A, userId: "u", email: "e", name: "", role });

  it("off and shadow: unchanged (browser page, no token, no run header)", () => {
    for (const mode of ["off", "shadow"] as const)
      runWithAuth({ mode, identity: { kind: "none" } }, () => {
        expect(notJordi(h(page))).toBeUndefined();
        expect(notJordi(h({ ...page, authorization: "Bearer at_x" }))).toMatch(/token/);
        expect(notJordi(h({ ...page, "x-run-id": "run_1" }))).toMatch(/persona run/);
        expect(notJordi(h({}))).toMatch(/console page/);
      });
    expect(notJordi(h(page))).toBeUndefined(); // no request context at all (today)
  });

  it("on: the owner's session or a tailnet browser (legacy) marks; a member, a token or a run never", () => {
    runWithAuth({ mode: "on", identity: sess("owner"), scope: A }, () => expect(notJordi(h(page))).toBeUndefined());
    runWithAuth({ mode: "on", identity: { kind: "legacy", tenant: A, peer: HOST1 }, scope: A }, () => expect(notJordi(h(page))).toBeUndefined());
    runWithAuth({ mode: "on", identity: sess("member"), scope: A }, () => expect(notJordi(h(page))).toMatch(/member/));
    runWithAuth({ mode: "on", identity: { kind: "token", tenant: A, tokenId: "t", label: "l" }, scope: A }, () => expect(notJordi(h(page))).toMatch(/logged in/));
    runWithAuth({ mode: "on", identity: sess("owner"), scope: A }, () => expect(notJordi(h({ ...page, "x-run-id": "run_1" }))).toMatch(/persona run/));
    runWithAuth({ mode: "on", identity: sess("owner"), scope: A }, () => expect(notJordi(h({}))).toMatch(/console page/));
  });

  it("on, over HTTP: a member's mark is refused, an agent token's mark is refused", async () => {
    t = makeApp("on");
    const m = t.user("m@example.com", A, "member");
    const { cookie } = await t.login(m.email, m.password);
    const r = await t.req("POST", `/api/milestones/${t.a.milestone}/mark`, { peer: OUTSIDE, headers: { cookie, ...page }, body: { verdict: "accomplished" } });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("jordi_only");
    const { token } = t.auth.createToken({ tenant: A, label: "a" });
    const r2 = await t.req("POST", `/api/milestones/${t.a.milestone}/mark`, { peer: OUTSIDE, headers: { authorization: `Bearer ${token}`, ...page }, body: { verdict: "accomplished" } });
    expect(r2.status).toBe(403);
  });
});
