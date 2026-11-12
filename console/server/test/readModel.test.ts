import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import type { ReadConfig } from "../src/routes/read.js";
import type { SpinesJson, SpinesRunner } from "../src/adapters/spines.js";
import type { ReadModelHost } from "../src/readModel/host.js";
import { createRefresher } from "../src/readModel/refresher.js";
import { applyPatch, keyOf, viewWaiting, type WaitingPayload } from "../src/readModel/views.js";
import { listSnapshotKeys } from "../src/readModel/table.js";
import type { WaitingItem } from "../src/inbox/waiting.js";

/**
 * Waiting on you (and the statuses) are a read model in console.db, built off the request path from the spines,
 * served in ms with an asOf, kept across restarts, changed at once by the owner's own answers.
 */
let root: string;
const dbs: DB[] = [];
const hosts: ReadModelHost[] = [];
const write = (rel: string, text: string) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
/** Write and push the mtime past the previous one (the refresher stamps mtime + size). */
let bump = 0;
const edit = (rel: string, text: string) => {
  write(rel, text);
  const t = new Date(Date.now() + 10_000 * ++bump);
  fs.utimesSync(path.join(root, rel), t, t);
};

const ASK = (code: string, q: string) => `- [ask ${code}: decide @Sam since 2026-10-30] ${q} — options: yes | no — recommend: yes — why Sam: product call`;
const SPINE = (asks: string[]) => `# PLAN-7: Fold
Spine ID: PLAN-7

## Current State

Owner: Delivery manager
Status: active
Waiting on: Sam (asks below)

## Waiting on

${asks.join("\n")}

## Issue Ledger

| Issue | Owner | Title | Status |
|---|---|---|---|
| T7-S1 | worker | First row | ready |
`;

/** A spines.py stand-in: counts calls and fails, so the tree is the markdown parse (the asks are read from the file). */
function countingRunner() {
  const calls: string[] = [];
  const run: SpinesRunner = async (dir) => {
    calls.push(dir);
    throw new Error("no spines.py in tests");
  };
  return { run, calls };
}

