import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { forTenant } from "../src/store.js";
import { createAuth, hashPassword } from "../src/auth/identity.js";
import { ensureAuth } from "../src/auth/schema.js";
import { mountAuth } from "../src/auth/gate.js";
import { judge } from "../src/auth/routeScope.js";
import { mountOAuth, type SignupInput } from "../src/auth/oauth.js";
import { LOGIN_PAGE } from "../src/auth/loginPage.js";
import { mailBody, mailFrom, type Mail } from "../src/auth/emailAccess.js";

/** email sign-up (a confirm link) and password reset on the customer sites. */
const TEAM = "cloud.example.com";
const SOCIAL = "cloud.example.org";
const HOSTS = `${TEAM}=team,${SOCIAL}=social`;

function setup(o: { env?: NodeJS.ProcessEnv; ready?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e88s4-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  ensureAuth(db);
  const app = new Hono();
  const api = new Hono();
  const auth = mountAuth(app, api, { db, store: forTenant(db, "home"), mode: "on" });
  const mails: Mail[] = [];
  const signups: SignupInput[] = [];
  const at = new Date().toISOString();
  const signup = async (i: SignupInput) => {
    signups.push(i);
    const world = `${i.product === "team" ? "et" : "es"}-mail-${signups.length}`;
    db.prepare("INSERT INTO tenants (id, name, skin, plan, created_at) VALUES (?, ?, ?, ?, ?)").run(world, "New", i.product === "social" ? "social" : "console", "team", at);
    createAuth(db).addMember({ email: i.email, tenant: world, role: "owner", name: i.name });
    return { world };
  };
  mountOAuth(api, {
    db,
    auth,
    signup,
    creds: async () => undefined,
    env: { NODE_ENV: "test", CONSOLE_CUSTOMER_HOSTS: HOSTS, ...o.env },
    mail: { send: async (m) => (mails.push(m), { ok: true, id: `msg-${mails.length}` }), ready: async () => o.ready !== false },
  });
  app.route("/api", api);
  const req = async (method: string, url: string, r: { host?: string; cookie?: string; body?: unknown; ip?: string } = {}) => {
    const headers: Record<string, string> = { host: r.host ?? TEAM, "x-forwarded-proto": "https" };
    if (r.cookie) headers.cookie = r.cookie;
    if (r.body !== undefined) headers["content-type"] = "application/json";
    const res = await app.request(url, { method, headers, body: r.body === undefined ? undefined : JSON.stringify(r.body) }, { incoming: { socket: { remoteAddress: r.ip ?? "203.0.113.9" } } });
    const text = await res.text();
    const cookies = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]);
    return { status: res.status, json: text.startsWith("{") ? JSON.parse(text) : undefined, cookies };
  };
  const linkOf = (m: Mail, kind: "confirm" | "reset") => new RegExp(`#${kind}=([\\w-]+)`).exec(m.text)?.[1] ?? "";
  return { db, req, mails, signups, linkOf, cleanup: () => (db.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}

describe("email sign-up and password reset", () => {
  let t: ReturnType<typeof setup> | undefined;
  beforeEach(() => vi.stubEnv("CONSOLE_CUSTOMER_HOSTS", HOSTS));
  afterEach(() => {
    t?.cleanup();
    t = undefined;
    vi.unstubAllEnvs();
  });

  it("the routes need no identity", () => {
    const db = openDb(":memory:");
    for (const [m, p] of [
      ["GET", "/api/access/email/status"],
      ["POST", "/api/access/email/signup"],
      ["POST", "/api/access/email/confirm"],
      ["POST", "/api/access/email/reset"],
      ["POST", "/api/access/email/reset/finish"],
    ])
      expect(judge(db, { kind: "none" }, m, p), p).toEqual({ allow: true });
    expect(judge(db, { kind: "none" }, "POST", "/api/access/email/other")).toMatchObject({ allow: false, status: 401 });
  });

  it("a stranger signs up on the team site: one mail to that address, the link makes the world and signs in once", async () => {
    t = setup();
    expect((await t.req("GET", "/api/access/email/status")).json).toEqual({ email: true, signup: true });
    const r = await t.req("POST", "/api/access/email/signup", { body: { email: "ANA@example.com", name: "Ana", password: "correct horse battery", next: "/credits" } });
    expect(r.status).toBe(200);
    expect(t.mails).toHaveLength(1);
    const m = t.mails[0];
    expect(m.to).toBe("ana@example.com");
    expect(m.from).toBe("EpicTeam <noreply@example.com>");
    expect(m.subject).toBe("Confirm your EpicTeam account");
    expect(m.text).toContain(`https://${TEAM}/login#confirm=`);
    expect(t.signups).toEqual([]); // nothing made before the link is used
    const token = t.linkOf(m, "confirm");
    // only on the site that sent it
    expect((await t.req("POST", "/api/access/email/confirm", { host: SOCIAL, body: { token } })).json.error.code).toBe("invalid_confirm");
    const ok = await t.req("POST", "/api/access/email/confirm", { body: { token } });
    expect(ok.json).toEqual({ ok: true, next: "/credits" });
    expect(t.signups).toEqual([{ email: "ana@example.com", name: "Ana", product: "team", provider: "email", host: TEAM }]);
    const session = ok.cookies.find((c) => c.startsWith("console_session=") && c !== "console_session=");
    expect((await t.req("GET", "/api/me", { cookie: session })).json.identity).toMatchObject({ kind: "session", email: "ana@example.com", tenantId: "et-mail-1" });
    // used once
    expect((await t.req("POST", "/api/access/email/confirm", { body: { token } })).json.error.code).toBe("invalid_confirm");
    // the password works for a later login
    const login = await t.req("POST", "/api/access/login", { body: { email: "ana@example.com", password: "correct horse battery" } });
    expect(login.status).toBe(200);
    // the sign-up counts with Google's and GitHub's
    expect(t.db.prepare("SELECT provider, signup_world FROM oauth_identities").all()).toEqual([{ provider: "email", signup_world: "et-mail-1" }]);
    // the send log: who, which site, outcome, the message id; never the link
    const log = t.db.prepare("SELECT kind, host, to_addr, outcome, message_id FROM access_mail_log").all();
    expect(log).toEqual([{ kind: "signup", host: TEAM, to_addr: "ana@example.com", outcome: "sent", message_id: "msg-1" }]);
    expect(JSON.stringify(t.db.prepare("SELECT * FROM access_mail_log").all())).not.toContain(token);
  });

  it("the social site sends from its own domain and makes a social world", async () => {
    t = setup();
    await t.req("POST", "/api/access/email/signup", { host: SOCIAL, body: { email: "bo@example.com", password: "another long password" } });
    expect(t.mails[0].from).toMatch(/<noreply@example\.org>$/);
    const ok = await t.req("POST", "/api/access/email/confirm", { host: SOCIAL, body: { token: t.linkOf(t.mails[0], "confirm") } });
    expect(ok.status).toBe(200);
    expect(t.signups[0]).toMatchObject({ product: "social", provider: "email", host: SOCIAL });
  });

  it("an expired link is refused", async () => {
    t = setup();
    await t.req("POST", "/api/access/email/signup", { body: { email: "cy@example.com", password: "a long enough pass" } });
    t.db.prepare("UPDATE email_tokens SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
    expect((await t.req("POST", "/api/access/email/confirm", { body: { token: t.linkOf(t.mails[0], "confirm") } })).json.error.code).toBe("invalid_confirm");
  });

  it("signing up with an address that has an account sends that address a reset link instead; the answer is the same", async () => {
    t = setup();
    await t.req("POST", "/api/access/email/signup", { body: { email: "ana@example.com", password: "correct horse battery" } });
    await t.req("POST", "/api/access/email/confirm", { body: { token: t.linkOf(t.mails[0], "confirm") } });
    const again = await t.req("POST", "/api/access/email/signup", { body: { email: "ana@example.com", password: "someone elses pass" } });
    const fresh = await t.req("POST", "/api/access/email/signup", { body: { email: "new@example.com", password: "someone elses pass" } });
    expect(again.json).toEqual(fresh.json);
    expect(t.mails[1]).toMatchObject({ to: "ana@example.com", subject: "You already have a EpicTeam account" });
    expect(t.mails[1].text).toContain("#reset=");
    expect(t.signups).toHaveLength(1);
  });

  it("reset: a link to the address that asked, once, old sessions end, the new password works", async () => {
    t = setup();
    await t.req("POST", "/api/access/email/signup", { body: { email: "ana@example.com", password: "correct horse battery" } });
    const s = await t.req("POST", "/api/access/email/confirm", { body: { token: t.linkOf(t.mails[0], "confirm") } });
    const session = s.cookies.find((c) => c.startsWith("console_session=") && c !== "console_session=");
    // an unknown address: the same answer, no mail
    const none = await t.req("POST", "/api/access/email/reset", { body: { email: "nobody@example.com" } });
    expect(none.status).toBe(200);
    expect(t.mails).toHaveLength(1);
    await t.req("POST", "/api/access/email/reset", { body: { email: "ana@example.com" } });
    await t.req("POST", "/api/access/email/reset", { body: { email: "ana@example.com" } });
    expect(t.mails.slice(1).map((m) => [m.to, m.subject])).toEqual([
      ["ana@example.com", "Reset your EpicTeam password"],
      ["ana@example.com", "Reset your EpicTeam password"],
    ]);
    const older = t.linkOf(t.mails[1], "reset");
    const newer = t.linkOf(t.mails[2], "reset");
    // a newer link ends the older one
    expect((await t.req("POST", "/api/access/email/reset/finish", { body: { token: older, password: "a brand new password" } })).json.error.code).toBe("invalid_reset");
    expect((await t.req("POST", "/api/access/email/reset/finish", { body: { token: newer, password: "short" } })).json.error.code).toBe("weak_password");
    const done = await t.req("POST", "/api/access/email/reset/finish", { body: { token: newer, password: "a brand new password" } });
    expect(done.json).toEqual({ ok: true, email: "ana@example.com" });
    expect((await t.req("POST", "/api/access/email/reset/finish", { body: { token: newer, password: "a brand new password" } })).json.error.code).toBe("invalid_reset");
    expect((await t.req("GET", "/api/me", { cookie: session })).json.identity.kind).toBe("none");
    expect((await t.req("POST", "/api/access/login", { body: { email: "ana@example.com", password: "correct horse battery" } })).status).toBe(401);
    expect((await t.req("POST", "/api/access/login", { body: { email: "ana@example.com", password: "a brand new password" } })).status).toBe(200);
  });

  it("the platform's own logins get no reset mail on a customer site", async () => {
    t = setup();
    t.db.prepare("INSERT OR IGNORE INTO tenants (id, name, skin, plan, created_at) VALUES ('home', 'Home', 'console', 'team', ?)").run(new Date().toISOString());
    const id = createAuth(t.db).addMember({ email: "owner@example.com", tenant: "home", role: "owner" });
    t.db.prepare("UPDATE users SET pw_hash = ? WHERE id = ?").run(hashPassword("the owners password"), id);
    const r = await t.req("POST", "/api/access/email/reset", { body: { email: "owner@example.com" } });
    expect(r.status).toBe(200);
    expect(t.mails).toHaveLength(0);
    expect(t.db.prepare("SELECT outcome, detail FROM access_mail_log").get()).toEqual({ outcome: "skipped", detail: "no world here" });
  });

  it("limits: 3 mails an address an hour, 8 tries a visitor in 15 minutes, the daily cap", async () => {
    t = setup({ env: { CONSOLE_MAIL_PER_DAY: "4" } });
    for (let i = 0; i < 5; i++) await t.req("POST", "/api/access/email/signup", { ip: `198.51.100.${i}`, body: { email: "ana@example.com", password: "correct horse battery" } });
    expect(t.mails).toHaveLength(3);
    await t.req("POST", "/api/access/email/signup", { ip: "198.51.100.20", body: { email: "x@example.com", password: "correct horse battery" } });
    await t.req("POST", "/api/access/email/signup", { ip: "198.51.100.21", body: { email: "y@example.com", password: "correct horse battery" } });
    expect(t.mails).toHaveLength(4); // the day's cap
    const codes: number[] = [];
    for (let i = 0; i < 9; i++) codes.push((await t.req("POST", "/api/access/email/reset", { ip: "192.0.2.50", body: { email: "z@example.com" } })).status);
    expect(codes.slice(0, 8).every((c) => c === 200)).toBe(true);
    expect(codes[8]).toBe(429);
  });

  it("off the customer sites, without mail, or with sign-up closed it does nothing", async () => {
    t = setup();
    expect((await t.req("POST", "/api/access/email/signup", { host: "team.example.com", body: { email: "a@example.com", password: "correct horse battery" } })).status).toBe(403);
    t.cleanup();
    t = setup({ ready: false });
    expect((await t.req("GET", "/api/access/email/status")).json.email).toBe(false);
    expect((await t.req("POST", "/api/access/email/reset", { body: { email: "a@example.com" } })).status).toBe(503);
    t.cleanup();
    t = setup({ env: { CONSOLE_SIGNUP: "off" } });
    expect((await t.req("POST", "/api/access/email/signup", { body: { email: "a@example.com", password: "correct horse battery" } })).json.error.code).toBe("signup_closed");
    expect(t.mails).toHaveLength(0);
  });

  it("the mail: one link, the site's domain, plain words; the login page has the forms", () => {
    expect(mailFrom("cloud.example.com", "team")).toMatchObject({ from: "EpicTeam <noreply@example.com>", domain: "example.com" });
    const b = mailBody("reset", { name: "EpicTeam", link: "https://x/login#reset=abc", minutes: 30, loginUrl: "https://x/login" });
    expect(b.text).toContain("https://x/login#reset=abc");
    expect(b.html).toContain('href="https://x/login#reset=abc"');
    const page = LOGIN_PAGE();
    for (const s of ["/api/access/email/status", "/api/access/email/signup", "/api/access/email/confirm", "/api/access/email/reset/finish", "Forgot your password?", "Sign up with email"]) expect(page).toContain(s);
  });
});
