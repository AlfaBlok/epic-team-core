import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import type { ReadConfig } from "../src/routes/read.js";
import type { ReadModelHost } from "../src/readModel/host.js";
import type { T3Client } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import { addToWaitingField, askLine, dropFromWaitingField, nextAskCode } from "../src/inbox/raise.js";
import { createSpineWriter } from "../src/inbox/spineWrite.js";
// this file checks the text with our own owner's name (src/identity.ts; the suite's owner is neutral, hostedSetup.ts)

/**
 * asks and answers live in the spine only. An ask raised through the API is a
 * coded line in the asker's spine (a commit on main), read by the inbox like any other ask; "answered" is the spine's
 * `[answered]` line, never a console.db row; a cache rebuilt from the repo shows the same Waiting on you.
 */

const A1 = "- [ask E909-A1: decide @Sam since 2026-10-20 row T4] Ship with one logger or two? — options: one | two — recommend: one — context: notes.md";
const SPINE = `# EPIC-909: Inbox spine

Spine ID: inbox-root
Integration policy: main-direct

## Current State

Status: active
Waiting on: Sam: E909-A1

## Waiting on

${A1}

## Issue Ledger

| Issue | Title | Needs | Status |
|---|---|---|---|
| T4 | Pick the logger layout | Sam | blocked |
| T5 | Deploy the reader | | ready |
`;
const REL = "docs/spines/root.md";

let tmp: string;
let origin: string;
let repo: string;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
const onMain = () => git(origin, ["show", `main:${REL}`]);
const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };
const dbs: DB[] = [];
const hosts: ReadModelHost[] = [];

beforeEach(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e62s4-"));
  origin = path.join(tmp, "origin.git");
  git(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = path.join(tmp, "seed");
  git(tmp, ["clone", "-q", origin, seed]);
  git(seed, ["checkout", "-q", "-b", "main"]);
  fs.mkdirSync(path.join(seed, "docs/spines"), { recursive: true });
  fs.writeFileSync(path.join(seed, REL), SPINE);
  fs.writeFileSync(path.join(seed, "docs/spines/notes.md"), "# notes\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "seed"]);
  git(seed, ["push", "-q", "origin", "main"]);
  repo = path.join(tmp, "inbox");
  git(tmp, ["clone", "-q", origin, repo]);
});
afterEach(async () => {
  for (const h of hosts) await h.refresher?.idle();
  for (const h of hosts.splice(0)) h.close();
  for (const d of dbs.splice(0)) d.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_SYSTEM", saved.s]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

class FakeT3 {
  calls: { op: string; args: any }[] = [];
  async listProjects() {
    return [{ id: "mcp:inbox", title: "inbox", workspaceRoot: "/nowhere/inbox", repositoryIdentity: { displayName: "acme/inbox" } }];
  }
  async listScheduledTasks() {
    return [];
  }
  async updateScheduledTask() {}
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread(input: any) {
    this.calls.push({ op: "launchThread", args: input });
    return { threadId: "thread_1" };
  }
  async sendToThread(threadId: string, message: string) {
    this.calls.push({ op: "sendToThread", args: { threadId, message } });
  }
  async readThreadStatus() {
    return { status: "idle", raw: {} };
  }
}

/** A console on `dbFile` (a second call on the same file = a restart / another host's rebuild). `readModel` = the cache. */
function boot(o: { dbFile?: string; readModel?: boolean } = {}) {
  const db = openDb(o.dbFile ?? path.join(tmp, "console.db"));
  dbs.push(db);
  const t3 = new FakeT3();
  const read: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] };
  let host: ReadModelHost | undefined;
  const app = createApp(db, {
    read,
    browser: { browserUrl: "http://127.0.0.1:9" },
    cycle: { enabled: true, t3: t3 as unknown as T3Client, dispatcher: { pick: async () => ({ seat: "seat1", providerInstanceId: "x" }), done: async () => {} } as unknown as Dispatcher, publicUrl: "http://console.test" },
    answers: { retryMs: [] },
    ...(o.readModel ? { readModel: { mode: "in-process" as const, tickMs: 0, onHost: (h: ReadModelHost) => hosts.push((host = h)) } } : {}),
  });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  const pass = async () => {
    if (!host) return;
    await host.refresher!.tick();
    await host.refresher!.idle();
  };
  return { db, t3, call, pass };
}
type Call = ReturnType<typeof boot>["call"];

async function seed(call: Call) {
  const m = (await call("POST", "/api/milestones", { title: "Inbox", repo: "Acme/inbox", path: REL })).json;
  const p = (await call("POST", "/api/personas", { name: "Builder", remit: "builds", model: "sonnet" })).json;
  const a = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true })).json;
  const run = (await call("POST", "/api/runs", { assignmentId: a.id, outcome: "blocked", threadId: "thread_run", endedAt: new Date().toISOString() })).json;
  return { m, a, run };
}
const raise = (call: Call, m: any, run: any, question = "Deploy T5 to production now?", proposedAction = "deploy T5 with the rollback in the runbook — why Sam: it widens access to production") =>
  call("POST", "/api/needs-owner", { runId: run.id, milestoneId: m.id, question, proposedAction, row: "T5" });
