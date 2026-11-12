import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createAuth, type AuthMode } from "../src/auth/identity.js";
import { isTenantSafe, judge } from "../src/auth/routeScope.js";
import { makeRepo, spineText } from "./reviewFixture.js";

/**
 * the review list in other worlds. Since auth went on (2026-11-01 16:03Z) the owner's a social world repo session on
 * the social site got 403 world_scope on GET /api/review-items every minute. Review items are now per world: each world
 * lists, approves and relaunches only its own (TENANT_SAFE) and another world's item id is a 404. The cards are
 * the spine rows in review of the world's own milestones' repos.
 */
const A = "home";
const Z = "social";
const cadence = { type: "interval" as const, everyMinutes: 60 };
const OUTSIDE = "203.0.113.7";
let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function worlds(mode: AuthMode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s4-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  const rA = makeRepo(dir, "home_repo", { "docs/spines/root.md": spineText("PLAN-0", "home_repo", [{ id: "T40-S2", title: "ALPHA-book", status: "review", evidence: "[book](https://team.example.com/book)" }]) });
  const rZ = makeRepo(dir, "social", { "docs/spines/root.md": spineText("PLAN-0", "social", [{ id: "Z-1", title: "SOCIAL-post", status: "review", evidence: "https://social.example.com/campaigns" }]) });
  const live = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
  const app = createApp(db, {
    auth: mode,
    read: { reposRoot: dir, seatsFile: path.join(dir, "seats.json"), listThreads: async () => [] },
    review: { live: { fetch: live, consoleHosts: [] } },
  });
  db.prepare("INSERT INTO tenants (id, name, skin, plan, created_at) VALUES (?, ?, 'social', 'internal', ?)").run(Z, Z, new Date().toISOString());
  const sa = createStore(db);
  const sz = createStore(db, { tenant: Z });
  const mA = sa.createMilestone({ title: "home_repo", repo: "home_repo", path: "docs/spines/root.md", owner: "Sam", paused: false });
  const pA = sa.createPersona({ name: "Delivery Manager", remit: "run", skills: [], model: "opus", mayWrite: true });
  const aA = sa.createAssignment({ milestoneId: mA.id, personaId: pA.id, cadence, enabled: true });
  const mZ = sz.createMilestone({ title: "social", repo: "social", path: "docs/spines/root.md", owner: "Sam", paused: false });
  const pZ = sz.createPersona({ name: "Delivery Manager", remit: "run", skills: [], model: "opus", mayWrite: true });
  const aZ = sz.createAssignment({ milestoneId: mZ.id, personaId: pZ.id, cadence, enabled: true });
  const auth = createAuth(db);
  const zTok = auth.createToken({ tenant: Z, label: "social session" }).token;
  const aTok = auth.createToken({ tenant: A, label: "automated-checks" }).token;
  const req = async (method: string, url: string, o: { bearer?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = o.bearer ? { authorization: `Bearer ${o.bearer}` } : {};
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const res = await app.request(url, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }, { incoming: { socket: { remoteAddress: o.bearer ? OUTSIDE : "127.0.0.1" } } });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json };
  };
  const events = () => db.prepare("SELECT * FROM auth_events").all() as any[];
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { db, req, events, mA, aA, mZ, aZ, zTok, aTok, rA, rZ };
}

describe("T48-S4 route judge", () => {
  it("the review routes are TENANT_SAFE; a social session is never refused world_scope on them", () => {
    const w = worlds("shadow");
    const id = { kind: "token" as const, tenant: Z, tokenId: "tok_judge", label: "judge" };
    for (const [m, p] of [
      ["GET", "/api/review-items"],
      ["HEAD", "/api/review-items"],
      ["POST", "/api/review-items"],
      ["POST", "/api/review-items/rv_x/recheck"],
      ["POST", "/api/review-items/rv_x/approve"],
      ["POST", "/api/review-items/rv_x/relaunch"],
      ["POST", "/api/review-items/rv_x/snooze"],
    ]) {
      expect(isTenantSafe(m, p), `${m} ${p}`).toBe(true);
      expect(judge(w.db, id, m, p), `${m} ${p}`).toEqual({ allow: true });
    }
    // only the routes the list serves: a guessed sub-route stays the home world's
    expect(isTenantSafe("POST", "/api/review-items/rv_x/delete")).toBe(false);
    expect(isTenantSafe("DELETE", "/api/review-items/rv_x")).toBe(false);
  });
});

