import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import type { ReadConfig } from "../src/routes/read.js";
import type { SpinesRunner } from "../src/adapters/spines.js";
import type { ReadModelHost } from "../src/readModel/host.js";
import { firstDiff, normalizeView, viewDiff } from "../src/readModel/drift.js";

/**
 * the hourly drift check rebuilds every stored read-model view from the repo off to the side and
 * compares it with the stored payload (times ignored). A cache written by anything but the refresher, or a refresh that
 * missed a change, is drift: logged, in /api/health, and sent to the owner through the WhatsApp alert path.
 */
let root: string;
const dbs: DB[] = [];
const hosts: ReadModelHost[] = [];
const write = (rel: string, text: string) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
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
const noSpines: SpinesRunner = async () => {
  throw new Error("no spines.py in tests");
};

function setup() {
  const db = openDb(path.join(root, "c.db"));
  dbs.push(db);
  const sent: string[] = [];
  const read: ReadConfig = { reposRoot: root, seatsFile: path.join(root, "seats.json"), listThreads: async () => [], spines: noSpines };
  let host: ReadModelHost | undefined;
  const app = createApp(db, {
    read,
    browser: { browserUrl: "http://127.0.0.1:9" },
    readModel: { mode: "in-process", tickMs: 0, onHost: (h) => hosts.push((host = h)), drift: { everyMs: 3600_000, firstAfterMs: 3600_000, confirmAfterMs: 0, alert: true } },
    whatsapp: { sender: async () => async (text: string) => (sent.push(text), { ok: true, receipt: "whatsapp:m1:sent" }) },
  });
  const m = createStore(db).createMilestone({ title: "Fold", repo: "Acme/fold", path: "docs/spines/root.md", owner: "", paused: false });
  const pass = async () => {
    await host!.refresher!.tick();
    await host!.refresher!.idle();
  };
  const health = async () => (await (await app.request("/api/health")).json()) as { ok: boolean; drift: { state: string; checked?: number; differ?: number; at?: string } };
  return { db, app, m, pass, health, sent, host: () => host! };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e62s3-"));
  write("fold/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/fold.git\n`);
  write("fold/docs/spines/root.md", SPINE([ASK("PLAN-7-A1", "Ship the fold?")]));
});
afterEach(async () => {
  for (const h of hosts) await h.refresher?.idle();
  for (const h of hosts.splice(0)) h.close();
  for (const d of dbs.splice(0)) d.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("T62-S3 drift check", () => {
  it("compares while ignoring computation times; names the first difference", () => {
    expect(normalizeView({ at: "x", asOf: "y", b: [{ checkedAt: 1, v: 2 }], u: undefined })).toEqual({ b: [{ v: 2 }] });
    expect(firstDiff({ a: [1, { s: "open" }] }, { a: [1, { s: "answered" }] })).toEqual({ path: "a[1].s", stored: '"open"', fresh: '"answered"' });
    expect(viewDiff(JSON.stringify({ at: "2026-01-01", items: [1] }), { at: "2026-11-02", items: [1] })).toBeUndefined();
  });

  it("a cache built by the refresher matches its rebuild from the repo; /api/health reports the check", async () => {
    const t = setup();
    expect((await t.health()).drift.state).toBe("pending");
    await t.pass();
    const r = await t.host().checkDrift();
    expect(r?.error).toBeUndefined();
    expect(r?.differ).toEqual([]);
    expect(r?.ok).toBe(true);
    expect(r!.checked).toBeGreaterThanOrEqual(3); // Team waiting + status, the milestone's waiting + status
    const h = await t.health();
    expect(h.drift).toMatchObject({ state: "ok", differ: 0, checked: r!.checked });
    expect(t.sent).toEqual([]);
  });

  it("a spine edit the refresher has not read yet is not drift (the check lets it catch up first)", async () => {
    const t = setup();
    await t.pass();
    write("fold/docs/spines/root.md", SPINE([ASK("PLAN-7-A1", "Ship the fold?"), ASK("PLAN-7-A2", "Name it?")]));
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(root, "fold/docs/spines/root.md"), later, later);
    const r = await t.host().checkDrift();
    expect(r?.ok).toBe(true);
  });

  it("a stored view written by anything but the refresher is drift: logged, in health, alerted once", async () => {
    const t = setup();
    await t.pass();
    const key = JSON.stringify(["waiting", "", t.m.id, 0]);
    const row = t.db.prepare("SELECT payload FROM read_model WHERE key = ?").get(key) as { payload: string };
    const p = JSON.parse(row.payload) as { items: { state: string }[] };
    p.items[0]!.state = "answered"; // a DB-only "answered": the spine still shows the ask open
    t.db.prepare("UPDATE read_model SET payload = ? WHERE key = ?").run(JSON.stringify(p), key);
    const r = await t.host().checkDrift();
    expect(r?.ok).toBe(false);
    expect(r?.differ.map((d) => d.key)).toEqual([key]);
    expect(r?.differ[0]).toMatchObject({ path: "items[0].state", stored: '"answered"', fresh: '"open"' });
    expect((await t.health()).drift).toMatchObject({ state: "drift", differ: 1 });
    const full = (await (await t.app.request("/api/read-model/drift")).json()) as { last: { differ: { key: string }[] } };
    expect(full.last.differ[0]!.key).toBe(key);
    await new Promise((res) => setTimeout(res, 20));
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatch(/read model DRIFT: 1 of \d+ views differ/);
    expect(t.sent[0]).toMatch(/L-45/);
    expect((t.db.prepare("SELECT kind, ok FROM wa_sends").all() as { kind: string }[]).map((x) => x.kind)).toEqual(["drift"]);
    // the same drift again the same day: not sent twice
    await t.host().checkDrift();
    await new Promise((res) => setTimeout(res, 20));
    expect(t.sent).toHaveLength(1);
  });
});
