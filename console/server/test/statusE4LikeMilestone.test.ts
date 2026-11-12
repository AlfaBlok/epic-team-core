import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { CycleOptions } from "../src/cycle/service.js";
import type { T3Client } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
import type { ReadConfig } from "../src/routes/read.js";
import type { Tree, TreeNode } from "../src/adapters/tree.js";
import type { WaitingItem } from "../src/inbox/waiting.js";
import { AGENT_VERDICT } from "../src/adapters/outcome.js";
import { cachedRunner, spinesPyRunner } from "../src/adapters/spines.js";
import { asksToMark, itemsPhrase, milestoneStatus, outcomeOf, type StatusInput } from "../src/status/compute.js";
import { OUTCOME_RULE } from "../src/wakePrompt.js";

/**
 * the header said Accomplished + Needs you "1 question" while nothing was open.
 * An agent-written Verdict, a free-text "verify the Outcome" and an answered persona request must not contradict.
 */

const NOW = Date.parse("2026-10-25T12:00:00Z");
const node = (key: string, over: Partial<TreeNode> = {}, children: TreeNode[] = []): TreeNode => ({
  key, id: key.split("/").pop()!, kind: "ticket", title: key, status: "done", color: "green", children, flags: [], ...over,
});
const tree = (root: TreeNode): Tree => ({ milestoneId: "m1", root, counts: { grey: 0, blue: 0, yellow: 0, red: 0, green: 0 }, nonGreen: 0, closed: 0, flagged: 0, source: "spines", warnings: [] });
const E4_TREE = tree(node("m1", { kind: "spine", status: "active", color: "blue" }, [node("m1/S1")]));
const outcome = (closedBy: string | null) => ({ verdict: "accomplished", sentence: "One logger.", evidence: [{ doneMeans: "D1", links: ["x"] }], risk: null, closedAt: "2026-10-25", closedBy });
const VERIFY: WaitingItem = {
  id: "wj_8de1b672755f63b8", source: "heuristic", signal: "waiting_on", state: "open", repo: "poly-maker", milestoneId: "m1", milestoneTitle: "E4", nodeKey: "m1", title: "E4: One logger",
  ask: "unknown", question: "verify the Outcome and set Status done", detail: "Waiting on: Sam: verify the Outcome and set Status done (Mark in the console)", path: "docs/one-logger/E4-ONE-LOGGER.md", line: 5,
  contextLinks: [], owner: { kind: "none", label: "" }, decidable: false,
};
const input = (over: Partial<StatusInput> = {}): StatusInput => ({
  milestone: { id: "m1", paused: false }, status: "active", tree: E4_TREE, doneMeans: { done: 2, total: 2 }, outcome: outcome("run_d6cad26e-0000"), waiting: [VERIFY], runs: [], assignments: [], now: NOW, ...over,
});

