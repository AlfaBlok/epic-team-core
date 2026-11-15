import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { Milestone } from "../src/store.js";
import { resolveSkillDir, spinesPyRunner } from "../src/adapters/spines.js";
import type { ReadConfig } from "../src/routes/read.js";
import type { T3Client, T3MessagePage, T3ThreadMessage } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import { MILESTONE_SEED_VERSION, milestoneEndpointLines, milestoneUpdateMessage } from "../src/desk/milestoneChat.js";
import { claimsSection, rowOf } from "../src/desk/dispatch.js";

/** the repo desk dispatches from its chat through the console (parent + child runs); the child run is the claim. */

const PAGE = { "Sec-Fetch-Site": "same-origin" };
const BASE = "http://console.test";
const chatOf = (id: string) => ({ "X-Console-Run": `milestone-chat:${id}` });
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
const put = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

class FakeT3 implements T3Client {
  calls: { op: string; args: any }[] = [];
  threads = new Map<string, { messages: T3ThreadMessage[] }>();
  private n = 0;
  private pos = 0;
  ops = (op: string) => this.calls.filter((c) => c.op === op);
  private push(threadId: string, role: "user" | "assistant", text: string) {
    this.threads.get(threadId)?.messages.push({ itemId: `item_${++this.pos}`, position: this.pos * 2, role, text, status: "completed", truncated: false, updatedAt: new Date().toISOString() });
  }
  async listProjects() {
    return [{ id: "p_demo", title: "demo", workspaceRoot: "/x/demo", repositoryIdentity: { displayName: "acme/demo" } }];
  }
  async listScheduledTasks() {
    return [];
  }
  async updateScheduledTask() {
    return undefined;
  }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread(input: any) {
    this.calls.push({ op: "launchThread", args: input });
    const threadId = `thread_${++this.n}`;
    this.threads.set(threadId, { messages: [] });
    if (input.message) this.push(threadId, "user", input.message);
    return { threadId };
  }
  async sendToThread(threadId: string, message: string, clientRequestId?: string, mode?: string) {
    this.calls.push({ op: "sendToThread", args: { threadId, message, clientRequestId, mode } });
    this.push(threadId, "user", message);
  }
  async readThreadStatus() {
    return { status: "running", raw: {} };
  }
  async interruptThread(threadId: string, reason?: string) {
    this.calls.push({ op: "interruptThread", args: { threadId, reason } });
  }
  async readThreadMessages(threadId: string, opts: { afterPosition?: number; limit?: number } = {}): Promise<T3MessagePage> {
    const all = (this.threads.get(threadId)?.messages ?? []).filter((m) => opts.afterPosition === undefined || m.position > opts.afterPosition);
    const page = all.slice(0, opts.limit ?? 100);
    return { messages: page, nextPosition: page.length ? page[page.length - 1].position : (opts.afterPosition ?? null), hasMore: all.length > page.length, archived: false };
  }
}

const spine = (title: string, id: string, parent: string, extra = "", n = 1) => `# ${title}

Spine profile: compact
Spine ID: ${id}
Primary document: docs/spines/${id}.md
Root spine: ${parent === "none" ? "self" : "[demo](root.md)"}
Parent spine: ${parent}
Integration branch: main
Integration policy: main-direct

## Goal

Ship ${title}.

## Current State

Owner: Delivery manager
Status: active
Waiting on: none
Next action: build

${extra}
## Issue Ledger

| Issue | Role | Owner / Assignment | Title | Status | Depends On |
|---|---|---|---|---|---|
| E${n}-S1 | Ticket worker | Builder | First thing | ready | none |

## Decisions

None.
`;
const askIn = (code: string) => `## Waiting on\n\n- [ask ${code}: decide @Sam since 2026-10-20] One logger or two? — options: one | two — recommend: one\n`;


