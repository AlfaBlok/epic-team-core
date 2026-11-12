import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createCycle } from "../src/cycle/service.js";
import { RESENT, USAGE_LIMIT } from "../src/cycle/reconcile.js";
import { lastErrorOf, McpT3Client, type T3Client, type T3MessagePage, type T3ThreadMessage, type T3ThreadRun } from "../src/t3/client.js";
import { runnerDispatcher } from "../src/t3/dispatcher.js";
import { seatBlock, seatBlockerFor, mapSeats } from "../src/adapters/seats.js";
import { createChatSession, migrateDeskSessions, SEAT_MOVE } from "../src/desk/session.js";

/**
 * a persona's home thread (and a desk chat) stays on the seat it launched on. On 2026-11-01 seat1/seat2 hit their
 * 5-hour limit; worker picks avoided them, but cadence / Run-now wakes still went to the old home thread and failed
 * `T3 turn failed, no report` (17:03, 17:11, 18:34, 18:43, 18:45, 19:14Z), and the desks' `[repo-desk update] v7` failed
 * on seat1/seat2 at 18:43Z. Now: (1) a limited / logged-out home seat = a new home thread on a seat with headroom;
 * (2) a turn failed on the usage limit = broker told (maxed_until) + one fresh re-send; (3) no seat with headroom = a
 * deferred wake, never red; (4) a desk on a limited seat moves before the owner's send, its endpoint update waits.
 */

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const SOON = new Date(Date.now() + 2 * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
/** T3's own items on the Delivery Manager's home thread, 2026-11-01 18:45:16Z (turn 259 on seat1). */
const LIMIT_ERR = "Usage limit reached: Claude API rate limit reached. Try again later.";

class FakeT3 implements T3Client {
  sent: string[] = [];
  launched: { threadId: string; instanceId?: string }[] = [];
  turns = new Map<string, T3ThreadRun[]>();
  errors = new Map<string, string>();
  async listProjects() {
    return [{ id: "proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }];
  }
  async listScheduledTasks() {
    return [];
  }
  async updateScheduledTask() {
    return undefined;
  }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread(input: { modelSelection?: { instanceId?: string } }) {
    const threadId = `home${this.launched.length + 1}`;
    this.launched.push({ threadId, instanceId: input.modelSelection?.instanceId });
    return { threadId };
  }
  async sendToThread(threadId: string) {
    this.sent.push(threadId);
  }
  async readThreadStatus(threadId: string) {
    const runs = this.turns.get(threadId) ?? [];
    return { status: runs[0]?.status ?? "idle", runs, raw: {} };
  }
  async readLastError(threadId: string) {
    return this.errors.get(threadId);
  }
}

/** Picks from `seats` in order; a null entry refuses with `reason` (the broker's no-seat answer). */
function fakeDispatcher(seats: (string | null)[], reason = `no seat: seat1 limited until ${SOON}; seat2 limited until ${SOON}`) {
  const calls: string[][] = [];
  let i = 0;
  const d = runnerDispatcher(async (args) => {
    calls.push(args);
    if (args[0] === "pick") {
      const seat = seats[Math.min(i++, seats.length - 1)];
      return seat ? JSON.stringify({ id: seat, via: "t3_delegate_task", providerInstanceId: `claudeAgent_${seat}` }) : JSON.stringify({ id: null, reason });
    }
    if (args[0] === "sessions") return JSON.stringify({ host: "host1", live: 1, cap: 6 });
    return JSON.stringify({ ok: true });
  });
  return { d, calls, set: (s: (string | null)[]) => ((seats = s), (i = 0)) };
}

let db: DB | undefined;
let dir: string | undefined;
let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  db?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  db = dir = stop = undefined;
  vi.unstubAllGlobals();
});

type SeatState = { limitedUntil?: string; loggedOut?: boolean };
function writeSeats(file: string, seats: Record<string, SeatState>) {
  const out: Record<string, unknown> = {};
  for (const [id, s] of Object.entries(seats))
    out[id] = {
      logged_in: !s.loggedOut,
      maxed_until: s.limitedUntil ?? null,
      in_flight: 0,
      usage: { known: true, five_hour_pct: s.limitedUntil ? 100 : 20, weekly_pct: 10, status: s.limitedUntil ? "limited" : "ok" },
    };
  fs.writeFileSync(file, JSON.stringify({ seats: out }));
}

async function setup(seats: (string | null)[] = ["seat1", "seat2"], extra: { deferMaxMs?: number } = {}) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "e6s47-"));
  db = openDb(path.join(dir, "cy.db"));
  const seatsFile = path.join(dir, "seats.json");
  writeSeats(seatsFile, { seat1: {}, seat2: {} });
  const t3 = new FakeT3();
  const disp = fakeDispatcher(seats);
  const store = createStore(db);
  const cycle = createCycle(db, store, { enabled: true, t3, dispatcher: disp.d, publicUrl: "http://x", sendRetryMs: 0, seatsFile, ...extra });
  stop = () => cycle.stop();
  const m = store.createMilestone({ title: "M", repo: "/srv/agent/github/home_repo", path: "", owner: "", paused: false });
  const p = store.createPersona({ name: "Delivery Manager", remit: "r", skills: [], model: "sonnet", mayWrite: false, host: "host1" });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 120 }, enabled: true });
  const first = await cycle.runNow(a.id); // launches home1 on seat1 (the home thread every later wake sends into)
  store.updateRun(first.id, { outcome: "progressed", endedAt: new Date().toISOString() });
  const age = (runId: string, ms: number) => db!.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(ago(ms), runId);
  const turn = (status: string, startMin: number, endMin?: number): T3ThreadRun => ({
    status,
    requestedAt: ago(startMin * MIN),
    startedAt: ago(startMin * MIN),
    completedAt: endMin === undefined ? null : ago(endMin * MIN),
  });
  const seatsAre = (s: Record<string, SeatState>) => writeSeats(seatsFile, s);
  return { t3, disp, store, cycle, a, age, turn, seatsAre };
}

