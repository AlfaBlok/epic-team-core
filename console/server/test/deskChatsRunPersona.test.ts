import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import type { T3Client, T3MessagePage, T3ThreadMessage } from "../src/t3/client.js";
import { runnerDispatcher } from "../src/t3/dispatcher.js";
import { createChatSession, HOST_MOVE, migrateDeskSessions, type DeskHost } from "../src/desk/session.js";

/**
 * desk chats (Team desk, repo desks, world desks) launched on the main server's T3 whatever their persona's host, so the desks
 * could not move off the main server. Now a chat launches on its persona's host (the worker server over the console's tunnel, picking through that
 * host's dispatcher) and every read and send of a thread goes to the host it runs on.
 */

class DeskT3 implements T3Client {
  calls: { op: string; args: any }[] = [];
  threads = new Map<string, T3ThreadMessage[]>();
  private n = 0;
  private pos = 0;
  constructor(readonly name: string) {}
  ops = (op: string) => this.calls.filter((c) => c.op === op);
  async listProjects() {
    this.calls.push({ op: "listProjects", args: {} });
    return [{ id: `p-${this.name}`, title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo" }];
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
    this.threads.get(threadId)!.push({ itemId: `${this.name}-i${++this.pos}`, position: this.pos, role, text, status: "completed", truncated: false, updatedAt: new Date().toISOString() });
  }
  async launchThread(input: { message?: string; modelSelection?: any; projectId: string }) {
    this.calls.push({ op: "launchThread", args: input });
    const threadId = `${this.name}-desk${++this.n}`;
    this.threads.set(threadId, []);
    if (input.message) this.push(threadId, "user", input.message);
    return { threadId };
  }
  async sendToThread(threadId: string, message: string) {
    this.calls.push({ op: "sendToThread", args: { threadId, message } });
    if (!this.threads.has(threadId)) throw new Error(`thread ${threadId} not found`);
    this.push(threadId, "user", message);
  }
  async settleThread(threadId: string) {
    this.calls.push({ op: "settleThread", args: { threadId } });
  }
  async readThreadStatus(threadId: string) {
    this.calls.push({ op: "readThreadStatus", args: { threadId } });
    if (!this.threads.has(threadId)) throw new Error(`thread ${threadId} not found`);
    return { status: "idle", raw: {} };
  }
  async readThreadMessages(threadId: string): Promise<T3MessagePage> {
    this.calls.push({ op: "readThreadMessages", args: { threadId } });
    if (!this.threads.has(threadId)) throw new Error(`thread ${threadId} not found`);
    const messages = this.threads.get(threadId)!;
    return { messages, nextPosition: messages.at(-1)?.position ?? null, hasMore: false, archived: false };
  }
}

const dispatcher = (host: string, picks: string[]) =>
  runnerDispatcher(async (args) => {
    picks.push(`${host}:${args[0]}`);
    if (args[0] === "pick") return JSON.stringify({ id: "seat2", via: "t3_delegate_task", providerInstanceId: "claudeAgent_seat2" });
    return JSON.stringify({ ok: true });
  });

let db: DB | undefined;
let dir: string | undefined;
afterEach(() => {
  db?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  db = dir = undefined;
});

function desk(o: { host: DeskHost; wired?: boolean }) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "e6s56-"));
  db = openDb(path.join(dir, "d.db"));
  migrateDeskSessions(db);
  const store = createStore(db);
  const persona = store.createPersona({ name: "Team desk", remit: "r", skills: [], model: "claude-opus-5-5", mayWrite: true, host: o.host });
  const main = new DeskT3("main");
  const worker = new DeskT3("worker");
  let vps3Up = true;
  const picks: string[] = [];
  const marks: string[] = [];
  const gate = { take: () => ({ ok: true as const, token: "t" }), cancel: () => undefined, mark: (why: string) => void marks.push(why) };
  const chat = createChatSession(
    {
      db,
      store,
      t3: main,
      dispatcher: dispatcher("main", picks),
      sendWaitMs: 50,
      startGate: gate as any,
      environmentId: () => "env-main",
      ...(o.wired === false
        ? {}
        : {
            clientFor: (h: DeskHost) => (h === "main" ? main : vps3Up ? worker : undefined),
            dispatcherFor: (h: DeskHost) => dispatcher(h, picks),
            environmentIdFor: (h: DeskHost) => `env-${h}`,
          }),
    },
    {
      key: "team",
      repo: "home_repo",
      title: "Team desk",
      personaName: "Team desk",
      remit: () => "r",
      seedMarker: "[team-desk seed]",
      updateMarker: "[team-desk update]",
      seedVersion: 1,
      seed: ({ summary }) => `[team-desk seed]\n${summary ?? ""}`,
      update: () => "[team-desk update] v1",
      unavailable: "off",
    },
  );
  const moveTo = (h: DeskHost) => db!.prepare("UPDATE personas SET host = ? WHERE id = ?").run(h, persona.id);
  return { main, worker, chat, picks, marks, moveTo, setVps3: (up: boolean) => (vps3Up = up) };
}

