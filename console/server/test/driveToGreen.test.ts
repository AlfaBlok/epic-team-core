import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createStore } from "../src/store.js";
import { openDb, type DB } from "../src/db.js";
import type { CycleOptions } from "../src/cycle/service.js";
import type { T3Client, T3Project } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import type { ReadConfig } from "../src/routes/read.js";
import { ASK_TYPE_RULES, citedAskCodes, parseAsks } from "../src/inbox/asks.js";
import { askForAsksText } from "../src/inbox/routes.js";
import { wakeProtocol } from "../src/cycle/prompts.js";
// this file checks the text with our own owner's name (src/identity.ts; the suite's owner is neutral, hostedSetup.ts)

// drive to green, ask only in the ask tier.

const SPINE = `# PLAN-9: Drive

Spine ID: drive-root

## Current State

Status: active
Waiting on: Sam (INBOX-A1)

## Waiting on

- [ask INBOX-A1: approve @Sam since 2026-10-22 row T1] Drop the old archive (irreversible)? — rollback: none — recommend: approve — unblocks: T1 — context: notes.md
- [answered INBOX-A2 2026-10-22 @Delivery-Manager] Restart the relay on host1? — answer: restarted — why: reversible, inside the goal — rollback: systemctl start relay
- [answered INBOX-A3 2026-10-21 @Sam] Use pg1? — answer: yes
- [answered INBOX-A4 2026-10-21 @steward · done 2026-10-22 abc1234] Bump the cache size? — answer: 2 GiB

## Issue Ledger

| Issue | Title | Needs | Status |
|---|---|---|---|
| T1 | Drop archive | Sam | blocked |
`;

const PROJECTS: T3Project[] = [{ id: "mcp:drive", title: "drive", workspaceRoot: "/nowhere/drive", repositoryIdentity: { displayName: "acme/drive" } }];

class FakeT3 implements T3Client {
  calls: { op: string; args: any }[] = [];
  threads = new Map<string, string[]>();
  private n = 0;
  ops = (op: string) => this.calls.filter((c) => c.op === op);
  async listProjects() {
    return PROJECTS;
  }
  async listScheduledTasks() {
    return [];
  }
  async updateScheduledTask() {
    return undefined;
  }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread(input: { projectId: string; title: string; message?: string }) {
    this.calls.push({ op: "launchThread", args: input });
    const threadId = `thread_${++this.n}`;
    this.threads.set(threadId, input.message ? [input.message] : []);
    return { threadId };
  }
  async sendToThread(threadId: string, message: string, clientRequestId?: string) {
    this.calls.push({ op: "sendToThread", args: { threadId, message, clientRequestId } });
    this.threads.set(threadId, [...(this.threads.get(threadId) ?? []), message]);
  }
  async readThreadStatus() {
    return { status: "idle", raw: {} };
  }
}

class FakeDispatcher implements Dispatcher {
  async pick() {
    return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" };
  }
  async done() {}
}

let reposRoot: string;
let db: DB;
let t3: FakeT3;
const write = (rel: string, text: string) => {
  const f = path.join(reposRoot, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

/** the spine already says it monitors (the worker wrote the line), so a monitoring report needs no console write. */
const monitored = () =>
  write("drive/docs/spines/root.md", SPINE.replace("Waiting on: Sam (INBOX-A1)\n", "Waiting on: Sam (INBOX-A1)\nMonitoring: the window · next check 2099-01-01T00:00:00Z\n"));

beforeEach(() => {
  reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-drive-"));
  write("drive/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/drive.git\n`);
  write("drive/docs/spines/root.md", SPINE);
  write("drive/docs/spines/notes.md", "# notes\n");
});
afterEach(() => {
  db?.close();
  fs.rmSync(reposRoot, { recursive: true, force: true });
});

function setup(over: Partial<CycleOptions> = {}) {
  db = openDb(path.join(reposRoot, "console.db"));
  t3 = new FakeT3();
  const read: ReadConfig = { reposRoot, seatsFile: path.join(reposRoot, "seats.json"), listThreads: async () => [] };
  const app = createApp(db, { read, cycle: { enabled: true, t3, dispatcher: new FakeDispatcher(), publicUrl: "http://console.test", ...over } });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  return { call };
}

async function seed(call: ReturnType<typeof setup>["call"]) {
  const m = (await call("POST", "/api/milestones", { title: "Drive", repo: "Acme/drive", path: "docs/spines/root.md" })).json;
  const dm = (await call("POST", "/api/personas", { name: "Delivery Manager", remit: "runs the milestone", model: "opus" })).json;
  const a = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: dm.id, cadence: { type: "interval", everyMinutes: 60 } })).json;
  return { m, dm, a };
}

