// ready work always starts. A Delivery manager wake that leaves ready rows with no worker and no written
// reason is refused once (rows listed back), a second such finish is kept, flagged and the next wake booked now;
// the wake prompt lists every ready row of each PICK UP child; a failed start retries at once with the same clientRequestId.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { ReadConfig } from "../src/routes/read.js";
import { openDb, type DB } from "../src/db.js";
import { unaccountedReady, readyUnstartedText, READY_ACCOUNT_RULE } from "../src/cycle/movement.js";
import { childReadyRows } from "../src/cycle/children.js";
import { childLine, parentWakeSteps } from "../src/wakePrompt.js";
import { START_FAIL_RULE, CHILD_RUN_RETRY_RULE } from "../src/cycle/prompts.js";
import type { Tree, TreeNode } from "../src/adapters/tree.js";

describe("unaccountedReady", () => {
  const ready = ["E907-S2", "E907-S3", "E907-S4"];
  it("tonight's case: three ready rows, no worker, a summary that names none → all three", () => {
    expect(unaccountedReady({ ready, launchedRows: [], summary: "outcome: progressed: tidied the ledger" })).toEqual(ready);
  });
  it("a child run or a written reason per row accounts for it", () => {
    const summary = "outcome: progressed: dispatched E907-S2\nnot started E907-S3: waits on E907-S2's deploy\nskipped E907-S4: claimed by run_x";
    expect(unaccountedReady({ ready, launchedRows: ["E907-S2"], summary })).toEqual([]);
  });
  it("naming a row without a reason word is not a reason; another row's id never matches a prefix", () => {
    expect(unaccountedReady({ ready: ["E907-S1"], launchedRows: [], summary: "not started E907-S2: x" })).toEqual(["E907-S1"]);
    expect(unaccountedReady({ ready, launchedRows: [], summary: "looked at E907-S2, E907-S3 and E907-S4" })).toEqual(ready);
  });
  it("a queued ceiling or no-seat line covers the rows it does not name; `left ready:` lists ids", () => {
    expect(unaccountedReady({ ready, launchedRows: [], summary: "3 ready rows queued: no seat with headroom (all seats busy)" })).toEqual([]);
    expect(unaccountedReady({ ready, launchedRows: [], summary: "left ready: E907-S2, E907-S3, E907-S4 (worker ceiling)" })).toEqual([]);
  });
  it("the refusal lists the rows and the rule is in words a wake can follow", () => {
    expect(readyUnstartedText(["E907-S4"])).toMatch(/1 ready row in your scope has no worker and no written reason: E907-S4/);
    expect(READY_ACCOUNT_RULE).toMatch(/not started <row>: <reason>/);
  });
});

describe("wake prompt: every ready row of each PICK UP child, by id", () => {
  const node = (o: Partial<TreeNode> & { id: string; kind: TreeNode["kind"] }): TreeNode =>
    ({ key: o.id, title: o.id, status: "ready", color: "grey", children: [], flags: [], ...o }) as TreeNode;
  const tree: Tree = {
    root: node({
      id: "root", kind: "spine", path: "docs/spines/root.md", status: "active",
      children: [
        node({ id: "e907", kind: "spine", path: "docs/spines/epic-907.md", children: [
          node({ id: "E907-S2", kind: "ticket", ready: true }),
          node({ id: "E907-S9", kind: "ticket", status: "done" }),
          node({ id: "E907-S4", kind: "ticket", ready: true, children: [node({ id: "E907-S4a", kind: "ticket", ready: true })] }),
          node({ id: "e907x", kind: "spine", path: "docs/spines/epic-907x.md", children: [node({ id: "X1", kind: "ticket", ready: true })] }),
        ] }),
      ],
    }),
  } as Tree;
  it("childReadyRows: own ledger rows and sub-rows, never a nested spine's", () => {
    expect(childReadyRows(tree, "./docs/spines/epic-907.md")).toEqual(["E907-S2", "E907-S4", "E907-S4a"]);
    expect(childReadyRows(tree, "docs/spines/nope.md")).toEqual([]);
  });
  it("a PICK UP line lists them; an owned child does not; step 1 says each gets a worker or a reason", () => {
    const c = { path: "docs/spines/epic-907.md", title: "Analytics", status: "active", runState: "running" as const, ready: ["E907-S2", "E907-S4"] };
    expect(childLine(c)).toMatch(/PICK UP — ready rows: E907-S2, E907-S4$/);
    expect(childLine({ ...c, ready: [] })).toMatch(/PICK UP — no ready row$/);
    expect(childLine({ ...c, ownedBy: "Analyst" })).not.toMatch(/ready rows/);
    expect(parentWakeSteps([c]).join("\n")).toMatch(/lists every ready row of its Issue Ledger by id[\s\S]*worker this wake or a written reason/);
  });
});