describe("T6-S56 desk chats run on their persona's host", () => {
  it("a worker desk launches, reads and sends on worker only, picks through worker's dispatcher, and skips main's start gate", async () => {
    const d = desk({ host: "worker" });
    const v = await d.chat.view();
    expect(v.threadId).toBe("worker-desk1");
    expect(v.environmentId).toBe("env-worker");
    expect(d.worker.ops("launchThread")[0].args.projectId).toBe("p-worker");
    expect(d.picks).toEqual(["worker:pick", "worker:done"]);
    d.worker.push("worker-desk1", "assistant", "Hello from worker.");
    const out = await d.chat.send("ping");
    expect(out.threadId).toBe("worker-desk1");
    expect(d.worker.ops("sendToThread").map((c) => c.args.message)).toEqual(["ping"]);
    const after = await d.chat.view();
    expect(after.messages.map((m) => m.text)).toContain("Hello from worker.");
    expect(after.messages.map((m) => m.text)).toContain("ping");
    expect(d.main.calls).toEqual([]); // the main server's T3 is never asked anything
    expect(d.marks).toEqual([]);
    expect(d.chat.current()?.host).toBe("worker");
    // console notes go to the thread's own host
    await d.chat.clientOf(d.chat.current()!).sendToThread("worker-desk1", "[note]");
    expect(d.chat.gateOf(d.chat.current()!)).toBeUndefined();
  });

  it("a desk whose persona moved to worker relaunches there with a summary read from its main thread", async () => {
    const d = desk({ host: "main" });
    await d.chat.view();
    expect(d.chat.current()).toMatchObject({ threadId: "main-desk1", host: "main" });
    expect(d.marks).toEqual(["desk team launch"]);
    d.main.push("main-desk1", "assistant", "Placed it under PLAN-18.");
    d.moveTo("worker");
    const v = await d.chat.view();
    expect(v.threadId).toBe("worker-desk1");
    const seed = d.worker.ops("launchThread")[0].args.message as string;
    expect(seed).toContain("Placed it under PLAN-18.");
    const old = d.chat.sessions()[0];
    expect(old).toMatchObject({ threadId: "main-desk1", host: "main", endReason: `${HOST_MOVE}worker` });
    expect(d.chat.current()).toMatchObject({ threadId: "worker-desk1", host: "worker" });
    await new Promise((r) => setTimeout(r, 0));
    expect(d.main.ops("settleThread").map((c) => c.args.threadId)).toEqual(["main-desk1"]); // its idle process stops
    expect(d.worker.ops("settleThread")).toEqual([]);
  });

  it("worker unreachable keeps a main desk where it is; it moves once worker answers", async () => {
    const d = desk({ host: "main" });
    await d.chat.view();
    d.moveTo("worker");
    d.setVps3(false);
    expect((await d.chat.view()).threadId).toBe("main-desk1");
    d.setVps3(true);
    expect((await d.chat.view()).threadId).toBe("worker-desk1");
  });

  it("an existing worker thread whose T3 cannot be reached is not read from main", async () => {
    const d = desk({ host: "worker" });
    await d.chat.view();
    d.setVps3(false);
    await expect(d.chat.send("hi")).rejects.toThrow(/worker/);
    expect(d.main.calls).toEqual([]);
  });

  it("finds the repo's project by its checkout path when T3 lists it without a repository identity", async () => {
    const d = desk({ host: "worker" });
    d.worker.listProjects = async () => [{ id: "p-bare", title: "home_repo", workspaceRoot: "/srv/agent/github/home_repo", repositoryIdentity: null }];
    (d.chat.profile as { repo: string }).repo = "Acme/home_repo";
    expect((await d.chat.view()).threadId).toBe("worker-desk1");
    expect(d.worker.ops("launchThread")[0].args.projectId).toBe("p-bare");
  });

  it("without host wiring every chat stays on main (as before)", async () => {
    const d = desk({ host: "worker", wired: false });
    expect((await d.chat.view()).threadId).toBe("main-desk1");
    expect(d.worker.calls).toEqual([]);
  });
});
