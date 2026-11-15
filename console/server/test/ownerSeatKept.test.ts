import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createCycle } from "../src/cycle/service.js";
import type { T3Client, T3MessagePage, T3ThreadMessage } from "../src/t3/client.js";
import { runnerDispatcher } from "../src/t3/dispatcher.js";
import { ownerSeatFree, ownerSeatOf, seatBlockerFor } from "../src/adapters/seats.js";
import { createChatSession, migrateDeskSessions, SEAT_MOVE } from "../src/desk/session.js";
import { ownerName } from "../src/identity.js";

/**
 * One seat is kept for the owner. The broker's seats.json names it
 * (`owner_seat`); persona wakes never run on it (a home thread there moves off), his Team desk moves onto it, his desk's
 * pick asks `pick --for owner`, and a wake carrying his own note falls back to it only when no other seat is free.
 */

let db: DB | undefined;
let dir: string | undefined;
let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  db?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  db = dir = stop = undefined;
});

const seatRow = (five = 20, limited = false) => ({
  logged_in: true,
  maxed_until: null,
  in_flight: 0,
  usage: { known: true, five_hour_pct: five, weekly_pct: 10, status: limited ? "limited" : "ok" },
});
function writeSeats(file: string, kept: string | undefined, seats: Record<string, ReturnType<typeof seatRow>>) {
  fs.writeFileSync(file, JSON.stringify({ ...(kept ? { owner_seat: kept } : {}), seats }));
}
function tmp(prefix: string) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(dir, "seats.json");
}

/** Picks from `seats` in order (a null entry refuses with `reason`); `--for owner` picks answer `owner` when set. */
function fakeDispatcher(seats: (string | null)[], o: { owner?: string; reason?: string } = {}) {
  const calls: string[][] = [];
  let i = 0;
  const d = runnerDispatcher(async (args) => {
    calls.push(args);
    if (args[0] === "pick") {
      const seat = args.includes("owner") && o.owner ? o.owner : seats[Math.min(i++, seats.length - 1)];
      return seat
        ? JSON.stringify({ id: seat, via: "t3_delegate_task", providerInstanceId: `claudeAgent_${seat}` })
        : JSON.stringify({ id: null, reason: o.reason ?? "no seat: seat1 limited until 2099-01-01T00:00:00Z; seat4 kept for Sam" });
    }
    if (args[0] === "sessions") return JSON.stringify({ host: "host1", live: 1, cap: 6 });
    return JSON.stringify({ ok: true });
  });
  return { d, calls, picks: () => calls.filter((c) => c[0] === "pick") };
}

describe("seats.json names the kept seat", () => {
  it("ownerSeatOf reads owner_seat only when it is a known seat", () => {
    expect(ownerSeatOf({ owner_seat: "seat4", seats: { seat4: {} } })).toBe("seat4");
    expect(ownerSeatOf({ owner_seat: "seat9", seats: { seat4: {} } })).toBeUndefined();
    expect(ownerSeatOf({ seats: { seat4: {} } })).toBeUndefined();
  });

  it("a persona's blocker refuses the kept seat; the owner's desks never do", () => {
    const f = tmp("e6s115a-");
    writeSeats(f, "seat4", { seat1: seatRow(), seat4: seatRow() });
    expect(seatBlockerFor(f, { persona: true, owner: "Sam" })("seat4")).toBe("seat4 kept for Sam");
    expect(seatBlockerFor(f, { persona: true, owner: "Sam" })("seat1")).toBeUndefined();
    expect(seatBlockerFor(f)("seat4")).toBeUndefined();
  });

  it("ownerSeatFree: only while the broker would give it (ok status, under the 5-hour skip line)", () => {
    const f = tmp("e6s115b-");
    writeSeats(f, "seat4", { seat1: seatRow(), seat4: seatRow(30) });
    expect(ownerSeatFree(f)).toBe("seat4");
    writeSeats(f, "seat4", { seat1: seatRow(), seat4: seatRow(92) });
    expect(ownerSeatFree(f)).toBeUndefined();
    writeSeats(f, "seat4", { seat1: seatRow(), seat4: seatRow(100, true) });
    expect(ownerSeatFree(f)).toBeUndefined();
    writeSeats(f, undefined, { seat1: seatRow() });
    expect(ownerSeatFree(f)).toBeUndefined();
    expect(ownerSeatFree("/nonexistent/seats.json")).toBeUndefined();
  });

  it("the dispatcher's owner pick asks `pick --for owner`", async () => {
    const x = fakeDispatcher(["seat1"], { owner: "seat4" });
    expect(await x.d.pick({ for: "owner" })).toMatchObject({ seat: "seat4" });
    expect(await x.d.pick()).toMatchObject({ seat: "seat1" });
    expect(x.picks()).toEqual([["pick", "--for", "owner"], ["pick"]]);
  });
});

