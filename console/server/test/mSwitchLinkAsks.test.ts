import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import Database from "better-sqlite3";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createAuth, hashPassword } from "../src/auth/identity.js";
import { LOGIN_PAGE } from "../src/auth/loginPage.js";
import { ensureAuth } from "../src/auth/schema.js";

/**
 * from the security review (docs/status/e77-s3/r3/security-review.md):
 * M-1 the other site's login page no longer redeems a ?handoff= link on load: it shows "Continue as <email> into <world>"
 * and redeems only on the click (a POST from that page); L-1 a link is bound to the host it was made for; L-2 single use
 * is a conditional database update checked by its row count.
 */
const A = "home";
const Z = "social";
const OUTSIDE = "203.0.113.7";
const TEAM = "team.example.com";
const SOCIAL = "social.example.com";
const SAM = "sam+home@example.com";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e77s5-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  const app = createApp(db, { auth: "on", read: { reposRoot: dir, seatsFile: path.join(dir, "seats.json"), listThreads: async () => [] } });
  db.prepare("INSERT OR IGNORE INTO tenants (id, name, skin, plan, created_at) VALUES (?, 'Memo social', 'social', 'internal', ?)").run(Z, new Date().toISOString());
  const auth = createAuth(db);
  for (const w of [A, Z]) auth.addMember({ email: SAM, tenant: w, role: "owner" });
  db.prepare("UPDATE users SET pw_hash = ?").run(hashPassword("correct horse battery"));
  const req = async (method: string, url: string, o: { host?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { host: o.host ?? TEAM, ...(o.headers ?? {}) };
    if (o.cookie) headers.cookie = o.cookie;
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const res = await app.request(url, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }, { incoming: { socket: { remoteAddress: OUTSIDE } } });
    const text = await res.text();
    return { status: res.status, json: text && text.startsWith("{") ? JSON.parse(text) : undefined, setCookie: res.headers.get("set-cookie") ?? "" };
  };
  const mint = async () => {
    const l = await req("POST", "/api/access/login", { body: { email: SAM, password: "correct horse battery", tenant: A } });
    const s = await req("POST", "/api/access/switch", { cookie: l.setCookie.split(";")[0], body: { tenant: Z } });
    return new URLSearchParams(new URL(s.json.handoff).hash.slice(1)).get("handoff") ?? "";
  };
  const redeem = (token: string, host = SOCIAL) => req("POST", "/api/access/handoff", { host, body: { token } });
  const peek = (token: string, host = SOCIAL) => req("POST", "/api/access/handoff/peek", { host, body: { token } });
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { db, req, mint, redeem, peek };
}

/** Runs the login page's script against a tiny DOM: what it fetches on load, and what a click on Continue does. */
async function loadLoginPage(search: string, answer: (url: string) => { ok: boolean; status?: number; body: unknown }, hash = "") {
  const script = LOGIN_PAGE().split("<script>")[1].split("</script>")[0];
  const els = new Map<string, Record<string, unknown>>();
  for (const id of LOGIN_PAGE().matchAll(/id="([^"]+)"/g)) {
    const tag = LOGIN_PAGE().slice(0, id.index).lastIndexOf("<");
    els.set(id[1], { id: id[1], hidden: /^<[^>]*\shidden[\s>]/.test(LOGIN_PAGE().slice(tag, LOGIN_PAGE().indexOf(">", id.index) + 1)), textContent: "", value: "", disabled: false });
  }
  const calls: string[] = [];
  const nav: string[] = [];
  const sandbox = {
    URLSearchParams,
    document: { title: "", getElementById: (id: string) => els.get(id) },
    location: { hostname: SOCIAL, search, hash, replace: (u: string) => nav.push(u), href: "" },
    history: { replaceState: (_s: unknown, _t: string, u: string) => nav.push(`replace:${u}`) },
    fetch: async (url: string) => {
      // every load also asks which sign-in buttons this site shows (none here)
      if (url === "/api/access/oauth/providers") return { ok: true, status: 200, json: async () => ({ providers: [] }) };
      calls.push(url);
      const a = answer(url);
      return { ok: a.ok, status: a.status ?? 200, json: async () => a.body };
    },
  };
  vm.runInNewContext(script, sandbox);
  await new Promise((r) => setTimeout(r, 0));
  return { els, calls, nav, click: async () => {
    await (els.get("handoff")!.onsubmit as (e: unknown) => Promise<void> | void)({ preventDefault() {} });
    await new Promise((r) => setTimeout(r, 0));
  } };
}

