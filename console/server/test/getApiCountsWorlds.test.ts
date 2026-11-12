import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { addCard, makeRepo, spineText } from "./reviewFixture.js";
import { createAuth, hashPassword } from "../src/auth/identity.js";
import { isTenantSafe } from "../src/auth/routeScope.js";
import { DESK_INBOX_DIR, deskInboxSection, parseNote, readInbox } from "../src/desk/inbox.js";

/**
 * the world switcher. GET /api/counts/worlds lists every world the login belongs to with what
 * waits on the owner there (red: blocked asks, green: review cards), each read exactly as that world's own /api/counts reads it;
 * never a world the login is not a member of; an agent token sees its own world only.
 */
const A = "home";
const Z = "social";
const X = "es-stranger-0001";
const OUTSIDE = "203.0.113.7";

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e77s1-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  const repos = Object.fromEntries([A, Z, X].map((n) => [n, makeRepo(dir, n, { "docs/spines/root.md": spineText("PLAN-0", n, []) })]));
  const app = createApp(db, {
    auth: "on",
    read: { reposRoot: dir, seatsFile: path.join(dir, "seats.json"), listThreads: async () => [] },
    review: { live: { fetch: (async () => new Response("ok")) as unknown as typeof fetch, consoleHosts: [] } },
  });
  for (const [id, name] of [[Z, "Memo social"], [X, "A stranger"]])
    db.prepare("INSERT OR IGNORE INTO tenants (id, name, skin, plan, created_at) VALUES (?, ?, 'social', 'internal', ?)").run(id, name, new Date().toISOString());
  const ms = Object.fromEntries([A, Z, X].map((w) => [w, createStore(db, { tenant: w }).createMilestone({ title: w, repo: w, path: "docs/spines/root.md", owner: "Sam", paused: false })]));
  const review = (id: string, world: string) => {
    fs.appendFileSync(path.join(repos[world].dir, "docs/spines/root.md"), `| ${id} | Ticket worker | seat2 | item ${id} | review | none | none | main | [live](https://team.example.com/${id}) | 2026-11-02 | followups: none; confirm: yes |\n`);
    addCard(repos[world].dir, id, `https://team.example.com/${id}`);
  };
  const auth = createAuth(db);
  const user = (email: string, worlds: string[]) => {
    let id = "";
    for (const w of worlds) id = auth.addMember({ email, tenant: w, role: "owner" });
    db.prepare("UPDATE users SET pw_hash = ? WHERE id = ?").run(hashPassword("correct horse battery"), id);
    return email;
  };
  const req = async (method: string, url: string, o: { headers?: Record<string, string>; body?: unknown } = {}) => {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const res = await app.request(url, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }, { incoming: { socket: { remoteAddress: OUTSIDE } } });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined, headers: res.headers };
  };
  const login = async (email: string, tenant: string) => {
    const r = await req("POST", "/api/access/login", { body: { email, password: "correct horse battery", tenant } });
    return (r.headers.get("set-cookie") ?? "").split(";")[0];
  };
  /** A read after the background pass a first read starts (review rows are read once per world, then cached). */
  const settled = async (url: string, headers: Record<string, string>) => {
    await req("GET", url, { headers });
    await new Promise((r) => setTimeout(r, 50));
    return req("GET", url, { headers });
  };
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { req, settled, login, user, review, auth, ms, repos };
}

describe("T77-S1 GET /api/counts/worlds", () => {
  it("is TENANT_SAFE (both skins show the switcher)", () => {
    expect(isTenantSafe("GET", "/api/counts/worlds")).toBe(true);
    expect(isTenantSafe("POST", "/api/counts/worlds")).toBe(false);
  });

  it("lists every world of the login with that world's own red and green, and never a world it does not belong to", async () => {
    const w = setup();
    w.review("rv_a1", A);
    w.review("rv_a2", A);
    w.review("rv_z1", Z);
    w.review("rv_x1", X);
    w.review("rv_x2", X);
    w.review("rv_x3", X);
    const sam = w.user("sam@example.com", [A, Z]);
    const cookie = await w.login(sam, A);
    const r = await w.settled("/api/counts/worlds", { cookie });
    expect(r.status).toBe(200);
    const worlds = r.json.worlds as { tenantId: string; tenantName: string; current: boolean; review: number; needsYou: number | null }[];
    expect(worlds.map((x) => x.tenantId)).toEqual([A, Z]);
    expect(worlds.find((x) => x.tenantId === A)).toMatchObject({ current: true, review: 2 });
    expect(worlds.find((x) => x.tenantId === Z)).toMatchObject({ current: false, review: 1, tenantName: "Memo social" });
    expect(JSON.stringify(r.json)).not.toContain(X);

    // the same numbers each world's own /api/counts sends once switched there
    const own = (await w.req("GET", "/api/counts", { headers: { cookie } })).json;
    expect(own.review).toBe(2);
    expect(own.needsYou ?? null).toBe(worlds[0].needsYou);
    const sw = await w.req("POST", "/api/access/switch", { headers: { cookie, origin: "http://localhost" }, body: { tenant: Z } });
    expect(sw.status).toBe(200);
    const zCookie = (sw.headers.get("set-cookie") ?? "").split(";")[0];
    const zOwn = (await w.settled("/api/counts", { cookie: zCookie })).json;
    expect(zOwn.review).toBe(1);
    const zWorlds = (await w.settled("/api/counts/worlds", { cookie: zCookie })).json.worlds;
    expect(zWorlds.find((x: { tenantId: string }) => x.tenantId === Z).current).toBe(true);
    expect(zWorlds.find((x: { tenantId: string }) => x.tenantId === A).review).toBe(2);
  });

  it("a login with one world gets one row; an agent token gets its own world only", async () => {
    const w = setup();
    w.review("rv_z1", Z);
    const tester = w.user("tester@example.com", [X]);
    const cookie = await w.login(tester, X);
    const one = (await w.settled("/api/counts/worlds", { cookie })).json.worlds;
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ tenantId: X, current: true, review: 0 });
    const tok = w.auth.createToken({ tenant: Z, label: "memo check" }).token;
    const t = (await w.settled("/api/counts/worlds", { authorization: `Bearer ${tok}` })).json.worlds;
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ tenantId: Z, current: true, review: 1 });
  });

  it("no identity: 401", async () => {
    const w = setup();
    expect((await w.req("GET", "/api/counts/worlds")).status).toBe(401);
  });
});