// ---------- desk chats ----------
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

function desk(seats: (string | null)[], o: { owner?: string; tenant?: string; prefer?: boolean } = {}) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "e6s115d-"));
  db = openDb(path.join(dir, "d.db"));
  migrateDeskSessions(db);
  if (o.tenant) db.prepare("INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)").run(o.tenant, o.tenant, new Date().toISOString());
  const t3 = new DeskT3();
  const disp = fakeDispatcher(seats, { owner: o.owner });
  const kept = { seat: undefined as string | undefined };
  const chat = createChatSession(
    { db, store: createStore(db), t3, dispatcher: disp.d, sendWaitMs: 50, ownerSeat: () => kept.seat },
    {
      key: "team",
      repo: "home_repo",
      title: "Team desk",
      personaName: "Team desk",
      ...(o.tenant ? { tenant: o.tenant } : {}),
      remit: () => "r",
      seedMarker: "[desk seed]",
      updateMarker: "[desk update]",
      seedVersion: 1,
      seed: ({ summary }) => `[desk seed]\n${summary ?? ""}`,
      update: () => "[desk update] v1",
      unavailable: "off",
      preferOwnerSeat: o.prefer ?? true,
    },
  );
  return { t3, disp, chat, kept };
}

describe("his Team desk runs on the seat kept for him", () => {
  it("the desk's launch asks the owner pick", async () => {
    const d = desk(["seat2"], { owner: "seat4" });
    await d.chat.view();
    expect(d.disp.picks()).toEqual([["pick", "--for", "owner"]]);
    expect(d.t3.ops("launchThread")[0].args.modelSelection.instanceId).toBe("claudeAgent_seat4");
  });

  it("a desk on another seat moves to the kept seat before his send, once", async () => {
    const d = desk(["seat2"]); // no kept seat yet: the desk launched on seat2
    await d.chat.view();
    expect(d.chat.current()!.seat).toBe("seat2");
    d.kept.seat = "seat4";
    const fake = d.disp as any;
    fake.d.pick = async () => ({ seat: "seat4", providerInstanceId: "claudeAgent_seat4" });
    const out = await d.chat.send("hello");
    expect(out.threadId).toBe("desk2");
    expect(d.t3.ops("launchThread")[1].args.modelSelection.instanceId).toBe("claudeAgent_seat4");
    expect(db!.prepare("SELECT thread_id, seat, end_reason FROM desk_session ORDER BY seq").all()).toEqual([
      { thread_id: "desk1", seat: "seat2", end_reason: `${SEAT_MOVE}seat2: the Team desk goes to seat4, the seat kept for ${ownerName()}` },
      { thread_id: "desk2", seat: "seat4", end_reason: null },
    ]);
    await d.chat.send("again"); // already there: no further move
    expect(d.t3.ops("launchThread")).toHaveLength(2);
  });

  it("the broker does not give the kept seat: the desk stays where it is (no thread launched)", async () => {
    const d = desk(["seat2", "seat3"]);
    await d.chat.view();
    d.kept.seat = "seat4"; // seats.json says free, the broker answers another seat (it is near its limit after all)
    const out = await d.chat.send("hello");
    expect(out.threadId).toBe("desk1");
    expect(d.t3.ops("launchThread")).toHaveLength(1);
    expect(d.disp.calls.filter((c) => c[0] === "done").map((c) => c[1])).toContain("seat3"); // the stray pick is released
  });

  it("another world's desk never asks the owner pick nor moves to his seat", async () => {
    const d = desk(["seat2"], { owner: "seat4", tenant: "other-world" });
    await d.chat.view();
    d.kept.seat = "seat4";
    await d.chat.send("hello");
    expect(d.disp.picks()).toEqual([["pick"]]);
    expect(d.t3.ops("launchThread")).toHaveLength(1);
  });

  it("a chat without preferOwnerSeat (a repo desk) stays on its seat", async () => {
    const d = desk(["seat2"], { prefer: false });
    await d.chat.view();
    d.kept.seat = "seat4";
    await d.chat.send("hello");
    expect(d.t3.ops("launchThread")).toHaveLength(1);
  });
});

