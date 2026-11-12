import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { ReadConfig } from "../src/routes/read.js";
import type { SpinesRunner } from "../src/adapters/spines.js";
import type { ReadModelHost } from "../src/readModel/host.js";
import type { T3Client } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import { createAnswerJobs, type AnswerJobs } from "../src/inbox/answerJobs.js";
import { withRepoLock, gitContention } from "../src/repoLock.js";
import { createRepoPuller } from "../src/cycle/repoPull.js";

/**
 * an answer is stored and acknowledged at once (idempotency key), the spine write, push and wake run after in a
 * durable job (retried, resumed after a restart), the click never reads spines.py or git, and git on one checkout is
 * serialised across the console.
 */

const A1 = "- [ask T9-A1: decide @Sam since 2026-10-20 row T4] Ship with one logger or two? — options: one | two — recommend: one — context: notes.md";
const A2 = "- [ask T9-A2: decide @Sam since 2026-10-20 row T5] Keep the old dashboard? — options: keep | drop — recommend: drop — context: notes.md";
const A3 = "- [ask T9-A3: decide @Sam since 2026-10-22 row T6] Rename the bucket? — options: yes | no — recommend: yes — context: notes.md";
const spine = (asks: string[]) => `# PLAN-9: Inbox spine

Spine ID: inbox-root
Integration policy: main-direct

## Current State

Status: active
Waiting on: Sam (see Waiting on)

## Waiting on

${asks.join("\n")}

## Issue Ledger

| Issue | Title | Needs | Status |
|---|---|---|---|
| T4 | Pick the logger layout | Sam | blocked |
| T5 | Dashboard | Sam | blocked |
| T6 | Bucket | Sam | blocked |
`;

let tmp: string;
let origin: string;
let seed: string;
let repo: string;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, args: string[], at?: string) =>
  execFileSync("git", args, { cwd, env: at ? { ...ENV, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : ENV, encoding: "utf8" }).trim();
const put = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const savedEnv = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };
const seedRepo = () => {
  origin = path.join(tmp, "origin.git");
  git(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
  seed = path.join(tmp, "seed");
  git(tmp, ["clone", "-q", origin, seed]);
  git(seed, ["checkout", "-q", "-b", "main"]);
  put(seed, "docs/spines/root.md", spine([A1, A2]));
  put(seed, "docs/spines/notes.md", "# notes\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "asks"], "2026-10-20T10:00:00.000Z");
  git(seed, ["push", "-q", "origin", "main"]);
  repo = path.join(tmp, "inbox");
  git(tmp, ["clone", "-q", origin, repo]);
};
beforeEach(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e33s9-"));
});
const dbs: DB[] = [];
const hosts: ReadModelHost[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.close();
  for (const d of dbs.splice(0)) d.close();
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

/** spines.py stand-in: counted, fails (the tree is the markdown parse). */
const spinesCalls: string[] = [];
const spines: SpinesRunner = async (dir) => {
  spinesCalls.push(dir);
  throw new Error("no spines.py in tests");
};

function setup(o: { dbFile?: string; ack?: "saved" | "done"; retryMs?: number[]; readModel?: "in-process" | "none" } = {}) {
  const db = openDb(o.dbFile ?? path.join(tmp, "console.db"));
  dbs.push(db);
  const t3 = new FakeT3();
  let host: ReadModelHost | undefined;
  let jobs: AnswerJobs | undefined;
  const read: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [], spines };
  const app = createApp(db, {
    read,
    browser: { browserUrl: "http://127.0.0.1:9" },
    readModel: { mode: o.readModel ?? "in-process", tickMs: 0, onHost: (h) => hosts.push((host = h)) },
    answers: { ack: o.ack ?? "saved", retryMs: o.retryMs ?? [30, 30], onJobs: (j) => (jobs = j) },
    cycle: { enabled: true, t3: t3 as unknown as T3Client, dispatcher: { pick: async () => ({ seat: "seat1", providerInstanceId: "x" }), done: async () => {} } as unknown as Dispatcher, publicUrl: "http://console.test" },
  });
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const t0 = Date.now();
    const res = await app.request(url, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined, ms: Date.now() - t0 };
  };
  const pass = async () => {
    await host!.refresher!.tick();
    await host!.refresher!.idle();
  };
  return { db, t3, call, pass, jobs: () => jobs!, host: () => host! };
}
type Setup = ReturnType<typeof setup>;