const items = async (call: Call, mid?: string) => (await call("GET", `/api/waiting-on-owner${mid ? `?milestoneId=${mid}` : ""}`)).json as any[];
const needsYou = async (call: Call) => (await call("GET", "/api/status")).json.needsYou as number;

describe("pure: code, line, Waiting on field", () => {
  it("next code: the prefix the spine's asks use (any state), else its H1 code; one past the highest", () => {
    expect(nextAskCode(SPINE)).toBe("E909-A2");
    expect(nextAskCode(SPINE.replace(A1, `${A1}\n- [answered E909-A7 2026-10-21 @Sam] Old? — answer: yes`))).toBe("E909-A8");
    expect(nextAskCode("# EPIC-962: The repo\n\n## Current State\n")).toBe("EPIC-962-A1");
    expect(nextAskCode("# notes\n")).toBe("ASK-A1");
  });
  it("the ask line: approve when an action is proposed, row, recommend, who raised it (persona + run)", () => {
    expect(askLine("E909-A2", { question: "Deploy — now?", proposedAction: "deploy T5", askedBy: "Builder", runId: "run_1", row: "T5" }, "2026-11-02")).toBe(
      "- [ask E909-A2: approve @Sam since 2026-11-02 row T5] Deploy - now? — recommend: deploy T5 — context: raised by Builder (run run_1) through the console API; the console wrote this line",
    );
    expect(askLine("E909-A3", { question: "Which region?", askedBy: "the credits gate" }, "2026-11-02")).toMatch(/^- \[ask E909-A3: decide @Sam since 2026-11-02\] Which region\? — context: raised by the credits gate through/);
  });
  it("Current State `Waiting on:` names the new code, and drops it again", () => {
    const one = addToWaitingField(SPINE.replace("Waiting on: Sam: E909-A1", "Waiting on: nobody"), "E909-A2", "Sam");
    expect(one).toContain("Waiting on: Sam: E909-A2\n");
    const two = addToWaitingField(SPINE, "E909-A2", "Sam");
    expect(two).toContain("Waiting on: Sam: E909-A1; Sam: E909-A2\n");
    expect(addToWaitingField(two, "E909-A2", "Sam")).toBe(two);
    expect(dropFromWaitingField(two, "E909-A2")).toContain("Waiting on: Sam: E909-A1\n");
    expect(dropFromWaitingField(one, "E909-A2")).toContain("Waiting on: nobody\n");
  });
});

describe("E962-S9 guard: under the test runner the spine writer touches temp checkouts only", () => {
  it("a checkout outside the OS temp dir is refused before any git call", async () => {
    const w = await createSpineWriter().edit({ repoDir: "/", path: "docs/x.md", label: "t", edit: (t) => ({ text: `${t}x`, msg: "m", body: "b" }) });
    expect(w).toMatchObject({ status: "skipped" });
    expect(w.reason).toMatch(/^tests write only temp checkouts/);
    expect((globalThis as any).__e62s9.drain()).toEqual(["spine write to /"]); // recorded, drained: this refusal is the point
  });
});

