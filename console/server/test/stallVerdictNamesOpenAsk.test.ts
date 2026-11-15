import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Tree, TreeNode } from "../src/adapters/tree.js";
import { epicWaits, stallVerdict, type MovingEpic } from "../src/cycle/movement.js";
import { openDb, type DB } from "../src/db.js";
import type { WaitingItem } from "../src/inbox/waiting.js";
import type { ReadConfig } from "../src/routes/read.js";
import type { Assignment } from "../src/store.js";

/**
 * the stall watch named no `[waits on]` reference as an epic's blocker./27/30/31 read
 * `skip · no unclaimed ready rows` while each row waits on (the owner). The verdict now reuses the console's one
 * resolver (waitingOnJordi → referencedBy, D19) and names the open ask and who it waits on.
 */

const NOW = Date.parse("2026-11-01T06:00:00Z");
const H = 3600_000;
const epic = (over: Partial<MovingEpic> = {}): MovingEpic => ({
  milestoneId: "m1", repo: "Acme/x", path: "docs/spines/epic-26.md", title: "PLAN-26", status: "active",
  workers: [], doneToday: [], ready: [], rows: ["T26-S1", "T26-S2"], lastCommitAt: new Date(NOW - 3 * H).toISOString(), ...over,
});
const dm = { id: "as_dm", milestoneId: "m1", personaId: "p_dm", enabled: true, createdAt: "2026-10-01T00:00:00Z" } as Assignment;
const seats = [{ id: "seat1", name: "seat1", resetsAt: {}, limited: false, inFlight: 0, status: "ok" as const }];
const verdict = (e: Partial<MovingEpic>, waits?: Parameters<typeof stallVerdict>[0]["waits"]) =>
  stallVerdict({ milestone: { id: "m1", repo: "Acme/x", paused: false }, epic: epic(e), manager: dm, managerName: "Delivery Manager", runs: [], seats, waits }, NOW);

const node = (over: Partial<TreeNode>): TreeNode => ({ key: "k", id: "x", kind: "ticket", title: "", status: "open", color: "grey", children: [], flags: [], ...over });
const ask = (over: Partial<WaitingItem>): WaitingItem =>
  ({ id: "wj", source: "ask", state: "open", code: "PLAN-29-A1", repo: "x", who: "Sam", milestoneId: "m1", path: "docs/spines/epic-29.md", row: "T29-S0", title: "", ask: "do", question: "", contextLinks: [], owner: { kind: "none" }, ...over }) as WaitingItem;

describe("T6-S43 stallVerdict names the open ask", () => {
  const w = [{ code: "PLAN-29-A1", who: "Sam", rows: ["T26-S2"] }];
  it("no unclaimed ready rows + an open ask → 'waits on <code> (<who>) for <rows>', with waitsOn", () => {
    expect(verdict({}, w)).toMatchObject({ verdict: "skip", reason: "waits on PLAN-29-A1 (Sam) for T26-S2", waitsOn: w });
    expect(verdict({}, [...w, { code: "ops/PLAN-10-A7", who: "Sam", rows: [] }]).reason).toBe("waits on PLAN-29-A1 (Sam) for T26-S2; waits on ops/PLAN-10-A7 (Sam)");
  });
  it("without waits the reason is unchanged; a blocked epic keeps its status reason and adds the ask", () => {
    expect(verdict({}).reason).toBe("no unclaimed ready rows");
    expect(verdict({}, []).reason).toBe("no unclaimed ready rows");
    expect(verdict({ status: "blocked" }, w).reason).toBe("status blocked: not ready/active · waits on PLAN-29-A1 (Sam) for T26-S2");
  });
  it("an epic that still has ready rows is judged as before (the ask holds only its own rows)", () => {
    const v = verdict({ ready: ["T26-S1"] }, w);
    expect(v.verdict).toBe("fire");
    expect(v.waitsOn).toBeUndefined();
  });
});

