import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { ASK_GRACE_MS, answerWakeMessage, askerAt, epicRunState } from "../src/inbox/asker.js";
import type { Tree, TreeNode } from "../src/adapters/tree.js";
import type { ReadConfig } from "../src/routes/read.js";
import type { T3Client } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import { RESTART_QUEUED_REASON, STEER_RETRY_FOR_MS, STEER_RETRY_MS } from "../src/inbox/routes.js";
// this file checks the text with our own owner's name (src/identity.ts; the suite's owner is neutral, hostedSetup.ts)
vi.hoisted(async () => (await import("../src/identity.js")).setIdentity({ owner: "Sam" }));

/** an answer wakes the persona who asked, or steers its running session; once per response. */

const A1 = "- [ask T9-A1: decide @Sam since 2026-10-20 row T4] Ship with one logger or two? — options: one | two — recommend: one — context: notes.md";
const A2 = "- [ask T9-A2: approve @Sam since 2026-10-20 row T5] Deploy T5 in place of the old reader? — recommend: yes — context: notes.md";
const A3 = "- [ask T9-A3: decide @Sam since 2026-10-21 row T6] Keep the old dashboard? — options: keep | drop — recommend: drop — context: notes.md";
const spine = (status: string, asks: string[]) => `# PLAN-9: Inbox spine

Spine ID: inbox-root
Integration policy: main-direct

## Current State

Status: ${status}
Waiting on: Sam (see Waiting on)

## Waiting on

${asks.join("\n")}

## Issue Ledger

| Issue | Title | Needs | Status |
|---|---|---|---|
| T4 | Pick the logger layout | Sam | blocked |
| T5 | Deploy the reader | Sam go | blocked |
| T6 | Dashboard | Sam | blocked |
`;

/** The DM's run wrote A1 + A2 (commit at 10:00); A3 came in a commit no run window holds. */
const ASKED_AT = "2026-10-20T10:00:00.000Z";
const LATER_AT = "2026-10-21T10:00:00.000Z";

// ---------- pure ----------

describe("askerAt: the run window holding the ask line's commit", () => {
  const store = createStore(openDb(":memory:"));
  const m = store.createMilestone({ title: "M", repo: "r", path: "p", owner: "", paused: false });
  const dm = store.createPersona({ name: "Delivery Manager", remit: "x", skills: [], model: "opus", mayWrite: false });
  const b = store.createPersona({ name: "Builder", remit: "x", skills: [], model: "sonnet", mayWrite: false });
  const aDm = store.createAssignment({ milestoneId: m.id, personaId: dm.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true });
  const aB = store.createAssignment({ milestoneId: m.id, personaId: b.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true });
  store.createRun({ assignmentId: aDm.id, outcome: "progressed", startedAt: "2026-10-20T09:00:00.000Z", endedAt: "2026-10-20T09:30:00.000Z", summary: "" });
  store.createRun({ assignmentId: aB.id, outcome: "progressed", startedAt: "2026-10-20T09:20:00.000Z", endedAt: "2026-10-20T09:40:00.000Z", summary: "" });
  store.createRun({ assignmentId: aDm.id, outcome: "idle", startedAt: "2026-10-20T09:35:00.000Z", endedAt: "2026-10-20T09:35:00.000Z", summary: "skipped: previous run x still running" });

  it("inside one window: that assignment (any persona, the DM included)", () => {
    expect(askerAt(store, m.id, "2026-10-20T09:10:00.000Z")).toMatchObject({ assignmentId: aDm.id, personaName: "Delivery Manager", via: "ask" });
  });
  it("two windows: the latest start wins; a skipped wake never counts", () => {
    expect(askerAt(store, m.id, "2026-10-20T09:25:00.000Z")?.assignmentId).toBe(aB.id);
    expect(askerAt(store, m.id, "2026-10-20T09:36:00.000Z")?.assignmentId).toBe(aB.id);
  });
  it("up to 10 min after the run ended (its last push), then nobody", () => {
    expect(ASK_GRACE_MS).toBe(600_000);
    expect(askerAt(store, m.id, "2026-10-20T09:49:00.000Z")?.assignmentId).toBe(aB.id);
    expect(askerAt(store, m.id, "2026-10-20T09:51:00.000Z")).toBeUndefined();
    expect(askerAt(store, m.id, "not a time")).toBeUndefined();
  });
});

