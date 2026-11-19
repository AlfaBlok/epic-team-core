import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import type { T3Client } from "../src/t3/client.js";
import { createStore } from "../src/store.js";
import { createCycle } from "../src/cycle/service.js";
import type { Tree, TreeNode } from "../src/adapters/tree.js";
import { wakeFingerprint } from "../src/cycle/skipUnchanged.js";
import { deskNoteLines, newsPart, serverWheelReader, wheelFaults } from "../src/cycle/wakeNews.js";
import { parseWakeParts } from "../src/cycle/wakeWhy.js";

/**
 * a Delivery Manager's "nothing new" skip counts its open faults as news: a red server-wheel key result it
 * owns (a host's CPU, a failing check, a channel down) and an open desk note. Seen once: an ops DM skipped
 * while main's CPU pressure hit 86% and a product's WhatsApp was down; another world's DM skipped 7 wakes with an open note.
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

const node = (id: string, p: string): TreeNode => ({ key: id, id, kind: "spine", title: id, status: "active", color: "grey", path: p, children: [], flags: [] });

function setup(persona = "Delivery Manager") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s168-"));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docs/epic.md"), "# EPIC\n## Current State\nNext action: S2\n");
  const db: DB = openDb(path.join(dir, "c.db"));
  const store = createStore(db);
  const news: string[] = [];
  const treeFor = async (): Promise<Tree> => ({
    milestoneId: "m", root: node("PLAN-1", "docs/epic.md"),
    counts: { grey: 1, blue: 0, yellow: 0, red: 0, green: 0 }, nonGreen: 1, closed: 0, flagged: 0, source: "spines", warnings: [],
  });
  const cycle = createCycle(db, store, { enabled: true, t3: new FakeT3(), publicUrl: "http://x", treeFor, treeTodo: async () => "", repoDir: () => repo, wakeNews: async () => [...news] });
  cleanup = () => { cycle.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  const m = store.createMilestone({ title: "M", repo: "ops", path: "docs/epic.md", owner: "", paused: false });
  const p = store.createPersona({ name: persona, remit: "keep main up", skills: [], model: "claude-opus-5-5", mayWrite: true });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 120 }, enabled: true });
  const newest = () => store.listRuns({ assignmentId: a.id }).find((r) => !r.parentRunId)!;
  const cadence = async () => {
    const w = await cycle.wake(a.id, { threadId: "home" });
    return { ...w, real: w.run?.outcome === "running" };
  };
  const finish = async (edit?: () => void) => {
    const r = newest();
    edit?.();
    store.updateRun(r.id, { outcome: "idle", endedAt: new Date(Date.now() + 1).toISOString() });
    cycle.runEnded(r.id);
    await cycle.settled();
    return r;
  };
  return { news, cycle, a, cadence, finish, newest };
}

const CPU = "wheel:main_cpu red: Keep CPU for production on main (work waited for a CPU 86% of the last 5 min, load 7.1 on 4 CPUs)";

describe("open faults are news for the Delivery Manager's skip", () => {
  it("a red server-wheel key result that starts wakes it; the same fault with moving numbers skips; clearing it wakes", async () => {
    const t = setup();
    expect((await t.cadence()).real).toBe(true);
    await t.finish();
    expect((await t.cadence()).real).toBe(false); // nothing new: skipped
    t.news.push(CPU);
    expect((await t.cadence()).real).toBe(true); // main's CPU went red: never "nothing new"
    await t.finish();
    t.news[0] = CPU.replace("86%", "91%").replace("7.1", "6.4");
    expect((await t.cadence()).real).toBe(false); // the same fault, its numbers moved: not news
    t.news.push("wheel:checks red: a product's live checks pass on host1 (failing twice in a row: chat.whatsapp)");
    expect((await t.cadence()).real).toBe(true); // a channel down joined it
    await t.finish();
    t.news.length = 0;
    expect((await t.cadence()).real).toBe(true); // all clear is news too
  });

  it("an open desk note wakes it, and wake-check names it", async () => {
    const t = setup();
    await t.cadence();
    await t.finish();
    t.news.push("desk note open: desk/inbox/2026-11-19-home-his-words.md (the owner: I haven't seen anything on my inbox for it)");
    const c = (await t.cycle.wakeCheck(t.a.id)) as { wouldSkip: boolean; why?: string; news?: string[] };
    expect(c.wouldSkip).toBe(false);
    expect(c.why).toContain("open faults changed");
    expect(c.why).toContain("desk/inbox/2026-11-19-home-his-words.md");
    expect(c.news).toHaveLength(1);
    expect((await t.cadence()).real).toBe(true);
  });

  it("a persona that does not dispatch never reads the faults", async () => {
    const t = setup("Listener");
    await t.cadence();
    await t.finish();
    t.news.push(CPU);
    expect((await t.cadence()).real).toBe(false);
  });

  it("the part is recorded on the wake; old parts read as no fault; fingerprints without faults stay the same", async () => {
    const t = setup();
    t.news.push(CPU);
    await t.cadence();
    await t.finish();
    expect(t.newest().wakeParts?.news).toBe(newsPart([CPU]));
    expect(parseWakeParts(JSON.stringify({ spines: "s", prompt: "p", answer: "", running: "r", ready: "0" }))?.news).toBe("");
    const base = { spines: "s", running: [], readyAndSeatFree: false, answer: "", prompt: "" };
    expect(wakeFingerprint({ ...base, news: [] })).toBe(wakeFingerprint(base));
    expect(wakeFingerprint({ ...base, news: [CPU] })).not.toBe(wakeFingerprint(base));
  });
});

describe("the fault lines", () => {
  const spokes = [
    { id: "main_cpu", state: "red", must: "Keep CPU for production", host: "main", now: "86%", owner: "ops" },
    { id: "main_mem", state: "amber", must: "Keep memory for production", host: "main", owner: "ops" },
    { id: "jobs", state: "red", must: "Keep our services running", host: "both" },
    { id: "flats", state: "red", must: "Mexico City flats read", owner: "airbnb-observatory" },
  ];
  it("each repo gets only its own red key results; a spoke with no owner is the wheel's own repo's", () => {
    expect(wheelFaults(spokes, "ops", "team")).toEqual(["wheel:main_cpu red: Keep CPU for production on main (86%)"]);
    expect(wheelFaults(spokes, "team", "team")).toEqual(["wheel:jobs red: Keep our services running on both"]);
    expect(wheelFaults(undefined, "ops", "team")).toEqual([]);
  });
  it("only open desk notes count", () => {
    expect(deskNoteLines([{ file: "desk/inbox/a.md", status: "open", about: "hi" }, { file: "desk/inbox/b.md", status: "answered" }])).toEqual(["desk note open: desk/inbox/a.md (hi)"]);
  });
  it("the wheel is read at most once a minute and an unreadable wheel keeps the last reading", async () => {
    let calls = 0;
    let fail = false;
    let t = 0;
    const f = (async () => {
      calls++;
      if (fail) throw new Error("down");
      return new Response(JSON.stringify({ spokes: [{ id: "jobs", state: "red" }] }));
    }) as unknown as typeof fetch;
    const read = serverWheelReader("http://wheel/wheel.json", f, 60_000, () => t);
    t = 100_000;
    expect(await read()).toHaveLength(1);
    expect(await read()).toHaveLength(1);
    expect(calls).toBe(1);
    fail = true;
    t += 61_000;
    expect(await read()).toHaveLength(1);
    expect(calls).toBe(2);
    expect(await serverWheelReader(undefined, f)()).toBeUndefined();
  });
});