describe("E962-S4 an ask raised through the API lives in the spine", () => {
  it("POST /needs-owner writes a coded line into the spine (one commit on main) and the inbox reads it from there", async () => {
    const { call, db } = boot();
    const { m, run } = await seed(call);
    const head = git(origin, ["rev-parse", "main"]);
    const r = await raise(call, m, run);
    expect(r.status).toBe(201);
    expect(r.json.ask).toMatchObject({ code: "E909-A2", repo: "inbox", path: REL });
    // the spine on origin/main: the ask line, Current State names it, one commit by the console
    const text = onMain();
    expect(text).toMatch(/^- \[ask E909-A2: approve @Sam since \d{4}-\d{2}-\d{2} row T5\] Deploy T5 to production now\? — recommend: deploy T5 with the rollback in the runbook - why Sam: it widens access to production — context: raised by Builder \(run run_[\w-]+\) through the console API/m);
    expect(text).toContain("Waiting on: Sam: E909-A1; Sam: E909-A2\n");
    expect(git(origin, ["rev-list", "--count", `${head}..main`])).toBe("1");
    expect(git(origin, ["log", "-1", "--format=%s", "main"])).toBe("Ask E909-A2: raised by Builder (via console API)");
    expect(git(origin, ["log", "-1", "--format=%b", "main"])).toContain(`Run: ${run.id}`);
    // Waiting on you: a spine ask like any other, attributed to the run that raised it
    const card = (await items(call, m.id)).find((i) => i.code === "E909-A2");
    expect(card).toMatchObject({ source: "ask", state: "open", ask: "approve", row: "T5", question: "Deploy T5 to production now?", path: REL, asker: { via: "run" } });
    expect(await needsYou(call)).toBe(2);
    // console.db keeps only the raise log (superseded by the code), never an open item
    expect(db.prepare("SELECT status, superseded_by FROM needs_jordi").all()).toEqual([{ status: "superseded", superseded_by: "inbox/E909-A2" }]);
    expect((await call("GET", "/api/needs-owner?status=open")).json).toEqual([]);
    // the same question again is not asked twice
    const again = await raise(call, m, run);
    expect(again.json.ask).toMatchObject({ code: "E909-A2", note: "the same question is already open in the spine" });
    expect(git(origin, ["rev-list", "--count", `${head}..main`])).toBe("1");
  });

  it("a spine write that is refused raises nothing and records nothing (409 with the reason)", async () => {
    const { call, db } = boot();
    const { m, run } = await seed(call);
    fs.writeFileSync(path.join(repo, "docs/spines/notes.md"), "# dirty\n"); // uncommitted change: the writer refuses
    const head = git(origin, ["rev-parse", "main"]);
    const r = await raise(call, m, run);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("spine_write_refused");
    expect(r.json.error.message).toMatch(/uncommitted changes.*Nothing was recorded/);
    expect(git(origin, ["rev-parse", "main"])).toBe(head);
    expect(db.prepare("SELECT count(*) AS n FROM needs_jordi").get()).toEqual({ n: 0 });
    expect((await items(call, m.id)).filter((i) => i.state === "open").map((i) => i.code)).toEqual(["E909-A1"]);
    // a path outside the repo, or no spine file, is refused the same way
    expect((await call("POST", "/api/needs-owner", { milestoneId: m.id, question: "q? — why Sam: it spends money", path: "../x.md" })).status).toBe(409);
    expect((await call("POST", "/api/needs-owner", { milestoneId: m.id, question: "q? — why Sam: it spends money", path: "docs/none.md" })).status).toBe(409);
  });

  it("approve with grantWrite on an API-raised ask grants write to the run that asked", async () => {
    const { call } = boot();
    const { m, a, run } = await seed(call);
    await raise(call, m, run, "I need write to git - why Sam: it widens access", "git only: branches one-logger*");
    const card = (await items(call, m.id)).find((i) => i.code === "E909-A2");
    const scope = "git only: branches one-logger*, spine main-direct; no prod/root";
    const r = await call("POST", `/api/waiting-on-owner/${card.id}/respond`, { kind: "approve", text: "go", milestoneId: m.id, grantWrite: { scope } });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ spine: { status: "written" }, assignmentId: a.id });
    expect((await call("GET", `/api/assignments/${a.id}`)).json).toMatchObject({ writeEnabled: true, writeScope: scope });
    expect(onMain()).toMatch(/^- \[answered E909-A2 \d{4}-\d{2}-\d{2} @Sam\] I need write to git .*— answer: APPROVED - Granted write, scope: git only: branches one-logger\*, spine main-direct; no prod\/root go$/m);
    // the grant is a Standing approvals line in the asker's spine (written before the assignment changed)
    expect(onMain()).toMatch(/^## Standing approvals$/m);
    expect(onMain()).toMatch(/^- \[grant E909-G1 @Sam since \d{4}-\d{2}-\d{2}\] Builder may write: git only: branches one-logger\*, spine main-direct; no prod\/root — expires: never — context: Sam approved E909-A2 with a write grant on the console$/m);
  });
});