describe("T19-S5 pieces", () => {
  it("reads the row a child run works on from its summary", () => {
    expect(rowOf("T19-S5 chat dispatch")).toBe("T19-S5");
    expect(rowOf("N10-6: fix")).toBe("N10-6");
    expect(rowOf("Woke on cadence")).toBeUndefined();
  });
  it("the endpoint list carries the chat dispatch and the claims; the update carries the remit; the version moved to 3", () => {
    expect(MILESTONE_SEED_VERSION).toBeGreaterThanOrEqual(3);
    const lines = milestoneEndpointLines(BASE, { id: "m_x" }).join("\n");
    expect(lines).toContain(`${BASE}/api/milestones/m_x/chat/dispatch`);
    expect(lines).toContain("409 `claimed`");
    expect(lines).toContain("root L-3");
    const up = milestoneUpdateMessage(BASE, { id: "m_x" }, "New remit: manage on request.");
    expect(up).toContain(`[repo-desk update] v${MILESTONE_SEED_VERSION}`);
    expect(up).toContain("New remit: manage on request.");
    expect(claimsSection([])).toBeUndefined();
  });
  it("the remit file drops 'never dispatch' and says it never writes code", () => {
    const remit = fs.readFileSync(path.join(__dirname, "../../../../docs/personas/repo-desk.md"), "utf8");
    expect(remit).not.toMatch(/never build, dispatch workers, verify, integrate/);
    expect(remit).toContain("never write code yourself");
    expect(remit).toContain("/chat/dispatch");
  });
});

const skillDir = resolveSkillDir(process.env);

