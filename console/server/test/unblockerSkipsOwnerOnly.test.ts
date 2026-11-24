import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { T3Client, T3ModelSelection } from "../src/t3/client.js";
import { createStore, type OpenAsk, type Run } from "../src/store.js";
import { createCycle } from "../src/cycle/service.js";
import { carriedLabel, classifyAsks, memorySkipDecision, readAskMemory, rememberChecks, withCarriedChecks, withPrints } from "../src/cycle/askMemory.js";
import { OWNER_ONLY_RUN, ownerOnly, ownerOnlyWords } from "../src/cycle/ownerOnly.js";
import { textHash } from "../src/cycle/skipUnchanged.js";
import { gitOut } from "../src/freshness.js";
import {
  type CheckResult,
  NEW_ASK_NOTE_BY,
  UNBLOCKER_BACKSTOP_MINUTES,
  createNewAskWaker,
  defaultCadenceFor,
  gitAuthorRun,
  readSeen,
} from "../src/cycle/newAskWake.js";

/**
 * The Unblocker skips an ask only the owner can do and one already left on the hard floor whose wording alone changed
 * (test setup as the new-ask wake test's: a new open ask after a pull wakes the milestone's switched-on Unblocker within the debounce, once per batch;
 * never an off Unblocker (L-10), never for asks it wrote itself or already assessed (memory); its cadence is a
 * 6 h backstop).
 */