describe("T6-S47 (1) a wake whose home seat is limited or logged out goes to a new home thread", () => {
  it("seat1 limited: Run now launches home2 on the seat pick returns; home1 is left as is", async () => {
    const t = await setup(["seat1", "seat2"]);
    t.seatsAre({ seat1: { limitedUntil: SOON }, seat2: {} });
    const run = await t.cycle.runNow(t.a.id);
    expect(t.t3.sent).toEqual([]); // nothing into the limited thread
    expect(t.t3.launched.map((l) => l.threadId)).toEqual(["home1", "home2"]);
    expect(t.t3.launched[1].instanceId).toBe("claudeAgent_seat2");
    const r = t.store.getRun(run.id)!;
    expect(r.outcome).toBe("running");
    expect(r.seat).toBe("seat2");
    expect(r.threadId).toBe("home2");
    expect(r.preWake).toContain(`fresh session: home seat seat1 limited until ${SOON}`);
    expect(t.cycle.getLink(t.a.id)).toMatchObject({ threadId: "home2", seat: "seat2" });
    // the next wake, seat2 healthy, sends into home2 (no third thread)
    t.store.updateRun(run.id, { outcome: "progressed", endedAt: new Date().toISOString() });
    await t.cycle.runNow(t.a.id);
    expect(t.t3.sent).toEqual(["home2"]);
    expect(t.t3.launched).toHaveLength(2);
  });

  it("seat1 logged out: same move", async () => {
    const t = await setup(["seat1", "seat3"]);
    t.seatsAre({ seat1: { loggedOut: true }, seat3: {} });
    const run = await t.cycle.runNow(t.a.id);
    expect(t.t3.sent).toEqual([]);
    expect(t.store.getRun(run.id)!).toMatchObject({ seat: "seat3", threadId: "home2" });
    expect(t.store.getRun(run.id)!.preWake).toContain("fresh session: home seat seat1 logged out");
  });

  it("seat1 healthy: the wake goes into home1 as before (no pick, no new thread)", async () => {
    const t = await setup();
    const picks = t.disp.calls.filter((c) => c[0] === "pick").length;
    await t.cycle.runNow(t.a.id);
    expect(t.t3.sent).toEqual(["home1"]);
    expect(t.disp.calls.filter((c) => c[0] === "pick")).toHaveLength(picks);
  });
});

