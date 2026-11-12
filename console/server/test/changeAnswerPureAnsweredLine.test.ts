import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { changeAnswer, type AnswerTarget } from "../src/inbox/spineWrite.js";
import type { ReadConfig } from "../src/routes/read.js";
import type { T3Client } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
// this file checks the text with our own owner's name (src/identity.ts; the suite's owner is neutral, hostedSetup.ts)

/** the owner changes an answer before the owner acts on it. */

const SPINE = `# PLAN-9: Inbox spine

Spine ID: inbox-root
Integration policy: main-direct

## Current State

Status: active
Waiting on: Sam (see Waiting on)

## Waiting on

- [ask T9-A1: decide @Sam since 2026-10-20 row T4] Ship with one logger or two? — options: one | two — recommend: one — context: notes.md
- [ask T9-A2: approve @Sam since 2026-10-21 row T5] Deploy T5 in place of the old reader? — recommend: yes — context: notes.md

## Issue Ledger

| Issue | Title | Needs | Status |
|---|---|---|---|
| T4 | Pick the logger layout | Sam | blocked |
| T5 | Deploy the reader | Sam go | blocked |
`;

const T = (over: Partial<AnswerTarget> = {}): AnswerTarget => ({ id: "wj_t", source: "ask", question: "Ship with one logger or two?", code: "T9-A1", path: "docs/spines/root.md", ...over });

describe("changeAnswer (pure): the [answered] line is rewritten in place", () => {
  const answered = SPINE.replace(
    "- [ask T9-A1: decide @Sam since 2026-10-20 row T4] Ship with one logger or two? — options: one | two — recommend: one — context: notes.md",
    "- [answered T9-A1 2026-10-22 @Sam] Ship with one logger or two? — options: one | two — recommend: one — context: notes.md — answer: one",
  );

  it("coded ask: same code, new date and answer, every other line untouched, still one answered line", () => {
    const e = changeAnswer(answered, T(), "two", "2026-10-24");
    expect(e.how).toBe("rewrite");
    if (e.how !== "rewrite") return;
    const before = answered.split("\n");
    const after = e.text.split("\n");
    expect(after).toHaveLength(before.length);
    expect(after[e.line]).toBe("- [answered T9-A1 2026-10-24 @Sam] Ship with one logger or two? — options: one | two — recommend: one — context: notes.md — answer: two");
    expect(after.filter((l, i) => l !== before[i])).toHaveLength(1);
    expect(after.filter((l) => l.includes("[answered"))).toHaveLength(1);
  });

  it("non-ask entry (`[answered <date> @Sam]`, no code): matched by question; keeps segments after the answer", () => {
    const text = `${SPINE.replace("## Issue Ledger", "- [answered 2026-10-22 @Sam] Sam's go on P2 — answer: go — why: keep this\n\n## Issue Ledger")}`;
    const e = changeAnswer(text, T({ code: undefined, source: "heuristic", question: "Sam's go on P2" }), "APPROVED — not before 18:00", "2026-10-24");
    expect(e.how).toBe("rewrite");
    if (e.how === "rewrite") expect(e.text.split("\n")[e.line]).toBe("- [answered 2026-10-24 @Sam] Sam's go on P2 — answer: APPROVED - not before 18:00 — why: keep this");
  });

  it("refuses when the owner already acted (done marker, line gone), on a persona's answer, and reports an unchanged answer", () => {
    expect(changeAnswer(answered.replace("— answer: one", "— answer: one · done 2026-10-23 abc1234"), T(), "two", "2026-10-24").how).toBe("done");
    expect(changeAnswer(answered.replace("@Sam] Ship", "@Sam · done 2026-10-23] Ship"), T(), "two", "2026-10-24").how).toBe("done");
    expect(changeAnswer(SPINE, T(), "two", "2026-10-24").how).toBe("missing");
    expect(changeAnswer(answered.replace("2026-10-22 @Sam]", "2026-10-22 @Unblocker]"), T(), "two", "2026-10-24")).toMatchObject({ how: "not_jordi", who: "Unblocker" });
    expect(changeAnswer(answered, T(), "one", "2026-10-22").how).toBe("same");
  });
});

// ---------- API ----------

