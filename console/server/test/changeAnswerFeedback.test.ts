import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { changeAnswer } from "../src/inbox/spineWrite.js";
import type { ReadConfig } from "../src/routes/read.js";
import type { T3Client } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
// this file checks the text with our own owner's name (src/identity.ts; the suite's owner is neutral, hostedSetup.ts)

/**
 * on 2026-11-09 02:37Z the owner pressed Change answer three times on an approve ask he had approved and got 409
 * each time: the answered line had lost its ask kind, so the card offered a plain answer box, and the server read his words
 * on an approve ask as feedback and refused any change to feedback. Now a change to his words on an approved ask goes
 * through as feedback (the [feedback] line, the row reopened, the asker woken), and the answered card keeps its ask kind.
 */

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


const ANSWERED = "- [answered T9-A2 2026-11-08 @Sam] Approve the two mockups? — recommend: yes — context: notes.md — answer: APPROVED";

describe("changeAnswer(feedback)", () => {
  it("rewrites the [answered … APPROVED] line as his [feedback] line and reopens the row the ask named", () => {
    const e = changeAnswer(spine("active", [ANSWERED]), { id: "x", source: "ask", question: "Approve the two mockups?", code: "T9-A2", row: "T5" }, "simpler, one logo", "2026-11-09", "Sam", true);
    expect(e.how).toBe("rewrite");
    if (e.how !== "rewrite") return;
    expect(e.text).toContain("- [feedback T9-A2 2026-11-09 @Sam] Approve the two mockups? — recommend: yes — context: notes.md — feedback: simpler, one logo\n");
    expect(e.text).not.toContain("APPROVED");
    expect(e.reopened).toEqual({ row: "T5", was: "done (fed T9-A2)" });
    expect(e.text).toContain("| T5 | Mockups and logos | Sam go | active (feedback T9-A2 by Sam 2026-11-09, round 2: simpler, one logo) |");
  });
  it("a plain change still rewrites the answer in place and reopens nothing", () => {
    const e = changeAnswer(spine("active", [ANSWERED]), { id: "x", source: "ask", question: "Approve the two mockups?", code: "T9-A2", row: "T5" }, "DENIED", "2026-11-09");
    expect(e.how === "rewrite" && e.text).toContain("[answered T9-A2 2026-11-09 @Sam] Approve the two mockups? — recommend: yes — context: notes.md — answer: DENIED");
    expect(e.how === "rewrite" && e.reopened).toBeFalsy();
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

describe("API: Change answer on an approved ask", () => {
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
  const approved = async (call: Call) => {
    const { m, dm } = await seed(call);
    const a2 = (await items(call, m.id)).find((i) => i.code === "T9-A2");
    const r = await call("POST", `/api/waiting-on-owner/${a2.id}/respond`, { kind: "approve", text: "", milestoneId: m.id, wake: false });
    expect(r.json).toMatchObject({ kind: "approve", spine: { status: "written" } });
    return { m, dm, r: r.json };
  };

  it("the answered card keeps its ask kind (approve), so Change answer offers Changes wanted, not a plain answer box", async () => {
    const { call } = setup();
    const { m } = await approved(call);
    const card = (await call("GET", `/api/waiting-on-owner?milestoneId=${m.id}&includeSuperseded=true`)).json.find((i: any) => i.code === "T9-A2");
    expect(card).toMatchObject({ state: "answered", ask: "approve", response: { kind: "approve" } });
  });

  for (const kind of ["answer", "feedback"] as const) {
    it(`Change answer on an approved ask to his words (${kind}): goes through as feedback, the row reopens, the asker hears the approval no longer stands`, async () => {
      const { call } = setup();
      const { m, dm, r } = await approved(call);
      const c = await call("POST", `/api/owner-responses/${r.id}/change`, { kind, text: "simpler, one logo" });
      expect(c.status).toBe(201);
      expect(c.json).toMatchObject({ kind: "feedback", replacesId: r.id, spine: { status: "written" } });
      const text = file();
      expect(text).toMatch(/- \[feedback T9-A2 \d{4}-\d\d-\d\d @Sam\] Approve the two mockups\? .* — feedback: simpler, one logo/);
      expect(text).not.toContain("[answered T9-A2");
      expect(text).toMatch(/\| T5 \| Mockups and logos \| Sam go \| active \(feedback T9-A2 by Sam \d{4}-\d\d-\d\d, round 2: simpler, one logo\) \|/);
      expect(git(repo, ["log", "-1", "--format=%s"])).toBe("Feedback T9-A2: changes wanted, not approved (Sam, via console)");
      expect(c.json.wake).toMatchObject({ notified: "woken", assignmentId: dm.id });
      const run = (await runsOf(call, dm.id)).find((x) => x.id === c.json.wake.runId);
      expect(run.instructions).toContain('He changed his earlier answer ("APPROVED") to this feedback');
      expect(run.instructions).toContain("Row T5 is active again");
      // the card now reads as feedback: no second change (the next round answers it)
      const card = (await call("GET", `/api/waiting-on-owner?milestoneId=${m.id}&includeSuperseded=true`)).json.find((i: any) => i.code === "T9-A2");
      expect(card).toMatchObject({ state: "answered", feedback: true, response: { kind: "feedback" } });
      expect((await call("POST", `/api/owner-responses/${c.json.id}/change`, { kind: "approve", text: "" })).status).toBe(409);
    });
  }

  it("Changes wanted needs his words; Approve stays the answer already given", async () => {
    const { call } = setup();
    const { r } = await approved(call);
    expect((await call("POST", `/api/owner-responses/${r.id}/change`, { kind: "feedback", text: " " })).status).toBe(400);
    expect((await call("POST", `/api/owner-responses/${r.id}/change`, { kind: "approve", text: "" })).status).toBe(400);
    expect(file()).toContain("— answer: APPROVED");
  });
});