describe("answerWakeMessage: one template", () => {
  const item = { code: "T9-A1", path: "docs/spines/root.md", row: "T4" };
  it("names the code, quotes the answer, pull first, cites the commit and the row", () => {
    expect(answerWakeMessage({ item, answer: "two", repo: "inbox", sha: "0123456789abcdef0123" })).toBe(
      'Sam answered T9-A1 (inbox/docs/spines/root.md): "two". First run `git pull --ff-only` on main in inbox so you read the latest spine (the [answered] line is commit 0123456789ab). Then act on the answer per the ask\'s row T4.',
    );
  });
  it("a steer is prefixed; a change says so", () => {
    expect(answerWakeMessage({ item, answer: "two", repo: "inbox", steer: true })).toMatch(/^New answer while you are running — Sam answered T9-A1/);
    expect(answerWakeMessage({ item, answer: "two", oldAnswer: "one", repo: "inbox" })).toMatch(/^Sam changed his answer to T9-A1 \(inbox\/docs\/spines\/root\.md\): "two" \(was "one"\)\./);
  });
});

describe("epicRunState: EpicSpine run_state of the ask's spine", () => {
  const node = (status: string, p = "docs/a.md", children: TreeNode[] = []): TreeNode => ({ key: p, id: p, kind: "spine", title: p, status, color: "grey", path: p, children, flags: [] });
  const tree = (root: TreeNode) => ({ root }) as Tree;
  it("ready / active / blocked are runnable; draft, deferred, done are not; unknown spine = undefined", () => {
    for (const s of ["ready", "active", "blocked — on Sam"]) expect(epicRunState(tree(node(s)), "docs/a.md")?.runnable).toBe(true);
    for (const s of ["draft", "deferred", "done", ""]) expect(epicRunState(tree(node(s)), "docs/a.md")?.runnable).toBe(false);
    expect(epicRunState(tree(node("active", "docs/root.md", [node("draft", "docs/child.md")])), "docs/child.md")).toEqual({ status: "draft", runnable: false });
    expect(epicRunState(tree(node("active")), "docs/other.md")).toBeUndefined();
  });
});

// ---------- API ----------