describe("T48-S4 auth on: each world sees and acts on only its own review items", () => {
  /** Each world's list once its links were checked (the first read checks them in the background). */
  const seed = async (w: ReturnType<typeof worlds>) => {
    await w.req("GET", "/api/review-items", { bearer: w.aTok });
    await w.req("GET", "/api/review-items", { bearer: w.zTok });
    await new Promise((r) => setTimeout(r, 30));
    const a = (await w.req("GET", "/api/review-items", { bearer: w.aTok })).json;
    const z = (await w.req("GET", "/api/review-items", { bearer: w.zTok })).json;
    expect([a.length, z.length]).toEqual([1, 1]);
    return { a: a[0], z: z[0] };
  };

  it("GET /api/review-items: 200 with only the caller's world (both directions), no world_scope line", async () => {
    const w = worlds("on");
    await seed(w);
    const z = await w.req("GET", "/api/review-items", { bearer: w.zTok });
    expect(z.status).toBe(200);
    expect(z.json.map((i: any) => i.title)).toEqual(["SOCIAL-post"]);
    expect(z.text).not.toContain("ALPHA");
    const a = await w.req("GET", "/api/review-items", { bearer: w.aTok });
    expect(a.status).toBe(200);
    expect(a.json.map((i: any) => i.title)).toEqual(["ALPHA-book"]);
    expect(a.text).not.toContain("SOCIAL");
    for (const q of ["pending", "snoozed", "all"]) expect((await w.req("GET", `/api/review-items?state=${q}`, { bearer: w.zTok })).text).not.toContain("ALPHA");
    expect(w.events().filter((e) => e.reason === "world_scope")).toEqual([]);
  });

  it("home (legacy trust, the Team home on team.example.com) is unchanged: its own list, never another world's", async () => {
    const w = worlds("on");
    await seed(w);
    const a = await w.req("GET", "/api/review-items");
    expect(a.status).toBe(200);
    expect(a.json.map((i: any) => i.title)).toEqual(["ALPHA-book"]);
  });

  it("another world's item id is a 404 for recheck, approve, relaunch and snooze, and its row stays in review", async () => {
    const w = worlds("on");
    const { a, z } = await seed(w);
    for (const act of ["recheck", "approve", "relaunch", "snooze"]) {
      const body = act === "relaunch" ? { feedback: "redo" } : act === "snooze" ? { hours: 3 } : undefined;
      expect((await w.req("POST", `/api/review-items/${a.id}/${act}`, { bearer: w.zTok, body })).status, `z→a ${act}`).toBe(404);
      expect((await w.req("POST", `/api/review-items/${z.id}/${act}`, { bearer: w.aTok, body })).status, `a→z ${act}`).toBe(404);
    }
    expect(w.rA.rowLine("docs/spines/root.md", "T40-S2")).toContain("| review |");
    expect(w.rZ.rowLine("docs/spines/root.md", "Z-1")).toContain("| review |");
    // its own snooze works on the social world's Team home too (L-5 parity), then unsnooze
    const sn = await w.req("POST", `/api/review-items/${z.id}/snooze`, { bearer: w.zTok, body: { hours: 3 } });
    expect(sn.status).toBe(200);
    expect((await w.req("GET", "/api/review-items", { bearer: w.zTok })).json).toEqual([]);
    expect((await w.req("POST", `/api/review-items/${z.id}/snooze`, { bearer: w.zTok, body: { until: null } })).status).toBe(200);
    // its own: approve works, in its own repo
    const ok = await w.req("POST", `/api/review-items/${z.id}/approve`, { bearer: w.zTok });
    expect(ok.status).toBe(200);
    expect(ok.json.state).toBe("approved");
    expect(w.rZ.rowLine("docs/spines/root.md", "Z-1")).toMatch(/\| done \(approved by Sam \d{4}-\d{2}-\d{2}\) \|/);
    expect(w.rA.rowLine("docs/spines/root.md", "T40-S2")).toContain("| review |");
  });

  it("POST /api/review-items and a run's `review` are hints in any world: nothing is stored, no list changes", async () => {
    const w = worlds("on");
    const r = await w.req("POST", "/api/review-items", { bearer: w.zTok, body: { title: "x", liveUrl: "https://social.example.com/", milestoneId: w.mA.id } });
    expect(r.status).toBe(202);
    const run = await w.req("POST", "/api/runs", { bearer: w.zTok, body: { assignmentId: w.aZ.id, outcome: "running", summary: "" } });
    expect(run.status).toBe(201);
    const p = await w.req("PATCH", `/api/runs/${run.json.id}`, {
      bearer: w.zTok,
      body: { outcome: "progressed", summary: "Campaign page live.", review: { url: "https://social.example.com/campaigns", ref: "Z-2" } },
    });
    expect(p.status).toBe(200);
    const { a, z } = await seed(w);
    expect([a.ref, z.ref]).toEqual(["T40-S2", "Z-1"]);
  });
});

describe("T48-S4 auth off: one console, unchanged", () => {
  it("lists every world's rows in review", async () => {
    const w = worlds("off");
    await w.req("GET", "/api/review-items");
    await new Promise((r) => setTimeout(r, 30));
    const l = await w.req("GET", "/api/review-items");
    expect(l.json.map((i: any) => i.title).sort()).toEqual(["ALPHA-book", "SOCIAL-post"]);
  });
});