describe("T77-S5 M-1: a switch link asks before it signs in", () => {
  it("peek answers who and which world, sets no cookie and leaves the link unspent", async () => {
    const { mint, peek, redeem } = setup();
    const t = await mint();
    const p = await peek(t);
    expect(p.status).toBe(200);
    expect(p.json).toEqual({ email: SAM, tenant: Z, tenantName: "Memo social" });
    expect(p.setCookie).toBe("");
    expect((await peek(t)).status).toBe(200); // reading it twice spends nothing
    const r = await redeem(t);
    expect(r.status).toBe(200);
    expect(r.json.identity.tenantId).toBe(Z);
    expect((await peek(t)).status).toBe(400); // once used, nothing more to read
  });

  it("peek refuses a bad, expired, other-host or no-longer-member link", async () => {
    const { db, mint, peek } = setup();
    expect((await peek("nope")).json.error.code).toBe("invalid_handoff");
    const t = await mint();
    expect((await peek(t, TEAM)).json.error.code).toBe("wrong_host");
    db.prepare("DELETE FROM memberships WHERE tenant_id = ?").run(Z);
    expect((await peek(t)).status).toBe(403);
    const late = setup();
    const u = await late.mint();
    late.db.prepare("UPDATE auth_handoffs SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await late.peek(u)).status).toBe(400);
  });

  it("the login page, opened with a link, only reads it and shows Continue as <email> into <world>", async () => {
    const page = await loadLoginPage("", (url) => ({ ok: true, body: url.endsWith("/peek") ? { email: SAM, tenant: Z, tenantName: "Memo social" } : {} }), "#handoff=tok");
    expect(page.calls).toEqual(["/api/access/handoff/peek"]); // nothing redeemed on load
    expect(page.nav).toEqual(["replace:/login"]); // the token leaves the address bar at once
    expect(page.els.get("handoff")!.hidden).toBe(false);
    expect(page.els.get("login")!.hidden).toBe(true);
    expect(page.els.get("hoGo")!.hidden).toBe(false);
    expect(page.els.get("hoGo")!.textContent).toBe(`Continue as ${SAM} into Memo social`);
    await page.click();
    expect(page.calls).toEqual(["/api/access/handoff/peek", "/api/access/handoff"]);
    expect(page.nav).toEqual(["replace:/login", "/"]);
  });

  it("the login page, given a link it cannot use, shows the error and the normal login, and never redeems", async () => {
    const page = await loadLoginPage("", () => ({ ok: false, status: 400, body: { error: { message: "this switch link was made for another site: switch again" } } }), "#handoff=tok");
    expect(page.calls).toEqual(["/api/access/handoff/peek"]);
    expect(page.nav).toEqual(["replace:/login", "replace:/login"]);
    expect(page.els.get("login")!.hidden).toBe(false);
    expect(page.els.get("handoff")!.hidden).toBe(true);
    expect(page.els.get("err")!.textContent).toMatch(/another site/);
  });

  it("the login page without a link does not touch the handoff routes", async () => {
    const page = await loadLoginPage("", () => ({ ok: true, body: {} }));
    expect(page.calls).toEqual([]);
    expect(page.els.get("handoff")!.hidden).toBe(true);
  });

  it("a cross-site page cannot peek either", async () => {
    const { mint, req } = setup();
    const t = await mint();
    const r = await req("POST", "/api/access/handoff/peek", { host: SOCIAL, body: { token: t }, headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } });
    expect(r.status).toBe(403);
  });
});

describe("T77-S5 L-1: a link is bound to the host it was made for", () => {
  it("stores the target host and refuses the link on the other host, without spending it", async () => {
    const { db, mint, redeem } = setup();
    const t = await mint();
    expect((db.prepare("SELECT host FROM auth_handoffs").get() as { host: string }).host).toBe(SOCIAL);
    const wrong = await redeem(t, TEAM);
    expect(wrong.status).toBe(400);
    expect(wrong.json.error.code).toBe("wrong_host");
    expect(wrong.setCookie).toBe("");
    expect((await redeem(t, "localhost")).json.error.code).toBe("wrong_host");
    expect((await redeem(t)).status).toBe(200); // its own host still takes it
  });

  it("a link with no host (made before T77-S5) is refused", async () => {
    const { db, mint, redeem } = setup();
    const t = await mint();
    db.prepare("UPDATE auth_handoffs SET host = NULL").run();
    expect((await redeem(t)).json.error.code).toBe("wrong_host");
  });

  it("an older database gains the host column", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e77s5-old-"));
    const file = path.join(dir, "console.db");
    const raw = new Database(file);
    raw.exec("CREATE TABLE auth_handoffs (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, tenant_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT)");
    raw.close();
    const db = openDb(file);
    ensureAuth(db);
    const cols = (db.prepare("PRAGMA table_info(auth_handoffs)").all() as { name: string }[]).map((c) => c.name);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    expect(cols).toContain("host");
  });
});

describe("T77-S5 L-2: single use is a conditional update, not process order", () => {
  it("a link spent by someone else between the read and the update is refused (row count 0)", async () => {
    const { db, mint } = setup();
    const t = await mint();
    // another process spends the link just before this one's UPDATE runs
    const racing = new Proxy(db, {
      get(target, prop) {
        if (prop !== "prepare") return Reflect.get(target, prop);
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!sql.startsWith("UPDATE auth_handoffs SET used_at")) return stmt;
          return { run: (...a: unknown[]) => (target.prepare("UPDATE auth_handoffs SET used_at = ?").run(new Date().toISOString()), stmt.run(...a)) };
        };
      },
    }) as DB;
    expect(() => createAuth(racing).useHandoff(t, SOCIAL)).toThrow(/invalid, used or expired/);
  });

  it("the update itself checks unused, unexpired and the host", async () => {
    const { db, mint } = setup();
    const t = await mint();
    let sql = "";
    const spy = new Proxy(db, {
      get(target, prop) {
        if (prop !== "prepare") return Reflect.get(target, prop);
        return (s: string) => {
          if (s.startsWith("UPDATE auth_handoffs")) sql = s;
          return target.prepare(s);
        };
      },
    }) as DB;
    expect(createAuth(spy).useHandoff(t, SOCIAL).tenant).toBe(Z);
    expect(sql).toMatch(/WHERE hash = \? AND used_at IS NULL AND expires_at >= \? AND host = \?/);
    expect(() => createAuth(db).useHandoff(t, SOCIAL)).toThrow(/invalid, used or expired/);
  });
});