describe("a failed start retries at once with the same clientRequestId", () => {
  it("pick timeout, run create 5xx, delegate ECONNRESET: at once, same id, then another seat", () => {
    expect(START_FAIL_RULE).toMatch(/retried at once in this turn, never left to the next wake/);
    expect(START_FAIL_RULE).toMatch(/ECONNRESET[\s\S]*SAME clientRequestId `<ticket id>-<child run id>`/);
    expect(START_FAIL_RULE).toMatch(/pick` again \(the broker now prefers another seat or host\)/);
    expect(CHILD_RUN_RETRY_RULE).toMatch(/one clientRequestId per wake, `<ticket id>-<this wake run id>`/);
  });
});

// ---------- app level ----------
let reposRoot: string;
let db: DB;
const repo = () => path.join(reposRoot, "rs");
const sh = (args: string[]) =>
  execFileSync("git", ["-C", repo(), ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }, stdio: "pipe" }).toString();
beforeEach(() => {
  reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-readystart-"));
  fs.mkdirSync(path.join(repo(), "docs/spines"), { recursive: true });
  sh(["init", "-q", "-b", "main"]);
  sh(["remote", "add", "origin", "https://github.com/Acme/rs.git"]);
  fs.writeFileSync(
    path.join(repo(), "docs/spines/root.md"),
    "# EPIC-906: Ready\n\nSpine ID: ready-root\n\n## Current State\n\nStatus: active\nWaiting on: none\n\n## Issue Ledger\n\n| Issue | Title | Status |\n|---|---|---|\n| T1 | TEST ready row | ready |\n| T2 | Other | ready |\n",
  );
  sh(["add", "-A"]);
  sh(["commit", "-qm", "spine"]);
});
afterEach(() => {
  db?.close();
  fs.rmSync(reposRoot, { recursive: true, force: true });
});

describe("app: the finishing PATCH of a Delivery manager wake", () => {
  async function setup(persona = "Delivery Manager") {
    db = openDb(path.join(reposRoot, "console.db"));
    const read: ReadConfig = { reposRoot, seatsFile: path.join(reposRoot, "seats.json"), listThreads: async () => [] };
    const app = createApp(db, { read, browser: { browserUrl: "http://127.0.0.1:9" } });
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : undefined };
    };
    const m = (await call("POST", "/api/milestones", { title: "Ready", repo: "Acme/rs", path: "docs/spines/root.md" })).json;
    const p = (await call("POST", "/api/personas", { name: persona, remit: "runs the milestone", model: "opus" })).json;
    const a = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true })).json;
    return { call, a };
  }
  const end = () => new Date().toISOString();

  it("refuses once with the rows listed; a second such finish is kept, flagged stalled and books the next wake now", async () => {
    const { call, a } = await setup();
    const r = (await call("POST", "/api/runs", { assignmentId: a.id })).json;
    await call("POST", "/api/runs", { assignmentId: a.id, parentRunId: r.id, summary: "T2 other", outcome: "running" });
    const p1 = await call("PATCH", `/api/runs/${r.id}`, { outcome: "progressed", summary: "outcome: progressed: dispatched T2", endedAt: end() });
    expect(p1.status).toBe(400);
    expect(p1.json.error.code).toBe("ready_unstarted");
    expect(p1.json.error.message).toMatch(/no worker and no written reason: T1\./);
    const p2 = await call("PATCH", `/api/runs/${r.id}`, { outcome: "progressed", summary: "outcome: progressed: dispatched T2", endedAt: end() });
    expect(p2.status).toBe(200);
    expect(p2.json.stalled).toMatch(/left 1 ready row with no worker or reason after a refusal: T1/);
    expect(p2.json.summary).toMatch(/ready rows left with no worker or reason: T1; next wake booked now/);
    expect(Date.parse(p2.json.retryAt)).toBeLessThanOrEqual(Date.now());
  });

  it("a worker on one row and a written reason on the other: accepted the first time, not stalled", async () => {
    const { call, a } = await setup();
    const r = (await call("POST", "/api/runs", { assignmentId: a.id })).json;
    await call("POST", "/api/runs", { assignmentId: a.id, parentRunId: r.id, summary: "T2 other", outcome: "running" });
    const p = await call("PATCH", `/api/runs/${r.id}`, { outcome: "progressed", summary: "outcome: progressed: dispatched T2\nnot started T1: needs the T2 schema first", endedAt: end() });
    expect(p.status).toBe(200);
    expect(p.json.stalled).toBeUndefined();
  });

  it("no worker but a written reason on every ready row: accepted the first time, not stalled", async () => {
    const { call, a } = await setup();
    const r = (await call("POST", "/api/runs", { assignmentId: a.id })).json;
    const p = await call("PATCH", `/api/runs/${r.id}`, { outcome: "progressed", summary: "outcome: progressed: nothing started\nnot started T1: needs the schema first\nnot started T2: waits on the owner", endedAt: end() });
    expect(p.status).toBe(200);
    expect(p.json.stalled).toBeUndefined();
  });

  it("no worker and a reason on only one of two ready rows: refused, then stalled naming the other", async () => {
    const { call, a } = await setup();
    const r = (await call("POST", "/api/runs", { assignmentId: a.id })).json;
    const body = { outcome: "progressed", summary: "outcome: progressed: nothing started\nnot started T1: needs the schema first", endedAt: end() };
    expect((await call("PATCH", `/api/runs/${r.id}`, body)).json.error.message).toMatch(/no written reason: T2\./);
    const p2 = await call("PATCH", `/api/runs/${r.id}`, body);
    expect(p2.json.stalled).toMatch(/after a refusal: T2$/);
  });

  it("never for another persona, nor for a failed wake", async () => {
    const { call, a } = await setup("steward");
    const r = (await call("POST", "/api/runs", { assignmentId: a.id })).json;
    expect((await call("PATCH", `/api/runs/${r.id}`, { outcome: "progressed", summary: "outcome: progressed: x", endedAt: end() })).status).toBe(200);
  });
  it("a failed Delivery manager wake is not refused", async () => {
    const { call, a } = await setup();
    const r = (await call("POST", "/api/runs", { assignmentId: a.id })).json;
    expect((await call("PATCH", `/api/runs/${r.id}`, { outcome: "failed", summary: "crashed", endedAt: end() })).status).toBe(200);
  });
});