describe("T6-S47 (2) a turn that failed on the seat's usage limit", () => {
  it("the broker is told with T3's text (sets maxed_until) and the wake goes once to a new home thread on a healthy seat", async () => {
    const t = await setup(["seat1", "seat2"]);
    const run = await t.cycle.runNow(t.a.id); // seats.json still said ok: sent into home1 on seat1
    expect(t.t3.sent).toEqual(["home1"]);
    t.age(run.id, 6 * MIN);
    t.t3.turns.set("home1", [t.turn("failed", 5, 5)]);
    t.t3.errors.set("home1", `${LIMIT_ERR} (limited until ${SOON})`);
    await t.cycle.reconcile();
    const r = t.store.getRun(run.id)!;
    expect(r.outcome).toBe("running"); // not "T3 turn failed, no report from persona"
    expect(r.summary).toContain(`${RESENT} on a new thread: T3 turn failed: ${LIMIT_ERR}`);
    const done = t.disp.calls.find((c) => c[0] === "done" && c.includes("--signal"))!;
    expect(done.slice(0, 3)).toEqual(["done", "seat1", "--fail"]);
    expect(done[4]).toContain(`limited until ${SOON}`);
    expect(r).toMatchObject({ threadId: "home2", seat: "seat2" });
    expect(t.store.getRun(run.id)!.preWake).toContain("fresh session: seat1 hit its usage limit");
  });

  it("every limit wording the broker knows is matched (LIMIT_RE twin)", () => {
    for (const s of [LIMIT_ERR, "You've hit your session limit · resets 7:50pm (UTC)", "You've hit your 5-hour limit", "rate limit reached", "session limit"])
      expect(USAGE_LIMIT.test(s), s).toBe(true);
    expect(USAGE_LIMIT.test("The provider could not start this turn")).toBe(false);
  });

  it("lastErrorOf names the reset T3 noted for that turn as an ISO time", () => {
    const items = [
      { type: "system_notice", runId: "r259", text: "Claude usage limit reached. This turn is paused until the 5-hour limit resets in 1h 5m.", updatedAt: "2026-11-01T18:45:16.433Z" },
      { type: "assistant_message", runId: "r259", text: "You've hit your session limit · resets 7:50pm (UTC)" },
      { type: "error", runId: "r259", title: "Usage limit reached", text: "Claude API rate limit reached. Try again later." },
    ];
    expect(lastErrorOf(items)).toBe(`${LIMIT_ERR} (limited until 2026-11-01T19:50:16Z)`);
    expect(lastErrorOf(items.slice(2))).toBe(LIMIT_ERR);
  });

  it("McpT3Client.readLastError reads the thread's NEWEST items (a long home thread's first 20 never hold its last error)", async () => {
    const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "e6s47t-")), "token");
    fs.writeFileSync(tokenFile, "tok\n");
    const asked: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        const args = body.params?.arguments ?? {};
        if (body.method === "tools/call") asked.push(args);
        const items =
          args.afterPosition === 2935
            ? [{ position: 2955, type: "error", title: "Usage limit reached", text: "Claude API rate limit reached. Try again later." }]
            : [{ position: 0, type: "user_message", text: "wake" }];
        const result = body.method === "tools/call" ? { structuredContent: { thread: { itemCount: 2956 }, items } } : {};
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "mcp-session-id": "s1" } });
      }),
    );
    const c = new McpT3Client("http://127.0.0.1:1/mcp", tokenFile, [0, 0]);
    expect(await c.readLastError("mcp:dm")).toBe(LIMIT_ERR);
    expect(asked.at(-1)).toMatchObject({ view: "activity", limit: 20, afterPosition: 2935 });
  });
});

describe("T6-S47 (3) no seat with headroom: a deferred retry, never red", () => {
  it("home seat limited and every seat refused: the Run now is deferred, the old thread untouched; it launches once a seat frees", async () => {
    const t = await setup(["seat1", null]);
    t.seatsAre({ seat1: { limitedUntil: SOON }, seat2: { limitedUntil: SOON } });
    const run = await t.cycle.runNow(t.a.id);
    let r = t.store.getRun(run.id)!;
    expect(r.outcome).toBe("deferred");
    expect(r.summary).toMatch(/^Deferred: all seats busy \(seat1 limited until .*\), will retry/);
    expect(t.t3.sent).toEqual([]);
    expect(t.t3.launched).toHaveLength(1);
    t.disp.set(["seat3"]);
    t.seatsAre({ seat1: { limitedUntil: SOON }, seat3: {} });
    await t.cycle.tickDeferred(new Date(Date.now() + 2 * MIN));
    r = t.store.getRun(run.id)!;
    expect(r).toMatchObject({ outcome: "running", seat: "seat3", threadId: "home2" });
  });

  it("the reconciler's re-send after a limit failure finds no seat: deferred, not failed", async () => {
    const t = await setup(["seat1", null]);
    const run = await t.cycle.runNow(t.a.id);
    t.age(run.id, 6 * MIN);
    t.t3.turns.set("home1", [t.turn("failed", 5, 5)]);
    t.t3.errors.set("home1", LIMIT_ERR);
    t.seatsAre({ seat1: { limitedUntil: SOON }, seat2: { limitedUntil: SOON } });
    await t.cycle.reconcile();
    const r = t.store.getRun(run.id)!;
    expect(r.outcome).toBe("deferred");
    expect(r.summary).toContain("all seats busy");
  });

  it("still no seat when the deferral runs out: the wake is skipped (idle), not failed", async () => {
    const t = await setup(["seat1", null], { deferMaxMs: 1 });
    t.seatsAre({ seat1: { limitedUntil: SOON }, seat2: { limitedUntil: SOON } });
    const run = await t.cycle.runNow(t.a.id);
    await new Promise((r) => setTimeout(r, 5));
    await t.cycle.tickDeferred(new Date(Date.now() + 2 * MIN));
    const r = t.store.getRun(run.id)!;
    expect(r.outcome).toBe("idle");
    expect(r.summary).toMatch(/^Wake skipped: all seats busy .* the next wake tries again$/);
  });
});

