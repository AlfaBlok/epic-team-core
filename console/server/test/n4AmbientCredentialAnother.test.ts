import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createAuth } from "../src/auth/identity.js";
import { crossSiteRefusal, hostAllowed } from "../src/auth/csrf.js";


// the console's ambient credentials (session cookie; legacy trust of a
// loopback or tailnet caller with no credential) cannot be used from another site or through a rebound host name.

const TAILNET = "100.64.0.63";
const CONSOLE = "100.64.0.10:8750";
let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e59s12n4-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  const app = createApp(db, { auth: "on", read: { reposRoot: dir, seatsFile: path.join(dir, "seats.json"), listThreads: async () => [] } });
  const m = createStore(db).createMilestone({ title: "MAIN Stability", repo: "home_repo", path: "docs/spines/root.md", owner: "Sam", paused: false });
  const auth = createAuth(db);
  const cookie = auth.createSession(auth.addMember({ email: "sam@example.com", tenant: "home", role: "owner" }), "home").id;
  const req = async (method: string, url: string, headers: Record<string, string>, body?: string, peer = TAILNET) => {
    const res = await app.request(`http://${headers.host ?? CONSOLE}${url}`, { method, headers, body }, { incoming: { socket: { remoteAddress: peer } } });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  const title = () => (db.prepare("SELECT title FROM milestones WHERE id = ?").get(m.id) as { title: string }).title;
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { db, req, m, cookie, title };
}

const patch = JSON.stringify({ title: "pwned" });

describe("T59-S12 N4: no ambient credential from another site", () => {
  it("the audit's drive-by: a cross-site text/plain PATCH on tailnet legacy trust is refused and changes nothing", async () => {
    const s = setup();
    const drives: Record<string, string>[] = [
      { host: CONSOLE, origin: "https://evil.example", "content-type": "text/plain;charset=UTF-8" },
      { host: CONSOLE, origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "text/plain" },
      { host: CONSOLE, origin: "null", "content-type": "text/plain" },
      { host: "team.example.com", origin: "https://blog.example.com", "sec-fetch-site": "same-site", "content-type": "text/plain", cookie: `console_session=${s.cookie}` },
    ];
    for (const h of drives) {
      const r = await s.req("PATCH", `/api/milestones/${s.m.id}`, h, patch);
      expect(r.status, JSON.stringify(h)).toBe(403);
      expect(r.json.error.code).toBe("cross_site");
    }
    expect(s.title()).toBe("MAIN Stability");
  });

  it("DNS rebinding: a host name the console does not serve gets 421, reads and writes", async () => {
    const s = setup();
    const me = await s.req("GET", "/api/me", { host: "rebind.evil.example:8750" });
    expect(me.status).toBe(421);
    expect(me.json.error.code).toBe("bad_host");
    expect((await s.req("PATCH", `/api/milestones/${s.m.id}`, { host: "rebind.evil.example:8750", "sec-fetch-site": "same-origin", "content-type": "application/json" }, patch)).status).toBe(421);
    expect(s.title()).toBe("MAIN Stability");
  });

  it("login CSRF: a cross-site login POST is refused", async () => {
    const s = setup();
    const r = await s.req("POST", "/api/access/login", { host: "team.example.com", origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "application/json" }, JSON.stringify({ email: "a@example.com", password: "x" }));
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("cross_site");
  });

  it("the console's own page still writes (tailnet IP over http, team.example.com over https); curl and agents unchanged", async () => {
    const s = setup();
    const own = await s.req("PATCH", `/api/milestones/${s.m.id}`, { host: CONSOLE, origin: `http://${CONSOLE}`, "content-type": "application/json" }, JSON.stringify({ title: "A" }));
    expect(own.status, JSON.stringify(own.json)).toBe(200);
    const team = await s.req(
      "PATCH",
      `/api/milestones/${s.m.id}`,
      { host: "team.example.com", "x-forwarded-host": "team.example.com", "x-forwarded-for": "198.51.100.4", origin: "https://team.example.com", "sec-fetch-site": "same-origin", "content-type": "application/json", cookie: `console_session=${s.cookie}` },
      JSON.stringify({ title: "B" }),
      "172.19.0.14",
    );
    expect(team.status, JSON.stringify(team.json)).toBe(200);
    const curl = await s.req("PATCH", `/api/milestones/${s.m.id}`, { host: "127.0.0.1:8750", "content-type": "application/json" }, JSON.stringify({ title: "C" }), "127.0.0.1");
    expect(curl.status).toBe(200);
    expect(s.title()).toBe("C");
  });

  it("the public routes another site posts to on purpose are not judged here", () => {
    const h = (o: Record<string, string>) => (n: string) => o[n];
    expect(crossSiteRefusal("POST", "/api/public/testers", h({ host: "signup.example.com", origin: "https://epicspine.dev", "sec-fetch-site": "cross-site" }))).toBeUndefined();
    expect(crossSiteRefusal("POST", "/api/hooks/memo/voice-note", h({ host: "172.17.0.1:8750" }))).toBeUndefined();
    expect(crossSiteRefusal("POST", "/api/auth-sync/abc/upload", h({ host: CONSOLE, origin: "https://x.example" }))).toBeUndefined();
    expect(crossSiteRefusal("GET", "/api/runs", h({ host: CONSOLE, origin: "https://evil.example", "sec-fetch-site": "cross-site" }))).toBeUndefined(); // reads: CORS keeps the answer from the page
  });

  it("hostAllowed: IPs, loopback, single-label, tailnet and home names; never a foreign public name", () => {
    for (const h of ["100.64.0.10:8750", "[fd7a:115c:a1e0::1]:8750", "127.0.0.1", "localhost:5173", "worker:5173", "main.tail-example.ts.net", "team.example.com", "social.example.com", ""])
      expect(hostAllowed(h, {}), h).toBe(true);
    for (const h of ["evil.example", "example.com.evil.example", "team.example.com.evil.example:8750", "100.64.0.10.nip.io"]) expect(hostAllowed(h, {}), h).toBe(false);
    expect(hostAllowed("console.customer.example", { CONSOLE_ALLOWED_HOSTS: "console.customer.example" })).toBe(true);
  });
});