class FakeT3 implements T3Client {
  launches: { title: string; message?: string; modelSelection?: T3ModelSelection }[] = [];
  async listProjects() {
    return [{ id: "proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }];
  }
  async listScheduledTasks() { return []; }
  async updateScheduledTask() { return undefined; }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread(input: { title: string; message?: string; modelSelection?: T3ModelSelection }) {
    this.launches.push(input);
    return { threadId: `thread${this.launches.length}` };
  }
  async sendToThread() {}
  async readThreadStatus() { return { status: "idle", raw: {} }; }
}
const disp = { async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; }, async done() {} };

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

const ask = (code: string, line = 40): OpenAsk => ({ code, kind: "decide", path: "docs/PLAN-0-ROOT.md", line, textHash: textHash(`${code} text`) });

function setup(o: { enabled?: boolean; authorRun?: (dir: string, rel: string, line: number) => Promise<string | undefined> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-owner-only-"));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  const db: DB = openDb(path.join(dir, "c.db"));
  const store = createStore(db);
  const t3 = new FakeT3();
  const state = { asks: [] as OpenAsk[] };
  const cycle = createCycle(db, store, { enabled: true, t3, dispatcher: disp, publicUrl: "http://x", openAsks: async () => state.asks, grants: async () => [], repoDir: () => repo });
  const m = store.createMilestone({ title: "M", repo: "home_repo", path: "docs/PLAN-0-ROOT.md", owner: "", paused: false });
  const p = store.createPersona({ name: "Unblocker", remit: "answer asks", skills: [], model: "claude-opus-5-5", mayWrite: true, freshThreadEachWake: true });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: defaultCadenceFor("Unblocker"), enabled: o.enabled ?? true });
  const waker = createNewAskWaker({
    db,
    store,
    openAsks: async () => state.asks,
    grants: async () => [],
    repoDir: () => repo,
    authorRun: o.authorRun,
    wake: (id, note, by) => cycle.runNow(id, { instructions: note, instructionsBy: by }),
    debounceMs: 30,
  });
  cleanup = () => {
    waker.stop();
    cycle.stop();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const runs = () => store.listRuns({ assignmentId: a.id }).filter((r) => !r.parentRunId);
  /** A pull moved the checkout; wait out the debounce and the check. */
  const pulled = async () => {
    waker.repoMoved(repo);
    await waker.settled();
  };
  /** The woken Unblocker finishes, assessing every open ask it was given (memory written as on its PATCH). */
  const finish = (run: Run, floor?: string[]) => {
    const asks = withPrints(state.asks, []);
    const ended = store.updateRun(run.id, { outcome: "idle", endedAt: new Date().toISOString(), openAsks: asks, checks: asks.map((x) => ({ code: x.code, decision: "left" as const, why: "floor", ...(floor ? { floor } : {}) })) } as never)!;
    rememberChecks(db, ended, m.id);
  };
  return { db, store, t3, state, cycle, waker, m, p, a, repo, runs, pulled, finish };
}

const only = (code: string, kind: string, whyYou?: string, line = 40): OpenAsk => {
  const j = ownerOnly(kind, whyYou);
  return { ...ask(code, line), kind, ...(j ? { ownerOnly: j } : {}) };
};

describe("which asks are the owner's alone", () => {
  it("names the owner's identity, money, phone or computer, a public send, and the do label", () => {
    expect(ownerOnly("approve", "it goes out in your name from your own mailbox")?.floor).toBe("new_public_exposure");
    expect(ownerOnly("decide", "only you can send words to your father")?.floor).toBe("new_public_exposure");
    expect(ownerOnly("approve", "it publishes in your name")?.floor).toBe("new_public_exposure");
    expect(ownerOnly("decide", "a public price, and money")?.floor).toBe("new_money");
    expect(ownerOnly("approve", "it spends your Stars, or you name a tester to do it")?.floor).toBe("new_money");
    expect(ownerOnly("do", "your card and your phone")?.floor).toBe("new_money");
    expect(ownerOnly("do", "this is a setting inside your own phone or Mac")?.floor).toBe("jordi_hands");
    expect(ownerOnly("provide", "the consent needs your own sign-in; no agent has it")?.floor).toBe("jordi_hands");
    expect(ownerOnly("provide", "only you can open your Bitwarden.")?.floor).toBe("jordi_hands");
    expect(ownerOnly("do", undefined)).toEqual({ floor: "jordi_hands", why: `${ownerOnlyWords()} (a step taken in person)` });
  });

  it("leaves a taste call, a key result or a card he asked for to the Unblocker", () => {
    expect(ownerOnly("decide", "a taste and product call")).toBeUndefined();
    expect(ownerOnly("approve", "only you set your key results")).toBeUndefined();
    expect(ownerOnly("decide", "only you know what you want added, and you asked for this card")).toBeUndefined();
    expect(ownerOnly("decide", "names are the brand, his call")).toBeUndefined();
    expect(ownerOnly("approve", undefined)).toBeUndefined();
  });
});

describe("the Unblocker skips asks only the owner can do", () => {
  it("a new owner-only ask after a pull wakes nobody; a new ordinary ask still does", async () => {
    const t = setup();
    t.state.asks = [only("E907-A28", "approve", "it goes out in your name to an outside tester"), only("E948-A24", "do")];
    await t.pulled();
    expect(t.runs()).toHaveLength(0);
    expect(t.t3.launches).toHaveLength(0);
    t.state.asks.push(ask("E909-A1", 41));
    await t.pulled();
    expect(t.runs()).toHaveLength(1);
    expect(t.runs()[0].instructions).toContain("E909-A1");
    expect(t.runs()[0].instructions).not.toContain("E907-A28");
  });

  it("an owner-only ask is carried as left with its floor, and a cadence wake with only those skips", () => {
    const asks = [only("E995-A8", "provide", "Exa's human check needs your own browser")];
    const s = classifyAsks(asks, [], []);
    expect(s[0]).toMatchObject({ status: "unchanged", memory: { runId: OWNER_ONLY_RUN, verdict: "left" } });
    expect(s[0].memory!.check.floor).toEqual(["jordi_hands"]);
    const earlier = { id: "run_1", assignmentId: "a", outcome: "idle", summary: "answered 0 · left 1", startedAt: "2026-11-24T00:00:00Z", endedAt: "2026-11-24T00:05:00Z", askFingerprint: "x" } as Run;
    const d = memorySkipDecision([earlier], asks, s);
    expect(d.skip).toBe(true);
    if (d.skip) expect(d.summary).toContain(`E995-A8 left (${ownerOnlyWords()})`);
    expect(carriedLabel(OWNER_ONLY_RUN)).toBe(`left (${ownerOnlyWords()})`);
    // the finishing PATCH gets its carried left even though no run ever assessed it
    const checks = withCarriedChecks([{ ...asks[0], carriedFrom: OWNER_ONLY_RUN }], [], []);
    expect(checks).toEqual([expect.objectContaining({ code: "E995-A8", decision: "left", carriedFrom: OWNER_ONLY_RUN, floor: ["jordi_hands"] })]);
  });

  it("an ask already left on the hard floor is not assessed again when only its wording changes", async () => {
    const t = setup();
    t.state.asks = [ask("E938-A4")];
    await t.pulled();
    expect(t.runs()).toHaveLength(1);
    t.finish(t.runs()[0], ["new_public_exposure"]);
    const reworded = { ...ask("E938-A4"), textHash: textHash("E938-A4 reworded") };
    const mem = readAskMemory(t.db, t.m.id);
    expect(classifyAsks([reworded], [], mem)[0].status).toBe("unchanged");
    // the owner's comment on its card is news: assess it again
    expect(classifyAsks([{ ...reworded, commentHash: textHash("go ahead") }], [], mem)[0]).toMatchObject({ status: "changed", changed: ["text", "comment"] });
  });

  it("an ask left off the floor is still assessed again when its wording changes", async () => {
    const t = setup();
    t.state.asks = [ask("E909-A2")];
    await t.pulled();
    t.finish(t.runs()[0]);
    const reworded = { ...ask("E909-A2"), textHash: textHash("E909-A2 reworded") };
    expect(classifyAsks([reworded], [], readAskMemory(t.db, t.m.id))[0]).toMatchObject({ status: "changed", changed: ["text"] });
  });
});