describe("T6-S47 seatBlock", () => {
  it("names limited / logged-out seats; ok, unknown or missing never block", () => {
    const seats = mapSeats({ seats: { seat1: { maxed_until: SOON, usage: { known: true, five_hour_pct: 100 } }, seat2: { logged_in: false }, seat3: { usage: { known: true, five_hour_pct: 5 } } } });
    expect(seatBlock(seats, "seat1")).toBe(`seat1 limited until ${SOON}`);
    expect(seatBlock(seats, "seat2")).toBe("seat2 logged out");
    expect(seatBlock(seats, "seat3")).toBeUndefined();
    expect(seatBlock(seats, "seat9")).toBeUndefined();
    expect(seatBlockerFor("/nonexistent/seats.json")("seat1")).toBeUndefined();
  });
});

// ---------- (4) desk chats ----------
class DeskT3 implements T3Client {
  calls: { op: string; args: any }[] = [];
  threads = new Map<string, T3ThreadMessage[]>();
  private n = 0;
  private pos = 0;
  ops = (op: string) => this.calls.filter((c) => c.op === op);
  async listProjects() {
    return [{ id: "p", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }];
  }
  async listScheduledTasks() {
    return [];
  }
  async updateScheduledTask() {
    return undefined;
  }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  push(threadId: string, role: "user" | "assistant", text: string) {
    this.threads.get(threadId)!.push({ itemId: `i${++this.pos}`, position: this.pos, role, text, status: "completed", truncated: false, updatedAt: new Date().toISOString() });
  }
  async launchThread(input: { message?: string; modelSelection?: any }) {
    this.calls.push({ op: "launchThread", args: input });
    const threadId = `desk${++this.n}`;
    this.threads.set(threadId, []);
    if (input.message) this.push(threadId, "user", input.message);
    return { threadId };
  }
  async sendToThread(threadId: string, message: string) {
    this.calls.push({ op: "sendToThread", args: { threadId, message } });
    this.push(threadId, "user", message);
  }
  async readThreadStatus() {
    return { status: "idle", raw: {} };
  }
  async readThreadMessages(threadId: string): Promise<T3MessagePage> {
    const messages = this.threads.get(threadId) ?? [];
    return { messages, nextPosition: messages.at(-1)?.position ?? null, hasMore: false, archived: false };
  }
}

function desk(seats: (string | null)[]) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "e6s47d-"));
  db = openDb(path.join(dir, "d.db"));
  migrateDeskSessions(db);
  const t3 = new DeskT3();
  const disp = fakeDispatcher(seats);
  const block: Record<string, string> = {};
  let version = 7;
  const chat = createChatSession(
    { db, store: createStore(db), t3, dispatcher: disp.d, sendWaitMs: 50, seatBlocked: (s) => (s ? block[s] : undefined) },
    {
      key: "milestone:m1",
      repo: "home_repo",
      title: "Repo desk",
      personaName: "Repo desk",
      remit: () => "r",
      seedMarker: "[repo-desk seed]",
      updateMarker: "[repo-desk update]",
      get seedVersion() {
        return version;
      },
      seed: ({ summary }) => `[repo-desk seed]\n${summary ?? ""}`,
      update: () => `[repo-desk update] v${version}`,
      unavailable: "off",
    },
  );
  return { t3, disp, chat, block, bump: () => version++ };
}

