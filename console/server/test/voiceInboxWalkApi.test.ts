import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { ReadConfig } from "../src/routes/read.js";
vi.hoisted(async () => (await import("../src/identity.js")).setIdentity({ owner: "Sam" }));

// through the API: the Team desk's call starts with his inbox (the open ask of repo3 here), and the walk's tools
// answer at POST /api/voice/calls/:cid/tool, keeping his place.

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

describe("the inbox walk through the API", () => {
  it("the call's instructions list his open question, next_card reads it with its place, an unknown tool is refused", async () => {
    const readCfg: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] };
    const ok = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const minted: any[] = [];
    const mint = async (b: unknown) => (minted.push(b), { value: "ek_test", expires_at: Math.floor(Date.now() / 1000) + 60, session: { id: "sess_1" } });
    const app = createApp(db, { read: readCfg, review: { live: { fetch: ok, consoleHosts: [] } }, voice: { mint } });
    const call = async (method: string, url: string, body?: unknown) => {
      const headers: Record<string, string> = { "sec-fetch-site": "same-origin", ...(body === undefined ? {} : { "Content-Type": "application/json" }) };
      const res = await app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : undefined };
    };
    for (const n of ["1", "2", "3"]) expect((await call("POST", "/api/milestones", { title: `Root ${n}`, repo: `Acme/repo${n}`, path: "docs/spines/root.md" })).status).toBe(201);

    const started = await call("POST", "/api/voice/calls");
    expect(started.status).toBe(201);
    const sess = minted[0].session;
    expect(sess.tools.map((t: { name: string }) => t.name)).toContain("next_card");
    expect(sess.instructions).toMatch(/His inbox now: 1 card \(0 to review, 1 questions\)\./);
    expect(sess.instructions).toMatch(/1\. Question \[E903-A1\]/);
    const id = started.json.call.id;
    const next = await call("POST", `/api/voice/calls/${id}/tool`, { name: "next_card", args: {} });
    expect(next.status).toBe(200);
    expect(next.json).toMatchObject({ place: "card 1 of 1", pos: 1, total: 1 });
    expect(next.json.card).toContain("A question waiting on Sam");
    expect((await call("POST", `/api/voice/calls/${id}/tool`, { name: "next_card" })).json).toMatchObject({ done: true });
    expect((await call("POST", `/api/voice/calls/${id}/tool`, { name: "press_button", args: {} })).status).toBe(404);
    expect((await call("POST", `/api/voice/calls/${id}/tool`, {})).status).toBe(400);
  });
});
