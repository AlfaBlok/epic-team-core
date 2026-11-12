import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createAuth, hashPassword } from "../src/auth/identity.js";
import { LOGIN_PAGE } from "../src/auth/loginPage.js";

/**
 * the rest of the security review (docs/status/e77-s3/r3/security-review.md):
 * L-3 a switch link carries its token in the fragment (#handoff=), which the browser never sends, so no proxy log holds it;
 * L-4 minting and using switch links are limited per login and per address (one-minute windows, 429 with Retry-After).
 */
const A = "home";
const Z = "social";
const TEAM = "team.example.com";
const SOCIAL = "social.example.com";
const SAM = "sam+home@example.com";
const OTHER = "e77-check@example.com";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e77s8-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  const app = createApp(db, { auth: "on", read: { reposRoot: dir, seatsFile: path.join(dir, "seats.json"), listThreads: async () => [] } });
  db.prepare("INSERT OR IGNORE INTO tenants (id, name, skin, plan, created_at) VALUES (?, 'Memo social', 'social', 'internal', ?)").run(Z, new Date().toISOString());
  const auth = createAuth(db);
  for (const e of [SAM, OTHER]) for (const w of [A, Z]) auth.addMember({ email: e, tenant: w, role: "owner" });
  db.prepare("UPDATE users SET pw_hash = ?").run(hashPassword("correct horse battery"));
  // Behind cloudflared + Traefik: the socket peer is the proxy, the visitor is Cf-Connecting-Ip.
  const req = async (method: string, url: string, o: { host?: string; cookie?: string; body?: unknown; ip?: string } = {}) => {
    const headers: Record<string, string> = { host: o.host ?? TEAM, "x-forwarded-for": "172.18.0.1", "cf-connecting-ip": o.ip ?? "203.0.113.7" };
    if (o.cookie) headers.cookie = o.cookie;
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const res = await app.request(url, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }, { incoming: { socket: { remoteAddress: "172.18.0.2" } } });
    const text = await res.text();
    return { status: res.status, json: text && text.startsWith("{") ? JSON.parse(text) : undefined, retryAfter: res.headers.get("retry-after") };
  };
  const login = async (email: string) => {
    const l = await app.request("/api/access/login", { method: "POST", headers: { host: TEAM, "content-type": "application/json" }, body: JSON.stringify({ email, password: "correct horse battery", tenant: A }) });
    return (l.headers.get("set-cookie") ?? "").split(";")[0];
  };
  const switchTo = (cookie: string, ip?: string) => req("POST", "/api/access/switch", { cookie, body: { tenant: Z }, ip });
  const tokenOf = (link: string) => new URLSearchParams(new URL(link).hash.slice(1)).get("handoff") ?? "";
  const redeem = (token: string, ip?: string) => req("POST", "/api/access/handoff", { host: SOCIAL, body: { token }, ip });
  const peek = (token: string, ip?: string) => req("POST", "/api/access/handoff/peek", { host: SOCIAL, body: { token }, ip });
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { db, login, switchTo, tokenOf, redeem, peek };
}

