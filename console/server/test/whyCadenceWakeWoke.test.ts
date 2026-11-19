import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import type { T3Client } from "../src/t3/client.js";
import { createStore, type Run } from "../src/store.js";
import { createCycle } from "../src/cycle/service.js";
import { buildTree, dependsOnOpenAsk, type Tree, type TreeNode } from "../src/adapters/tree.js";
import { WAKE_PARTS, changedParts, wakeParts, wokeBecause, type WakeParts } from "../src/cycle/wakeWhy.js";

/**
 * every real cadence wake records why it woke (which fingerprint part changed, or which skip rule let it
 * run), and the whatgpt Delivery Manager case: blocked on with fp 2aa04dfb ×11, never skipped, because its S6
 * row read "ready" (Depends On:) and the seat pool had a free seat, so "ready + free seat" woke it every 2 h.
 */
class FakeT3 implements T3Client {
  async listProjects() {
    return [{ id: "proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }];
  }
  async listScheduledTasks() { return []; }
  async updateScheduledTask() { return undefined; }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread() { return { threadId: "t" }; }
  async sendToThread() {}
  async readThreadStatus() { return { status: "idle", raw: {} }; }
}

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

const NOW = Date.parse("2026-10-26T03:00:00Z");
const P: WakeParts = { spines: "s1", prompt: "p1", answer: "", running: "r0", ready: "0", data: "", rollup: "", news: "" };
const run = (id: string, over: Partial<Run> = {}): Run => ({
  id, assignmentId: "a", startedAt: "2026-10-26T01:18:00Z", endedAt: "2026-10-26T01:19:00Z", outcome: "blocked", summary: "blocked: waits on E900-A11",
  kind: "wake", askFingerprint: "fp1", wakeParts: P, ...over,
} as Run);

describe("why a cadence wake woke", () => {
  it("names each fingerprint part that changed", () => {
    const now: Record<string, Partial<WakeParts>> = {
      spines: { spines: "s2" }, prompt: { prompt: "p2" }, answer: { answer: "jr_1" }, running: { running: "r1" }, ready: { ready: "1" }, data: { data: "d1" }, rollup: { rollup: "u1" }, news: { news: "n1" },
    };
    const words = { spines: "spines changed", prompt: "prompt changed", answer: "new answer", running: "running children changed", ready: "ready rows nobody is on + a free seat", data: "data/ files changed", rollup: "a Current State lag changed", news: "open faults changed" };
    for (const k of WAKE_PARTS) {
      const parts = { ...P, ...now[k] };
      expect(changedParts(P, parts)).toEqual([k]);
      expect(wokeBecause([run("r1")], parts, "fp2", { readyIds: ["S6"], now: NOW })).toContain(words[k]);
    }
  });

  it("same fingerprint: names the skip rule that let it run", () => {
    const o = { now: NOW };
    // the same ready rows + a free seat are no reason on their own (they are a fingerprint part)
    expect(wokeBecause([run("r1", { wakeParts: { ...P, ready: "1:abc" } })], { ...P, ready: "1:abc" }, "fp1", { readyIds: ["S6"], now: NOW })).toBe("nothing changed (skip not applied)");
    expect(wokeBecause([run("r1", { wakeParts: { ...P, ready: "1:abc" } })], { ...P, ready: "1:def" }, "fp2", { readyIds: ["S7"], now: NOW })).toBe("ready rows nobody is on + a free seat (S7)");
    expect(wokeBecause([run("r1", { outcome: "failed" })], P, "fp1", o)).toBe("last wake ended failed");
    expect(wokeBecause([run("r1", { outcome: "blank_report" })], P, "fp1", o)).toBe("last wake ended blank_report");
    expect(wokeBecause([run("r1", { outcome: "monitoring", nextCheckAt: "2026-10-26T02:00:00Z" })], P, "fp1", { now: Date.parse("2026-10-26T03:00:00Z") })).toBe("its next check is due");
    const child = run("c1", { parentRunId: "r1", outcome: "progressed", endedAt: "2026-10-26T02:00:00Z", askFingerprint: undefined });
    expect(wokeBecause([child, run("r1")], P, "fp1", o)).toBe("a child run ended");
    const skips = Array.from({ length: 6 }, (_, i) => run(`s${i}`, { outcome: "idle", summary: "skipped: nothing new since r1" }));
    expect(wokeBecause([...skips, run("r1")], P, "fp1", o)).toBe("nothing changed (skip not applied)"); // no count cap
    expect(wokeBecause([...skips, run("r1")], P, "fp1", { now: Date.parse("2026-10-26T13:18:00Z") })).toBe("nothing changed (skip not applied)"); // under 24 h
    expect(wokeBecause([...skips, run("r1")], P, "fp1", { now: Date.parse("2026-10-27T01:18:00Z") })).toBe("max age (last real wake 24 h ago, cap 24 h)");
    expect(wokeBecause([], P, "fp1")).toBe("first wake (no earlier wake to compare)");
    expect(wokeBecause([run("r1")], undefined, undefined)).toBe("no readable tree (never skipped)");
    expect(wokeBecause([run("r1", { wakeParts: undefined })], P, "fp2", o)).toBe("fingerprint changed (parts not recorded then)");
  });

  it("dependsOnOpenAsk matches whole codes only", () => {
    expect(dependsOnOpenAsk("E900-A11 (QR scan)", ["E900-A11"])).toBe("E900-A11");
    expect(dependsOnOpenAsk("S1-S4, E900-A6, E900-A8", ["E900-A11"])).toBeUndefined();
    expect(dependsOnOpenAsk("E900-A1", ["E900-A11"])).toBeUndefined();
    expect(dependsOnOpenAsk("E900-A11", ["E900-A1"])).toBeUndefined();
    expect(dependsOnOpenAsk("[EPIC-900 e900-a11](EPIC-900-ROOT.md)", ["E900-A11"])).toBe("E900-A11");
    expect(dependsOnOpenAsk(undefined, ["E900-A11"])).toBeUndefined();
  });
});

// whatgpt_v3 at 5dcdce9 (2026-10-26), trimmed to what the tree and the fingerprint read: the root's open ask and
//'s ledger, whose S6 row reads `ready` and depends on (verbatim rows).
const EPIC0 = (ask: string) => `# EPIC-900: WhatGPT v3 — whatgpt.ai live

Spine ID: whatgpt-v3-root

## Current State

Status: active
Waiting on: Sam: E900-A11 (scan the QR)
Last attempted: 2026-10-26T21:18Z wake: E900-A11 still open

## Waiting on

${ask}

## Child Epics

| Spine | Kind | Link | Purpose | Status |
|---|---|---|---|---|
| wave-1-core-relay | child | [EPIC-901: Wave 1 core relay](EPIC-901-WAVE-1-CORE-RELAY.md) | Basic WhatsApp↔LLM relay | active |
`;
const OPEN = "- [ask E900-A11: do @Sam since 2026-10-24 row S5] Scan the WhatsApp QR at https://admin.whatgpt.ai to link +525666390765 (root-URL 404 fixed); recommend now.";
const ANSWERED = "- [answered E900-A11 2026-10-27 @Sam] Scan the WhatsApp QR — answer: scanned";
const EPIC1 = `# EPIC-901: Wave 1 core relay

Spine ID: wave-1-core-relay
Parent spine: [EPIC-900: WhatGPT v3 — whatgpt.ai live](EPIC-900-ROOT.md)

## Current State

Status: active
Waiting on: [EPIC-900 E900-A11](EPIC-900-ROOT.md) (QR scan)

## Waiting on

- [waits on E900-A11 row S5] QR scan to pair +525666390765 (canonical ask in [EPIC-900](EPIC-900-ROOT.md))

## Issue Ledger

| Issue | Role | Owner / Assignment | Title | Status | Depends On | PR/Branch | Base | Latest Evidence | Last Verified | Next Action |
|---|---|---|---|---|---|---|---|---|---|---|
| draft | Ticket worker | unassigned | S5 CI to GHCR + Deployer deploy on host1, pair +525666390765, restart drill (E1-4) | blocked | S1-S4, E900-A6, E900-A8 | wt/s5 | main | deployed | 2026-10-24 | pair |
| draft | Ticket worker | unassigned | S6 live proof: E1-2 text recall, E1-3 voice incl. non-English, E1-4 restart drill + 7-day watch; owner numbers only (E900-G8) | ready | E900-A11 (QR scan) | wt/s6-prep (prep merged) | main | prep: checklist [S6-LIVE-PROOF](S6-LIVE-PROOF.md), admin \`/admin/transcript?user=<id>\` + \`?format=md\`, \`scripts/restart-drill.sh\` (refuses before pairing) | 2026-10-24 | after the scan: run the checklist, export transcripts, run the drills |
`;

function whatgpt() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e8s23-"));
  const repo = path.join(dir, "whatgpt_v3");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git/config"), `[remote "origin"]\n\turl = https://github.com/Acme/whatgpt_v3.git\n`);
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  const write = (ask: string) => {
    fs.writeFileSync(path.join(repo, "docs/EPIC-900-ROOT.md"), EPIC0(ask));
    fs.writeFileSync(path.join(repo, "docs/EPIC-901-WAVE-1-CORE-RELAY.md"), EPIC1);
  };
  write(OPEN);
  const M = { id: "ms_whatgpt", repo: "Acme/whatgpt_v3", path: "docs/EPIC-900-ROOT.md", paused: false, title: "whatgpt_v3 · EPIC-900" };
  return { dir, repo, write, tree: () => buildTree(dir, M) };
}
const all = (n: TreeNode): TreeNode[] => [n, ...n.children.flatMap(all)];
const s6 = (t: Tree) => all(t.root).find((n) => n.title.startsWith("S6 live proof"));

describe("whatgpt Delivery Manager: a ready row that depends on an open ask is not ready", () => {
  it("S6 (Depends On E900-A11, open) is not ready; once E900-A11 is answered it is", () => {
    const w = whatgpt();
    try {
      const n = s6(w.tree())!;
      expect(n).toMatchObject({ status: "ready", dependsOn: "E900-A11 (QR scan)" });
      expect(n.ready).toBeUndefined();
      w.write(ANSWERED);
      expect(s6(w.tree())!.ready).toBe(true);
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  });

  it("cadence: the blocked DM's next wake skips (free seat in the pool); before, ready + free seat woke it every time", async () => {
    const w = whatgpt();
    const db: DB = openDb(path.join(w.dir, "c.db"));
    const store = createStore(db);
    const disp = {
      async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; },
      async done() {},
      async status() { return { name: "seat pool (central on host1)", capacity: 2, available: 2 }; },
    };
    const cycle = createCycle(db, store, { enabled: true, t3: new FakeT3(), dispatcher: disp, publicUrl: "http://x", treeFor: async () => w.tree(), treeTodo: async () => "## Epic tree (your to-do)", repoDir: () => w.repo });
    cleanup = () => { cycle.stop(); db.close(); fs.rmSync(w.dir, { recursive: true, force: true }); };
    const m = store.createMilestone({ title: "whatgpt_v3 · EPIC-900", repo: "Acme/whatgpt_v3", path: "docs/EPIC-900-ROOT.md", owner: "Sam", paused: false });
    const p = store.createPersona({ name: "Delivery Manager", remit: "deliver", skills: [], model: "claude-opus-5-5", mayWrite: true });
    const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 120 }, enabled: true });
    const cadence = async () => {
      const r = await cycle.wake(a.id, { threadId: "home" });
      return { ...r, real: r.run?.outcome === "running" };
    };
    const finish = async (summary: string) => {
      const r = store.listRuns({ assignmentId: a.id }).find((x) => !x.parentRunId)!;
      // the DM's own bookkeeping commit (Last attempted) during its wake is not news
      fs.writeFileSync(path.join(w.repo, "docs/EPIC-900-ROOT.md"), EPIC0(OPEN).replace("2026-10-26T21:18Z", new Date().toISOString()));
      store.updateRun(r.id, { outcome: "blocked", summary, endedAt: new Date(Date.now() + 1).toISOString() });
      cycle.runEnded(r.id);
      await cycle.settled();
      return store.getRun(r.id)!;
    };

    const w1 = await cadence();
    expect(w1.real).toBe(true);
    expect(w1.run!.wokeBecause).toBe("first wake (no earlier wake to compare)");
    expect(w1.run!.summary).toBe("Woke on cadence · woke: first wake (no earlier wake to compare)");
    const r1 = await finish("blocked: waits on E900-A11 (QR scan); service healthy in pairing (7738304), billing live");
    expect(r1.wokeBecause).toBe("first wake (no earlier wake to compare)"); // kept on the run after the persona's report
    expect(r1.wakeParts).toMatchObject({ ready: "0" });
    const w2 = await cadence();
    expect(w2.real).toBe(false);
    expect(w2.run!.summary).toBe(`skipped: nothing new since ${r1.id}`);

    expect(await cycle.wakeCheck(a.id)).toMatchObject({ wouldSkip: true, readyIds: [], parts: { ready: "0" }, lastRealWake: { id: r1.id, outcome: "blocked" } });

    // the owner answers in the spine: S6 is ready, a seat is free → real, and it says why.
    w.write(ANSWERED);
    expect(await cycle.wakeCheck(a.id)).toMatchObject({ wouldSkip: false, readyIds: ["draft"], why: expect.stringMatching(/ready rows nobody is on \+ a free seat \(draft\)/) });
    const w3 = await cadence();
    expect(w3.real).toBe(true);
    expect(w3.run!.wokeBecause).toMatch(/^spines changed; ready rows nobody is on \+ a free seat/);
  });
});