const protocolFor = (personaName: string) =>
  wakeProtocol({
    base: "http://c",
    run: { id: "run_1" },
    assignment: { id: "asg_1", mayWrite: true, writeScope: "spine" },
    milestone: { id: "ms_1" },
    persona: { id: "p_1", name: personaName },
  } as any);

describe("tier rules in the prompts", () => {
  it("every ask rule set carries the goal, the three tiers and the blocked rule", () => {
    const rules = ASK_TYPE_RULES.join("\n");
    expect(rules).toContain("move the milestone toward green");
    expect(rules).toContain("end every wake with a step done");
    expect(rules).toContain("Tier do: reversible and inside the epic's goal");
    expect(rules).toContain("Tier do + tell");
    expect(rules).toContain("decided by <persona>: <what> — why — rollback");
    expect(rules).toContain("Tier ask: ONLY irreversible data loss; money: spend beyond a standing approval or a limit recorded in the spine; publishing or contacting third parties; widening security or access");
    expect(rules).toContain("changing an epic's goal or Done means; a one-way door the goal and recorded answers do not settle; what only Sam can physically do");
    expect(rules).toContain("`blocked` means Sam must act: use it only citing an open ask-tier code");
  });

  it("the wake protocol states them (and the L-8 no-paste rules still)", () => {
    const text = protocolFor("archivist");
    for (const l of ASK_TYPE_RULES) expect(text).toContain(l);
    expect(text).toContain("Drive to green; ask Sam only in the ask tier");
    expect(text).toContain("Every wake ends with a step done; `blocked` only citing an open ask-tier code");
    expect(text).toContain("Never ask Sam to run commands");
  });

  it("the ask-for-asks request states them too", () => {
    const text = askForAsksText({ milestoneTitle: "M", milestoneId: "ms_1", path: "docs/x.md", spineTitle: "X", items: [], base: "http://c" });
    expect(text).toContain("Tier ask: ONLY irreversible data loss");
    expect(text).toContain("Tier do + tell");
  });

  it("an answer that is itself a question is a research task, in the wake, the ask-for-asks request and the DM section (M2-43b)", () => {
    expect(ASK_TYPE_RULES.join("\n")).toContain("answer to an ask is itself a question");
    for (const text of [
      protocolFor("archivist"),
      askForAsksText({ milestoneTitle: "M", milestoneId: "ms_1", path: "docs/x.md", spineTitle: "X", items: [], base: "http://c" }),
    ]) {
      expect(text).toContain("research it now");
      expect(text).toContain("Never leave the answer sitting");
    }
    expect(protocolFor("Delivery Manager")).toContain("whose answer is itself a question is yours to run");
    expect(protocolFor("infra-steward")).not.toContain("whose answer is itself a question is yours to run");
  });

  it("only the Delivery Manager gets the triage section", () => {
    const dm = protocolFor("Delivery Manager");
    expect(dm).toContain("G. Delivery Manager triage");
    expect(dm).toContain("answer it yourself");
    expect(dm).toContain("[answered <CODE> <YYYY-MM-DD> @Delivery-Manager]");
    expect(dm).toContain("answer: <what> — why: <reason> — rollback: <how to undo>");
    expect(dm).toContain("at most 3 ask-tier items");
    expect(dm).toContain("/api/waiting-on-owner?milestoneId=ms_1");
    expect(protocolFor("infra-steward")).not.toContain("G. Delivery Manager triage");
  });
});

