import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import type { T3Client, T3MessagePage, T3ThreadMessage } from "../src/t3/client.js";
import { runnerDispatcher } from "../src/t3/dispatcher.js";
import {
  createChatSession,
  fromHistoryPosition,
  HISTORY_STRIDE,
  historyPosition,
  migrateDeskSessions,
  sessionNote,
  type DeskHost,
  type DeskView,
} from "../src/desk/session.js";

/**
 * moved the Team desk from
 * the main server to the worker server and opened a new thread there; the Chat page read only the live thread, so the whole conversation since 25 Oct
 * vanished from one poll to the next, leaving a "New session: the earlier chat was gone" divider. Now the earlier sessions are
 * read back as history (each from its own host) above the live thread, the divider says why the session changed, and a host
 * that cannot be reached gives the last good read with `unreachable` instead of an error or an empty chat.
 */

class PagedT3 implements T3Client {
  threads = new Map<string, T3ThreadMessage[]>();
  reads: string[] = [];
  up = true;
  private n = 0;
  constructor(readonly name: string) {}
  private check() {
    if (!this.up) throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  }
  async listProjects() {
    this.check();
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
    const list = this.threads.get(threadId)!;
    const position = list.length;
    list.push({ itemId: `${threadId}-i${position}`, position, role, text, status: "completed", truncated: false, updatedAt: new Date(Date.UTC(2026, 10, 3, 0, 0, position)).toISOString() });
  }
  thread(threadId: string, seed: string, said: [("user" | "assistant"), string][]) {
    this.threads.set(threadId, []);
    this.push(threadId, "user", seed);
    for (const [r, t] of said) this.push(threadId, r, t);
  }
  async launchThread(input: { message?: string }) {
    this.check();
    const threadId = `${this.name}-desk${++this.n}`;
    this.threads.set(threadId, []);
    if (input.message) this.push(threadId, "user", input.message);
    return { threadId };
  }
  async sendToThread(threadId: string, message: string) {
    this.check();
    if (!this.threads.has(threadId)) throw new Error(`thread ${threadId} not found`);
    this.push(threadId, "user", message);
  }
  async readThreadStatus(threadId: string) {
    this.check();
    if (!this.threads.has(threadId)) throw new Error(`thread ${threadId} not found`);
    return { status: "idle", raw: { itemCount: this.threads.get(threadId)!.length } };
  }
  async readThreadMessages(threadId: string, o: { afterPosition?: number; limit?: number } = {}): Promise<T3MessagePage> {
    this.check();
    this.reads.push(threadId);
    if (!this.threads.has(threadId)) throw new Error(`thread ${threadId} not found`);
    const all = this.threads.get(threadId)!.filter((m) => o.afterPosition === undefined || m.position > o.afterPosition);
    const messages = all.slice(0, o.limit ?? 100);
    return { messages, nextPosition: messages.at(-1)?.position ?? null, hasMore: all.length > messages.length, archived: false };
  }
}

const dispatcher = () =>
  runnerDispatcher(async (args) =>
    args[0] === "pick" ? JSON.stringify({ id: "seat7", via: "t3_delegate_task", providerInstanceId: "claudeAgent_seat7" }) : JSON.stringify({ ok: true }),
  );

let db: DB | undefined;
let dir: string | undefined;
afterEach(() => {
  db?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  db = dir = undefined;
});

const SEED = "[team-desk seed]";

