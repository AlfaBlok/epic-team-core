import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import type { T3Client } from "../src/t3/client.js";
import { createStore } from "../src/store.js";
import { createCycle, URGENT_RETRY_MS, type RunState } from "../src/cycle/service.js";
import { deskInboxSection, parseNote, readInbox, urgentOpenNotes } from "../src/desk/inbox.js";

/**
 * an urgent note between worlds wakes the receiving world's home Delivery Manager
 * at once, not on its next cadence. Once per note; a wake that did not start is retried after URGENT_RETRY_MS.
 */
class FakeT3 implements T3Client {
  calls: string[] = [];
  private n = 0;
  async listProjects() { return [{ id: "proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }]; }
  async listScheduledTasks() { return []; }
  async updateScheduledTask() { return undefined; }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread() { this.calls.push("launchThread"); return { threadId: `thread_${++this.n}` }; }
  async sendToThread() { this.calls.push("sendToThread"); }
  async readThreadStatus() { return { status: "idle", raw: {} }; }
}

let cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups) c(); cleanups = []; });

const note = (fm: string, body = "Restore the WhatsApp session now.") => `---\n${fm}\n---\n${body}\n`;

function setup(o: { persona?: string; due: () => Array<{ file: string; at: string }> }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-urgent-"));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docs/PLAN-0.md"), "# PLAN-0\n## Current State\nStatus: ready\n");
  const db: DB = openDb(path.join(dir, "c.db"));
  const store = createStore(db);
  const disp = { async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; }, async done() {}, async status() { return { name: "pool", capacity: 2, available: 1 }; } };
  const t3 = new FakeT3();
  let mid = "";
  const cycle = createCycle(db, store, {
    enabled: true, t3, dispatcher: disp, publicUrl: "http://x", repoDir: () => repo,
    runState: async (): Promise<RunState> => ({ state: "finished", runnable: false }),
    urgentNotesDue: async () => o.due().map((n) => ({ milestoneId: mid, ...n })),
  });
  cleanups.push(() => { cycle.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const m = store.createMilestone({ title: "Acme", repo: "home_repo", path: "docs/PLAN-0.md", owner: "", paused: false });
  mid = m.id;
  const p = store.createPersona({ name: o.persona ?? "Delivery Manager", remit: "deliver", skills: [], model: "claude-opus-5-5", mayWrite: true, host: "host1" });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 720 }, enabled: true });
  const top = () => store.listRuns({ assignmentId: a.id }).filter((r) => !r.parentRunId);
  return { store, cycle, t3, a, top };
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

describe("urgent desk notes", () => {
  it("reads urgent from `urgent: yes` or an about starting URGENT; an answer only by the field", () => {
    expect(parseNote("a.md", note("from: home\nabout: Phylax down\nurgent: yes"))?.urgent).toBe(true);
    expect(parseNote("a.md", note("from: home\nabout: URGENT: Phylax WhatsApp broken"))?.urgent).toBe(true);
    expect(parseNote("a.md", note("from: home\nabout: Phylax down"))?.urgent).toBeUndefined();
    expect(parseNote("a.md", note("from: acme\nabout: Re: URGENT: Phylax\nin-reply-to: desk/inbox/x.md"))?.urgent).toBeUndefined();
    expect(parseNote("a.md", note("from: acme\nabout: Re: URGENT: Phylax\nin-reply-to: desk/inbox/x.md\nurgent: yes"))?.urgent).toBe(true);
    expect(parseNote("a.md", note("from: home\nabout: URGENT: x\nurgent: no"))?.urgent).toBeUndefined();
  });

  it("lists only open urgent notes with their arrival time, and the wake section puts them first", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-urgent-inbox-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, "desk/inbox"), { recursive: true });
    fs.writeFileSync(path.join(dir, "desk/inbox/2026-11-19-home-urgent.md"), note("from: home\nabout: URGENT: Phylax down\nreply-to: example/team\nstatus: open"));
    fs.writeFileSync(path.join(dir, "desk/inbox/2026-11-19-home-old.md"), note("from: home\nabout: URGENT: done\nstatus: answered"));
    fs.writeFileSync(path.join(dir, "desk/inbox/2026-11-19-home-plain.md"), note("from: home\nabout: a plain note\nstatus: open"));
    const due = urgentOpenNotes(dir);
    expect(due.map((n) => n.file)).toEqual(["desk/inbox/2026-11-19-home-urgent.md"]);
    expect(Date.parse(due[0].at)).toBeGreaterThan(Date.now() - 60_000);
    const s = deskInboxSection(readInbox(dir), "example/acme")!;
    expect(s).toContain("**URGENT** `desk/inbox/2026-11-19-home-urgent.md`");
    expect(s).toContain("act on it first in this wake");
  });

  it("wakes the home Delivery Manager at once past a finished spine, once per note; a newer note wakes it again", async () => {
    let due = [{ file: "desk/inbox/2026-11-19-home-urgent-phylax.md", at: ago(60_000) }];
    const t = setup({ due: () => due });
    expect(await t.cycle.tickUrgentNotes()).toEqual([t.a.id]);
    expect(t.t3.calls).toContain("launchThread");
    const run = t.top().find((r) => r.outcome === "running")!;
    expect(run).toMatchObject({ wokeBecause: "urgent desk note: 2026-11-19-home-urgent-phylax.md" });
    // a live wake: no second one
    expect(await t.cycle.tickUrgentNotes()).toEqual([]);
    const w = await t.cycle.wake(t.a.id, { threadId: "thread_1" });
    expect(w.skipped).toBeFalsy();
    t.store.updateRun(w.run!.id, { outcome: "progressed", endedAt: new Date().toISOString() });
    // the wake ran after the note arrived: carried, never again (even past the retry gap)
    expect(await t.cycle.tickUrgentNotes(new Date(Date.now() + URGENT_RETRY_MS + 60_000))).toEqual([]);
    // a newer urgent note arrives after that wake: it wakes again at once
    due = [...due, { file: "desk/inbox/2026-11-19-infra-urgent-sdb.md", at: new Date(Date.now() + 1000).toISOString() }];
    expect(await t.cycle.tickUrgentNotes(new Date(Date.now() + 2000))).toEqual([t.a.id]);
  });

  it("a wake that failed is retried only after the retry gap", async () => {
    const t = setup({ due: () => [{ file: "desk/inbox/u.md", at: ago(60_000) }] });
    expect(await t.cycle.tickUrgentNotes()).toEqual([t.a.id]);
    const run = t.top().find((r) => r.outcome === "running")!;
    t.store.updateRun(run.id, { outcome: "failed", endedAt: new Date().toISOString() });
    expect(await t.cycle.tickUrgentNotes()).toEqual([]);
    expect(await t.cycle.tickUrgentNotes(new Date(Date.now() + URGENT_RETRY_MS + 1000))).toEqual([t.a.id]);
  });

  it("no Delivery Manager, or no urgent note: no wake", async () => {
    const t = setup({ persona: "Writer", due: () => [{ file: "desk/inbox/u.md", at: ago(60_000) }] });
    expect(await t.cycle.tickUrgentNotes()).toEqual([]);
    const u = setup({ due: () => [] });
    expect(await u.cycle.tickUrgentNotes()).toEqual([]);
    expect(u.t3.calls).toEqual([]);
  });
});