describe("E962-S4 answered comes from the spine only", () => {
  it("a failed answer write keeps the ask open (counted, error on the card, Retry); Retry writes it and only then is it answered", async () => {
    const { call, t3 } = boot();
    const { m, a, run } = await seed(call);
    await raise(call, m, run);
    const card = (await items(call, m.id)).find((i) => i.code === "E909-A2");
    git(repo, ["remote", "set-url", "--push", "origin", path.join(tmp, "nowhere.git")]); // pushes fail
    const r = await call("POST", `/api/waiting-on-owner/${card.id}/respond`, { kind: "approve", text: "", milestoneId: m.id, wake: false });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ delivery: "failed", spine: { status: "failed" }, job: { state: "failed" } });
    expect(onMain()).toContain("- [ask E909-A2: approve");
    const open = (await items(call, m.id)).find((i) => i.id === card.id);
    expect(open).toMatchObject({ state: "open", response: { id: r.json.id, spine: { status: "failed" } } });
    expect(await needsYou(call)).toBe(2);
    // the asker's wake carries no copy of the answer: the ask is still open in the spine
    const wake1 = (await call("POST", `/api/assignments/${a.id}/wake?format=json`, {})).json;
    expect(wake1.prompt as string).not.toMatch(/Deploy T5 to production now\? — answer:/);
    await call("PATCH", `/api/runs/${wake1.runId ?? wake1.run?.id}`, { outcome: "idle", summary: "ok", endedAt: new Date().toISOString() });
    // Retry once the remote is back: written, answered, out of the count; the asker reads it from the spine
    git(repo, ["remote", "set-url", "--push", "origin", origin]);
    const retry = await call("POST", `/api/owner-responses/${r.json.id}/deliver`);
    expect(retry.json).toMatchObject({ delivery: "sent", spine: { status: "written" } });
    expect(onMain()).toMatch(/^- \[answered E909-A2 \d{4}-\d{2}-\d{2} @Sam\] Deploy T5 to production now\? .*— answer: APPROVED$/m);
    expect(await needsYou(call)).toBe(1);
    expect((await items(call, m.id)).find((i) => i.code === "E909-A2")).toMatchObject({ state: "answered" });
    const prompt = (await call("POST", `/api/assignments/${a.id}/wake?format=json`, {})).json.prompt as string;
    expect(prompt).toMatch(/docs\/spines\/root\.md:\d+ — Deploy T5 to production now\? — answer: APPROVED/);
    expect(prompt).not.toContain("NOT in the spine yet");
    expect(t3.calls.filter((x) => x.op === "sendToThread")).toEqual([]); // no decision message to a thread: the line is the answer
  });

  it("a skipped write (checkout off main) keeps the ask open and counted; the woken asker is told to write the line in itself", async () => {
    const { call, t3 } = boot();
    const { m, run } = await seed(call);
    await raise(call, m, run);
    const card = (await items(call, m.id)).find((i) => i.code === "E909-A2");
    git(repo, ["checkout", "-q", "-b", "feature"]);
    const r = await call("POST", `/api/waiting-on-owner/${card.id}/respond`, { kind: "approve", text: "", milestoneId: m.id });
    expect(r.json).toMatchObject({ delivery: "queued", spine: { status: "skipped" }, wake: { notified: "woken" } });
    git(repo, ["checkout", "-q", "main"]);
    expect((await items(call, m.id)).find((i) => i.id === card.id)).toMatchObject({ state: "open", response: { spine: { status: "skipped" } } });
    expect(await needsYou(call)).toBe(2);
    expect(t3.calls.find((x) => x.op === "launchThread")!.args.message).toContain("could not write this answer into the spine");
  });

  it("drop the cache (read model, raise log, delivery log) and rebuild from the repo: the same Waiting on you", async () => {
    const dbFile = path.join(tmp, "cache.db");
    const first = boot({ dbFile, readModel: true });
    const { m, run } = await seed(first.call);
    await raise(first.call, m, run);
    const a1 = (await items(first.call, m.id)).find((i) => i.code === "E909-A1");
    expect((await first.call("POST", `/api/waiting-on-owner/${a1.id}/respond`, { kind: "answer", text: "two", milestoneId: m.id, wake: false })).json).toMatchObject({ spine: { status: "written" } });
    await first.pass();
    const shape = (list: any[]) => list.map((i) => ({ id: i.id, code: i.code, state: i.state, source: i.source, answer: i.answer, question: i.question })).sort((x, y) => x.id.localeCompare(y.id));
    const before = { items: shape(await items(first.call)), needsYou: await needsYou(first.call) };
    expect(before.needsYou).toBe(1);
    expect(before.items.filter((i) => i.state === "open" && i.source === "ask").map((i) => i.code)).toEqual(["E909-A2"]);
    expect(before.items.find((i) => i.code === "E909-A1")).toMatchObject({ state: "answered", answer: "two" });

    // everything console.db holds about asks goes: the cache, the raise log, the delivery log
    first.db.exec("DELETE FROM read_model; DELETE FROM needs_jordi; DELETE FROM jordi_responses;");
    const rebuilt = boot({ dbFile, readModel: true });
    await rebuilt.pass();
    expect({ items: shape(await items(rebuilt.call)), needsYou: await needsYou(rebuilt.call) }).toEqual(before);
    // and on a console with no cache at all (another host)
    const plain = boot({ dbFile });
    expect({ items: shape(await items(plain.call)), needsYou: await needsYou(plain.call) }).toEqual(before);
  });
});

