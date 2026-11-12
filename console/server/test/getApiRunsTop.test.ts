import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { ReadConfig } from "../src/routes/read.js";
import { createStore } from "../src/store.js";
import { mountAskedNoRow, type AskedNoRow } from "../src/status/askedNoRow.js";

/**
 * lists loaded from an API that sends everything get the Show 20 / 50 / all limit on the server:
 * /api/runs?top= (the newest wakes with their child runs, and the wake count), /api/tickets?limit=, /api/asked-no-row?limit=.
 * Without the parameter each answers as before.
 */

let reposRoot: string;
let db: DB;
const write = (rel: string, text: string) => {
  const f = path.join(reposRoot, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

beforeEach(() => {
  reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s16-"));
  write("ending/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/ending.git\n`);
  write("ending/docs/spines/root.md", "# PLAN-9: Ending\n\n## Current State\n\nStatus: active\n");
  for (let i = 1; i <= 5; i++) write(`ending/tickets/T${i}-thing.md`, `# T${i}: Thing ${i}\n\nStatus: ready\n`);
});
afterEach(() => {
  db?.close();
  fs.rmSync(reposRoot, { recursive: true, force: true });
});

async function setup() {
  db = openDb(path.join(reposRoot, "console.db"));
  const read: ReadConfig = { reposRoot, seatsFile: path.join(reposRoot, "seats.json"), listThreads: async () => [] };
  const app = createApp(db, { read, browser: { browserUrl: "http://127.0.0.1:9" } });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  const m = (await call("POST", "/api/milestones", { title: "Ending", repo: "Acme/ending", path: "docs/spines/root.md" })).json;
  const p = (await call("POST", "/api/personas", { name: "steward", remit: "runs the milestone", model: "opus" })).json;
  const a = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 } })).json;
  return { call, a, m };
}

describe("GET /api/runs?top= (T48-S16 Runs page)", () => {
  it("the newest n wakes, every run under them (two levels), and the wake count; all = every wake; no top = as before", async () => {
    const { call, a, m } = await setup();
    const store = createStore(db);
    const at = (min: number) => new Date(Date.UTC(2026, 10, 1, 0, min)).toISOString();
    const wakes = Array.from({ length: 30 }, (_, i) => store.createRun({ assignmentId: a.id, startedAt: at(i), outcome: "progressed", summary: `w${i}`, kind: "wake" }));
    const kid = store.createRun({ assignmentId: a.id, parentRunId: wakes[29].id, startedAt: at(40), outcome: "progressed", summary: "kid" });
    const grandkid = store.createRun({ assignmentId: a.id, parentRunId: kid.id, startedAt: at(41), outcome: "progressed", summary: "grandkid" });
    store.createRun({ assignmentId: a.id, parentRunId: wakes[0].id, startedAt: at(42), outcome: "progressed", summary: "old kid" });

    const top = (await call("GET", "/api/runs?top=20")).json;
    expect(top.total).toBe(30);
    const ids = top.runs.map((r: { id: string }) => r.id);
    expect(ids.slice(0, 20)).toEqual(wakes.slice(10).reverse().map((w) => w.id)); // newest first
    expect(ids).toContain(kid.id);
    expect(ids).toContain(grandkid.id);
    expect(top.runs.some((r: { summary: string }) => r.summary === "old kid")).toBe(false); // its wake is not in the 20
    expect(top.runs).toHaveLength(22);

    const all = (await call("GET", "/api/runs?top=all")).json;
    expect(all.total).toBe(30);
    expect(all.runs).toHaveLength(33);
    expect((await call("GET", `/api/runs?top=5&milestoneId=${m.id}`)).json.total).toBe(30);
    expect((await call("GET", "/api/runs?top=5&milestoneId=ms_none")).json).toEqual({ runs: [], total: 0 });

    const flat = (await call("GET", "/api/runs")).json;
    expect(Array.isArray(flat)).toBe(true);
    expect(flat).toHaveLength(33);
  });
});

describe("GET /api/tickets?limit= (T48-S16 Tickets page)", () => {
  it("the first n tickets and the count; no limit = the array as before", async () => {
    const { call } = await setup();
    const full = (await call("GET", "/api/tickets")).json;
    expect(Array.isArray(full)).toBe(true);
    expect(full.length).toBeGreaterThanOrEqual(5);
    const cut = (await call("GET", "/api/tickets?limit=2")).json;
    expect(cut).toEqual({ tickets: full.slice(0, 2), total: full.length });
    expect((await call("GET", "/api/tickets?limit=all")).json).toEqual({ tickets: full, total: full.length });
  });
});

describe("GET /api/asked-no-row?limit= (T48-S16 Team home)", () => {
  it("the first n lines and the total; no limit = every line", async () => {
    const items: AskedNoRow[] = Array.from({ length: 30 }, (_, i) => ({ milestoneId: "ms_1", milestoneTitle: "t", path: "p.md", spineTitle: "PLAN-1", id: `E1-${i + 1}`, text: "x" }) as AskedNoRow);
    const api = new Hono();
    mountAskedNoRow(api, { list: async () => ({ items }) });
    const cut = await (await api.request("/asked-no-row?limit=20")).json();
    expect(cut.items).toHaveLength(20);
    expect(cut.total).toBe(30);
    expect(await (await api.request("/asked-no-row")).json()).toEqual({ items, total: 30 });
  });
});