describe("T13-S10 status of an E4-like milestone", () => {
  it("agent-written Verdict + Status active + 'verify the Outcome' → ready_to_mark, exactly 1 item, Needs you '1 to mark'", () => {
    const s = milestoneStatus(input());
    expect(s.outcome).toMatchObject({ word: "ready_to_mark", source: "derived", note: AGENT_VERDICT });
    expect(s.items.map((i) => [i.id, i.kind, i.state])).toEqual([["ready_to_mark:m1", "ready_to_mark", "open"]]);
    expect(s.needsYou).toBe(1);
    expect(s.flow).toMatchObject({ word: "needs_you", reason: "1 to mark" });
    expect(s.reasons.join(" ")).toContain(AGENT_VERDICT);
  });

  it("a console-marked spine still reads accomplished with 0 items (the stale verify line is not a question either)", () => {
    const s = milestoneStatus(input({ status: "done", outcome: outcome("Sam (console)"), tree: tree(node("m1", { kind: "spine" }, [node("m1/S1")])) }));
    expect(s.outcome).toEqual({ word: "accomplished", source: "outcome" });
    expect(s.items).toEqual([]);
    expect(s.needsYou).toBe(0);
  });

  it("marks made before the console mark (Status done, Closed by someone else) keep reading as before", () => {
    expect(outcomeOf({ status: "done", outcome: outcome("/root delivery manager (user decision)"), tree: tree(node("m1", { kind: "spine" })) }).word).toBe("accomplished");
  });

  it("an agent Verdict with goals still open under it reads not_yet, never accomplished or reopened", () => {
    const open = tree(node("m1", { kind: "spine", status: "active", color: "blue" }, [node("m1/E2", { kind: "spine", status: "active", color: "blue" })]));
    expect(outcomeOf({ status: "active", outcome: outcome("run_x"), tree: open })).toMatchObject({ word: "not_yet", note: expect.stringContaining(AGENT_VERDICT) });
  });

  it("'verify the Outcome' with an Outcome written but no verdict: the one ready_to_mark item, not a question", () => {
    const s = milestoneStatus(input({ outcome: { ...outcome(null), verdict: null }, doneMeans: { done: 1, total: 2 } }));
    expect(s.outcome.word).toBe("ready_to_mark");
    expect(s.items.map((i) => i.kind)).toEqual(["ready_to_mark"]);
  });

  it("without an Outcome section the free-text line is no item (T13-S14): a defect for the Delivery Manager", () => {
    const s = milestoneStatus(input({ outcome: null, doneMeans: { done: 1, total: 2 } }));
    expect(s.items.map((i) => i.kind)).not.toContain("free_text_ask");
    expect(s.needsYou).toBe(0);
    expect(s.defects?.map((d) => d.kind)).toEqual(["free_text"]);
  });

  it("header counts by kind; mark lines are recognised, other asks are not", () => {
    expect(itemsPhrase([{ kind: "ready_to_mark" }, { kind: "needs_jordi", ask: "approve" }, { kind: "free_text_ask", ask: "unknown" }, { kind: "ask", ask: "unknown" }])).toBe("1 to mark, 1 approval, 2 questions");
    for (const t of ["Sam: verify the Outcome and set Status done", "Sam to review and mark the outcome", "Sam: set Status to done", "Sam: accept the Outcome"]) expect(asksToMark({ title: "x", detail: t })).toBe(true);
    for (const t of ["Sam: approve the Deployer restore", "Sam: which region?", "Sam: review the outcome deck"]) expect(asksToMark({ title: "x", detail: t }), t).toBe(t.includes("outcome"));
  });

  it("the wake rule tells agents to remove an agent Verdict and not to restate the mark as Waiting on", () => {
    expect(OUTCOME_RULE).toMatch(/not `Closed: … by Sam` was written by an agent: remove it/);
    expect(OUTCOME_RULE).toMatch(/Never write Sam's mark as a `Waiting on:` line/);
  });
});

// ---------- through the API: status items = the tab's open items; the answered request is consumed ----------

const E4 = `# PLAN-4: One logger

Spine ID: PLAN-4
Root spine: self
Integration policy: main-direct

## Goal

One logger.

## Current State

Status: active
Phase: review
Waiting on: Sam: verify the Outcome and set Status done (Mark in the console)

## Done means

- [x] D1 one logger
- [x] D2 old logger removed

## Outcome

Verdict: accomplished
Outcome: One logger for every service.
Closed: 2026-10-25 by run_d6cad26e-0000
Risk: none

| Done means | Evidence |
|---|---|
| D1 one logger | abc1234 |
| D2 old logger removed | def5678 |

## Issue Ledger

| Issue | Title | Status |
|---|---|---|
| S1 | Build it | done |
`;
const MARKED = E4.replace("Status: active", "Status: done").replace(/Waiting on: .*/, "Waiting on: nothing").replace("by run_d6cad26e-0000", "by Sam (console)");

class FakeT3 implements T3Client {
  private n = 0;
  async listProjects() {
    return [{ id: "mcp:poly", title: "poly-maker", workspaceRoot: "/nowhere/poly-maker", repositoryIdentity: { displayName: "acme/poly-maker" } }];
  }
  async listScheduledTasks() {
    return [];
  }
  async updateScheduledTask() {
    return undefined;
  }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread() {
    return { threadId: `thread_${++this.n}` };
  }
  async sendToThread() {}
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

const SKILL = [process.env.EPICSPINE_SKILL_DIR, path.join(os.homedir(), "github/epicspine-skill/skill/epic-spine"), path.join(os.homedir(), ".agents/skills/epic-spine")]
  .filter((d): d is string => !!d)
  .find((d) => fs.existsSync(path.join(d, "scripts/spines.py")));
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

let reposRoot: string;
let db: DB;
const write = (rel: string, text: string) => {
  const f = path.join(reposRoot, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
beforeEach(() => {
  reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "console-e13s10-"));
  fs.mkdirSync(path.join(reposRoot, "poly-maker"));
  git(path.join(reposRoot, "poly-maker"), "init", "-q", "-b", "main");
  git(path.join(reposRoot, "poly-maker"), "remote", "add", "origin", "https://github.com/Acme/poly-maker.git");
});
afterEach(() => {
  db?.close();
  fs.rmSync(reposRoot, { recursive: true, force: true });
});

function setup(spine: string, over: Partial<CycleOptions> = {}) {
  write("poly-maker/docs/one-logger/E4-ONE-LOGGER.md", spine);
  db = openDb(path.join(reposRoot, "console.db"));
  const read: ReadConfig = { reposRoot, seatsFile: path.join(reposRoot, "seats.json"), listThreads: async () => [], spines: cachedRunner(spinesPyRunner(SKILL!, { timeoutMs: 50_000 })) };
  const app = createApp(db, { read, cycle: { enabled: true, t3: new FakeT3(), dispatcher: new FakeDispatcher(), publicUrl: "http://console.test", ...over } });
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };
  return { call };
}

describe.skipIf(!SKILL)("T13-S10 E4 fixture through the API (spines.py)", () => {
  it("1 open item (ready_to_mark) everywhere; an ask raised through the API that cannot reach the spine is refused and adds nothing (T62-S4)", async () => {
    const { call } = setup(E4);
    const m = (await call("POST", "/api/milestones", { title: "E4", repo: "Acme/poly-maker", path: "docs/one-logger/E4-ONE-LOGGER.md" })).json;
    const p = (await call("POST", "/api/personas", { name: "Delivery Manager", remit: "runs it", model: "opus" })).json;
    const a = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 } })).json;
    const run = (await call("POST", "/api/runs", { assignmentId: a.id, outcome: "blocked", threadId: "thread_run" })).json;
    const nj = await call("POST", "/api/needs-owner", { runId: run.id, milestoneId: m.id, question: "Approve: Restore the stored settings (env) of the idle Deployer app ideascraper?", proposedAction: "restore env - why Sam: it restores secret settings" });
    expect(nj.status).toBe(409); // the fixture is no git checkout: nothing written, nothing recorded

    const st = (await call("GET", `/api/milestones/${m.id}/status`)).json;
    expect(st.outcome).toMatchObject({ word: "ready_to_mark", note: AGENT_VERDICT });
    expect(st.items.map((i: { id: string; kind: string }) => [i.id, i.kind])).toEqual([[`ready_to_mark:${m.id}`, "ready_to_mark"]]);
    expect(st.needsYou).toBe(1);
    expect(st.flow).toMatchObject({ word: "needs_you", reason: "1 to mark" });
    const all = (await call("GET", "/api/status")).json;
    expect(all.needsYou).toBe(1);

    const tab = (await call("GET", `/api/waiting-on-owner?milestoneId=${m.id}&includeSuperseded=true`)).json as WaitingItem[];
    // The tab's open section is the status items: no waiting item but the status's open ids is open there.
    const openIds = new Set(st.items.filter((i: { state: string }) => i.state === "open").map((i: { id: string }) => i.id));
    expect(tab.filter((i) => openIds.has(i.id))).toEqual([]); // ready_to_mark has no waiting card: the tab renders it from status
  });

  it("console-marked E4 reads accomplished with 0 items", async () => {
    const { call } = setup(MARKED);
    const m = (await call("POST", "/api/milestones", { title: "E4", repo: "Acme/poly-maker", path: "docs/one-logger/E4-ONE-LOGGER.md" })).json;
    const st = (await call("GET", `/api/milestones/${m.id}/status`)).json;
    expect(st.outcome).toEqual({ word: "accomplished", source: "outcome" });
    expect(st.items.filter((i: { state: string }) => i.state !== "alarm")).toEqual([]);
    expect(st.needsYou).toBe(0);
  });
});