describe("T6-S43 epicWaits", () => {
  const tree = {
    root: node({ key: "r", kind: "spine", children: [
      node({ key: "r/T26-S2", id: "T26-S2" }),
      node({ key: "r/T26-S9", id: "T26-S9", status: "done", color: "green" }),
      node({ key: "r/T27-S1", id: "T27-S1", status: "superseded", color: "grey" }),
    ] }),
  } as unknown as Tree;
  const ref = (p: string, row: string, key: string, milestoneId = "m1") => ({ milestoneId, milestoneTitle: "", path: p, row, nodeKey: key, via: "waits_on" as const });
  it("its own open asks and the open asks its open rows reference, per epic file; closed rows, other milestones, answered asks do not count", () => {
    const items = [
      ask({ referencedBy: [ref("docs/spines/epic-26.md", "T26-S2", "r/T26-S2"), ref("docs/spines/epic-26.md", "T26-S9", "r/T26-S9"), ref("docs/spines/epic-27.md", "T27-S1", "r/T27-S1"), ref("docs/spines/epic-30.md", "T30-S2", "o/T30-S2", "m2")] }),
      ask({ id: "wj2", code: "PLAN-10-A7", repo: "ops", milestoneId: "m9", path: "docs/spines/epic10.md", row: "S4", referencedBy: [ref("./docs/spines/epic-26.md", "T26-S2", "r/T26-S2")] }),
      ask({ id: "wj3", code: "PLAN-26-A1", state: "answered", path: "docs/spines/epic-26.md", row: "T26-S1" }),
      { ...ask({ id: "h1", code: undefined, path: "docs/spines/epic-26.md" }), source: "heuristic" } as WaitingItem,
    ];
    expect(epicWaits({ id: "m1", repo: "Acme/x" }, tree, items)).toEqual({
      "docs/spines/epic-29.md": [{ code: "PLAN-29-A1", who: "Sam", rows: ["T29-S0"] }],
      "docs/spines/epic-26.md": [{ code: "PLAN-29-A1", who: "Sam", rows: ["T26-S2"] }, { code: "ops/PLAN-10-A7", who: "Sam", rows: ["T26-S2"] }],
    });
  });
});

// ---------- app: GET /api/stall-watch on real spine files ----------

const ASKER = `# PLAN-29: Social capabilities

## Current State

Status: active
Waiting on: Sam (PLAN-29-A1)

## Waiting on

- [ask PLAN-29-A1: do @Sam since 2026-10-27 row T29-S0] Create the four accounts at https://signup.example — why Sam: his phone and email

## Issue Ledger

| Issue | Title | Needs | Status |
|---|---|---|---|
| T29-S0 | Accounts exist | Sam | blocked |
`;
const WAITER = (status: string) => `# PLAN-26: TikTok

## Current State

Status: ${status}

## Waiting on

- [waits on social/PLAN-29-A1 row T26-S2] The TikTok account Sam creates
- [waits on social/PLAN-29-A1 row T26-S9] An old step, already done

## Issue Ledger

| Issue | Title | Needs | Status |
|---|---|---|---|
| T26-S2 | Post the first short | account | open |
| T26-S3 | Read DMs | T26-S2 | open |
| T26-S9 | Old step | — | done |
`;

let reposRoot: string;
let db: DB;
const write = (rel: string, text: string) => {
  const f = path.join(reposRoot, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
beforeEach(() => {
  reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s43-"));
  write("social/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/social.git\n`);
  write("social/docs/spines/epic-29.md", ASKER);
  write("social/docs/spines/epic-26.md", WAITER("active"));
  write("seats.json", JSON.stringify({ seats: { seat1: { usage: { five_hour_pct: 10, known: true }, logged_in: true } } }));
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
    const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  await call("POST", "/api/milestones", { title: "PLAN-29", repo: "Acme/social", path: "docs/spines/epic-29.md" });
  await call("POST", "/api/milestones", { title: "PLAN-26", repo: "Acme/social", path: "docs/spines/epic-26.md" });
  const stall = async () => ((await call("GET", "/api/stall-watch")).json.epics as { path: string; reason: string; waitsOn?: unknown }[]);
  return { call, stall };
}

describe("T6-S43 app: /api/stall-watch names the ask an idle epic waits on", () => {
  it("the referencing epic and the asking epic both read 'waits on PLAN-29-A1 (Sam)'; the done row's reference holds nothing", async () => {
    const { stall } = await setup();
    const by = Object.fromEntries((await stall()).map((e) => [e.path, e]));
    expect(by["docs/spines/epic-26.md"]).toMatchObject({ verdict: "skip", reason: "waits on PLAN-29-A1 (Sam) for T26-S2", waitsOn: [{ code: "PLAN-29-A1", who: "Sam", rows: ["T26-S2"] }] });
    expect(by["docs/spines/epic-29.md"]).toMatchObject({ verdict: "skip", reason: "waits on PLAN-29-A1 (Sam) for T29-S0" });
  });
  it("once the ask is answered the reason goes back to 'no unclaimed ready rows'", async () => {
    write("social/docs/spines/epic-29.md", ASKER.replace(/- \[ask PLAN-29-A1[^\n]*/, "- [answered PLAN-29-A1 2026-11-01 @Sam] Create the four accounts — answer: done"));
    const { stall } = await setup();
    for (const e of await stall()) {
      expect(e.reason).toBe("no unclaimed ready rows");
      expect(e.waitsOn).toBeUndefined();
    }
  });
});
