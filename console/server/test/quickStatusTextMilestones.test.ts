import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { ReadConfig } from "../src/routes/read.js";
import { quickStatusText, VOICE_TOOLS } from "../src/voice/voice.js";

/** the call's quick status names the owner's milestones in priority order (big roots first), so "what are my priorities?" needs no desk. */

describe("E942-S9 quickStatusText milestones", () => {
  it("big roots numbered in the given order, then the other milestones; state, % done and what waits on Sam", () => {
    const text = quickStatusText({
      milestones: [
        { title: "Memo launch", bigRoot: 1, word: "needs_you", pct: 40, needsYou: 3, waits: ["EPIC-929-A1 Create the Memo accounts", "E946-A4 proxy"] },
        { title: "House decision", bigRoot: 2, word: "stalled" },
        { title: "home_repo", word: "working", pct: 72 },
      ],
      waiting: [],
      stuck: [],
      working: [],
    }).split("\n");
    expect(text.slice(0, 5)).toEqual([
      "Priorities (Sam's focus milestones, in his order, 1 = top priority): 2.",
      "1. Memo launch: waits on you, 40% done; waits on Sam: EPIC-929-A1 Create the Memo accounts; E946-A4 proxy and 1 more",
      "2. House decision: stuck: no one is moving it",
      "Other milestones (not in focus, after the focus milestones): 1.",
      "- home_repo: being worked on now, 72% done",
    ]);
    expect(text[5]).toBe("Waiting on Sam: 0.");
  });

  it("no big roots: one plain list; none at all: the old three sections only", () => {
    expect(quickStatusText({ milestones: [{ title: "A", word: "planning" }], waiting: [], stuck: [], working: [] }).split("\n").slice(0, 2)).toEqual([
      "Milestones (no priority set): 1.",
      "- A: a draft, not started",
    ]);
    expect(quickStatusText({ waiting: [], stuck: [], working: [] })).toBe("Waiting on Sam: 0.\nStuck: 0.\nWorking now: 0.");
  });

  it("the tool description tells the voice priorities come from quick status", () => {
    expect(VOICE_TOOLS.find((t) => t.name === "quick_status")?.description).toMatch(/priority order.*big roots first/);
    expect(VOICE_TOOLS.find((t) => t.name === "quick_status")?.description).toMatch(/what are my priorities/);
  });
});

const spine = (n: string, ask: boolean) => `# EPIC-990${n}: Spine ${n}

Integration policy: main-direct

## Current State

Status: active
Waiting on: ${ask ? "Sam (see Waiting on)" : "none"}

## Waiting on

${ask ? `- [ask E90${n}-A1: decide @Sam since 2026-10-22 row T1] Question ${n} — unblocks: T1` : ""}

## Issue Ledger

| Issue | Title | Needs | Status |
|---|---|---|---|
| T1 | Thing | Sam | ${ask ? "blocked" : "ready"} |
`;

let tmp: string;
let db: DB;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e42s9-"));
  for (const n of ["1", "2", "3"]) {
    const dir = path.join(tmp, `repo${n}`);
    fs.mkdirSync(path.join(dir, "docs/spines"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs/spines/root.md"), spine(n, n === "3"));
    git(tmp, "init", "-q", "-b", "main", dir);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "seed");
  }
  db = openDb(path.join(tmp, "console.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("E942-S9 the call's quick status through the API", () => {
  it("lists the milestones big roots first, in Sam's order, with what waits on him, well under 0.5 s", async () => {
    const readCfg: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] };
    const ok = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const mint = async () => ({ value: "ek_test", expires_at: Math.floor(Date.now() / 1000) + 60, session: { id: "sess_1" } });
    const app = createApp(db, { read: readCfg, review: { live: { fetch: ok, consoleHosts: [] } }, voice: { mint } });
    const call = async (method: string, url: string, body?: unknown) => {
      const headers: Record<string, string> = { "sec-fetch-site": "same-origin", ...(body === undefined ? {} : { "Content-Type": "application/json" }) };
      const res = await app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : undefined };
    };
    const one = (await call("POST", "/api/milestones", { title: "Old milestone", repo: "Acme/repo1", path: "docs/spines/root.md" })).json;
    const two = (await call("POST", "/api/milestones", { title: "Second root", repo: "Acme/repo2", path: "docs/spines/root.md" })).json;
    const three = (await call("POST", "/api/milestones", { title: "Top root", repo: "Acme/repo3", path: "docs/spines/root.md" })).json;
    expect((await call("PATCH", `/api/milestones/${three.id}`, { bigRoot: 1 })).status).toBe(200);
    expect((await call("PATCH", `/api/milestones/${two.id}`, { bigRoot: 2 })).status).toBe(200);
    void one;

    const started = await call("POST", "/api/voice/calls");
    expect(started.status).toBe(201);
    const t0 = performance.now();
    const st = await call("GET", `/api/voice/calls/${started.json.call.id}/status`);
    const ms = performance.now() - t0;
    expect(st.status).toBe(200);
    expect(st.json.milestones).toBe(3);
    const lines = (st.json.text as string).split("\n");
    expect(lines[0]).toBe("Priorities (Sam's focus milestones, in his order, 1 = top priority): 2.");
    expect(lines[1]).toMatch(/^1\. Top root: waits on you.*; waits on Sam: E903-A1 /);
    expect(lines[2]).toMatch(/^2\. Second root: /);
    expect(lines[3]).toBe("Other milestones (not in focus, after the focus milestones): 1.");
    expect(lines[4]).toMatch(/^- Old milestone: /);
    // A second read comes from the read model / warm caches: the voice's answer time.
    const t1 = performance.now();
    await call("GET", `/api/voice/calls/${started.json.call.id}/status`);
    expect(Math.min(ms, performance.now() - t1)).toBeLessThan(500);
  });
});