describe("T6-S47 (4) desk chats on a limited seat", () => {
  it("Sam's send moves the desk to a seat from pick, seeded with a summary; the old thread is left as is", async () => {
    const d = desk(["seat1", "seat3"]);
    await d.chat.view(); // desk1 on seat1
    d.t3.push("desk1", "assistant", "Placed it under PLAN-18.");
    d.block.seat1 = `seat1 limited until ${SOON}`;
    const out = await d.chat.send("move it to PLAN-17");
    expect(out.threadId).toBe("desk2");
    const launch = d.t3.ops("launchThread")[1].args;
    expect(launch.modelSelection.instanceId).toBe("claudeAgent_seat3");
    expect(launch.message).toContain("desk1");
    expect(launch.message).toContain(`seat1 limited until ${SOON}, so the console moved this chat to a seat with headroom`);
    expect(launch.message).toContain("Placed it under PLAN-18.");
    expect(d.t3.ops("sendToThread").map((c) => c.args.threadId)).toEqual(["desk2"]);
    expect(db!.prepare("SELECT thread_id, seat, end_reason FROM desk_session ORDER BY seq").all()).toEqual([
      { thread_id: "desk1", seat: "seat1", end_reason: `${SEAT_MOVE}seat1 limited until ${SOON}` },
      { thread_id: "desk2", seat: "seat3", end_reason: null },
    ]);
  });

  it("no seat with headroom: the send stays on the old thread and the chat does not fail", async () => {
    const d = desk(["seat1", null]);
    await d.chat.view();
    d.block.seat1 = "seat1 logged out";
    const out = await d.chat.send("hello");
    expect(out.threadId).toBe("desk1");
    expect(d.t3.ops("launchThread")).toHaveLength(1);
    expect(d.chat.current()!.threadId).toBe("desk1");
  });

  it("the endpoint update (syncSeed) waits while the seat is limited and goes once headroom is back; it never relaunches", async () => {
    const d = desk(["seat1", "seat3"]);
    await d.chat.view();
    d.bump(); // v8: the live desk1 has v7
    d.block.seat1 = `seat1 limited until ${SOON}`;
    await d.chat.syncSeed();
    expect(d.t3.ops("sendToThread")).toHaveLength(0);
    expect(d.chat.syncError()).toBeUndefined();
    expect(d.t3.ops("launchThread")).toHaveLength(1);
    delete d.block.seat1;
    await d.chat.syncSeed();
    expect(d.t3.ops("sendToThread").map((c) => c.args)).toEqual([{ threadId: "desk1", message: "[repo-desk update] v8" }]);
  });
});

describe("T6-S47 (manager item 2) a limit whose reset has passed is not a block", () => {
  // seat2 2026-11-01: usage read 19:56Z says limited, maxed_until and the 5h reset 19:59:59Z; at 20:00:10Z it can take work
  const raw = {
    seats: {
      seat2: {
        logged_in: true,
        maxed_until: "2026-11-01T19:59:59Z",
        usage: { known: true, status: "limited", five_hour_pct: 100, five_hour_resets_at: "2026-11-01T19:59:59Z", limited_until: "2026-11-01T19:59:59Z", read_at: "2026-11-01T19:56:00Z" },
      },
    },
  };
  it("after the reset: not limited, seatBlock answers undefined; before it: blocked", () => {
    const after = mapSeats(raw, new Date("2026-11-01T20:00:10Z"));
    expect(after[0]).toMatchObject({ limited: false });
    expect(seatBlock(after, "seat2")).toBeUndefined();
    const before = mapSeats(raw, new Date("2026-11-01T19:58:00Z"));
    expect(before[0]).toMatchObject({ limited: true, status: "limited" });
    expect(seatBlock(before, "seat2")).toBe("seat2 limited until 2026-11-01T19:59:59Z");
  });
  it("a usage-limited status with no reset time stays limited; a future maxed_until wins over a passed usage reset", () => {
    expect(mapSeats({ seats: { s: { logged_in: true, usage: { known: true, status: "limited" } } } })[0].limited).toBe(true);
    const later = new Date(Date.now() + 3600_000).toISOString();
    const s = mapSeats({ seats: { s: { maxed_until: later, usage: { known: true, status: "limited", limited_until: "2026-01-01T00:00:00Z" } } } })[0];
    expect(s.limited).toBe(true);
  });
});
