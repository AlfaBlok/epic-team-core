import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createCycle } from "../src/cycle/service.js";
import { wakeProtocol } from "../src/cycle/prompts.js";
import { workerMessage } from "../src/cycle/workerLaunch.js";
import { buildWakePrompt, deckBriefLine, milestoneDeckUrl } from "../src/wakePrompt.js";
import type { T3Client } from "../src/t3/client.js";

// "when people work on inside this milestone, they get a reference to that deck immediately".
const deck = "https://team.example.com/milestones/ms_1?tab=deck";
const persona = { name: "Delivery Manager", remit: "Run the milestone.", skills: [], mayWrite: true };
const milestone = { title: "Epic Book per milestone", repo: "home_repo", path: "docs/spines/epic-47.md", owner: "" };

describe("T47-S4 r4: the milestone's deck in every wake and worker brief", () => {
  it("the deck link is the milestone's Deck tab, on one epic with &epic=", () => {
    expect(milestoneDeckUrl("https://team.example.com/", "ms_1")).toBe(deck);
    expect(milestoneDeckUrl("https://team.example.com", "ms_1", "PLAN-47")).toBe(`${deck}&epic=PLAN-47`);
  });

  it("the wake prompt names the deck right after its first line; no deck, no section", () => {
    const p = buildWakePrompt(persona, milestone, undefined, undefined, undefined, undefined, undefined, {}, undefined, deck);
    const lines = p.split("\n");
    expect(lines[0]).toMatch(/^You are Delivery Manager/);
    expect(lines[2]).toBe("## This milestone's deck: read it first");
    expect(lines[3]).toContain(`This milestone's deck: ${deck}`);
    expect(p.indexOf(deck)).toBeLessThan(p.indexOf("## Your remit"));
    expect(p).toContain(`\`${deck}&epic=<EPIC-n, or the spine's file name>\``);
    expect(p).toContain(`Every worker brief you write inside this milestone opens with \`This milestone's deck: ${deck}\``);
    expect(buildWakePrompt(persona, milestone)).not.toContain("deck");
  });

  it("the console protocol tells the manager each worker brief opens with the deck lines", () => {
    const o = { base: "http://c", run: { id: "run_1" }, assignment: { id: "asg_1", writeEnabled: true, writeScope: "repo" }, milestone: { id: "ms_1" }, persona: { name: "Delivery Manager", remit: "" }, runningWorkers: 0 };
    const p = wakeProtocol({ ...o, deckUrl: deck } as never);
    expect(p).toContain(`Its brief opens with the line \`${deckBriefLine(deck)}\` and, when it names a Bound epic, \`This epic's deck: ${deck}&epic=<that epic's EPIC-n>\``);
    expect(wakeProtocol(o as never)).not.toContain("deck");
  });

  it("a console-launched worker's message opens with the deck, once", () => {
    const m = workerMessage({ base: "http://c", runId: "run_2", parentRunId: "run_1", ticket: "T47-S4", brief: "Do the row.", deckUrl: deck });
    expect(m.split("\n")[0]).toBe(`This milestone's deck: ${deck}`);
    const named = workerMessage({ base: "http://c", runId: "run_2", parentRunId: "run_1", ticket: "T47-S4", brief: `This milestone's deck: ${deck}\nDo the row.`, deckUrl: deck });
    expect(named.split(deck).length - 1).toBe(1);
    expect(workerMessage({ base: "http://c", runId: "run_2", parentRunId: "run_1", ticket: "T47-S4", brief: "Do the row." })).not.toContain("deck");
  });
});

class FakeT3 implements Partial<T3Client> {
  async launchThread() { return { threadId: "thread_new" }; }
  async sendToThread() {}
  async readThreadStatus() { return { status: "idle", raw: {} }; }
}

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe("T47-S4 r4: a real wake carries its milestone's deck (acme only)", () => {
  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e47s4-"));
    const repo = path.join(dir, "repo");
    fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
    fs.writeFileSync(path.join(repo, "docs/epic.md"), "# PLAN-47: Book\n## Current State\nStatus: active\nNext action: build\n");
    const db: DB = openDb(path.join(dir, "c.db"));
    const store = createStore(db);
    const disp = { async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; }, async done() {}, async status() { return { name: "pool", capacity: 2, available: 1 }; } };
    const cycle = createCycle(db, store, { enabled: true, t3: new FakeT3() as unknown as T3Client, dispatcher: disp, publicUrl: "http://x", teamUrl: "https://team.example", repoDir: () => repo } as never);
    cleanup = () => { cycle.stop(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
    const wakeOf = (world?: string) => {
      const m = store.createMilestone({ title: "M", repo: "home_repo", path: "docs/epic.md", owner: "", paused: false });
      const p = store.createPersona({ name: "Delivery Manager", remit: "r", skills: [], model: "claude-sonnet-5-5", mayWrite: true, host: "host1" });
      if (world) {
        db.prepare("INSERT OR IGNORE INTO tenants (id, name, skin, plan, owner_handle, owner_name, created_at) VALUES (?, 'W', 'social', 'founding', 'Ana', 'Ana B.', ?)").run(world, new Date().toISOString());
        db.prepare("UPDATE milestones SET tenant_id = ? WHERE id = ?").run(world, m.id);
        db.prepare("UPDATE personas SET tenant_id = ? WHERE id = ?").run(world, p.id);
      }
      const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 30 }, enabled: true });
      return { m, wake: () => cycle.wake(a.id, { threadId: "thread_1" }) };
    };
    return { wakeOf };
  }

  it("an acme milestone's wake opens with its Deck tab; another world's has none", async () => {
    const t = setup();
    const own = t.wakeOf();
    const w = await own.wake();
    const url = `https://team.example/milestones/${own.m.id}?tab=deck`;
    expect(w.prompt).toContain(`## This milestone's deck: read it first\n- This milestone's deck: ${url}`);
    expect(w.prompt).toContain(`Its brief opens with the line \`This milestone's deck: ${url}\``);
    const other = await t.wakeOf("memo").wake();
    expect(other.prompt).not.toContain("This milestone's deck");
  });
});