let tmp: string;
let origin: string;
let repo: string;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, args: string[], at?: string) =>
  execFileSync("git", args, { cwd, env: at ? { ...ENV, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : ENV, encoding: "utf8" }).trim();
const put = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

const savedEnv = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };
/** Seed the repo: A1 + A2 committed at ASKED_AT, A3 added at LATER_AT; `status` = the epic's Status. */
const seedRepo = (status = "active") => {
  origin = path.join(tmp, "origin.git");
  git(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = path.join(tmp, "seed");
  git(tmp, ["clone", "-q", origin, seed]);
  git(seed, ["checkout", "-q", "-b", "main"]);
  put(seed, "docs/spines/root.md", spine(status, [A1, A2]));
  put(seed, "docs/spines/notes.md", "# notes\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "asks"], ASKED_AT);
  put(seed, "docs/spines/root.md", spine(status, [A1, A2, A3]));
  git(seed, ["commit", "-q", "-am", "one more ask"], LATER_AT);
  git(seed, ["push", "-q", "origin", "main"]);
  repo = path.join(tmp, "inbox");
  git(tmp, ["clone", "-q", origin, repo]);
};
beforeEach(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e15s1-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", savedEnv.g], ["GIT_CONFIG_SYSTEM", savedEnv.s]] as const) {
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
  async sendToThread(threadId: string, message: string, clientRequestId?: string, mode?: string) {
    this.calls.push({ op: "sendToThread", args: { threadId, message, clientRequestId, mode } });
  }
  async readThreadStatus() {
    return { status: "idle", raw: {} };
  }
}

describe("API: an answer wakes or steers the asker", () => {
  let db: DB;
  let t3: FakeT3;
  const setup = (status = "active") => {
    seedRepo(status);
    db = openDb(path.join(tmp, "console.db"));
    t3 = new FakeT3();
    const readCfg: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] };
    const app = createApp(db, {
      read: readCfg,
      cycle: { enabled: true, t3: t3 as unknown as T3Client, dispatcher: { pick: async () => ({ seat: "seat1", providerInstanceId: "x" }), done: async () => {} } as unknown as Dispatcher, publicUrl: "http://console.test" },
    });
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : undefined };
    };
    return { call };
  };
  afterEach(() => db?.close());
  type Call = ReturnType<typeof setup>["call"];
  const items = async (call: Call, mid: string) => (await call("GET", `/api/waiting-on-owner?milestoneId=${mid}`)).json as any[];
  /** Builder (not the DM) owns the milestone (ownerFor); the DM's run window holds the A1 / A2 commit. */
  const seed = async (call: Call, o: { builderEnabled?: boolean } = {}) => {
    const m = (await call("POST", "/api/milestones", { title: "Inbox", repo: "Acme/inbox", path: "docs/spines/root.md" })).json;
    const dmP = (await call("POST", "/api/personas", { name: "Delivery Manager", remit: "runs it", model: "opus" })).json;
    const bP = (await call("POST", "/api/personas", { name: "Builder", remit: "builds", model: "sonnet" })).json;
    const dm = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: dmP.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true })).json;
    const b = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: bP.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: o.builderEnabled ?? true })).json;
    await call("POST", "/api/runs", { assignmentId: dm.id, outcome: "progressed", startedAt: "2026-10-20T09:55:00.000Z", endedAt: "2026-10-20T10:01:00.000Z" });
    return { m, dm, b };
  };
  const runsOf = async (call: Call, assignmentId: string) => (await call("GET", `/api/runs?assignmentId=${assignmentId}`)).json as any[];
  const answer = (call: Call, m: any, it: any, body: Record<string, unknown> = {}) =>
    call("POST", `/api/waiting-on-owner/${it.id}/respond`, { kind: "answer", text: "two", milestoneId: m.id, ...body });

  it("attribution: the card names the asker: the run that committed the line, else the milestone owner", async () => {
    const { call } = setup();
    const { m, dm, b } = await seed(call);
    const list = await items(call, m.id);
    expect(list.find((i) => i.code === "T9-A1").asker).toMatchObject({ assignmentId: dm.id, personaName: "Delivery Manager", via: "ask" });
    expect(list.find((i) => i.code === "T9-A3").asker).toMatchObject({ assignmentId: b.id, personaName: "Builder", via: "owner" });
  });

  it("idle asker: woken with Run now; instructions name the code, quote the answer, pull main first, cite the commit", async () => {
    const { call } = setup();
    const { m, dm, b } = await seed(call);
    const a1 = (await items(call, m.id)).find((i) => i.code === "T9-A1");
    const r = await answer(call, m, a1);
    expect(r.status).toBe(201);
    expect(r.json.spine.status).toBe("written");
    expect(r.json.wake).toMatchObject({ notified: "woken", runId: expect.any(String), persona: "Delivery Manager", assignmentId: dm.id });
    const run = (await runsOf(call, dm.id)).find((x) => x.id === r.json.wake.runId);
    expect(run).toMatchObject({ outcome: "running", instructionsBy: "Sam" });
    expect(run.instructions).toBe(
      `Sam answered T9-A1 (inbox/docs/spines/root.md): "two". First run \`git pull --ff-only\` on main in inbox so you read the latest spine (the [answered] line is commit ${r.json.spine.sha.slice(0, 12)}). Then act on the answer per the ask's row T4.`,
    );
    expect(await runsOf(call, b.id)).toEqual([]); // the owner was not the asker
  });

  it("live asker: its running session is steered (no second run)", async () => {
    const { call } = setup();
    const { m, dm } = await seed(call);
    const live = (await call("POST", "/api/runs", { assignmentId: dm.id, outcome: "running", threadId: "thread_live" })).json;
    const a1 = (await items(call, m.id)).find((i) => i.code === "T9-A1");
    const r = await answer(call, m, a1);
    expect(r.json.wake).toMatchObject({ notified: "steered", runId: live.id, mode: "steer" });
    const sent = t3.calls.filter((x) => x.op === "sendToThread");
    expect(sent).toHaveLength(1);
    expect(sent[0].args).toMatchObject({ threadId: "thread_live", mode: "steer", clientRequestId: `console-answer-${r.json.id}` });
    expect(sent[0].args.message).toMatch(/^New answer while you are running — Sam answered T9-A1 \(inbox\/docs\/spines\/root\.md\): "two"\. First run `git pull --ff-only`/);
    expect((await runsOf(call, dm.id)).filter((x) => x.outcome === "running")).toHaveLength(1);
  });

  it("two answers back-to-back: one wake, then one steer of that run; never already_running", async () => {
    const { call } = setup();
    const { m, dm } = await seed(call);
    const list = await items(call, m.id);
    const r1 = await answer(call, m, list.find((i) => i.code === "T9-A1"));
    const r2 = await call("POST", `/api/waiting-on-owner/${list.find((i) => i.code === "T9-A2").id}/respond`, { kind: "approve", text: "", milestoneId: m.id });
    expect(r1.json.wake).toMatchObject({ notified: "woken" });
    expect(r2.json.wake).toMatchObject({ notified: "steered", runId: r1.json.wake.runId });
    expect(t3.calls.filter((x) => x.op === "launchThread")).toHaveLength(1);
    const steers = t3.calls.filter((x) => x.op === "sendToThread");
    expect(steers).toHaveLength(1);
    expect(steers[0].args.message).toContain('Sam answered T9-A2 (inbox/docs/spines/root.md): "APPROVED"');
    expect((await runsOf(call, dm.id)).filter((x) => x.instructionsBy === "Sam")).toHaveLength(1);
  });

  it("paused milestone: no wake, the response says why", async () => {
    const { call } = setup();
    const { m, dm } = await seed(call);
    await call("PATCH", `/api/milestones/${m.id}`, { paused: true });
    const a1 = (await items(call, m.id)).find((i) => i.code === "T9-A1");
    const r = await answer(call, m, a1);
    expect(r.json.wake).toMatchObject({ notified: "skipped", reason: "the milestone is paused", persona: "Delivery Manager" });
    expect((await runsOf(call, dm.id)).filter((x) => x.instructionsBy === "Sam")).toEqual([]);
    expect(t3.calls).toEqual([]);
  });

  it("settled milestone and a non-runnable (draft) epic: no wake", async () => {
    const { call } = setup("draft");
    const { m } = await seed(call);
    const list = await items(call, m.id);
    const r = await answer(call, m, list.find((i) => i.code === "T9-A1"));
    expect(r.json.wake).toMatchObject({ notified: "skipped", reason: "its epic is draft, not runnable" });
    createStore(db).setSettled(m.id, true); // the route settles only a marked outcome; the flag is what matters here
    const r2 = await answer(call, m, list.find((i) => i.code === "T9-A3"), { text: "drop" });
    expect(r2.json.wake).toMatchObject({ notified: "skipped", reason: "the milestone is settled" });
    expect(t3.calls).toEqual([]);
  });

  it("T76-S2: Approve on an approve ask of a draft epic wakes the asker (his yes is the ready stamp)", async () => {
    const { call } = setup("draft");
    const { m, dm } = await seed(call);
    const a2 = (await items(call, m.id)).find((i) => i.code === "T9-A2");
    const r = await answer(call, m, a2, { kind: "approve", text: "" });
    expect(r.json.wake).toMatchObject({ notified: "woken" });
    expect((await runsOf(call, dm.id)).filter((x) => x.instructionsBy === "Sam")).toHaveLength(1);
  });

  it("wake: false only records the answer", async () => {
    const { call } = setup();
    const { m, dm } = await seed(call);
    const a1 = (await items(call, m.id)).find((i) => i.code === "T9-A1");
    const r = await answer(call, m, a1, { wake: false });
    expect(r.json).toMatchObject({ spine: { status: "written" }, wake: { notified: "off" } });
    expect((await runsOf(call, dm.id)).filter((x) => x.instructionsBy === "Sam")).toEqual([]);
    expect(t3.calls).toEqual([]);
  });

  it("idempotent per response: a re-delivered answer never wakes twice", async () => {
    const { call } = setup();
    const { m, dm } = await seed(call);
    const a1 = (await items(call, m.id)).find((i) => i.code === "T9-A1");
    const r = await answer(call, m, a1);
    expect(r.json.wake.notified).toBe("woken");
    // The same answer posted again (its line flipped) returns what was recorded; re-deliver is refused.
    const again = await answer(call, m, a1);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ id: r.json.id, wake: { notified: "woken", runId: r.json.wake.runId } });
    expect((await call("POST", `/api/owner-responses/${r.json.id}/deliver`)).status).toBe(409);
    expect((await runsOf(call, dm.id)).filter((x) => x.instructionsBy === "Sam")).toHaveLength(1);
    expect(t3.calls.filter((x) => x.op === "launchThread")).toHaveLength(1);
  });

  it("T15-S4: a written answer whose wake failed or was skipped: deliver re-runs only the wake, once", async () => {
    const { call } = setup();
    const { m, dm, b } = await seed(call);
    await call("PATCH", `/api/milestones/${m.id}`, { paused: true });
    const list = await items(call, m.id);
    const r = await answer(call, m, list.find((i) => i.code === "T9-A1"));
    expect(r.json).toMatchObject({ delivery: "sent", spine: { status: "written" }, wake: { notified: "skipped" } });
    const sha = r.json.spine.sha;
    await call("PATCH", `/api/milestones/${m.id}`, { paused: false });
    const again = await call("POST", `/api/owner-responses/${r.json.id}/deliver`);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ id: r.json.id, delivery: "sent", spine: { status: "written", sha }, wake: { notified: "woken", persona: "Delivery Manager" } });
    expect((await runsOf(call, dm.id)).filter((x) => x.instructionsBy === "Sam")).toHaveLength(1);
    // now final: a second Wake now is refused and wakes nobody
    expect((await call("POST", `/api/owner-responses/${r.json.id}/deliver`)).status).toBe(409);
    expect((await runsOf(call, dm.id)).filter((x) => x.instructionsBy === "Sam")).toHaveLength(1);
    expect(t3.calls.filter((x) => x.op === "launchThread")).toHaveLength(1);
    expect(t3.calls.filter((x) => x.op === "sendToThread")).toEqual([]); // no second thread message
    // a failed wake (e.g. T3 down, console restarted) is retried the same way: runNow once
    const r2 = await answer(call, m, list.find((i) => i.code === "T9-A3"), { wake: false });
    db.prepare("UPDATE jordi_responses SET wake_status = 'failed', wake_reason = 'T3 down' WHERE id = ?").run(r2.json.id);
    const spineBefore = git(repo, ["rev-parse", "HEAD"]);
    const w2 = await call("POST", `/api/owner-responses/${r2.json.id}/deliver`);
    expect(w2.status).toBe(200);
    expect(w2.json.wake).toMatchObject({ notified: "woken", persona: "Builder" }); // A3's asker is the owner
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(spineBefore); // no second spine write
    expect((await runsOf(call, b.id)).filter((x) => x.instructionsBy === "Sam")).toHaveLength(1);
  });

  it("T15-S4: deliver stays 409 for a written answer whose wake is final (woken / steered / off) or still queued", async () => {
    const { call } = setup();
    const { m, dm } = await seed(call);
    const a1 = (await items(call, m.id)).find((i) => i.code === "T9-A1");
    const r = await answer(call, m, a1, { wake: false });
    expect(r.json.wake.notified).toBe("off");
    for (const status of ["off", "steered", "woken", "queued"]) {
      db.prepare("UPDATE jordi_responses SET wake_status = ? WHERE id = ?").run(status, r.json.id);
      const res = await call("POST", `/api/owner-responses/${r.json.id}/deliver`);
      expect(res.status, status).toBe(409);
    }
    expect((await runsOf(call, dm.id)).filter((x) => x.instructionsBy === "Sam")).toEqual([]);
    expect(t3.calls).toEqual([]);
  });

  it("T15-S5: a refused spine write still wakes the asker with the answer, code, file:line and reason; it writes the line itself", async () => {
    const { call } = setup();
    const { m, dm } = await seed(call);
    git(repo, ["checkout", "-q", "-b", "feature"]); // guard: the checkout is not on main
    const a1 = (await items(call, m.id)).find((i) => i.code === "T9-A1");
    const r = await answer(call, m, a1);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ delivery: "queued", spine: { status: "skipped", reason: "the checkout is on feature, not main" } });
    expect(r.json.wake).toMatchObject({ notified: "woken", runId: expect.any(String), persona: "Delivery Manager" });
    expect(r.json.wake.reason).toBeUndefined();
    const run = (await runsOf(call, dm.id)).find((x) => x.id === r.json.wake.runId);
    expect(run.instructions).toBe(
      `Sam answered T9-A1 (inbox/docs/spines/root.md:${a1.line + 1}): "two". The console could not write this answer into the spine (the checkout is on feature, not main), so it is not there yet: ` +
        "first run `git pull --ff-only` on main in inbox, then write it in yourself (flip the ask line to `[answered T9-A1 <YYYY-MM-DD> @Sam] … — answer: …` in docs/spines/root.md) " +
        "following the repo's Integration policy (open a PR if the policy or a Deploy gate requires one; never push around it). Then act on the answer per the ask's row T4.",
    );
    // a live run: a second refused answer steers it with the same instructions
    const r2 = await call("POST", `/api/waiting-on-owner/${(await items(call, m.id)).find((i) => i.code === "T9-A2").id}/respond`, { kind: "approve", text: "", milestoneId: m.id });
    expect(r2.json.wake).toMatchObject({ notified: "steered", runId: r.json.wake.runId });
    expect(t3.calls.filter((x) => x.op === "sendToThread").at(-1)!.args.message).toMatch(/^New answer while you are running — Sam answered T9-A2 .*"APPROVED"\. The console could not write this answer into the spine \(the checkout is on feature, not main\)/);
  });

  it("T62-S4: an unwritten answer is in no wake prompt (the ask is still open in the spine); once the owner writes the line, the spine's [answered] line is what the wake reads", async () => {
    const { call } = setup();
    const { m, dm, b } = await seed(call);
    git(repo, ["checkout", "-q", "-b", "feature"]);
    const a1 = (await items(call, m.id)).find((i) => i.code === "T9-A1");
    const r = await answer(call, m, a1, { wake: false });
    expect(r.json).toMatchObject({ spine: { status: "skipped" }, wake: { notified: "off" } });
    const prompt = (await call("POST", `/api/assignments/${b.id}/wake?format=json`, {})).json.prompt as string;
    expect(prompt).not.toContain("NOT in the spine yet");
    expect(prompt).not.toMatch(/Ship with one logger or two\? — answer: two/);
    // the ask is still open for the owner (Waiting on you, with the reason and Retry on its card)
    expect((await items(call, m.id)).find((i) => i.code === "T9-A1")).toMatchObject({ state: "open", response: { spine: { status: "skipped" } } });
    // the owner writes the line in (on main): the spine's [answered] line is in the next wake prompt
    git(repo, ["checkout", "-q", "main"]);
    const f = path.join(repo, "docs/spines/root.md");
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("- [ask T9-A1: decide @Sam since 2026-10-20 row T4]", "- [answered T9-A1 2026-10-25 @Sam]").replace(" — context: notes.md\n- [ask T9-A2", " — context: notes.md — answer: two\n- [ask T9-A2"));
    git(repo, ["commit", "-q", "-am", "owner writes the answer"]);
    const after = (await call("POST", `/api/assignments/${dm.id}/wake?format=json`, {})).json.prompt as string; // b's wake is still running
    expect(after).not.toContain("NOT in the spine yet");
    expect(after).toMatch(/- docs\/spines\/root\.md:\d+ — Ship with one logger or two\? — answer: two/);
  });

  it("change answer: the woken run is steered with the change", async () => {
    const { call } = setup();
    const { m } = await seed(call);
    const a1 = (await items(call, m.id)).find((i) => i.code === "T9-A1");
    const first = (await answer(call, m, a1, { text: "one" })).json;
    const ch = await call("POST", `/api/owner-responses/${first.id}/change`, { kind: "answer", text: "two" });
    expect(ch.json.wake).toMatchObject({ notified: "steered", runId: first.wake.runId });
    expect(t3.calls.filter((x) => x.op === "sendToThread").at(-1)!.args.message).toMatch(/^New answer while you are running — Sam changed his answer to T9-A1 \(inbox\/docs\/spines\/root\.md\): "two" \(was "one"\)/);
  });

  it("T62-S4: an ask raised through the API by a run that ended is a spine ask: the answer is its [answered] line and the run's assignment is woken", async () => {
    const { call } = setup();
    const { m, b } = await seed(call);
    const run = (await call("POST", "/api/runs", { assignmentId: b.id, outcome: "blocked", threadId: "thread_run", endedAt: new Date().toISOString() })).json;
    const raised = await call("POST", "/api/needs-owner", { runId: run.id, milestoneId: m.id, question: "Deploy now?", proposedAction: "deploy T4 - why Sam: it widens access" });
    expect(raised.status).toBe(201);
    const code = raised.json.ask.code;
    expect(code).toBe("T9-A4");
    const it = (await items(call, m.id)).find((i) => i.code === code);
    expect(it).toMatchObject({ source: "ask", state: "open", question: "Deploy now?", asker: { assignmentId: b.id, via: "run" } });
    const r = await call("POST", `/api/waiting-on-owner/${it.id}/respond`, { kind: "approve", text: "", milestoneId: m.id });
    expect(r.json).toMatchObject({ delivery: "sent", spine: { status: "written" }, wake: { notified: "woken", persona: "Builder" } });
    expect(git(origin, ["show", "main:docs/spines/root.md"])).toMatch(new RegExp(`- \\[answered ${code} \\d{4}-\\d{2}-\\d{2} @Sam\\] Deploy now\\? .*— answer: APPROVED`));
    const woke = (await runsOf(call, b.id)).find((x) => x.id === r.json.wake.runId);
    expect(woke.instructions).toMatch(new RegExp(`^Sam answered ${code} \\(inbox/docs/spines/root\\.md\\): "APPROVED"\\. First run \`git pull --ff-only\` on main in inbox`));
  });
});