describe("T77-S8 L-3: the token never travels in a query string", () => {
  it("a switch link carries the token in the fragment only, and that token works", async () => {
    const { login, switchTo, tokenOf, redeem } = setup();
    const s = await switchTo(await login(SAM));
    const u = new URL(s.json.handoff);
    expect(u.origin + u.pathname).toBe("https://social.example.com/login");
    expect(u.search).toBe(""); // what a proxy logs: the path and query, never the fragment
    expect(u.hash).toMatch(/^#handoff=[\w-]{40,}$/);
    expect((await redeem(tokenOf(s.json.handoff))).status).toBe(200);
  });

  it("the login page reads the fragment, clears it before any call, and ignores a ?handoff= query", async () => {
    const script = LOGIN_PAGE().split("<script>")[1].split("</script>")[0];
    const run = (search: string, hash: string) => {
      const order: string[] = [];
      const el = () => ({ hidden: false, textContent: "", value: "", disabled: false });
      const els = new Map<string, Record<string, unknown>>();
      vm.runInNewContext(script, {
        URLSearchParams,
        document: { title: "", getElementById: (id: string) => els.get(id) ?? (els.set(id, el()), els.get(id)) },
        location: { hostname: SOCIAL, search, hash, replace: () => {}, href: "" },
        history: { replaceState: (_s: unknown, _t: string, u: string) => order.push(`replace:${u}`) },
        fetch: async (url: string, init: { body: string }) => {
          order.push(`${url} ${init.body}`);
          return { ok: true, status: 200, json: async () => ({ email: SAM, tenantName: "Memo social" }) };
        },
      });
      return order;
    };
    expect(run("", "#handoff=tok")).toEqual(["replace:/login", '/api/access/handoff/peek {"token":"tok"}']);
    expect(run("?handoff=tok", "")).toEqual([]);
  });
});

describe("T77-S8 L-4: rate limits on switch links", () => {
  it("a login mints 10 links a minute, the 11th is refused 429 with Retry-After; another login is not held back", async () => {
    const { login, switchTo } = setup();
    const j = await login(SAM);
    for (let n = 0; n < 10; n++) expect((await switchTo(j, `198.51.100.${n}`)).status).toBe(200);
    const r = await switchTo(j, "198.51.100.99");
    expect(r.status).toBe(429);
    expect(r.json.error.code).toBe("too_many_switches");
    expect(r.json.error.message).toMatch(/wait a minute/);
    expect(r.retryAfter).toBe("60");
    expect((await switchTo(await login(OTHER), "198.51.100.98")).status).toBe(200);
  });

  it("an address mints 30 links a minute across logins, the 31st is refused", async () => {
    const { login, switchTo, db } = setup();
    const auth = createAuth(db);
    const cookies: string[] = [];
    for (let k = 0; k < 4; k++) {
      const e = `tester${k}@example.com`;
      for (const w of [A, Z]) auth.addMember({ email: e, tenant: w, role: "owner" });
      db.prepare("UPDATE users SET pw_hash = ? WHERE email = ?").run(hashPassword("correct horse battery"), e);
      cookies.push(await login(e));
    }
    const answers: number[] = [];
    for (let n = 0; n < 32; n++) answers.push((await switchTo(cookies[n % 4], "198.51.100.6")).status);
    expect(answers.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(answers.slice(30)).toEqual([429, 429]);
    expect((await switchTo(cookies[0], "198.51.100.7")).status).toBe(200); // another address is not held back
  });

  it("an address gets 30 peek or redeem calls a minute, refused ones included; a refused call spends no link", async () => {
    const { login, switchTo, tokenOf, peek, redeem } = setup();
    const good = tokenOf((await switchTo(await login(SAM), "198.51.100.8")).json.handoff);
    for (let n = 0; n < 30; n++) expect((await peek("guess" + n, "192.0.2.1")).status).toBe(400);
    const p = await peek(good, "192.0.2.1");
    expect(p.status).toBe(429);
    expect(p.json.error.code).toBe("too_many_switches");
    expect((await redeem(good, "192.0.2.1")).status).toBe(429);
    expect((await redeem(good, "192.0.2.2")).status).toBe(200); // the link was not spent by the refusals
  });

  it("a login uses 10 links a minute; the 11th is refused and stays unspent", async () => {
    const { login, switchTo, tokenOf, redeem, peek, db } = setup();
    const j = await login(SAM);
    const tokens: string[] = [];
    for (let n = 0; n < 10; n++) tokens.push(tokenOf((await switchTo(j, `198.51.100.${n}`)).json.handoff));
    for (let n = 0; n < 10; n++) expect((await redeem(tokens[n], `192.0.2.${n}`)).status).toBe(200);
    // the mint cap is spent too, so the 11th link is written straight into the table as a mint would
    const extra = tokenOf((await switchTo(await login(OTHER), "198.51.100.50")).json.handoff);
    db.prepare("UPDATE auth_handoffs SET user_id = (SELECT id FROM users WHERE email = ?) WHERE used_at IS NULL").run(SAM);
    const r = await redeem(extra, "192.0.2.50");
    expect(r.status).toBe(429);
    expect((await peek(extra, "192.0.2.51")).status).toBe(200); // still unspent
  });
});