const seedMilestone = async (s: Setup) => {
  const m = (await s.call("POST", "/api/milestones", { title: "Inbox", repo: "Acme/inbox", path: "docs/spines/root.md" })).json;
  const dmP = (await s.call("POST", "/api/personas", { name: "Delivery Manager", remit: "runs it", model: "opus" })).json;
  const dm = (await s.call("POST", "/api/assignments", { milestoneId: m.id, personaId: dmP.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true })).json;
  // The DM's run window holds the commit of A1 / A2: it is the asker.
  await s.call("POST", "/api/runs", { assignmentId: dm.id, outcome: "progressed", startedAt: "2026-10-20T09:55:00.000Z", endedAt: "2026-10-20T10:01:00.000Z" });
  return { m, dm };
};
const waiting = async (s: Setup, mid: string) => (await s.call("GET", `/api/waiting-on-owner?milestoneId=${mid}`)).json as any[];
const row = (db: DB, id: string) => db.prepare("SELECT * FROM jordi_responses WHERE id = ?").get(id) as Record<string, any>;

describe("T33-S9 answers: stored and acknowledged at once, written after", () => {
  it("saved: 201 with the job pending and no spines.py or git on the click; the job then writes the spine and wakes the asker", async () => {
    seedRepo();
    const s = setup();
    const { m, dm } = await seedMilestone(s);
    await waiting(s, m.id); // the views are registered,
    await s.pass(); // and stored by the refresher
    const a1 = (await waiting(s, m.id)).find((i) => i.code === "T9-A1");
    expect(a1.asker).toMatchObject({ assignmentId: dm.id });
    const head = git(repo, ["rev-parse", "HEAD"]);
    const before = spinesCalls.length;

    const r = await s.call("POST", `/api/waiting-on-owner/${a1.id}/respond`, { kind: "answer", text: "two", milestoneId: m.id, clientKey: "key-0001-abcdef" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ itemId: a1.id, delivery: "queued", job: { state: expect.stringMatching(/pending|running/) } });
    expect(r.json.item.asker).toMatchObject({ assignmentId: dm.id }); // from the stored view, not git blame
    expect(r.json.spine).toBeUndefined();
    expect(spinesCalls.length).toBe(before);

    // Until the job has written it, the card is still open (with its answer and progress) and counted.
    const card = (await waiting(s, m.id)).find((i) => i.id === a1.id);
    expect(card).toMatchObject({ state: "open", response: { id: r.json.id } });

    await s.jobs().idle();
    const done = (await s.call("GET", `/api/owner-responses?itemId=${a1.id}`)).json[0];
    expect(done).toMatchObject({ id: r.json.id, delivery: "sent", spine: { status: "written" }, wake: { notified: "woken", assignmentId: dm.id }, job: { state: "done", attempts: 1 } });
    expect(git(repo, ["rev-parse", "HEAD"])).not.toBe(head);
    expect(fs.readFileSync(path.join(repo, "docs/spines/root.md"), "utf8")).toMatch(/\[answered T9-A1 \d{4}-\d{2}-\d{2} @Sam\].*answer: two/);
    expect(git(origin, ["log", "-1", "--format=%s", "main"])).toMatch(/T9-A1/); // pushed
    // Written: the card turns answered and leaves the open count at once.
    expect((await waiting(s, m.id)).find((i) => i.code === "T9-A1")?.state).toBe("answered");
  });

  it("idempotent: the same clientKey (body or Idempotency-Key header) returns the stored answer; one row, one write, one wake", async () => {
    seedRepo();
    const s = setup();
    const { m, dm } = await seedMilestone(s);
    await waiting(s, m.id);
    await s.pass();
    const a1 = (await waiting(s, m.id)).find((i) => i.code === "T9-A1");
    const body = { kind: "answer", text: "two", milestoneId: m.id, clientKey: "retry-key-123456" };
    const [x, y] = await Promise.all([s.call("POST", `/api/waiting-on-owner/${a1.id}/respond`, body), s.call("POST", `/api/waiting-on-owner/${a1.id}/respond`, body)]);
    expect([x.status, y.status].sort()).toEqual([200, 201]);
    expect(x.json.id).toBe(y.json.id);
    await s.jobs().idle();
    const again = await s.call("POST", `/api/waiting-on-owner/${a1.id}/respond`, body);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ id: x.json.id, spine: { status: "written" }, job: { state: "done" } });
    const a2 = (await waiting(s, m.id)).find((i) => i.code === "T9-A2");
    const h1 = await s.call("POST", `/api/waiting-on-owner/${a2.id}/respond`, { kind: "answer", text: "drop", milestoneId: m.id }, { "Idempotency-Key": "header-key-0001" });
    const h2 = await s.call("POST", `/api/waiting-on-owner/${a2.id}/respond`, { kind: "answer", text: "drop", milestoneId: m.id }, { "Idempotency-Key": "header-key-0001" });
    expect(h2).toMatchObject({ status: 200, json: { id: h1.json.id } });
    await s.jobs().idle();
    expect((s.db.prepare("SELECT COUNT(*) AS n FROM jordi_responses").get() as { n: number }).n).toBe(2);
    expect(git(origin, ["log", "--format=%s", "main"]).split("\n").filter((l) => /T9-A1/.test(l))).toHaveLength(1);
    const runs = (await s.call("GET", `/api/runs?assignmentId=${dm.id}`)).json as any[];
    expect(runs.filter((r) => r.instructionsBy === "Sam")).toHaveLength(1); // A1 woke the DM once; A2 steered that run
  });

  it("an ask newer than the stored views is stored against its id at once and resolved by the job", async () => {
    seedRepo();
    const s = setup();
    const { m } = await seedMilestone(s);
    await waiting(s, m.id);
    await s.pass();
    // A3 lands on origin and in the checkout after the views were stored.
    put(seed, "docs/spines/root.md", spine([A1, A2, A3]));
    git(seed, ["commit", "-q", "-am", "A3"], "2026-10-22T10:00:00.000Z");
    git(seed, ["push", "-q", "origin", "main"]);
    git(repo, ["pull", "-q", "--ff-only"]);
    expect((await waiting(s, m.id)).some((i) => i.code === "T9-A3")).toBe(false); // the stored view does not have it yet
    const live = setup({ dbFile: path.join(tmp, "console.db"), readModel: "none" }); // the per-request read finds its id
    const a3 = (await waiting(live, m.id)).find((i) => i.code === "T9-A3");
    expect(a3).toBeTruthy();
    const before = spinesCalls.length;
    const r = await s.call("POST", `/api/waiting-on-owner/${a3.id}/respond`, { kind: "answer", text: "yes", milestoneId: m.id });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ itemId: a3.id, item: { unresolved: true }, job: { state: expect.stringMatching(/pending|running/) } });
    expect(spinesCalls.length).toBe(before); // nothing read on the click
    await s.jobs().idle();
    const done = (await s.call("GET", `/api/owner-responses?itemId=${a3.id}`)).json[0];
    expect(done).toMatchObject({ spine: { status: "written" }, job: { state: "done" }, item: { code: "T9-A3" } });
    expect(fs.readFileSync(path.join(repo, "docs/spines/root.md"), "utf8")).toMatch(/\[answered T9-A3 .*answer: yes/);
    // An unknown id with a milestone is stored too, and fails with the reason (the card shows it with Retry).
    const ghost = await s.call("POST", `/api/waiting-on-owner/nope-123/respond`, { kind: "answer", text: "x", milestoneId: m.id });
    expect(ghost.status).toBe(201);
    await s.jobs().idle();
    expect(row(s.db, ghost.json.id)).toMatchObject({ job_state: "failed", job_error: expect.stringMatching(/not in the spine any more/) });
  });

  it("a git failure is retried with backoff and the answer is written when origin is back; the card shows the failed try", async () => {
    seedRepo();
    const s = setup({ retryMs: [150, 150, 150] });
    const { m } = await seedMilestone(s);
    await waiting(s, m.id);
    await s.pass();
    const a1 = (await waiting(s, m.id)).find((i) => i.code === "T9-A1");
    fs.renameSync(origin, origin + ".away"); // GitHub unreachable
    const r = await s.call("POST", `/api/waiting-on-owner/${a1.id}/respond`, { kind: "answer", text: "two", milestoneId: m.id });
    expect(r.status).toBe(201);
    for (let i = 0; i < 100 && !row(s.db, r.json.id).job_error; i++) await new Promise((x) => setTimeout(x, 20));
    expect(row(s.db, r.json.id)).toMatchObject({ job_state: expect.stringMatching(/pending|running/), job_error: expect.stringMatching(/fetch/) });
    expect((await waiting(s, m.id)).find((i) => i.id === a1.id)?.response.job).toMatchObject({ attempts: 1, error: expect.stringMatching(/fetch/) });
    fs.renameSync(origin + ".away", origin);
    await s.jobs().idle();
    expect(row(s.db, r.json.id)).toMatchObject({ job_state: "done", spine_status: "written", wake_status: "woken" });
  });

  it("all tries failed: failed with the reason, the card stays open; Retry runs the job again", async () => {
    seedRepo();
    const s = setup({ retryMs: [20] });
    const { m } = await seedMilestone(s);
    await waiting(s, m.id);
    await s.pass();
    const a1 = (await waiting(s, m.id)).find((i) => i.code === "T9-A1");
    fs.renameSync(origin, origin + ".away");
    const r = await s.call("POST", `/api/waiting-on-owner/${a1.id}/respond`, { kind: "answer", text: "two", milestoneId: m.id, wake: false });
    await s.jobs().idle();
    expect(row(s.db, r.json.id)).toMatchObject({ job_state: "failed", job_attempts: 2, spine_status: "failed", wake_status: "off" });
    expect((await waiting(s, m.id)).find((i) => i.id === a1.id)).toMatchObject({ state: "open", response: { job: { state: "failed" } } });
    fs.renameSync(origin + ".away", origin);
    const retry = await s.call("POST", `/api/owner-responses/${r.json.id}/deliver`);
    expect(retry.status).toBe(200);
    await s.jobs().idle();
    expect(row(s.db, r.json.id)).toMatchObject({ job_state: "done", spine_status: "written" });
  });

  it("restart: an answer still waiting for its job is picked up at boot and written", async () => {
    seedRepo();
    const dbFile = path.join(tmp, "console.db");
    const s1 = setup({ dbFile, retryMs: [60_000] });
    const { m } = await seedMilestone(s1);
    await waiting(s1, m.id);
    await s1.pass();
    const a1 = (await waiting(s1, m.id)).find((i) => i.code === "T9-A1");
    fs.renameSync(origin, origin + ".away");
    const r = await s1.call("POST", `/api/waiting-on-owner/${a1.id}/respond`, { kind: "answer", text: "two", milestoneId: m.id });
    for (let i = 0; i < 100 && !row(s1.db, r.json.id).job_next_at; i++) await new Promise((x) => setTimeout(x, 20));
    expect(row(s1.db, r.json.id)).toMatchObject({ job_state: "pending", job_next_at: expect.any(String) }); // next try in 60 s
    expect(await s1.jobs().drain(1_000)).toBe(true); // SIGTERM: nothing running, the timer is dropped
    for (const h of hosts.splice(0)) h.close();
    dbs.splice(0).forEach((d) => d.close());

    fs.renameSync(origin + ".away", origin);
    const s2 = setup({ dbFile });
    await s2.jobs().idle();
    expect(row(s2.db, r.json.id)).toMatchObject({ job_state: "done", spine_status: "written", wake_status: "woken" });
  });

  it("done (default, agent callers): the reply waits for the job and carries the outcome", async () => {
    seedRepo();
    const s = setup({ ack: "done" });
    const { m } = await seedMilestone(s);
    const a1 = (await waiting(s, m.id)).find((i) => i.code === "T9-A1");
    const r = await s.call("POST", `/api/waiting-on-owner/${a1.id}/respond`, { kind: "answer", text: "two", milestoneId: m.id });
    expect(r.json).toMatchObject({ delivery: "sent", spine: { status: "written" }, wake: { notified: "woken" }, job: { state: "done" } });
  });
});

