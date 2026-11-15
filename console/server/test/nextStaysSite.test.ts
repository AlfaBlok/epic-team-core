import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { forTenant } from "../src/store.js";
import { createAuth, hashPassword, type AuthMode } from "../src/auth/identity.js";
import { ensureAuth } from "../src/auth/schema.js";
import { mountAuth } from "../src/auth/gate.js";
import { safeNext } from "../src/auth/oauth.js";
import { LOGIN_PAGE } from "../src/auth/loginPage.js";
import { leanJson } from "../src/leanJson.js";

/**
 * the security pass of the public route (app.epicteam.app, app.social.app) before it opens
 * (docs/status/e88-s7/README.md). What it fixed: a `next` that left the site, a public console that would refuse nothing
 * if CONSOLE_AUTH were not `on`, a health answer naming the platform's jobs, no framing or sniffing headers, and a login
 * throttle that a flood of keys emptied and that counted guesses per address only.
 */
const TEAM = "app.epicteam.app";
const proxied = (host: string, ip = "203.0.113.9") => ({ host, "x-forwarded-for": `${ip}, 172.19.0.1`, "x-forwarded-host": host, "x-forwarded-proto": "https", "cf-connecting-ip": ip });

function setup(mode: AuthMode = "on", lean = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e88s7-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  ensureAuth(db);
  const app = new Hono();
  const api = new Hono();
  if (lean) api.use("*", leanJson({ gzipMin: 1 })); // as app.ts: registered before the gate's routes, so inside it
  mountAuth(app, api, { db, store: forTenant(db, "home"), mode });
  api.get("/health", (c) => c.json({ ok: true, presses: { today: 3 }, vps3Disk: { state: "ok", free: "41%" }, checkoutSync: { out: ["home_repo"] } }));
  api.get("/milestones", (c) => c.json([]));
  app.route("/api", api);
  return { db, app };
}

describe("next stays on the site", () => {
  it("refuses tabs, newlines, spaces and backslashes anywhere (a browser drops the first and reads the last as a slash)", () => {
    expect(safeNext("/campaigns?x=1#y")).toBe("/campaigns?x=1#y");
    for (const bad of ["/\t/evil.example/", "/\n/evil.example", "/ /evil.example", "/x\\..\\..\\/evil", "/\\evil.example", "//evil.example", "https://evil.example", "\t//evil.example"]) expect(safeNext(bad), JSON.stringify(bad)).toBe("/");
  });
  it("the login page applies the same rule before it sends the browser on", () => {
    expect(LOGIN_PAGE()).toContain("const okNext = (v) =>");
    // the page's rule, run as the browser would
    const okNext = new Function(`return ${/const okNext = (\(v\) => [^\n]+);/.exec(LOGIN_PAGE())![1]}`)() as (v: string | null) => boolean;
    expect(okNext("/campaigns")).toBe(true);
    for (const bad of ["/\t/evil.example", "/\\evil.example", "//evil.example", "https://evil.example", null, ""]) expect(okNext(bad), JSON.stringify(bad)).toBe(false);
  });
});

describe("the customer sites", () => {
  it("are closed unless CONSOLE_AUTH=on (production's unit says shadow; only its env file says on)", async () => {
    for (const mode of ["off", "shadow"] as AuthMode[]) {
      const { app } = setup(mode);
      const r = await app.request("/api/milestones", { headers: proxied(TEAM) });
      expect(r.status, mode).toBe(503);
      expect((await r.json()).error.code).toBe("auth_off");
      expect((await app.request("/login", { headers: proxied(TEAM) })).status).toBe(503);
      // the tailnet console is not affected
      expect((await app.request("/api/milestones", { headers: { host: "team.example.com" } })).status).toBe(200);
    }
  });

  it("answer health with up or down only", async () => {
    const { app } = setup();
    const r = await app.request("/api/health", { headers: proxied(TEAM) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    const inside = await app.request("/api/health", { headers: { host: "team.example.com" } });
    expect(Object.keys(await inside.json())).toContain("vps3Disk");
  });

  it("answer health up when the inner answer went out gzipped, as it does for every Cloudflare request", async () => {
    const { app } = setup("on", true);
    for (const enc of ["gzip, deflate, br", "identity"]) {
      const r = await app.request("/api/health", { headers: { ...proxied(TEAM), "accept-encoding": enc } });
      expect(r.status, enc).toBe(200);
      expect(r.headers.get("content-encoding"), enc).toBeNull();
      expect(await r.json(), enc).toEqual({ ok: true });
    }
  });

  it("send no-framing, nosniff, referrer and HSTS headers on pages and API answers, refusals too", async () => {
    const { app } = setup();
    for (const p of ["/login", "/api/me", "/api/milestones"]) {
      const r = await app.request(p, { headers: proxied(TEAM) });
      expect(r.headers.get("x-frame-options"), p).toBe("SAMEORIGIN");
      expect(r.headers.get("content-security-policy"), p).toBe("frame-ancestors 'self'");
      expect(r.headers.get("x-content-type-options"), p).toBe("nosniff");
      expect(r.headers.get("referrer-policy"), p).toBe("strict-origin-when-cross-origin");
      expect(r.headers.get("strict-transport-security"), p).toBe("max-age=31536000");
    }
    expect((await app.request("/api/milestones", { headers: proxied(TEAM) })).status).toBe(401);
    expect((await app.request("/login", { headers: { host: "team.example.com" } })).headers.get("x-frame-options")).toBeNull();
  });
});

describe("the login throttle", () => {
  const login = (app: Hono, ip: string, email: string, password: string) =>
    app.request("/api/access/login", { method: "POST", headers: { ...proxied(TEAM, ip), "content-type": "application/json" }, body: JSON.stringify({ email, password }) });

  it("stops one email guessed from many addresses at 100 failures, and the right password still resets it", async () => {
    const { db, app } = setup();
    db.prepare("INSERT INTO users (id, email, name, pw_hash, created_at) VALUES ('u1', 'owner@example.com', 'O', ?, '2026-11-09')").run(hashPassword("the-right-password"));
    createAuth(db).addMember({ email: "owner@example.com", tenant: "home", role: "owner" });
    for (let i = 0; i < 100; i++) expect((await login(app, `198.51.100.${(i % 250) + 1}`, "owner@example.com", "wrong-password-xx")).status).toBe(401);
    expect((await login(app, "192.0.2.77", "owner@example.com", "wrong-password-xx")).status).toBe(429);
    expect((await login(app, "192.0.2.78", "other@example.com", "wrong-password-xx")).status).toBe(401); // another email is not held
  }, 60_000);

  it("ten failures from one address and email still stop that pair", async () => {
    const { app } = setup();
    for (let i = 0; i < 10; i++) expect((await login(app, "198.51.100.1", "a@example.com", "wrong-password-xx")).status).toBe(401);
    expect((await login(app, "198.51.100.1", "a@example.com", "wrong-password-xx")).status).toBe(429);
    expect((await login(app, "198.51.100.2", "a@example.com", "wrong-password-xx")).status).toBe(401);
  });
});