function setup(o: { runner?: SpinesRunner; dbFile?: string; mode?: "in-process" | "none"; teamRepo?: string } = {}) {
  const db = openDb(o.dbFile ?? path.join(root, "c.db"));
  dbs.push(db);
  const read: ReadConfig = { reposRoot: root, seatsFile: path.join(root, "seats.json"), listThreads: async () => [], ...(o.runner ? { spines: o.runner } : {}) };
  let host: ReadModelHost | undefined;
  const app = createApp(db, {
    read,
    browser: { browserUrl: "http://127.0.0.1:9" },
    readModel: { mode: o.mode ?? "in-process", tickMs: 0, onHost: (h) => hosts.push((host = h)) },
    ...(o.teamRepo ? { teamState: { repo: o.teamRepo } } : {}),
  });
  const get = async (url: string) => {
    const r = await app.request(url);
    return { body: await r.json(), asOf: r.headers.get("x-read-model-as-of") };
  };
  const post = async (url: string, body?: unknown) =>
    app.request(url, { method: "POST", headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const pass = async () => {
    await host!.refresher!.tick();
    await host!.refresher!.idle();
  };
  return { db, app, get, post, pass, host: () => host };
}

const open = (items: WaitingItem[]) => items.filter((i) => i.state === "open");

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e33s7-"));
  write("fold/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/fold.git\n`);
  write("fold/docs/spines/root.md", SPINE([ASK("PLAN-7-A1", "Ship the fold?")]));
});
afterEach(async () => {
  for (const h of hosts) await h.refresher?.idle();
  for (const h of hosts.splice(0)) h.close();
  for (const d of dbs.splice(0)) d.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("T33-S7 read model", () => {
  it("serves waiting and status from the stored view: no spines.py on the request, asOf on every answer", async () => {
    const { run, calls } = countingRunner();
    const { get, pass } = setup({ runner: run });
    const m = createStore(dbs[0]).createMilestone({ title: "Fold", repo: "Acme/fold", path: "docs/spines/root.md", owner: "", paused: false });
    await pass();
    const before = calls.length;
    expect(before).toBeGreaterThan(0); // the refresher read the repo
    for (let i = 0; i < 5; i++) {
      const w = await get("/api/waiting-on-owner");
      expect(open(w.body).map((x: WaitingItem) => x.code)).toEqual(["PLAN-7-A1"]);
      expect(w.asOf).toMatch(/^\d{4}-\d\d-\d\dT/);
      const ms = await get(`/api/waiting-on-owner?milestoneId=${m.id}&includeSuperseded=true`);
      expect(open(ms.body)).toHaveLength(1);
      const st = await get("/api/status");
      expect(st.body.needsYou).toBe(1);
      expect(st.body.asOf).toMatch(/^\d{4}-/);
      const one = await get(`/api/milestones/${m.id}/status`);
      expect(one.body.needsYou).toBe(1);
      expect(one.body.asOf).toMatch(/^\d{4}-/);
    }
    expect(calls.length).toBe(before);
  });

  it("a refresh after the spine changes updates the stored view (the request still never reads the spine)", async () => {
    const { run, calls } = countingRunner();
    const { get, pass } = setup({ runner: run });
    createStore(dbs[0]).createMilestone({ title: "Fold", repo: "Acme/fold", path: "docs/spines/root.md", owner: "", paused: false });
    await pass();
    const first = await get("/api/waiting-on-owner");
    edit("fold/docs/spines/root.md", SPINE([ASK("PLAN-7-A1", "Ship the fold?"), ASK("PLAN-7-A2", "Name it Fold?")]));
    const n = calls.length;
    // Until the refresher runs, the stored view answers (stale but instant).
    expect(open((await get("/api/waiting-on-owner")).body)).toHaveLength(1);
    expect(calls.length).toBe(n);
    await pass();
    expect(calls.length).toBeGreaterThan(n); // the moved stamp re-read that repo
    const after = await get("/api/waiting-on-owner");
    expect(open(after.body).map((x: WaitingItem) => x.code).sort()).toEqual(["PLAN-7-A1", "PLAN-7-A2"]);
    expect(after.asOf! >= first.asOf!).toBe(true);
    expect((await get("/api/status")).body.needsYou).toBe(2);
  });

  it("an unchanged repo is not re-read: the view's asOf moves on (checked), its content stays", async () => {
    const { run, calls } = countingRunner();
    const { get, pass } = setup({ runner: run });
    createStore(dbs[0]).createMilestone({ title: "Fold", repo: "Acme/fold", path: "docs/spines/root.md", owner: "", paused: false });
    await pass();
    const n = calls.length;
    const a = await get("/api/waiting-on-owner");
    await new Promise((r) => setTimeout(r, 15));
    await pass();
    expect(calls.length).toBe(n);
    const b = await get("/api/waiting-on-owner");
    expect(b.body).toEqual(a.body);
    expect(b.asOf! > a.asOf!).toBe(true);
  });

  it("T62-S4: open Needs Sam rows are never read (asks come from the spine alone); a refused answer keeps the spine ask counted", async () => {
    const { get, post, pass, host } = setup({ runner: countingRunner().run });
    const store = createStore(dbs[0]);
    const m = store.createMilestone({ title: "Fold", repo: "Acme/fold", path: "docs/spines/root.md", owner: "", paused: false });
    store.createNeedsJordi({ milestoneId: m.id, question: "May I rotate the staging key?", proposedAction: "rotate it", status: "open" });
    await pass();
    expect((await get("/api/status")).body.needsYou).toBe(1);
    expect(open((await get("/api/waiting-on-owner")).body).map((x: WaitingItem) => x.code)).toEqual(["PLAN-7-A1"]);
    await host()!.refresher!.idle();

    // An answer to the spine ask whose write is refused (no git checkout here): the card stays up and counted, with
    // the failure and Retry, until the answer is in the spine (it used to vanish for the patch's 5 min, then come back).
    const ask = open((await get("/api/waiting-on-owner")).body).find((x: WaitingItem) => x.code === "PLAN-7-A1")!;
    const res = await post(`/api/waiting-on-owner/${ask.id}/respond`, { kind: "answer", text: "yes", milestoneId: m.id });
    expect(res.status).toBe(201);
    const stored = (await res.json()) as { id: string };
    expect(stored).toMatchObject({ spine: { status: "skipped" }, job: { state: "failed" } });
    expect((await get("/api/status")).body.needsYou).toBe(1);
    // and after the refresher rebuilds the view (it used to count this failed answer as answered: 0 on a busy host,
    // where a refresh landed between the answer and the read)
    await pass();
    expect((await get("/api/status")).body.needsYou).toBe(1);
    const card = open((await get("/api/waiting-on-owner")).body).find((x: WaitingItem) => x.id === ask.id) as (WaitingItem & { response?: unknown }) | undefined;
    expect(card?.response).toMatchObject({ id: stored.id, job: { state: "failed" } });
  });

  it("after a restart the stored view answers at once, before the new refresher has read anything", async () => {
    const dbFile = path.join(root, "persist.db");
    const first = setup({ runner: countingRunner().run, dbFile });
    createStore(dbs[0]).createMilestone({ title: "Fold", repo: "Acme/fold", path: "docs/spines/root.md", owner: "", paused: false });
    await first.pass();
    const before = (await first.get("/api/waiting-on-owner")).body;
    for (const h of hosts.splice(0)) h.close();
    dbs.splice(0).forEach((d) => d.close());

    // The new console's spines.py never answers (a cold, loaded host): the request does not wait for it.
    const calls: string[] = [];
    const never: SpinesRunner = (dir) => (calls.push(dir), new Promise<SpinesJson>(() => {}));
    const second = setup({ runner: never, dbFile });
    const t0 = Date.now();
    const w = await second.get("/api/waiting-on-owner");
    const st = await second.get("/api/status");
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(w.body).toEqual(before);
    expect(st.body.needsYou).toBe(1);
    expect(calls).toEqual([]);
  });

  it("the asker (git blame of the ask line) comes from the stored view, not from the request", async () => {
    const { get, pass } = setup({ runner: countingRunner().run });
    const store = createStore(dbs[0]);
    const m = store.createMilestone({ title: "Fold", repo: "Acme/fold", path: "docs/spines/root.md", owner: "", paused: false });
    const b = store.createPersona({ name: "Builder", remit: "x", skills: [], model: "sonnet", mayWrite: false });
    const a = store.createAssignment({ milestoneId: m.id, personaId: b.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true });
    await pass();
    expect(open((await get("/api/waiting-on-owner")).body)[0].asker).toMatchObject({ assignmentId: a.id, personaName: "Builder" });
    // Detached since: a request working it out itself would find no one; the stored view still names the asker it read.
    store.deleteAssignment(a.id);
    expect(open((await get("/api/waiting-on-owner")).body)[0].asker).toMatchObject({ assignmentId: a.id });
  });

  it("a view with no row yet is answered inline but never stored: the refresher is the only writer", async () => {
    const { get, pass } = setup({ runner: countingRunner().run });
    createStore(dbs[0]).createMilestone({ title: "Fold", repo: "Acme/fold", path: "docs/spines/root.md", owner: "", paused: false });
    const w = await get("/api/waiting-on-owner");
    expect(open(w.body)).toHaveLength(1);
    expect(listSnapshotKeys(dbs[0])).toEqual([]);
    await pass();
    expect(listSnapshotKeys(dbs[0]).length).toBeGreaterThan(0);
  });

  it("answers exactly as the per-request path for every variant the web uses", async () => {
    write("fold/docs/spines/child.md", SPINE([ASK("PLAN-8-A1", "Child question?")]).replace(/PLAN-7/g, "PLAN-8"));
    write("fold/docs/spines/root.md", SPINE([ASK("PLAN-7-A1", "Ship the fold?")]).replace("| T7-S1 | worker | First row | ready |", "| T7-S1 | worker | First row | ready |\n| [PLAN-8](child.md) | worker | Child epic | active |"));
    const dbFile = path.join(root, "same.db");
    // the fold checkout plays the owner's team repo here, so both paths label its asks "Team".
    const rm = setup({ runner: countingRunner().run, dbFile, teamRepo: "fold" });
    const store = createStore(dbs[0]);
    const m = store.createMilestone({ title: "Fold", repo: "Acme/fold", path: "docs/spines/root.md", owner: "", paused: false });
    const nj = store.createNeedsJordi({ milestoneId: m.id, question: "Old question?", proposedAction: "", status: "open" });
    store.supersedeNeedsJordi(nj.id, "fold/PLAN-7-A1");
    store.createNeedsJordi({ milestoneId: m.id, question: "May I rotate the key?", proposedAction: "rotate", status: "open" });
    await rm.pass();
    const plain = setup({ runner: countingRunner().run, dbFile, mode: "none", teamRepo: "fold" });
    const keys = [...new Set(((await plain.get(`/api/waiting-on-owner?milestoneId=${m.id}`)).body as WaitingItem[]).map((i) => i.nodeKey!))];
    expect(keys.length).toBeGreaterThan(1);
    const urls = [
      "/api/waiting-on-owner",
      "/api/waiting-on-owner?includeSuperseded=true",
      "/api/waiting-on-owner?includeSettled=true",
      `/api/waiting-on-owner?milestoneId=${m.id}`,
      `/api/waiting-on-owner?milestoneId=${m.id}&includeSuperseded=true`,
      ...keys.map((k) => `/api/waiting-on-owner?milestoneId=${m.id}&nodeKey=${encodeURIComponent(k)}&includeSuperseded=true`),
      `/api/waiting-on-owner?nodeKey=${encodeURIComponent(keys[keys.length - 1])}`,
      "/api/waiting-on-owner?repo=fold&path=docs/spines/child.md",
      "/api/status",
      `/api/milestones/${m.id}/status`,
    ];
    const strip = (x: unknown): unknown =>
      Array.isArray(x) ? x.map(strip) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== "asOf" && k !== "at").map(([k, v]) => [k, strip(v)])) : x;
    for (const u of urls) expect(strip((await rm.get(u)).body), u).toEqual(strip((await plain.get(u)).body));
    expect(((await rm.get("/api/waiting-on-owner")).body as WaitingItem[]).some((i) => i.milestoneTitle === "Team")).toBe(true);
  });
});

describe("T33-S7 refresher", () => {
  it("a slow repo holds only the views that read it; another world's views are written", async () => {
    write("slow/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/slow.git\n`);
    write("slow/docs/spines/root.md", SPINE([ASK("PLAN-7-A9", "Slow question?")]));
    const db = openDb(path.join(root, "r.db"));
    dbs.push(db);
    const iso = new Date().toISOString();
    db.prepare("INSERT INTO tenants (id, name, skin, plan, created_at) VALUES (?, ?, 'social', 'founding', ?)").run("zs", "zs", iso);
    createStore(db).createMilestone({ title: "Fold", repo: "Acme/fold", path: "docs/spines/root.md", owner: "", paused: false });
    createStore(db, { tenant: "zs" }).createMilestone({ title: "Slow", repo: "Acme/slow", path: "docs/spines/root.md", owner: "", paused: false });
    const spines: SpinesRunner = (dir) => (dir.endsWith("slow") ? new Promise<SpinesJson>(() => {}) : Promise.reject(new Error("fallback")));
    const r = createRefresher({ db, reposRoot: root, spines, worlds: ["home", "zs"] });
    await r.tick();
    await new Promise((res) => setTimeout(res, 100));
    await r.tick();
    const stored = listSnapshotKeys(db).map((x) => JSON.parse(x.key) as unknown[]);
    expect(stored.some((k) => k[1] === "home" && k[0] === "status")).toBe(true);
    expect(stored.some((k) => k[1] === "home" && k[0] === "waiting")).toBe(true);
    expect(stored.some((k) => k[1] === "zs" && k[0] !== "review")).toBe(false);
    // the review view reads the spine files itself, never spines.py: a slow repo does not hold it
    expect(stored.some((k) => k[1] === "zs" && k[0] === "review")).toBe(true);
    r.stop();
  });
});

describe("T33-S7 views", () => {
  const item = (over: Partial<WaitingItem>): WaitingItem => ({
    id: "x", source: "ask", state: "open", milestoneId: "m1", milestoneTitle: "M", nodeKey: "m1/a", title: "t", ask: "decide", question: "q?", contextLinks: [], owner: { kind: "none", label: "" }, decidable: false, ...over,
  });
  it("nodeKey keeps the item's own node and the references in scope; superseded only on request", () => {
    const p: WaitingPayload = {
      items: [
        item({ id: "a", nodeKey: "m1/a" }),
        item({ id: "b", nodeKey: "m1/b/c" }),
        item({ id: "c", milestoneId: "m2", nodeKey: "m2/x", referencedBy: [{ milestoneId: "m1", milestoneTitle: "M", path: "p.md", nodeKey: "m1/b", via: "waits_on" }] }),
        item({ id: "d", source: "needs_jordi", state: "superseded", nodeKey: "m1" }),
      ],
      defects: [],
      scopedIds: ["m1"],
    };
    expect(viewWaiting(p, {}).map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(viewWaiting(p, { includeSuperseded: true }).map((i) => i.id)).toEqual(["a", "b", "c", "d"]);
    expect(viewWaiting(p, { nodeKey: "m1/b" }).map((i) => i.id)).toEqual(["b", "c"]);
  });
  it("a patch answers / snoozes / supersedes the item in every view kind and recounts", () => {
    const k = { kind: "status" as const, world: "", includeSettled: false };
    const st = { milestones: [{ milestoneId: "m1", items: [{ id: "a", kind: "ask", state: "open", milestoneId: "m1", title: "t" }, { id: "b", kind: "ask", state: "open", milestoneId: "m1", title: "t" }], needsYou: 2 }], items: [{ id: "a", kind: "ask", state: "open", milestoneId: "m1", title: "t" }, { id: "b", kind: "ask", state: "open", milestoneId: "m1", title: "t" }], needsYou: 2, at: "" };
    const a = applyPatch(k, st, { kind: "answered", id: "a" }) as typeof st;
    expect([a.needsYou, a.milestones[0].needsYou, a.items[0].state]).toEqual([1, 1, "answered"]);
    const s = applyPatch(k, a, { kind: "snoozed", id: "b", until: "2026-12-01" }) as typeof st;
    expect([s.needsYou, s.items.map((i) => i.id)]).toEqual([0, ["a"]]);
    const w = applyPatch({ kind: "waiting", world: "", includeSettled: false }, { items: [item({ id: "b" })], defects: [], scopedIds: ["m1"] }, { kind: "snoozed", id: "b", until: "2026-12-01" }) as WaitingPayload;
    expect(w.items[0].snoozedUntil).toBe("2026-12-01");
    expect(keyOf({ kind: "waiting", world: "", includeSettled: false })).not.toBe(keyOf({ kind: "waiting", world: "", includeSettled: true }));
  });
});
