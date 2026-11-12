import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { answerWakeMessage, askerAt } from "../src/inbox/asker.js";
import { parseAsks } from "../src/inbox/asks.js";
import { applyAnswer, feedbackCell, flipAskLine } from "../src/inbox/spineWrite.js";
import { denyCell } from "../src/review/rows.js";
import { answeredSection, type Tree } from "../src/adapters/tree.js";
import { answerWord, outcomeKind } from "../src/inbox/routes.js";
import type { ReadConfig } from "../src/routes/read.js";
import type { T3Client } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
// this file checks the text with our own owner's name (src/identity.ts; the suite's owner is neutral, hostedSetup.ts)

/** feedback is never approval. Three outcomes; feedback reopens the row and wakes the builder;'s misroute. */

const A2 = "- [ask T9-A2: approve @Sam since 2026-10-20 row T5] Approve the two mockups? — recommend: yes — context: notes.md";
const spine = (status: string, asks: string[], t5 = "done (fed T9-A2)") => `# PLAN-9: Inbox spine

Spine ID: inbox-root
Integration policy: main-direct

## Current State

Status: ${status}
Waiting on: Sam: T9-A2

## Waiting on

${asks.join("\n")}

## Issue Ledger

| Issue | Title | Needs | Status |
|---|---|---|---|
| T4 | Pick the logger layout | Sam | blocked |
| T5 | Mockups and logos | Sam go | ${t5} |
`;

// ---------- pure ----------

describe("the [feedback] line", () => {
  it("flipAskLine writes [feedback CODE date @Sam] … — feedback: his words; an approval stays [answered]", () => {
    expect(flipAskLine(A2, "another iteration, simpler", "2026-11-03", "Sam", true)).toBe(
      "- [feedback T9-A2 2026-11-03 @Sam] Approve the two mockups? — recommend: yes — context: notes.md — feedback: another iteration, simpler",
    );
    expect(flipAskLine(A2, "APPROVED", "2026-11-03")).toMatch(/^- \[answered T9-A2 2026-11-03 @Sam\] .* — answer: APPROVED$/);
  });

  it("applyAnswer(feedback): flips the line, drops the code from Waiting on and reopens the row the ask names", () => {
    const e = applyAnswer(spine("active", [A2]), { id: "x", source: "ask", question: "Approve the two mockups?", code: "T9-A2", row: "T5" }, "another iteration", "2026-11-03", "Sam", true);
    expect(e.how).toBe("flip");
    if (e.how !== "flip") return;
    expect(e.reopened).toEqual({ row: "T5", was: "done (fed T9-A2)" });
    expect(e.text).toContain("| T5 | Mockups and logos | Sam go | active (feedback T9-A2 by Sam 2026-11-03, round 2: another iteration) |");
    expect(e.text).toContain("Waiting on: nobody");
    expect(e.text).toContain("[feedback T9-A2 2026-11-03 @Sam]");
    // an approval reopens nothing
    const a = applyAnswer(spine("active", [A2]), { id: "x", source: "ask", question: "Approve the two mockups?", code: "T9-A2", row: "T5" }, "APPROVED", "2026-11-03");
    expect(a.how === "flip" && a.reopened).toBeFalsy();
    expect(a.how === "flip" && a.text).toContain("| T5 | Mockups and logos | Sam go | done (fed T9-A2) |");
  });

  it("feedbackCell counts rounds, keeps his words to one cell line (no pipes, no parentheses) and is idempotent", () => {
    expect(feedbackCell("T9-A3", "2026-11-04", "again (smaller) | please")("active (feedback T9-A2 by Sam 2026-11-03, round 2: x)")).toBe(
      "active (feedback T9-A3 by Sam 2026-11-04, round 3: again [smaller] / please)",
    );
    expect(feedbackCell("T9-A2", "2026-11-03", "x")("active (feedback T9-A2 by Sam 2026-11-03, round 2: x)")).toEqual({ skip: expect.any(String) });
  });

  it("parseAsks reads [feedback …] as answered (not waiting on Sam), flagged feedback, his words as the answer", () => {
    const [a] = parseAsks(spine("active", ["- [feedback T9-A2 2026-11-03 @Sam] Approve the two mockups? — feedback: simpler please"]));
    expect(a).toMatchObject({ code: "T9-A2", state: "answered", feedback: true, answer: "simpler please", since: "2026-11-03" });
    const [d] = parseAsks(spine("active", ["- [feedback T9-A2 2026-11-03 @Sam] Approve? — feedback: simpler · done 2026-11-04 abc1234"]));
    expect(d).toMatchObject({ feedback: true, doneAt: "2026-11-04", doneSha: "abc1234" });
  });

  it("free text on an approve ask is feedback, never an approval; elsewhere an answer stays an answer", () => {
    expect(outcomeKind({ source: "ask", ask: "approve" }, "answer")).toBe("feedback");
    expect(outcomeKind({ source: "ask", ask: "approve" }, "approve")).toBe("approve");
    expect(outcomeKind({ source: "ask", ask: "provide" }, "answer")).toBe("answer");
    expect(outcomeKind({ source: "ask", ask: "approve", decidedBy: "Unblocker" }, "answer")).toBe("answer");
    expect(answerWord("feedback", "simpler")).toBe("FEEDBACK, changes wanted, not approved — simpler");
  });

  it("the wake note says feedback, not approval, names the row reopened and asks for a new round", () => {
    const msg = answerWakeMessage({ item: { code: "T9-A2", path: "docs/spines/root.md", row: "T5" }, answer: "simpler", repo: "inbox", sha: "0123456789abcdef", feedback: true });
    expect(msg).toMatch(/^Sam gave feedback on T9-A2 \(inbox\/docs\/spines\/root\.md\): "simpler"\. This is NOT an approval/);
    expect(msg).toContain("Row T5 is active again");
    expect(msg).toContain("NEW ask");
    expect(msg).toContain("the [feedback] line is commit 0123456789ab");
  });

  it("the wake prompt lists a feedback line as changes wanted", () => {
    const t = { asks: { "docs/spines/root.md": parseAsks(spine("active", ["- [feedback T9-A2 2026-11-03 @Sam] Approve? — feedback: simpler"])) } } as unknown as Tree;
    const out = answeredSection(t).join("\n");
    expect(out).toContain("FEEDBACK (changes wanted, NOT approved): simpler");
    expect(out).toContain("never an approval");
  });

  it("Deny on a review card closes the row as superseded (denied), never done", () => {
    expect(denyCell("T5", "2026-11-03", "not needed (now)")("review")).toBe("superseded (denied by Sam 2026-11-03: not needed [now])");
    expect(denyCell("T5", "2026-11-03", "")("review")).toBe("superseded (denied by Sam 2026-11-03)");
    expect(denyCell("T5", "2026-11-03", "")("active")).toEqual({ skip: expect.any(String) });
  });
});