describe("E962-S4 carry-over of the open Needs Sam rows", () => {
  it("dry run first; then each open row is a spine ask (or superseded by the ask it restates) and the table is a log", async () => {
    const { call, db } = boot();
    const { m, run } = await seed(call);
    const store = createStore(db);
    const fresh = store.createNeedsJordi({ runId: run.id, milestoneId: m.id, question: "Rotate the relay token tonight?", proposedAction: "rotate it - why Sam: it changes an access token", status: "open" });
    const dup = store.createNeedsJordi({ milestoneId: m.id, question: "E909-A1: one logger or two, please decide", proposedAction: "", status: "open" });
    // a code only a `[superseded …]` line carries (the markdown parse skips those lines; spines.py may be slow or absent)
    const old = store.createNeedsJordi({ milestoneId: m.id, question: "E909-A0 (approve): the old logger question", proposedAction: "", status: "open" });
    fs.writeFileSync(path.join(repo, REL), fs.readFileSync(path.join(repo, REL), "utf8").replace(A1, `- [superseded E909-A0 2026-10-22 by E909-A1] The old logger question\n${A1}`));
    git(repo, ["commit", "-q", "-am", "superseded line"]);
    git(repo, ["push", "-q", "origin", "main"]);
    const head = git(origin, ["rev-parse", "main"]);
    const dry = await call("POST", "/api/needs-owner/carry", { dry: true });
    expect(dry.json.counts).toEqual({ would_carry: 1, would_supersede: 2 });
    expect(git(origin, ["rev-parse", "main"])).toBe(head);
    expect(store.getNeedsJordi(fresh.id)!.status).toBe("open");

    const real = await call("POST", "/api/needs-owner/carry", {});
    expect(real.json.counts).toEqual({ carried: 1, superseded: 2 });
    expect(store.getNeedsJordi(old.id)).toMatchObject({ status: "superseded", supersededBy: "inbox/E909-A0" });
    expect(real.json.lines.find((l: any) => l.id === fresh.id)).toMatchObject({ action: "carried", by: "inbox/E909-A2", path: REL });
    expect(real.json.lines.find((l: any) => l.id === dup.id)).toMatchObject({ action: "superseded", by: "inbox/E909-A1" });
    expect(onMain()).toMatch(/^- \[ask E909-A2: approve @Sam since \d{4}-\d{2}-\d{2}\] Rotate the relay token tonight\? — recommend: rotate it - why Sam: it changes an access token — context: raised by Builder \(carried from console\.db Needs Sam nj_[\w-]+, raised \d{4}-\d{2}-\d{2}\) \(run run_[\w-]+\) through the console API/m);
    expect(store.getNeedsJordi(fresh.id)).toMatchObject({ status: "superseded", supersededBy: "inbox/E909-A2" });
    expect(store.getNeedsJordi(dup.id)).toMatchObject({ status: "superseded", supersededBy: "inbox/E909-A1" });
    expect((await items(call, m.id)).filter((i) => i.state === "open").map((i) => i.code).sort()).toEqual(["E909-A1", "E909-A2"]);
    // once only: nothing left to carry
    expect((await call("POST", "/api/needs-owner/carry", {})).json.counts).toEqual({});
  });
});