describe("T33-S9 answer jobs", () => {
  const db = () => {
    const d = openDb(":memory:");
    dbs.push(d);
    d.prepare(`INSERT INTO jordi_responses (id, item_id, item, kind, text, delivery, created_at, job_state, job_attempts) VALUES ('jr_1', 'i', '{}', 'answer', 'x', 'queued', '2026-11-01', 'pending', 0)`).run();
    return d;
  };
  it("drain waits for a running step, and gives up after its limit (the row stays for the next start)", async () => {
    const d = db();
    let release!: () => void;
    const jobs = createAnswerJobs({ db: d, step: () => new Promise((r) => (release = () => r({ state: "done" }))), log: () => {} });
    void jobs.start("jr_1");
    expect(jobs.running()).toBe(1);
    expect(await jobs.drain(30)).toBe(false);
    expect((d.prepare("SELECT job_state FROM jordi_responses").get() as any).job_state).toBe("running");
    const drained = jobs.drain(2_000);
    release();
    expect(await drained).toBe(true);
    expect((d.prepare("SELECT job_state FROM jordi_responses").get() as any).job_state).toBe("done");
    await jobs.start("jr_1"); // draining: nothing new starts
    expect(jobs.running()).toBe(0);
  });
  it("resume at boot: a try cut by the stop is not counted", async () => {
    const d = db();
    d.prepare("UPDATE jordi_responses SET job_state = 'running', job_attempts = 1").run();
    const seen: number[] = [];
    const jobs = createAnswerJobs({ db: d, step: async (_id, o) => (seen.push(o.attempt), { state: "done" }), log: () => {} });
    expect(jobs.resume()).toEqual(["jr_1"]);
    await jobs.idle();
    expect(seen).toEqual([1]);
  });
  it("an error thrown by a step is retried; the last try is told it is the last", async () => {
    const d = db();
    const seen: boolean[] = [];
    const jobs = createAnswerJobs({ db: d, retryMs: [5, 5], step: async (_id, o) => (seen.push(o.last), o.last ? { state: "failed", error: "gave up" } : Promise.reject(new Error("boom"))), log: () => {} });
    await jobs.start("jr_1");
    await jobs.idle();
    expect(seen).toEqual([false, false, true]);
    expect(d.prepare("SELECT job_state, job_attempts, job_error FROM jordi_responses").get()).toEqual({ job_state: "failed", job_attempts: 3, job_error: "gave up" });
  });
});