// ---------- persona wakes ----------
class WakeT3 implements T3Client {
  sent: string[] = [];
  launched: { threadId: string; instanceId?: string }[] = [];
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
  async readThreadStatus() {
    return { status: "idle", runs: [], raw: {} };
  }
  async readLastError() {
    return undefined;
  }
}

async function wakes(seats: (string | null)[], owner?: string) {
  const seatsFile = tmp("e6s115w-");
  db = openDb(path.join(dir!, "cy.db"));
  writeSeats(seatsFile, undefined, { seat1: seatRow(), seat2: seatRow(), seat4: seatRow() });
  const t3 = new WakeT3();
  const disp = fakeDispatcher(seats, { owner });
  const store = createStore(db);
  const cycle = createCycle(db, store, { enabled: true, t3, dispatcher: disp.d, publicUrl: "http://x", sendRetryMs: 0, seatsFile, deferMaxMs: 60_000 });
  stop = () => cycle.stop();
  const m = store.createMilestone({ title: "M", repo: "/srv/agent/github/home_repo", path: "", owner: "", paused: false });
  const p = store.createPersona({ name: "Delivery Manager", remit: "r", skills: [], model: "sonnet", mayWrite: false, host: "host1" });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 120 }, enabled: true });
  const first = await cycle.runNow(a.id); // home1 on the first seat of the list
  store.updateRun(first.id, { outcome: "progressed", endedAt: new Date().toISOString() });
  return { t3, disp, store, cycle, a, keep: (k: string) => writeSeats(seatsFile, k, { seat1: seatRow(), seat2: seatRow(), seat4: seatRow() }) };
}

describe("persona wakes never run on the kept seat", () => {
  it("a home thread on the seat now kept for him moves to a new home thread on another seat", async () => {
    const t = await wakes(["seat4", "seat2"]);
    t.keep("seat4");
    const run = await t.cycle.runNow(t.a.id);
    expect(t.t3.sent).toEqual([]);
    expect(t.store.getRun(run.id)!).toMatchObject({ seat: "seat2", threadId: "home2" });
    expect(t.store.getRun(run.id)!.preWake).toContain(`home seat seat4 kept for ${ownerName()}`);
  });

  it("a wake with his own note falls back to his seat when no other seat is free; a plain wake waits", async () => {
    const t = await wakes(["seat1", null], "seat4");
    t.keep("seat1"); // seat1 (home1) is kept now, so both wakes need a new home thread and every other pick refuses
    const plain = await t.cycle.runNow(t.a.id);
    expect(t.t3.launched).toHaveLength(1); // deferred: no new home thread, nothing sent
    expect(t.t3.sent).toEqual([]);
    expect(t.disp.picks().some((c) => c.includes("owner"))).toBe(false);
    t.store.updateRun(plain.id, { outcome: "idle", endedAt: new Date().toISOString() });
    const mine = await t.cycle.runNow(t.a.id, { instructions: "do the thing", instructionsBy: ownerName() });
    expect(t.disp.picks().at(-1)).toEqual(["pick", "--for", "owner"]);
    expect(t.store.getRun(mine.id)!).toMatchObject({ seat: "seat4", threadId: "home2" });
    expect(t.t3.launched[1].instanceId).toBe("claudeAgent_seat4");
  });
});