/** A Team desk whose first thread ran on the main server (`said` in it), its persona now on `host`. */
function desk(o: { said: [("user" | "assistant"), string][]; host?: DeskHost }) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "e68s1-"));
  db = openDb(path.join(dir, "d.db"));
  migrateDeskSessions(db);
  const store = createStore(db);
  const persona = store.createPersona({ name: "Team desk", remit: "r", skills: [], model: "claude-opus-5-5", mayWrite: true, host: "main" });
  const main = new PagedT3("main");
  const worker = new PagedT3("worker");
  let tunnel = true;
  main.thread("old", `${SEED}\nfirst`, o.said);
  db.prepare("INSERT INTO desk_session (desk_key, thread_id, project_id, seat, created_at, seed_version, host) VALUES ('team', 'old', 'p-main', 'seat2', '2026-10-25T00:39:49Z', 1, 'main')").run();
  const chat = createChatSession(
    {
      db,
      store,
      t3: main,
      dispatcher: dispatcher(),
      sendWaitMs: 50,
      viewBudgetMs: 5_000,
      environmentId: () => "env-main",
      clientFor: (h: DeskHost) => (h === "main" ? main : tunnel ? worker : undefined),
      dispatcherFor: () => dispatcher(),
      environmentIdFor: (h: DeskHost) => `env-${h}`,
    },
    {
      key: "team",
      repo: "home_repo",
      title: "Team desk",
      personaName: "Team desk",
      remit: () => "r",
      seedMarker: SEED,
      updateMarker: "[team-desk update]",
      seedVersion: 1,
      seed: ({ summary }) => `${SEED}\n${summary ?? ""}`,
      update: () => "[team-desk update] v1",
      unavailable: "off",
    },
  );
  const moveTo = (h: DeskHost) => store.updatePersona(persona.id, { host: h });
  if (o.host && o.host !== "main") moveTo(o.host);
  return { chat, main, worker, moveTo, cutTunnel: (cut = true) => void (tunnel = !cut) };
}

const texts = (v: { messages: { kind: string; text: string; note?: string }[] }) => v.messages.map((m) => (m.kind === "seed" ? `--${m.note ?? "start"}--` : m.text));