describe("E986-S2: a do ask from the Team Browser, taken out by its raiser once moot", () => {
  it("kind do writes a do line; retire takes out only an open ask the console wrote", async () => {
    const { call } = boot();
    const { m } = await seed(call);
    const q = "The team's browser is signed out of x.com. Sign in to x.com as @MemoAgent in Chrome, then press Sync for *.x.com.";
    const r = await call("POST", "/api/needs-owner", { milestoneId: m.id, path: REL, question: q, proposedAction: "", kind: "do" });
    expect(r.status).toBe(201);
    expect(r.json.ask).toMatchObject({ code: "E909-A2", path: REL });
    expect(onMain()).toMatch(/^- \[ask E909-A2: do @Sam since \d{4}-\d{2}-\d{2}\] The team's browser is signed out of x\.com\. .* — context: raised by an API caller through the console API; the console wrote this line$/m);
    expect((await items(call, m.id)).find((i) => i.code === "E909-A2")).toMatchObject({ state: "open" });
    expect((await call("POST", "/api/needs-owner", { milestoneId: m.id, question: q, kind: "later" })).status).toBe(400);

    // an ask an agent wrote by hand is never taken out through this route
    const hand = await call("POST", "/api/needs-owner/retire", { milestoneId: m.id, path: REL, code: "E909-A1", why: "x reads signed in again" });
    expect(hand.status).toBe(409);
    expect(hand.json.error.message).toMatch(/not raised through the console API/);
    expect(onMain()).toContain("[ask E909-A1:");

    const head = git(origin, ["rev-parse", "main"]);
    const ok = await call("POST", "/api/needs-owner/retire", { milestoneId: m.id, path: REL, code: "E909-A2", why: "the hourly signed-in check reads *.x.com signed in again" });
    expect(ok.status).toBe(200);
    expect(onMain()).not.toContain("E909-A2");
    expect(git(origin, ["rev-list", "--count", `${head}..main`])).toBe("1");
    expect(git(origin, ["log", "-1", "--format=%s", "main"])).toMatch(/^Ask E909-A2 moot: the hourly signed-in check/);
    // twice: nothing open any more
    expect((await call("POST", "/api/needs-owner/retire", { milestoneId: m.id, path: REL, code: "E909-A2", why: "again" })).status).toBe(409);
    expect((await call("POST", "/api/needs-owner/retire", { milestoneId: m.id, path: REL, code: "bad code", why: "x" })).status).toBe(400);
  });
});

describe("E948-S43: the ask gate on the API and on the spine read", () => {
  it("POST /needs-owner refuses an ask that is not his (422 ask_not_his, nothing written); a spine line that fails is held from his inbox", async () => {
    const { call } = boot();
    const { m, run } = await seed(call);
    const head = git(origin, ["rev-parse", "main"]);
    const r = await raise(call, m, run, "Memo opens to strangers on 12 November", "declare Memo live for testers on 12 November");
    expect(r.status).toBe(422);
    expect(r.json.error?.code ?? r.json.code).toBe("ask_not_his");
    expect(JSON.stringify(r.json)).toMatch(/go-live date Sam did not set/);
    const r2 = await raise(call, m, run, "One scoreboard on your home with five live numbers", "five numbers above the red lines - why Sam: it adds to the first screen");
    expect(r2.status).toBe(422);
    expect(JSON.stringify(r2.json)).toMatch(/does not name what of Sam's it answers/);
    expect(git(origin, ["rev-parse", "main"])).toBe(head);
    // a line written straight into the spine: held from Waiting on you; his own asks stay
    const today = new Date().toISOString().slice(0, 10);
    const text = fs.readFileSync(path.join(repo, REL), "utf8").replace("\n\n## Issue Ledger", `\n- [ask E909-A7: approve @Sam since ${today}] Clear the 15 old epic outcomes in one go — recommend: yes — why Sam: only you may mark an outcome — unblocks: T4 — context: notes.md\n\n## Issue Ledger`);
    fs.writeFileSync(path.join(repo, REL), text);
    git(repo, ["commit", "-qam", "held ask"]);
    git(repo, ["push", "-q", "origin", "main"]);
    const codes = (await items(call, m.id)).filter((i) => i.source === "ask").map((i) => i.code);
    expect(codes).toContain("E909-A1");
    expect(codes).not.toContain("E909-A7");
  });
});