let tmp: string;
let origin: string;
let repo: string;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
const file = (rel: string, dir = repo) => path.join(dir, rel);
const read = (rel: string) => fs.readFileSync(file(rel), "utf8");
const put = (rel: string, text: string, dir = repo) => {
  fs.mkdirSync(path.dirname(file(rel, dir)), { recursive: true });
  fs.writeFileSync(file(rel, dir), text);
};
const commitAll = (dir: string, msg: string) => {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
};

const savedEnv = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };
beforeEach(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e8s11-"));
  origin = path.join(tmp, "origin.git");
  git(tmp, "init", "-q", "--bare", "-b", "main", origin);
  const seed = path.join(tmp, "seed");
  git(tmp, "clone", "-q", origin, seed);
  git(seed, "checkout", "-q", "-b", "main");
  put("docs/spines/root.md", SPINE, seed);
  put("docs/spines/notes.md", "# notes\n", seed);
  commitAll(seed, "seed");
  git(seed, "push", "-q", "origin", "main");
  repo = path.join(tmp, "inbox");
  git(tmp, "clone", "-q", origin, repo);
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
  async sendToThread(threadId: string, message: string) {
    this.calls.push({ op: "sendToThread", args: { threadId, message } });
  }
  async readThreadStatus() {
    return { status: "idle", raw: {} };
  }
}

