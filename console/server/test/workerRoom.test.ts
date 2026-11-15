import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import type { T3Client } from "../src/t3/client.js";
import { createStore } from "../src/store.js";
import { createWorkerRoom, memAvailableMb, roomFor, roomyMaxFromEnv, type Room } from "../src/cycle/workerRoom.js";

/** up to 14 workers per milestone while the broker has free seats and the worker server's memory has room; 10 otherwise. */
class FakeT3 implements T3Client {
  n = 0;
  async listProjects() { return [{ id: "proj", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }]; }
  async listScheduledTasks() { return []; }
  async updateScheduledTask() { return undefined; }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread() { return { threadId: `thread${++this.n}` }; }
  async sendToThread() {}
  async readThreadStatus() { return { status: "idle", raw: {} }; }
}
const disp = { async pick() { return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" }; }, async done() {} };

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function setup(seatsFree: number, memMb: number | null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-room-"));
  const db: DB = openDb(path.join(dir, "c.db"));
  const store = createStore(db);
  const workerRoom = createWorkerRoom({ base: 10, roomy: 14, seatsFree: async () => seatsFree, memMb: async () => memMb });
  const app = createApp(db, { cycle: { enabled: true, t3: new FakeT3(), dispatcher: disp, publicUrl: "http://x", maxWorkersPerMilestone: 10, workerRoom } });
  cleanup = () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  const m = store.createMilestone({ title: "M", repo: "/srv/agent/github/home_repo", path: "", owner: "", paused: false });
  const p = store.createPersona({ name: "mgr", remit: "my remit", skills: [], model: "sonnet", mayWrite: false, host: "host1" });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 240 }, enabled: true });
  const parent = store.createRun({ assignmentId: a.id, outcome: "progressed", summary: "earlier", endedAt: new Date().toISOString() });
  for (let i = 0; i < 10; i++) store.createRun({ assignmentId: a.id, parentRunId: parent.id, outcome: "running", summary: `T${i}` });
  const wake = async () => {
    const res = await app.request(`/api/assignments/${a.id}/wake?format=json`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    return ((await res.json()) as { prompt: string }).prompt;
  };
  return { wake };
}

describe("room-aware worker ceiling", () => {
  it("free seats and memory over the room line: the wake allows 14 and says so", async () => {
    const prompt = await setup(10, 7000).wake();
    expect(prompt).toContain("Run at most 14 child workers at once");
    expect(prompt).toContain("you may launch 4 more");
    expect(prompt).toContain("Room now: 14 workers allowed for this milestone (10 free seats, worker server memory 7000 MB (room line 5400 MB))");
  });

  it("no free seat: back to 10", async () => {
    const prompt = await setup(0, 7000).wake();
    expect(prompt).toContain("Run at most 10 child workers at once");
    expect(prompt).toContain("you may launch 0 more");
    expect(prompt).toContain("Room now: 10 workers allowed for this milestone (0 free seats");
  });

  it("memory short of the room line, or unreadable: back to 10", async () => {
    expect(await setup(5, 5000).wake()).toContain("Run at most 10 child workers at once");
    expect(await setup(5, null).wake()).toContain("worker server memory unreadable");
  });
});

describe("room rule", () => {
  it("roomy only when both readings are known and have room", () => {
    expect(roomFor({ base: 10, roomy: 14, seatsFree: 1, memMb: 5400 }).max).toBe(14);
    expect(roomFor({ base: 10, roomy: 14, seatsFree: 1, memMb: 5399 }).max).toBe(10);
    expect(roomFor({ base: 10, roomy: 14, seatsFree: 0, memMb: 9000 }).max).toBe(10);
    expect(roomFor({ base: 10, roomy: 14, seatsFree: null, memMb: 9000 }).max).toBe(10);
  });

  it("reads MemAvailable, caches a minute, and a failing reader means no room", async () => {
    expect(memAvailableMb("MemTotal: 16000000 kB\nMemAvailable:    7340032 kB\n")).toBe(7168);
    expect(memAvailableMb("nothing")).toBeNull();
    let calls = 0;
    let t = 0;
    const room = createWorkerRoom({ base: 10, roomy: 14, seatsFree: async () => { calls++; return 3; }, memMb: async () => { throw new Error("ssh down"); }, now: () => t });
    const r: Room = await room();
    expect(r.max).toBe(10);
    await room();
    expect(calls).toBe(1);
    t = 60_000;
    await room();
    expect(calls).toBe(2);
  });

  it("the env number never goes under the flat ceiling", () => {
    expect(roomyMaxFromEnv("16", 10)).toBe(16);
    expect(roomyMaxFromEnv("8", 10)).toBe(10);
    expect(roomyMaxFromEnv(undefined, 10)).toBe(14);
  });
});