describe("askerAt: T65-A1 replay (a live run beats a grace window; the Unblocker never asks)", () => {
  const store = createStore(openDb(":memory:"));
  const m = store.createMilestone({ title: "M6", repo: "r", path: "p", owner: "", paused: false });
  const dm = store.createPersona({ name: "Delivery Manager", remit: "x", skills: [], model: "opus", mayWrite: false });
  const ub = store.createPersona({ name: "Unblocker", remit: "x", skills: [], model: "opus", mayWrite: false });
  const b = store.createPersona({ name: "Builder", remit: "x", skills: [], model: "sonnet", mayWrite: false });
  const aDm = store.createAssignment({ milestoneId: m.id, personaId: dm.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true });
  const aUb = store.createAssignment({ milestoneId: m.id, personaId: ub.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true });
  const aB = store.createAssignment({ milestoneId: m.id, personaId: b.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true });
  // the real runs of 2026-11-03: DM worker run_72349652 (16:51:38 – 17:48:02) wrote the line at 17:47:23;
  // Unblocker run_aa7c603f ran 17:43:53 – 17:44:20 (inside its 10 min grace at 17:47:23, and it started later)
  store.createRun({ assignmentId: aDm.id, outcome: "blocked", startedAt: "2026-11-03T16:51:38.708Z", endedAt: "2026-11-03T17:48:02.581Z", summary: "blocked: waits on T65-A1" });
  store.createRun({ assignmentId: aUb.id, outcome: "idle", startedAt: "2026-11-03T17:43:53.791Z", endedAt: "2026-11-03T17:44:20Z", summary: "answered 0 · left 1" });

  it("the line's commit (17:47:23) goes to the Delivery Manager worker that was running, not the Unblocker", () => {
    expect(askerAt(store, m.id, "2026-11-03T17:47:23Z")).toMatchObject({ assignmentId: aDm.id, personaName: "Delivery Manager" });
  });
  it("the Unblocker is never the asker, even alone in the window", () => {
    expect(askerAt(store, m.id, "2026-11-03T17:44:00Z")?.assignmentId).toBe(aDm.id);
    store.createRun({ assignmentId: aUb.id, outcome: "idle", startedAt: "2026-11-03T20:00:00Z", endedAt: "2026-11-03T20:01:00Z", summary: "answered 0" });
    expect(askerAt(store, m.id, "2026-11-03T20:00:30Z")).toBeUndefined();
  });
  it("two grace-only windows: the latest start still wins (as before)", () => {
    store.createRun({ assignmentId: aB.id, outcome: "progressed", startedAt: "2026-11-03T18:00:00Z", endedAt: "2026-11-03T18:05:00Z", summary: "" });
    store.createRun({ assignmentId: aDm.id, outcome: "progressed", startedAt: "2026-11-03T17:59:00Z", endedAt: "2026-11-03T18:06:00Z", summary: "" });
    expect(askerAt(store, m.id, "2026-11-03T18:10:00Z")?.assignmentId).toBe(aB.id);
    // live at the time beats a later-started run already in its grace
    expect(askerAt(store, m.id, "2026-11-03T18:05:30Z")?.assignmentId).toBe(aDm.id);
  });
});