describe("T33-S9 one git operation at a time per checkout", () => {
  it("withRepoLock runs a checkout's operations one after another (other checkouts in parallel)", async () => {
    const log: string[] = [];
    const op = (dir: string, name: string, ms: number) =>
      withRepoLock(dir, async () => {
        log.push(`${name}+`);
        await new Promise((r) => setTimeout(r, ms));
        log.push(`${name}-`);
      });
    await Promise.all([op("/x/a", "a1", 30), op("/x/a/", "a2", 5), op("/x/b", "b1", 5)]);
    expect(log.indexOf("a1-")).toBeLessThan(log.indexOf("a2+"));
    expect(log.indexOf("b1+")).toBeLessThan(log.indexOf("a1-"));
    // a failing operation does not block the next
    await expect(withRepoLock("/x/a", async () => Promise.reject(new Error("no")))).rejects.toThrow("no");
    expect(await withRepoLock("/x/a", async () => 7)).toBe(7);
  });
  it("two pullers never pull the same checkout at once; a pull another git process got in the way of is tried once more", async () => {
    let active = 0;
    let max = 0;
    let fails = 1;
    const calls: string[][] = [];
    const g = async (_d: string, args: string[]) => {
      calls.push(args);
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      if (fails-- > 0) throw new Error("fatal: Cannot fast-forward to multiple branches.");
    };
    const p1 = createRepoPuller({ git: g, log: () => {}, contentionRetryMs: 5 });
    const p2 = createRepoPuller({ git: g, log: () => {}, contentionRetryMs: 5 });
    const [r1, r2] = await Promise.all([p1.pull("/x/repo"), p2.pull("/x/repo")]);
    expect(r1).toEqual({ ok: true }); // failed with the contention error, then succeeded
    expect(r2).toEqual({ ok: true });
    expect(max).toBe(1);
    expect(calls).toHaveLength(3);
    expect(gitContention("error: cannot lock ref 'refs/remotes/origin/main': is at 9ec87c6 but expected a66b8c6")).toBe(true);
    expect(gitContention("fatal: Not possible to fast-forward, aborting.")).toBe(false);
  });
});