describe("blocked needs an ask-tier code", () => {
  it("citedAskCodes reads bare, repo-qualified and lower-case codes", () => {
    expect(citedAskCodes("blocked: waits on T4-A3")).toEqual(["T4-A3"]);
    expect(citedAskCodes("waits on poly-maker/PLAN-10-A7 and INBOX-a1")).toEqual(["PLAN-10-A7", "INBOX-A1"]);
    expect(citedAskCodes("needs Sam's approval")).toEqual([]);
  });

  it("T8-S14: PATCH blocked without an open code is stored as monitoring (unknown or answered code too), the reported word kept", async () => {
    const { call } = setup();
    const { a } = await seed(call);
    for (const summary of ["needs Sam's approval to restart", "waits on INBOX-A9", /* answered */ "waits on INBOX-A2"]) {
      const run = (await call("POST", "/api/runs", { assignmentId: a.id })).json;
      const r = await call("PATCH", `/api/runs/${run.id}`, { outcome: "blocked", summary, endedAt: new Date().toISOString() });
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ outcome: "monitoring", reportedOutcome: "blocked", summary });
    }
  });

  it("PATCH blocked stays blocked citing an open ask code or with an open ask the run raised through the API; with only retryAt it is monitoring until then", async () => {
    const { call } = setup();
    const { m, a } = await seed(call);
    const r1 = (await call("POST", "/api/runs", { assignmentId: a.id })).json;
    const ok = await call("PATCH", `/api/runs/${r1.id}`, { outcome: "blocked", summary: "blocked: waits on Acme/INBOX-A1", endedAt: new Date().toISOString() });
    expect(ok.status).toBe(200);
    expect(ok.json.outcome).toBe("blocked");
    expect(ok.json.reportedOutcome).toBeUndefined();

    const r2 = (await call("POST", "/api/runs", { assignmentId: a.id })).json;
    monitored();
    const retry = new Date(Date.now() + 3_600_000).toISOString();
    const timed = (await call("PATCH", `/api/runs/${r2.id}`, { outcome: "blocked", summary: "needs the window", retryAt: retry })).json;
    expect(timed).toMatchObject({ outcome: "monitoring", reportedOutcome: "blocked", nextCheckAt: retry, retryAt: retry });

    const r3 = (await call("POST", "/api/runs", { assignmentId: a.id })).json;
    // the run raised its ask through the API (the raise log names the spine code; open or not is the spine's).
    createStore(db).logRaisedAsk({ runId: r3.id, milestoneId: m.id, question: "Drop the old archive (irreversible)?", proposedAction: "", by: "drive/INBOX-A1" });
    expect((await call("PATCH", `/api/runs/${r3.id}`, { outcome: "blocked", summary: "x" })).json.outcome).toBe("blocked");
    // a raised ask that is no longer open in the spine is no ask: monitoring
    const r4 = (await call("POST", "/api/runs", { assignmentId: a.id })).json;
    createStore(db).logRaisedAsk({ runId: r4.id, milestoneId: m.id, question: "Gone?", proposedAction: "", by: "drive/INBOX-A9" });
    expect((await call("PATCH", `/api/runs/${r4.id}`, { outcome: "blocked", summary: "x" })).json.outcome).toBe("monitoring");
  });

  it("T8-S14: a monitoring report is stored with nextCheckAt + until and asks for a timed wake at the next check", async () => {
    const { call } = setup();
    const { a } = await seed(call);
    await call("PATCH", `/api/assignments/${a.id}`, { enabled: true });
    const run = (await call("POST", "/api/runs", { assignmentId: a.id })).json;
    monitored();
    const next = new Date(Date.now() + 6 * 3_600_000).toISOString();
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const r = await call("PATCH", `/api/runs/${run.id}`, { outcome: "monitoring", summary: "7-day hold; next: archiver delete proof", nextCheckAt: next, until, endedAt: new Date().toISOString() });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ outcome: "monitoring", nextCheckAt: next, until });
    expect(r.json.reportedOutcome).toBeUndefined();
    expect((await call("GET", `/api/assignments/${a.id}`)).json.retryAt).toBe(next);
    // POST with blocked and no code: monitoring too
    const posted = await call("POST", "/api/runs", { assignmentId: a.id, outcome: "blocked", summary: "waits for DNS" });
    expect(posted.json).toMatchObject({ outcome: "monitoring", reportedOutcome: "blocked" });
  });

  it("other outcomes are never gated", async () => {
    const { call } = setup();
    const { a } = await seed(call);
    const run = (await call("POST", "/api/runs", { assignmentId: a.id })).json;
    expect((await call("PATCH", `/api/runs/${run.id}`, { outcome: "progressed", summary: "restarted the relay, recorded the decision" })).status).toBe(200);
  });
});

