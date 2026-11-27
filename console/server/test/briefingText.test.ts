import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { resetRepoScans } from "../src/adapters/repos.js";
import type { SpineNode, SpinesJson } from "../src/adapters/spines.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import type { ReadConfig } from "../src/routes/read.js";
import { bookBrief, briefing, treeBrief, tokensOf } from "../src/voice/brief.js";
import { BRIEF_WAIT_MS, CALL_FLOW_RULE, createVoice, teamRoster, voiceInstructions } from "../src/voice/voice.js";
// this file checks the text with our own owner's name (src/identity.ts; the suite's owner is neutral, hostedSetup.ts)
vi.hoisted(async () => (await import("../src/identity.js")).setIdentity({ owner: "Sam" }));

/**
 * every voice session starts briefed with the root tree (top-level milestones: code, one-line
 * goal, status, priority order) and a short Epic Book summary at its level (the desk: the root book; a milestone: its page),
 * so "what is this about, what are the top milestones" is answered on the call. One of the owner's milestones calls as a
 * milestone (not a campaign). The briefing never stops a call (slow or failing: left out) and its size is kept per call.
 */

const node = (over: Partial<SpineNode> & { path: string; title: string }): SpineNode => ({
  id: over.path,
  parent: null,
  status: "active",
  rollup_status: "active",
  dod: [],
  children: [],
  ...over,
});
const ROOT = "docs/spines/root.md";
const E42 = "docs/spines/epic-42.md";
const E40 = "docs/spines/epic-40.md";
const spines: SpinesJson = {
  root: ROOT,
  orphans: [],
  mismatches: [],
  nodes: [
    node({
      path: ROOT,
      title: "home_repo",
      goal: "Run a small team of AI employees that push milestones forward on their own.\n\nModel: more words here.",
      current_state: { status: "active", phase: "M6 active", next_action: "Ship the voice brief", waiting_on: "none" } as never,
      done_means: [
        { id: "DOD-1", text: "T3 runs as a service", done: true },
        { id: "DOD-2", text: "Three personas run unattended", done: false },
      ],
    }),
    node({
      path: E42,
      title: "EPIC-942: Talk to the desk",
      parent: ROOT,
      goal: "Sam talks to the Team desk by voice (run_2d89b5ad-aaaa).",
      current_state: { status: "active", phase: "Call the desk is live", next_action: "Brief every call", waiting_on: "Sam: E942-A1 (a WhatsApp key)" } as never,
      done_means: [
        { id: "E42-1", text: "A voice note reaches the desk", done: true },
        { id: "E42-4", text: "Sam calls the desk and it answers by voice", done: false },
      ],
    }),
    node({ path: E40, title: "EPIC-940: Lanes and radar", parent: ROOT, status: "blocked", goal: "Every lane on one radar.", current_state: { status: "blocked" } as never }),
  ],
};

describe("E942-S14 the briefing text", () => {
  it("root tree: focus milestones in priority order with code, status and a one-line goal, then the others by name", () => {
    const t = treeBrief([
      { code: "EPIC-940", title: "EPIC-940: Lanes and radar", goal: "Every lane on one radar.\n\nMore.", status: "blocked", rank: 2 },
      { code: "EPIC-942", title: "EPIC-942: Talk to the desk", goal: "Sam talks to the desk by voice.", status: "active", rank: 1 },
      { title: "Side quest", goal: "x" },
    ]);
    expect(t.split("\n")).toEqual([
      "Root tree: Sam's top-level milestones, in priority order (1 = top):",
      "1. EPIC-942 Talk to the desk (active): Sam talks to the desk by voice.",
      "2. EPIC-940 Lanes and radar (blocked): Every lane on one radar.",
      "Other milestones: Side quest.",
    ]);
    expect(treeBrief([])).toBe("");
  });

  it("book: Goal's first paragraph, Done means met and open, Phase, Waiting on, Next action; no ids or markdown", () => {
    const b = bookBrief({
      code: "EPIC-942",
      title: "EPIC-942: Talk to the desk",
      goal: "Sam talks to the **Team desk** by voice (run_2d89b5ad-aaaa).\n\nSecond paragraph.",
      doneMeans: [
        { id: "E42-1", text: "A voice note reaches the desk", done: true },
        { id: "E42-4", text: "Sam calls the desk", done: false },
      ],
      phase: "Call the desk is live",
      waitingOn: "Sam: E942-A1",
      next: "Brief every call",
      dod: { done: 1, total: 2 },
    });
    expect(b.split("\n")).toEqual([
      "Epic Book, this milestone: EPIC-942 Talk to the desk",
      "Goal: Sam talks to the Team desk by voice.",
      "Done means: 1 of 2 met. Open: E42-4 Sam calls the desk.",
      "Phase: Call the desk is live",
      "Waiting on: Sam: E942-A1",
      "Next action: Brief every call",
    ]);
  });

  it("stays small: 10 focus milestones with long goals and a full book fit in about 1,000 tokens", () => {
    const long = "A goal sentence that goes on and on. ".repeat(20);
    const tree = treeBrief(Array.from({ length: 10 }, (_, i) => ({ code: `EPIC-${i}`, title: `Milestone ${i}`, goal: long, status: "active", rank: i + 1 })));
    const book = bookBrief({ code: "root", title: "home_repo", goal: long, doneMeans: Array.from({ length: 9 }, (_, i) => ({ id: `D-${i}`, text: long, done: false })), phase: long, waitingOn: long, next: long, dod: { done: 0, total: 9 } });
    expect(tokensOf(briefing([tree, book]))).toBeLessThan(1_000);
  });
});