describe.skipIf(!skillDir)("T19-S5 dispatch from a milestone chat through the API", () => {
  let tmp: string;
  let db: DB;
  let t3: FakeT3;
  let picks: number;
  let dones: string[];
  const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };

  beforeEach(() => {
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e19s5-"));
    const origin = path.join(tmp, "origin.git");
    git(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
    const seed = path.join(tmp, "seed");
    git(tmp, ["clone", "-q", origin, seed]);
    git(seed, ["checkout", "-q", "-b", "main"]);
    put(seed, "docs/spines/root.md", spine("PLAN-1: Demo", "root", "none", "", 1).replace("## Issue Ledger", "## Spine Map\n\n| Spine | Status |\n|---|---|\n| [lower](lower.md) | active |\n| [side](side.md) | active |\n\n## Issue Ledger"));
    put(seed, "docs/spines/lower.md", spine("PLAN-2: Lower", "lower", "[demo](root.md)", "", 2).replace("| none |\n", "| none |\n| T2-S2 | Ticket worker | Builder | Second thing | ready | none |\n"));
    put(seed, "docs/spines/side.md", spine("PLAN-3: Side", "side", "[demo](root.md)", "", 3));
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-q", "-m", "seed"]);
    git(seed, ["push", "-q", "origin", "main"]);
    git(tmp, ["clone", "-q", origin, path.join(tmp, "demo")]);
    db = openDb(path.join(tmp, "console.db"));
    t3 = new FakeT3();
    picks = 0;
    dones = [];
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_SYSTEM", saved.s]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const boot = async () => {
    const read: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [], skillDir, spines: spinesPyRunner(skillDir!) };
    const dispatcher = {
      pick: async () => (picks++, { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }),
      done: async (seat: string) => void dones.push(seat),
    } as unknown as Dispatcher;
    const app = createApp(db, { read, cycle: { enabled: true, t3, dispatcher, publicUrl: BASE, seatsFile: path.join(tmp, "seats.json"), runState: async () => undefined } });
    const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await app.request(url, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : undefined, text };
    };
    const dm = (await call("POST", "/api/personas", { name: "Delivery manager", remit: "You manage.", model: "sonnet" })).json;
    const mk = async (title: string, p: string) => {
      const m = (await call("POST", "/api/milestones", { title, repo: "Acme/demo", path: p })).json;
      const a = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: dm.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: false })).json;
      return { m, a };
    };
    const root = await mk("Root", "docs/spines/root.md");
    const lower = await mk("Lower", "docs/spines/lower.md");
    const side = await mk("Side", "docs/spines/side.md");
    return { call, root, lower, side };
  };
  const dispatch = (x: Awaited<ReturnType<typeof boot>>, mid: string, body: object, h: Record<string, string>) => x.call("POST", `/api/milestones/${mid}/chat/dispatch`, body, h);

  it("creates a parent run on the chat's Repo desk assignment and a child run per worker, on the right milestone", async () => {
    const x = await boot();
    const L = chatOf(x.lower.m.id);
    await x.call("POST", `/api/milestones/${x.lower.m.id}/chat/messages`, { text: "build T2-S1 and T2-S2" }, PAGE);
    const one = await dispatch(x, x.lower.m.id, { ticket: "T2-S1", summary: "first thing" }, L);
    expect(one.status, one.text).toBe(201);
    expect(one.json).toMatchObject({ seat: "seat1", providerInstanceId: "claudeAgent_seat1", dryRun: false });
    expect(one.json.briefRules).toHaveLength(5);
    expect(one.json.steps.join("\n")).toContain(`Run: ${one.json.childRunId}`);
    const parent = (await x.call("GET", `/api/runs/${one.json.parentRunId}`)).json;
    const child = (await x.call("GET", `/api/runs/${one.json.childRunId}`)).json;
    expect(parent).toMatchObject({ milestoneId: x.lower.m.id, outcome: "progressed" });
    expect(parent.parentRunId).toBeUndefined();
    expect(parent.endedAt).toBeTruthy();
    expect(parent.threadId).toBe(t3.ops("launchThread")[0].args && [...t3.threads.keys()][0]);
    expect(child).toMatchObject({ milestoneId: x.lower.m.id, parentRunId: parent.id, seat: "seat1", outcome: "running", summary: "T2-S1 first thing", assignmentId: parent.assignmentId });
    // the parent sits on the milestone's Repo desk assignment, switched off (it never wakes on its own)
    const asg = (await x.call("GET", `/api/assignments?milestoneId=${x.lower.m.id}`)).json as any[];
    const desk = asg.find((a) => a.id === parent.assignmentId);
    expect(desk.enabled).toBe(false);
    const personas = (await x.call("GET", "/api/personas")).json as any[];
    expect(personas.find((p) => p.id === desk.personaId).name).toBe("Repo desk");
    // a second worker of the same request reuses the parent; a child PATCHed on return
    const two = await dispatch(x, x.lower.m.id, { ticket: "T2-S2", summary: "second thing", parentRunId: parent.id }, L);
    expect(two.status, two.text).toBe(201);
    expect(two.json.parentRunId).toBe(parent.id);
    expect((await x.call("GET", `/api/runs?parentRunId=${parent.id}`)).json).toHaveLength(2);
    expect((await x.call("PATCH", `/api/runs/${two.json.childRunId}`, { threadId: "thread_child" })).status).toBe(200);
    expect((await x.call("PATCH", `/api/runs/${two.json.childRunId}`, { outcome: "progressed", summary: "T2-S2 merged", endedAt: new Date().toISOString() })).status).toBe(200);
    expect(picks).toBe(3); // the chat thread's launch picks (and releases) one too
    expect((await x.call("GET", `/api/runs?milestoneId=${x.root.m.id}`)).json).toHaveLength(0);
    // a root chat dispatches for a lower milestone of its tree
    expect((await dispatch(x, x.side.m.id, { ticket: "T3-S1", summary: "side work", dryRun: true }, chatOf(x.root.m.id))).status).toBe(201);
  });

  it("refuses out of scope (sibling, parent, a spine outside the tree), non-chat callers and a bad parent; nothing recorded, no seat picked", async () => {
    const x = await boot();
    const L = chatOf(x.lower.m.id);
    for (const [mid, body] of [[x.side.m.id, {}], [x.root.m.id, {}], [x.root.m.id, { path: "docs/spines/side.md" }]] as const) {
      const r = await dispatch(x, mid, { ticket: "T3-S1", summary: "x", ...body }, L);
      expect(r.status).toBe(403);
      expect(r.json.error.code).toBe("out_of_scope");
    }
    expect((await dispatch(x, x.lower.m.id, { ticket: "T2-S1", summary: "x" }, PAGE)).json.error.code).toBe("chat_only");
    expect((await dispatch(x, x.lower.m.id, { ticket: "T2-S1", summary: "x" }, { "X-Console-Run": "team-desk" })).status).toBe(403);
    expect((await dispatch(x, x.lower.m.id, { ticket: "not a row", summary: "x" }, L)).status).toBe(400);
    expect((await dispatch(x, x.lower.m.id, { ticket: "T2-S1", summary: "x", parentRunId: "run_nope" }, L)).json.error.code).toBe("bad_parent");
    expect((await dispatch(x, "m_nope", { ticket: "T2-S1", summary: "x" }, L)).status).toBe(404);
    expect(picks).toBe(0);
    for (const m of [x.root.m, x.lower.m, x.side.m]) expect((await x.call("GET", `/api/runs?milestoneId=${m.id}`)).json).toHaveLength(0);
  });

  it("dry run: parent + child without a seat; closed by the desk", async () => {
    const x = await boot();
    const r = await dispatch(x, x.lower.m.id, { ticket: "T2-S1", summary: "prove the shape", dryRun: true }, chatOf(x.lower.m.id));
    expect(r.status, r.text).toBe(201);
    expect(r.json).toMatchObject({ seat: null, providerInstanceId: null, dryRun: true });
    expect(picks).toBe(0);
    const child = (await x.call("GET", `/api/runs/${r.json.childRunId}`)).json;
    expect(child.summary).toContain("[dry run: no worker started]");
    expect(child.parentRunId).toBe(r.json.parentRunId);
    expect((await x.call("PATCH", `/api/runs/${child.id}`, { outcome: "progressed", summary: "dry run closed", endedAt: new Date().toISOString() })).status).toBe(200);
  });

  it("the child run is the claim: the DM's wake lists the desk's row as claimed, and the chat cannot take a row the DM's worker runs", async () => {
    const x = await boot();
    const L = chatOf(x.lower.m.id);
    const mine = await dispatch(x, x.lower.m.id, { ticket: "T2-S1", summary: "first thing" }, L);
    expect(mine.status).toBe(201);
    // the same row again from any chat of the repo: claimed
    const again = await dispatch(x, x.root.m.id, { ticket: "T2-S1", summary: "again", path: "docs/spines/lower.md" }, chatOf(x.root.m.id));
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("claimed");
    expect(again.json.error.message).toContain("Repo desk");

    // the DM's scheduled wake on the lower milestone shows it claimed by the Repo desk
    db.prepare("UPDATE assignments SET enabled = 1 WHERE id = ?").run(x.lower.a.id);
    const wake = await x.call("POST", `/api/assignments/${x.lower.a.id}/wake?format=json`, {});
    expect(wake.status, wake.text).toBe(200);
    expect(wake.json.prompt).toContain("## Rows in flight (claimed)");
    expect(wake.json.prompt).toContain(`- T2-S1 — claimed by Repo desk (child run ${mine.json.childRunId}`);
    expect(wake.json.prompt).toContain("root L-3");
    const claims = (await x.call("GET", `/api/milestones/${x.root.m.id}/claims`)).json;
    expect(claims.claims.map((c: any) => c.ticket)).toEqual(["T2-S1"]);

    // vice versa: the DM's worker on claims it; the desk is refused and the seat untouched
    await x.call("POST", "/api/runs", { assignmentId: x.lower.a.id, parentRunId: wake.json.run.id, seat: "seat2", outcome: "running", summary: "T2-S2 second thing" });
    const theirs = await dispatch(x, x.lower.m.id, { ticket: "T2-S2", summary: "second thing" }, L);
    expect(theirs.status).toBe(409);
    expect(theirs.json.error.message).toContain("Delivery manager");
    expect(picks).toBe(1);
    // once the desk's worker returns, the row is free again
    await x.call("PATCH", `/api/runs/${mine.json.childRunId}`, { outcome: "progressed", summary: "T2-S1 done", endedAt: new Date().toISOString() });
    expect((await x.call("GET", `/api/milestones/${x.lower.m.id}/claims`)).json.claims.map((c: any) => c.ticket)).toEqual(["T2-S2"]);
  });
});