describe("FYI cards: asks a persona answered for Sam", () => {
  const list = async (call: ReturnType<typeof setup>["call"], q = "") => (await call("GET", `/api/waiting-on-owner${q}`)).json as any[];

  it("parses @persona answered lines (the tag keeps the persona as who)", () => {
    const asks = parseAsks(SPINE, "docs/spines/root.md");
    expect(asks.map((a) => [a.code, a.who, a.state])).toEqual([
      ["INBOX-A1", "Sam", "open"],
      ["INBOX-A2", "Delivery-Manager", "answered"],
      ["INBOX-A3", "Sam", "answered"],
      ["INBOX-A4", "steward", "answered"],
    ]);
    expect(asks[1].answer).toBe("restarted");
    expect(asks[3].doneAt).toBe("2026-10-22");
  });

  it("lists a persona-answered, not-done line as an answered item with decidedBy; Sam's own answers and done lines are not FYI", async () => {
    const { call } = setup();
    const { m } = await seed(call);
    const items = await list(call, `?milestoneId=${m.id}`);
    const fyi = items.filter((i) => i.decidedBy);
    expect(fyi).toHaveLength(1);
    expect(fyi[0]).toMatchObject({ source: "ask", code: "INBOX-A2", state: "answered", decidedBy: "Delivery-Manager", answer: "restarted", decidable: false });
    // INBOX-A4 (persona line marked done) is consumed: not an FYI. INBOX-A3 was the owner's own answer.
    expect(items.some((i) => i.code === "INBOX-A4")).toBe(false);
    expect(items.find((i) => i.code === "INBOX-A3")?.decidedBy).toBeUndefined();
    // Not counted as waiting: the only open item is the owner's INBOX-A1 (web counts structured && state open).
    const waiting = items.filter((i) => i.source !== "heuristic" && i.state === "open");
    expect(waiting.map((i) => i.code)).toEqual(["INBOX-A1"]);
  });

  it("Reverse (respond kind answer on the FYI item) sends the owner a reversal; approve/deny are refused; no spine rewrite", async () => {
    const { call } = setup();
    const { m, a } = await seed(call);
    const fyi = (await list(call, `?milestoneId=${m.id}`)).find((i) => i.decidedBy)!;
    expect((await call("POST", `/api/waiting-on-owner/${fyi.id}/respond`, { kind: "approve", milestoneId: m.id })).status).toBe(400);
    const r = await call("POST", `/api/waiting-on-owner/${fyi.id}/respond`, { kind: "answer", text: "Reverse this decision: roll it back.", milestoneId: m.id });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ kind: "answer", delivery: "sent", assignmentId: a.id });
    expect(r.json.spine).toBeUndefined();
    const msg = t3.ops("launchThread")[0].args.message as string;
    expect(msg).toContain("INBOX-A2: Sam REVERSES the decision Delivery-Manager took");
    expect(msg).toContain("Sam's answer: Reverse this decision: roll it back.");
    expect(msg).toContain("rollback");
    // The spine line is untouched, and the card now carries the response.
    expect(fs.readFileSync(path.join(reposRoot, "drive/docs/spines/root.md"), "utf8")).toBe(SPINE);
    const after = (await list(call, `?milestoneId=${m.id}`)).find((i) => i.id === fyi.id);
    expect(after.response).toMatchObject({ kind: "answer", delivery: "sent" });
    expect(after.state).toBe("answered");
  });
});