/** the first answer's wake is still launching its thread when a second answer comes in. */
class HeldT3 extends FakeT3 {
  release!: () => void;
  private held = new Promise<void>((res) => (this.release = res));
  launches = 0;
  async launchThread(input: any) {
    // Only the first launch is held (the first answer's wake); a later wake launches at once.
    if (this.launches++ === 0) await this.held;
    return super.launchThread(input);
  }
}

describe("API: a second answer while the first wake is still launching (T15-S3)", () => {
  let db: DB;
  let t3: HeldT3;
  let dbPath: string;
  let pending: Promise<unknown> | undefined;
  const readCfg = () => ({ reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] }) as ReadConfig;
  const appOn = (d: DB) => {
    const app = createApp(d, {
      read: readCfg(),
      cycle: { enabled: true, t3: t3 as unknown as T3Client, dispatcher: { pick: async () => ({ seat: "seat1", providerInstanceId: "x" }), done: async () => {} } as unknown as Dispatcher, publicUrl: "http://console.test" },
    });
    return async (method: string, url: string, body?: unknown) => {
      const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : undefined };
    };
  };
  type Call = ReturnType<typeof appOn>;
  afterEach(async () => {
    vi.useRealTimers();
    t3?.release();
    await pending; // the first answer's request ends before its database closes
    db?.close();
  });
  /** First answer (A1) starts a wake whose thread launch is held; the second (A2) comes in meanwhile. */
  const twoAnswers = async () => {
    seedRepo();
    dbPath = path.join(tmp, "console.db");
    db = openDb(dbPath);
    t3 = new HeldT3();
    const call = appOn(db);
    const m = (await call("POST", "/api/milestones", { title: "Inbox", repo: "Acme/inbox", path: "docs/spines/root.md" })).json;
    const dmP = (await call("POST", "/api/personas", { name: "Delivery Manager", remit: "runs it", model: "opus" })).json;
    const dm = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: dmP.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true })).json;
    await call("POST", "/api/runs", { assignmentId: dm.id, outcome: "progressed", startedAt: "2026-10-20T09:55:00.000Z", endedAt: "2026-10-20T10:01:00.000Z" });
    const list = (await call("GET", `/api/waiting-on-owner?milestoneId=${m.id}`)).json as any[];
    const first = call("POST", `/api/waiting-on-owner/${list.find((i) => i.code === "T9-A1").id}/respond`, { kind: "answer", text: "two", milestoneId: m.id });
    pending = first;
    await vi.waitFor(() => expect(t3.launches).toBe(1), { timeout: 10_000 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const r2 = await call("POST", `/api/waiting-on-owner/${list.find((i) => i.code === "T9-A2").id}/respond`, { kind: "approve", text: "", milestoneId: m.id });
    return { call, m, dm, first, r2 };
  };
  const wakeOf = async (call: Call, id: string) => ((await call("GET", "/api/owner-responses")).json as any[]).find((x) => x.id === id).wake;
  const steers = () => t3.calls.filter((x) => x.op === "sendToThread");

  it("queued, then steered once when the thread exists (same clientRequestId)", async () => {
    const { call, first, r2 } = await twoAnswers();
    const live = (await call("GET", `/api/runs?assignmentId=${r2.json.wake.assignmentId}`)).json.find((x: any) => x.outcome === "running");
    expect(r2.json.wake).toMatchObject({ notified: "queued", runId: live.id, persona: "Delivery Manager" });
    expect(steers()).toEqual([]);
    // still launching: the next try stays queued and sends nothing
    await vi.advanceTimersByTimeAsync(STEER_RETRY_MS);
    expect((await wakeOf(call, r2.json.id)).notified).toBe("queued");
    t3.release();
    const r1 = await first;
    expect(r1.json.wake).toMatchObject({ notified: "woken", runId: live.id });
    await vi.advanceTimersByTimeAsync(STEER_RETRY_MS);
    expect(await wakeOf(call, r2.json.id)).toMatchObject({ notified: "steered", runId: live.id, mode: "steer" });
    expect(steers()).toHaveLength(1);
    expect(steers()[0].args).toMatchObject({ threadId: "thread_1", mode: "steer", clientRequestId: `console-answer-${r2.json.id}` });
    expect(steers()[0].args.message).toContain('Sam answered T9-A2 (inbox/docs/spines/root.md): "APPROVED"');
    // done: no further tries
    await vi.advanceTimersByTimeAsync(STEER_RETRY_FOR_MS);
    expect(steers()).toHaveLength(1);
  });

  it("the run ends during the wait: the asker is woken with the answer instead", async () => {
    const { call, dm, r2 } = await twoAnswers();
    expect(r2.json.wake.notified).toBe("queued");
    await call("PATCH", `/api/runs/${r2.json.wake.runId}`, { outcome: "failed", endedAt: new Date().toISOString() });
    await vi.advanceTimersByTimeAsync(STEER_RETRY_MS);
    const w = await wakeOf(call, r2.json.id);
    expect(w).toMatchObject({ notified: "woken" });
    expect(w.runId).not.toBe(r2.json.wake.runId);
    const woke = (await call("GET", `/api/runs?assignmentId=${dm.id}`)).json.find((x: any) => x.id === w.runId);
    expect(woke).toMatchObject({ instructionsBy: "Sam" });
    expect(woke.instructions).toMatch(/^Sam answered T9-A2 \(inbox\/docs\/spines\/root\.md\): "APPROVED"\. First run `git pull --ff-only`/);
    expect(steers()).toEqual([]);
  });

  it("no thread after 2 min: failed with the reason", async () => {
    const { call, r2 } = await twoAnswers();
    expect(r2.json.wake.notified).toBe("queued");
    await vi.advanceTimersByTimeAsync(STEER_RETRY_FOR_MS - STEER_RETRY_MS);
    expect((await wakeOf(call, r2.json.id)).notified).toBe("queued");
    await vi.advanceTimersByTimeAsync(STEER_RETRY_MS);
    expect(await wakeOf(call, r2.json.id)).toMatchObject({ notified: "failed", reason: `its session had no thread to steer after 2 min (run ${r2.json.wake.runId})` });
    expect(steers()).toEqual([]);
  });

  it("restart: a row still queued is failed so Retry picks it up", async () => {
    const { r2 } = await twoAnswers();
    expect(r2.json.wake.notified).toBe("queued");
    vi.useRealTimers();
    const db2 = openDb(dbPath);
    try {
      const call2 = appOn(db2);
      expect(await wakeOf(call2, r2.json.id)).toMatchObject({ notified: "failed", reason: RESTART_QUEUED_REASON });
    } finally {
      db2.close();
    }
  });
});