// ---------- API (temp repos only) ----------

let tmp: string;
let repo: string;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, args: string[], at?: string) =>
  execFileSync("git", args, { cwd, env: at ? { ...ENV, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : ENV, encoding: "utf8" }).trim();
const put = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const savedEnv = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };
const ASKED_AT = "2026-10-20T10:00:00.000Z";
const seedRepo = (status: string, t5?: string) => {
  const origin = path.join(tmp, "origin.git");
  git(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = path.join(tmp, "seed");
  git(tmp, ["clone", "-q", origin, seed]);
  git(seed, ["checkout", "-q", "-b", "main"]);
  put(seed, "docs/spines/root.md", spine(status, [A2], t5));
  put(seed, "docs/spines/notes.md", "# notes\n");
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "asks"], ASKED_AT);
  git(seed, ["push", "-q", "origin", "main"]);
  repo = path.join(tmp, "inbox");
  git(tmp, ["clone", "-q", origin, repo]);
};
beforeEach(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e67s1-"));
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

describe("API: Approve, Feedback, Deny on an ask", () => {
  let db: DB;
  const setup = (status = "active", t5?: string) => {
    seedRepo(status, t5);
    db = openDb(path.join(tmp, "console.db"));
    const t3 = new FakeT3();
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
    return { call, t3 };
  };
  afterEach(() => db?.close());
  type Call = ReturnType<typeof setup>["call"];
  const items = async (call: Call, mid: string) => (await call("GET", `/api/waiting-on-owner?milestoneId=${mid}`)).json as any[];
  const seed = async (call: Call) => {
    const m = (await call("POST", "/api/milestones", { title: "Inbox", repo: "Acme/inbox", path: "docs/spines/root.md" })).json;
    const dmP = (await call("POST", "/api/personas", { name: "Delivery Manager", remit: "runs it", model: "opus" })).json;
    const ubP = (await call("POST", "/api/personas", { name: "Unblocker", remit: "answers asks", model: "opus" })).json;
    const dm = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: dmP.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true })).json;
    const ub = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: ubP.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true })).json;
    // the DM's worker wrote the ask (09:00 – 10:01); an Unblocker wake ran 09:58 – 09:59 (inside its grace at 10:00)
    await call("POST", "/api/runs", { assignmentId: dm.id, outcome: "progressed", startedAt: "2026-10-20T09:00:00.000Z", endedAt: "2026-10-20T10:01:00.000Z" });
    await call("POST", "/api/runs", { assignmentId: ub.id, outcome: "idle", startedAt: "2026-10-20T09:58:00.000Z", endedAt: "2026-10-20T09:59:00.000Z", summary: "answered 0 · left 1" });
    return { m, dm, ub };
  };
  const file = () => {
    git(repo, ["pull", "-q", "--ff-only"]);
    return fs.readFileSync(path.join(repo, "docs/spines/root.md"), "utf8");
  };
  const runsOf = async (call: Call, assignmentId: string) => (await call("GET", `/api/runs?assignmentId=${assignmentId}`)).json as any[];

  it("Feedback: [feedback] line, the fed row back to active with his words, the Delivery Manager woken with a feedback note, never the Unblocker", async () => {
    const { call } = setup();
    const { m, dm, ub } = await seed(call);
    const a2 = (await items(call, m.id)).find((i) => i.code === "T9-A2");
    expect(a2.asker).toMatchObject({ assignmentId: dm.id, personaName: "Delivery Manager" });
    const r = await call("POST", `/api/waiting-on-owner/${a2.id}/respond`, { kind: "feedback", text: "another iteration, simpler", milestoneId: m.id });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ kind: "feedback", spine: { status: "written" } });
    const text = file();
    expect(text).toMatch(/- \[feedback T9-A2 \d{4}-\d\d-\d\d @Sam\] Approve the two mockups\? .* — feedback: another iteration, simpler/);
    expect(text).toMatch(/\| T5 \| Mockups and logos \| Sam go \| active \(feedback T9-A2 by Sam \d{4}-\d\d-\d\d, round 2: another iteration, simpler\) \|/);
    expect(text).not.toContain("[answered T9-A2");
    expect(git(repo, ["log", "-1", "--format=%s"])).toBe("Feedback T9-A2: changes wanted, not approved (Sam, via console)");
    expect(r.json.wake).toMatchObject({ notified: "woken", assignmentId: dm.id });
    const run = (await runsOf(call, dm.id)).find((x) => x.id === r.json.wake.runId);
    expect(run.instructions).toMatch(/^Sam gave feedback on T9-A2 .*: "another iteration, simpler"\. This is NOT an approval/);
    expect(run.instructions).toContain("Row T5 is active again");
    expect((await runsOf(call, ub.id)).filter((x) => x.instructionsBy === "Sam")).toEqual([]);
    // the card reads as feedback, not answered-done
    const after = (await call("GET", `/api/waiting-on-owner?milestoneId=${m.id}&includeSuperseded=true`)).json as any[];
    expect(after.find((i) => i.code === "T9-A2")).toMatchObject({ state: "answered", feedback: true, answer: "another iteration, simpler" });
  });

  it("free text on an approve ask is stored as feedback; empty feedback is refused", async () => {
    const { call } = setup();
    const { m } = await seed(call);
    const a2 = (await items(call, m.id)).find((i) => i.code === "T9-A2");
    expect((await call("POST", `/api/waiting-on-owner/${a2.id}/respond`, { kind: "feedback", text: "  ", milestoneId: m.id })).status).toBe(400);
    const r = await call("POST", `/api/waiting-on-owner/${a2.id}/respond`, { kind: "answer", text: "I still dislike it a little", milestoneId: m.id });
    expect(r.json.kind).toBe("feedback");
    expect(file()).toContain("— feedback: I still dislike it a little");
  });

  it("feedback wakes even when the epic reads review (his feedback is a start order)", async () => {
    const { call } = setup("review");
    const { m, dm } = await seed(call);
    const a2 = (await items(call, m.id)).find((i) => i.code === "T9-A2");
    const r = await call("POST", `/api/waiting-on-owner/${a2.id}/respond`, { kind: "feedback", text: "more", milestoneId: m.id });
    expect(r.json.wake).toMatchObject({ notified: "woken", assignmentId: dm.id });
  });

  it("Approve closes it as [answered … APPROVED]; the row is not reopened", async () => {
    const { call } = setup();
    const { m } = await seed(call);
    const a2 = (await items(call, m.id)).find((i) => i.code === "T9-A2");
    const r = await call("POST", `/api/waiting-on-owner/${a2.id}/respond`, { kind: "approve", text: "", milestoneId: m.id });
    expect(r.json.kind).toBe("approve");
    const text = file();
    expect(text).toMatch(/- \[answered T9-A2 \d{4}-\d\d-\d\d @Sam\] .* — answer: APPROVED/);
    expect(text).toContain("| T5 | Mockups and logos | Sam go | done (fed T9-A2) |");
  });

  it("Deny on any ask closes it as [answered … DENIED]", async () => {
    const { call } = setup();
    const { m } = await seed(call);
    const a2 = (await items(call, m.id)).find((i) => i.code === "T9-A2");
    const r = await call("POST", `/api/waiting-on-owner/${a2.id}/respond`, { kind: "deny", text: "not now", milestoneId: m.id });
    expect(r.status).toBe(201);
    expect(file()).toMatch(/- \[answered T9-A2 \d{4}-\d\d-\d\d @Sam\] .* — answer: DENIED - not now/);
  });

  it("feedback is never changed in place: the next round answers it", async () => {
    const { call } = setup();
    const { m } = await seed(call);
    const a2 = (await items(call, m.id)).find((i) => i.code === "T9-A2");
    const r = await call("POST", `/api/waiting-on-owner/${a2.id}/respond`, { kind: "feedback", text: "simpler", milestoneId: m.id });
    const c = await call("POST", `/api/owner-responses/${r.json.id}/change`, { kind: "approve", text: "" });
    expect(c.status).toBe(409);
  });
});

describe("T3 clone (found by T67-S1's live proof: a first wake on host3 could not clone)", () => {
  it("asks T3 for a GitHub clone over https, so owner/name resolves and no ssh host key is needed", async () => {
    const { McpT3Client } = await import("../src/t3/client.js");
    const c = new McpT3Client("http://127.0.0.1:1/mcp", "/dev/null", [0, 0]);
    const calls: unknown[][] = [];
    (c as unknown as { call: (...a: unknown[]) => Promise<unknown> }).call = async (...a: unknown[]) => (calls.push(a), { cwd: "/srv/agent/github/x" });
    expect(await c.cloneProject({ repository: "Acme/x", destinationPath: "/srv/agent/github/x" })).toEqual({ cwd: "/srv/agent/github/x" });
    expect(calls).toEqual([["t3_project_clone", { repository: "Acme/x", destinationPath: "/srv/agent/github/x", provider: "github", protocol: "https" }]]);
  });
});