describe("API: POST /owner-responses/:id/change", () => {
  let db: DB;
  let t3: FakeT3;
  const setup = () => {
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
  const items = async (call: ReturnType<typeof setup>["call"], mid: string) => (await call("GET", `/api/waiting-on-owner?milestoneId=${mid}`)).json as any[];
  const seed = async (call: ReturnType<typeof setup>["call"]) => {
    const m = (await call("POST", "/api/milestones", { title: "Inbox", repo: "Acme/inbox", path: "docs/spines/root.md" })).json;
    const dm = (await call("POST", "/api/personas", { name: "Delivery Manager", remit: "runs it", model: "opus" })).json;
    const a = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: dm.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true })).json;
    return { m, a };
  };

  it("spine ask: rewrites the [answered] line in place, commits + pushes, keeps the old response, Activity shows old → new", async () => {
    const { call } = setup();
    const { m } = await seed(call);
    const ask = (await items(call, m.id)).find((i) => i.code === "T9-A1");
    const first = (await call("POST", `/api/waiting-on-owner/${ask.id}/respond`, { kind: "answer", text: "one", milestoneId: m.id })).json;
    expect(first.spine.status).toBe("written");
    const card = (await items(call, m.id)).find((i) => i.code === "T9-A1");
    expect(card).toMatchObject({ state: "answered", answer: "one", response: { id: first.id } });

    const ch = await call("POST", `/api/owner-responses/${first.id}/change`, { kind: "answer", text: "two" });
    expect(ch.status).toBe(201);
    expect(ch.json).toMatchObject({ replacesId: first.id, replacedAnswer: "one", kind: "answer", text: "two", delivery: "sent", spine: { status: "written" } });
    const today = new Date().toISOString().slice(0, 10);
    const text = read("docs/spines/root.md");
    expect(text.split("\n").filter((l) => l.includes("[answered"))).toEqual([
      `- [answered T9-A1 ${today} @Sam] Ship with one logger or two? — options: one | two — recommend: one — context: notes.md — answer: two`,
    ]);
    expect(git(origin, "show", "main:docs/spines/root.md")).toBe(text.trim());
    expect(git(origin, "log", "-1", "--format=%s", "main")).toBe("Answer T9-A1 changed: new answer (Sam, via console)");
    // Spine items: the line is the hand-off. The answer woke the asker (a new thread); the change steered that run.
    expect(first.wake).toMatchObject({ notified: "woken", runId: expect.any(String) });
    expect(ch.json.wake).toMatchObject({ notified: "steered", runId: first.wake.runId, mode: "steer" });
    const sent = t3.calls.filter((x) => x.op === "sendToThread").map((x) => x.args.message);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^New answer while you are running — Sam changed his answer to T9-A1 \(inbox\/docs\/spines\/root\.md\): "two" \(was "one"\)\. First run `git pull --ff-only` on main in inbox/);

    const after = (await items(call, m.id)).find((i) => i.code === "T9-A1");
    expect(after).toMatchObject({ state: "answered", answer: "two", response: { id: ch.json.id, replacedAnswer: "one" } });
    expect(((await call("GET", `/api/owner-responses?milestoneId=${m.id}`)).json as any[]).map((r) => r.text)).toEqual(["two", "one"]);
    const act = ((await call("GET", `/api/owner-activity?milestoneId=${m.id}`)).json as any[])[0];
    expect(act).toMatchObject({ type: "response", text: "two", replacesId: first.id, replacedAnswer: "one" });

    // The old response cannot be changed again (the chain moves on); the same answer twice is refused.
    expect((await call("POST", `/api/owner-responses/${first.id}/change`, { kind: "answer", text: "three" })).status).toBe(409);
    expect((await call("POST", `/api/owner-responses/${ch.json.id}/change`, { kind: "answer", text: "two" })).status).toBe(400);
  });

  it("approve ask: APPROVED → DENIED rewrites the same line", async () => {
    const { call } = setup();
    const { m } = await seed(call);
    const ask = (await items(call, m.id)).find((i) => i.code === "T9-A2");
    const first = (await call("POST", `/api/waiting-on-owner/${ask.id}/respond`, { kind: "approve", text: "", milestoneId: m.id })).json;
    const ch = await call("POST", `/api/owner-responses/${first.id}/change`, { kind: "deny", text: "wait for the audit" });
    expect(ch.status).toBe(201);
    const lines = read("docs/spines/root.md").split("\n").filter((l) => l.includes("[answered"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^- \[answered T9-A2 \d{4}-\d{2}-\d{2} @Sam\] Deploy T5 in place of the old reader\? — recommend: yes — context: notes\.md — answer: DENIED - wait for the audit$/);
  });

  it("refuses with a plain reason when the owner already acted (done marker, or the line deleted); nothing written", async () => {
    const { call } = setup();
    const { m } = await seed(call);
    const ask = (await items(call, m.id)).find((i) => i.code === "T9-A1");
    const first = (await call("POST", `/api/waiting-on-owner/${ask.id}/respond`, { kind: "answer", text: "one", milestoneId: m.id })).json;
    put("docs/spines/root.md", read("docs/spines/root.md").replace("— answer: one", "— answer: one · done 2026-10-23 abc1234"));
    commitAll(repo, "owner marks done");
    git(repo, "push", "-q", "origin", "main");
    const head = git(origin, "rev-parse", "main");
    const done = await call("POST", `/api/owner-responses/${first.id}/change`, { kind: "answer", text: "two" });
    expect(done.status).toBe(409);
    expect(done.json.error.message).toMatch(/marked done: the owner already acted/);

    put("docs/spines/root.md", read("docs/spines/root.md").split("\n").filter((l) => !l.includes("[answered")).join("\n"));
    commitAll(repo, "owner cleans up");
    git(repo, "push", "-q", "origin", "main");
    const gone = await call("POST", `/api/owner-responses/${first.id}/change`, { kind: "answer", text: "two" });
    expect(gone.status).toBe(409);
    expect(gone.json.error.message).toMatch(/not in docs\/spines\/root\.md any more: the owner already acted/);
    expect(((await call("GET", `/api/owner-responses?milestoneId=${m.id}`)).json as any[])).toHaveLength(1);
    expect(git(origin, "rev-list", "--count", `${head}..main`)).toBe("1"); // only the cleanup commit
  });

  // "persona request" changes (a Needs the owner row answered over its thread) are gone with the rows: an ask raised
  // through the API is a spine ask, changed like the spine asks above.

  it("a wake of the owner after the answer is flagged on the response (the owner may have read the old answer); change still allowed", async () => {
    const { call } = setup();
    const { m, a } = await seed(call);
    const ask = (await items(call, m.id)).find((i) => i.code === "T9-A1");
    // wake: false, so the only run after the answer is the one this test starts.
    const first = (await call("POST", `/api/waiting-on-owner/${ask.id}/respond`, { kind: "answer", text: "one", milestoneId: m.id, wake: false })).json;
    expect(first.wake).toMatchObject({ notified: "off" });
    expect((await items(call, m.id)).find((i) => i.code === "T9-A1").response.ownerRunSince).toBeUndefined();
    const later = new Date(Date.parse(first.createdAt) + 1000).toISOString();
    await call("POST", "/api/runs", { assignmentId: a.id, outcome: "running", startedAt: later });
    expect((await items(call, m.id)).find((i) => i.code === "T9-A1").response.ownerRunSince).toBe(later);
    expect((await call("POST", `/api/owner-responses/${first.id}/change`, { kind: "answer", text: "two" })).status).toBe(201);
  });
});
