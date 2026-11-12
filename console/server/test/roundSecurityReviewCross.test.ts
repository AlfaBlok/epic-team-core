import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createAuth, hashPassword } from "../src/auth/identity.js";

/**
 * security review (run_6ad91d59): the one-time cross-host switch link refuses what it must. A cross-site
 * page can neither mint nor redeem one; a link dies with the membership it was minted for; the redeemed session cookie
 * carries the same flags as a password login; the link is single use and 256 bits.
 */
const A = "home";
const Z = "social";
const OUTSIDE = "203.0.113.7";
const TEAM = "team.example.com";
const SOCIAL = "social.example.com";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

// moved the social site's browsers to app.social.app (test/signsCloudSocialApp.test.ts); the cross-host link itself still works with that off.
let moved: string | undefined;
beforeAll(() => {
  moved = process.env.CONSOLE_SOCIAL_MOVED_TO;
  process.env.CONSOLE_SOCIAL_MOVED_TO = "";
});
afterAll(() => {
  if (moved === undefined) delete process.env.CONSOLE_SOCIAL_MOVED_TO;
  else process.env.CONSOLE_SOCIAL_MOVED_TO = moved;
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e77s3r3sec-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  const app = createApp(db, { auth: "on", read: { reposRoot: dir, seatsFile: path.join(dir, "seats.json"), listThreads: async () => [] } });
  db.prepare("INSERT OR IGNORE INTO tenants (id, name, skin, plan, created_at) VALUES (?, 'Memo social', 'social', 'internal', ?)").run(Z, new Date().toISOString());
  const auth = createAuth(db);
  for (const w of [A, Z]) auth.addMember({ email: "sam+home@example.com", tenant: w, role: "owner" });
  db.prepare("UPDATE users SET pw_hash = ?").run(hashPassword("correct horse battery"));
  const req = async (method: string, url: string, o: { host?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { host: o.host ?? TEAM, ...(o.headers ?? {}) };
    if (o.cookie) headers.cookie = o.cookie;
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const res = await app.request(url, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }, { incoming: { socket: { remoteAddress: OUTSIDE } } });
    const text = await res.text();
    return { status: res.status, json: text && text.startsWith("{") ? JSON.parse(text) : undefined, setCookie: res.headers.get("set-cookie") ?? "" };
  };
  const login = async (host = TEAM) => {
    const r = await req("POST", "/api/access/login", { host, headers: { "x-forwarded-proto": "https" }, body: { email: "sam+home@example.com", password: "correct horse battery", tenant: A } });
    return { cookie: r.setCookie.split(";")[0], setCookie: r.setCookie };
  };
  const mint = async (cookie: string) => {
    const s = await req("POST", "/api/access/switch", { cookie, body: { tenant: Z } });
    return new URLSearchParams(new URL(s.json.handoff).hash.slice(1)).get("handoff") ?? "";
  };
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { req, login, mint, db };
}

describe("T77-S3 round 3 security review: the cross-host switch link", () => {
  it("is 256 bits of base64url, and works once only", async () => {
    const { req, login, mint } = setup();
    const t = await mint((await login()).cookie);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await req("POST", "/api/access/handoff", { host: SOCIAL, body: { token: t } })).status).toBe(200);
    expect((await req("POST", "/api/access/handoff", { host: SOCIAL, body: { token: t } })).status).toBe(400);
  });

  it("a page on another site can neither mint nor redeem one", async () => {
    const { req, login, mint } = setup();
    const { cookie } = await login();
    const evil = { origin: "https://evil.example", "sec-fetch-site": "cross-site" };
    const m = await req("POST", "/api/access/switch", { cookie, body: { tenant: Z }, headers: evil });
    expect(m.status).toBe(403);
    expect(m.json.handoff).toBeUndefined();
    const t = await mint(cookie);
    const r = await req("POST", "/api/access/handoff", { host: SOCIAL, body: { token: t }, headers: evil });
    expect(r.status).toBe(403);
    expect(r.setCookie).toBe("");
    // the refused call did not spend the link: the real page still redeems it
    expect((await req("POST", "/api/access/handoff", { host: SOCIAL, body: { token: t } })).status).toBe(200);
  });

  it("dies with the membership it was minted for", async () => {
    const { req, login, mint, db } = setup();
    const t = await mint((await login()).cookie);
    db.prepare("DELETE FROM memberships WHERE tenant_id = ?").run(Z);
    const r = await req("POST", "/api/access/handoff", { host: SOCIAL, body: { token: t } });
    expect(r.status).toBe(403);
    expect(r.setCookie).toBe("");
  });

  it("sets the session cookie with the same flags as a password login", async () => {
    const { req, login, mint } = setup();
    const l = await login();
    const t = await mint(l.cookie);
    const r = await req("POST", "/api/access/handoff", { host: SOCIAL, body: { token: t }, headers: { "x-forwarded-proto": "https" } });
    const flags = (s: string) => s.split(";").slice(1).map((x) => x.trim()).filter((x) => !x.startsWith("Expires=")).sort();
    expect(flags(r.setCookie)).toEqual(flags(l.setCookie));
    expect(r.setCookie).toMatch(/HttpOnly/);
    expect(r.setCookie).toMatch(/Secure/);
    expect(r.setCookie).toMatch(/SameSite=Lax/);
  });
});