describe("T77-S1 desk inbox (desk/inbox.ts)", () => {
  const note = (fm: Record<string, string>, body = "Please add a tester post.") => `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n${body}\n`;

  it("parses a note's frontmatter; a file without from/about is not a note", () => {
    const n = parseNote("desk/inbox/2026-11-07-home-hello.md", note({ from: "home", about: "say hello", "reply-to": "Acme/home_repo", status: "open" }));
    expect(n).toMatchObject({ from: "home", about: "say hello", replyTo: "Acme/home_repo", status: "open", body: "Please add a tester post." });
    expect(parseNote("x.md", "no frontmatter")).toBeUndefined();
    expect(parseNote("x.md", note({ from: "home" }))).toBeUndefined();
    expect(parseNote("x.md", note({ from: "a", about: "b" }))?.status).toBe("open"); // status defaults to open
  });

  it("reads only open notes into the wake section, with the answer rule; none open = no section", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e77s1-inbox-"));
    try {
      expect(readInbox(dir)).toEqual([]);
      fs.mkdirSync(path.join(dir, DESK_INBOX_DIR), { recursive: true });
      fs.writeFileSync(path.join(dir, DESK_INBOX_DIR, "README.md"), "# Desk inbox\n");
      fs.writeFileSync(path.join(dir, DESK_INBOX_DIR, "2026-11-07-home-hello.md"), note({ from: "home", about: "say hello", "reply-to": "Acme/home_repo", status: "open" }));
      fs.writeFileSync(path.join(dir, DESK_INBOX_DIR, "2026-11-06-home-old.md"), note({ from: "home", about: "old one", "reply-to": "Acme/home_repo", status: "answered" }));
      const notes = readInbox(dir);
      expect(notes.map((n) => n.file)).toEqual(["desk/inbox/2026-11-06-home-old.md", "desk/inbox/2026-11-07-home-hello.md"]);
      const s = deskInboxSection(notes, "e77-test")!;
      expect(s).toContain("## Desk inbox (1 open note from other worlds)");
      expect(s).toContain("`desk/inbox/2026-11-07-home-hello.md` from **home** (reply to Acme/home_repo): say hello");
      expect(s).toContain("> Please add a tester post.");
      expect(s).toContain("in-reply-to");
      expect(s).not.toContain("old one");
      expect(deskInboxSection(notes.filter((n) => n.status !== "open"), "e77-test")).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("T77-S1 GET /api/desk/inbox", () => {
  it("is TENANT_SAFE and lists only the caller's world's repos' notes", async () => {
    expect(isTenantSafe("GET", "/api/desk/inbox")).toBe(true);
    const w = setup();
    const drop = (world: string, name: string, fm: string) => {
      fs.mkdirSync(path.join(w.repos[world].dir, DESK_INBOX_DIR), { recursive: true });
      fs.writeFileSync(path.join(w.repos[world].dir, DESK_INBOX_DIR, name), `---\n${fm}\n---\nbody\n`);
    };
    drop(A, "2026-11-07-e77-test-hello.md", "from: e77-test\nabout: hello home\nreply-to: e77-test\nstatus: open");
    drop(Z, "2026-11-07-home-secret.md", "from: home\nabout: for memo only\nreply-to: Acme/home_repo\nstatus: answered");
    const zTok = w.auth.createToken({ tenant: Z, label: "z" }).token;
    const aTok = w.auth.createToken({ tenant: A, label: "a" }).token;
    const z = (await w.req("GET", "/api/desk/inbox", { headers: { authorization: `Bearer ${zTok}` } })).json;
    expect(z.repos).toHaveLength(1);
    expect(z.repos[0]).toMatchObject({ repo: Z, open: 0 });
    expect(z.repos[0].notes[0]).toMatchObject({ from: "home", status: "answered" });
    expect(JSON.stringify(z)).not.toContain("hello home");
    const a = (await w.req("GET", "/api/desk/inbox", { headers: { authorization: `Bearer ${aTok}` } })).json;
    expect(a.repos.map((r: { repo: string }) => r.repo)).toEqual([A]);
    expect(a.repos[0]).toMatchObject({ open: 1 });
    expect(JSON.stringify(a)).not.toContain("for memo only");
  });
});