describe("T68-S1 shown positions of earlier sessions", () => {
  it("map below every live position, keep their order, and map back", () => {
    expect(historyPosition(1, 0)).toBe(-HISTORY_STRIDE);
    expect(historyPosition(1, 5)).toBeLessThan(0);
    expect(historyPosition(2, HISTORY_STRIDE - 1)).toBeLessThan(historyPosition(1, 0));
    expect(fromHistoryPosition(historyPosition(1, 5))).toEqual({ j: 1, position: 5 });
    expect(fromHistoryPosition(historyPosition(3, 0))).toEqual({ j: 3, position: 0 });
    expect(fromHistoryPosition(7)).toEqual({ j: 0, position: 7 });
  });
  it("the divider says why a session followed another", () => {
    expect(sessionNote({ endReason: "host moved to worker", host: "main" })).toBe("New session: the desk moved from main to worker. The earlier chat is above.");
    expect(sessionNote({ endReason: "seat moved off seat1 limited until 05:00Z", host: "main" })).toMatch(/seat with headroom \(seat1 limited/);
    expect(sessionNote({ endReason: "archived", host: "main" })).toMatch(/earlier thread was gone \(archived\)/);
    expect(sessionNote(undefined)).toBeUndefined();
  });
});

describe("T68-S1 a desk keeps its conversation across a host move", () => {
  it("after the move the chat shows the main conversation above the new worker session, with the reason on the divider", async () => {
    const { chat, main, moveTo } = desk({ said: [["user", "ship the logos"], ["assistant", "on it"], ["user", "and the mockups"], ["assistant", "done"]] });
    const before = (await chat.view({ limit: 30 })) as DeskView;
    expect(texts(before)).toEqual(["--start--", "ship the logos", "on it", "and the mockups", "done"]);

    // the persona moves to the worker server; the next open moves the desk (as the owner's call did at 23:14Z)
    moveTo("worker");
    await chat.send("📞 Call question: why is the earlier chat gone?");
    const s = chat.current()!;
    expect(s.host).toBe("worker");

    const after = (await chat.view({ limit: 30 })) as DeskView;
    expect(after.threadId).toBe(s.threadId);
    expect(after.host).toBe("worker");
    // nothing said before the move is lost, nothing said after it either
    expect(texts(after)).toEqual([
      "--start--",
      "ship the logos",
      "on it",
      "and the mockups",
      "done",
      "--New session: the desk moved from main to worker. The earlier chat is above.--",
      "📞 Call question: why is the earlier chat gone?",
    ]);
    // the earlier messages come from the main server's T3 (the old thread's own host), with positions below the live thread's
    expect(main.reads).toContain("old");
    const old = after.messages.filter((m) => m.id.startsWith("old-"));
    expect(old.every((m) => (m.position ?? 0) < 0)).toBe(true);
    expect(after.messages.at(-1)!.position).toBeGreaterThanOrEqual(0);
    expect(after.messages.find((m) => m.kind === "seed" && m.session === 2)?.note).toMatch(/moved from main to worker/);
  });

  it("scrolling up pages from the live thread into the earlier session, and through a long one to its start", async () => {
    const said: [("user" | "assistant"), string][] = [];
    for (let i = 0; i < 700; i++) said.push([i % 2 ? "assistant" : "user", `old ${i}`]);
    const { chat } = desk({ said, host: "worker" });
    await chat.send("hello on worker");
    const first = (await chat.view({ limit: 30 })) as DeskView;
    expect(first.hasEarlier).toBe(true);
    expect(texts(first).slice(-3)).toEqual(["old 699", "--New session: the desk moved from main to worker. The earlier chat is above.--", "hello on worker"]);

    // page up until the start of the old thread, as the Chat page does with ?before=<oldest position>
    const seen = [...first.messages];
    let page = { messages: first.messages, hasEarlier: first.hasEarlier };
    for (let i = 0; i < 40 && page.hasEarlier; i++) {
      page = await chat.earlier(seen[0]!.position!, 30);
      seen.unshift(...page.messages);
    }
    expect(page.hasEarlier).toBe(false);
    const shown = texts({ messages: seen });
    expect(shown[0]).toBe("--start--");
    expect(shown.filter((t) => t.startsWith("old "))).toHaveLength(700);
    expect(new Set(seen.map((m) => m.id)).size).toBe(seen.length);
    const pos = seen.map((m) => m.position!);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
  });

  it("a live thread that already fills a screen does not read the earlier one on open, but scrolling up reaches it", async () => {
    const { chat, main, worker } = desk({ said: [["user", "before the move"]], host: "worker" });
    await chat.send("one");
    const live = chat.current()!.threadId;
    for (let i = 0; i < 40; i++) worker.push(live, i % 2 ? "assistant" : "user", `new ${i}`);
    main.reads.length = 0;
    const v = (await chat.view({ limit: 30 })) as DeskView;
    expect(texts(v).every((t) => !t.startsWith("before"))).toBe(true);
    expect(main.reads).not.toContain("old");
    const up = await chat.earlier(v.messages[0]!.position!, 30);
    expect(texts(up)).toContain("before the move");
  });

  it("an earlier thread that cannot be read (its host down) is left out, and the chat still opens", async () => {
    const { chat, main } = desk({ said: [["user", "before"]], host: "worker" });
    await chat.send("after");
    main.up = false;
    const v = (await chat.view({ limit: 30 })) as DeskView;
    expect(v.available).toBe(true);
    expect(texts(v)).toEqual(["--New session: the desk moved from main to worker. The earlier chat is above.--", "after"]);
    main.up = true;
  });
});

describe("T68-S1 a chat never goes blank when its host cannot be reached", () => {
  it("the worker tunnel down: the last good read with `unreachable: worker`, no error, no empty chat", async () => {
    const { chat, cutTunnel } = desk({ said: [["user", "before"]], host: "worker" });
    await chat.send("after");
    const good = (await chat.view({ limit: 30 })) as DeskView;
    expect(texts(good)).toContain("after");
    cutTunnel();
    const down = (await chat.view({ limit: 30 })) as DeskView;
    expect(down.available).toBe(true);
    expect(down.unreachable).toBe("worker");
    expect(down.t3).toBeUndefined();
    expect(texts(down)).toEqual(texts(good));
    cutTunnel(false);
    const back = (await chat.view({ limit: 30 })) as DeskView;
    expect(back.unreachable).toBeUndefined();
  });

  it("worker's T3 refusing connections reads the same way", async () => {
    const { chat, worker } = desk({ said: [["user", "before"]], host: "worker" });
    await chat.send("after");
    await chat.view({ limit: 30 });
    worker.up = false;
    const down = (await chat.view({ limit: 30 })) as DeskView;
    expect(down.unreachable).toBe("worker");
    expect(texts(down)).toContain("after");
  });
});