describe("E942-S14 a call starts briefed", () => {
  let dir: string;
  let db: DB;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e42s14v-"));
    db = openDb(path.join(dir, "c.db"));
  });
  afterEach(() => {
    vi.useRealTimers();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const voice = (brief?: () => Promise<string> | string) => {
    const minted: any[] = [];
    const v = createVoice({ db, mint: async (b) => (minted.push(b), { value: "ek", expires_at: 0 }), quickStatus: async () => ({ text: "", waiting: 0, stuck: 0, working: 0 }), ...(brief ? { brief } : {}) });
    return { v, minted };
  };

  it("the briefing follows the standing instructions, and its size is kept on the call", async () => {
    const { v, minted } = voice(() => briefing(["Root tree: 1. EPIC-942 Talk to the desk"]));
    const c = await v.start();
    const ins = minted[0].session.instructions as string;
    expect(ins.startsWith(voiceInstructions())).toBe(true);
    expect(ins).toMatch(/\n\nBriefing \(as of the call's start\)\. Questions about what this is about, what the top milestones are.*answer from this briefing at once.*with no tool call \(no quick_status, no ask_the_desk\).*in the order given here.*\nRoot tree: 1\. EPIC-942/s);
    expect(voiceInstructions()).toMatch(/except the briefing and the earlier conversation at the end of these instructions \(when there are any\) and what your tools return/);
    expect(c.call.briefTokens).toBe(tokensOf(briefing(["Root tree: 1. EPIC-942 Talk to the desk"])));
  });

  it("a failing or slow briefing never stops the call: it starts without one", async () => {
    const bad = voice(() => Promise.reject(new Error("book not built")));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const c1 = await bad.v.start();
    expect(bad.minted[0].session.instructions).toBe(`${voiceInstructions()}\n${CALL_FLOW_RULE}\n${teamRoster()}`);
    expect(c1.call.briefTokens).toBeUndefined();
    warn.mockRestore();
    await bad.v.end(c1.call.id, { reason: "hangup" });

    vi.useFakeTimers();
    const slow = voice(() => new Promise<string>(() => undefined));
    const p = slow.v.start();
    await vi.advanceTimersByTimeAsync(BRIEF_WAIT_MS + 10);
    await p;
    expect(slow.minted[0].session.instructions).toBe(`${voiceInstructions()}\n${CALL_FLOW_RULE}\n${teamRoster()}`);
  });
});

describe("E942-S14 the desk and a milestone call, through the app", () => {
  let root: string;
  let db: DB | undefined;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e42s14-"));
    fs.mkdirSync(path.join(root, "home_repo/.git"), { recursive: true });
    fs.mkdirSync(path.join(root, "home_repo/docs/spines"), { recursive: true });
    for (const n of spines.nodes) fs.writeFileSync(path.join(root, "home_repo", n.path), `# ${n.title}\n\n## Current State\n\nStatus: ${n.status}\n`);
    resetRepoScans(0);
  });
  afterEach(() => {
    resetRepoScans();
    db?.close();
    db = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const setup = () => {
    db = openDb(path.join(root, "c.db"));
    const minted: any[] = [];
    const read: ReadConfig = { reposRoot: root, seatsFile: path.join(root, "seats.json"), listThreads: async () => [], spines: async () => spines };
    const app = createApp(db, {
      read,
      browser: { browserUrl: "http://127.0.0.1:9" },
      book: { git: async () => "" },
      voice: { mint: async (b: unknown) => (minted.push(b), { value: "ek", expires_at: 0 }) },
    });
    const s = createStore(db);
    const mRoot = s.createMilestone({ title: "home_repo", repo: "Acme/home_repo", path: ROOT, owner: "", paused: false });
    // Created out of priority order: the lists must follow the focus positions, not creation.
    const m40 = s.createMilestone({ title: "EPIC-940", repo: "Acme/home_repo", path: E40, owner: "", paused: false, bigRoot: 2 });
    const m42 = s.createMilestone({ title: "EPIC-942", repo: "Acme/home_repo", path: E42, owner: "", paused: false, bigRoot: 1 });
    for (const [id, at] of [[mRoot.id, "2026-01-01"], [m40.id, "2026-01-02"], [m42.id, "2026-01-03"]]) db.prepare("UPDATE milestones SET created_at = ? WHERE id = ?").run(`${at}T00:00:00.000Z`, id);
    const page = { "sec-fetch-site": "same-origin", "content-type": "application/json" };
    const call = async (url: string) => {
      const r = await app.request(url, { method: "POST", headers: page });
      expect(r.status, await r.clone().text()).toBe(201);
      const j = (await r.json()) as { call: { id: string; briefTokens?: number } };
      await app.request(`${url}/${j.call.id}/end`, { method: "POST", headers: page, body: JSON.stringify({ reason: "hangup" }) });
      return { ...j, instructions: minted.at(-1).session.instructions as string, tools: JSON.stringify(minted.at(-1).session.tools) };
    };
    const quick = async (url: string) => {
      const r = await app.request(url, { method: "POST", headers: page });
      const id = ((await r.json()) as { call: { id: string } }).call.id;
      const st = (await (await app.request(`${url}/${id}/status`, { headers: page })).json()) as { text: string };
      await app.request(`${url}/${id}/end`, { method: "POST", headers: page, body: JSON.stringify({ reason: "hangup" }) });
      return st.text;
    };
    return { call, quick, mRoot, m42 };
  };

  it("a milestone call: its own desk, as a milestone; the root tree in priority order; its book page", async () => {
    const w = setup();
    const c = await w.call(`/api/milestones/${w.m42.id}/voice/calls`);
    const ins = c.instructions;
    expect(ins).toContain(`the desk of Sam's milestone "EPIC-942"`);
    expect(ins).not.toMatch(/campaign/);
    expect(c.tools).not.toMatch(/campaign|Team desk/);
    expect(ins).toContain(
      [
        "Root tree: Sam's top-level milestones, in priority order (1 = top):",
        "1. EPIC-942 Talk to the desk (active): Sam talks to the Team desk by voice.",
        "2. EPIC-940 Lanes and radar (blocked): Every lane on one radar.",
        "Other milestones: home_repo.",
      ].join("\n"),
    );
    expect(ins).toContain(
      [
        "Epic Book, this milestone: EPIC-942 Talk to the desk",
        "Goal: Sam talks to the Team desk by voice.",
        "Done means: 1 of 2 met. Open: E42-4 Sam calls the desk and it answers by voice.",
        "Phase: Call the desk is live",
        "Waiting on: Sam: E942-A1 (a WhatsApp key)",
        "Next action: Brief every call",
      ].join("\n"),
    );
    expect(ins).not.toContain("Epic Book, the root");
    expect(c.call.briefTokens).toBeGreaterThan(50);
  });

  it("a milestone call's quick status: this milestone, then the others in Sam's priority order (focus first)", async () => {
    const w = setup();
    const text = await w.quick(`/api/milestones/${w.mRoot.id}/voice/calls`);
    expect(text).toMatch(/^This milestone:\nhome_repo/);
    expect(text).toContain("Other milestones (in Sam's priority order, focus milestones first): 2.");
    expect(text.indexOf("- EPIC-942")).toBeGreaterThan(0);
    expect(text.indexOf("- EPIC-942")).toBeLessThan(text.indexOf("- EPIC-940"));
    expect(text).not.toMatch(/campaign/);
  });

  it("the desk call: the same root tree and the root book", async () => {
    const w = setup();
    const c = await w.call("/api/voice/calls");
    expect(c.instructions).toContain("1. EPIC-942 Talk to the desk (active)");
    expect(c.instructions).toContain(["Epic Book, the root (the whole team): home_repo", "Goal: Run a small team of AI employees that push milestones forward on their own.", "Done means: 1 of 2 met. Open: DOD-2 Three personas run unattended.", "Phase: M6 active", "Next action: Ship the voice brief"].join("\n"));
    expect(c.instructions).not.toContain("Epic Book, this milestone");
  });
});
