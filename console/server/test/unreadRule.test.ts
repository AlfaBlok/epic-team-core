import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { addCard, makeRepo, spineText } from "./reviewFixture.js";
import { createAuth, type AuthMode } from "../src/auth/identity.js";
import { isTenantSafe } from "../src/auth/routeScope.js";
import { unreadOf } from "../src/desk/unread.js";
import type { T3Client, T3MessagePage, T3ThreadMessage } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";

/**
 * the counter pills. GET /api/counts answers, per world, what waits on the owner to unblock (the status read model's
 * needsYou, red), what waits for his review (review items in state review, green) and unread chat replies (the world's
 * top-level Chat and each milestone's Chat tab), in total and per milestone. POST /api/chat/seen (the chat page opening)
 * clears a chat's unread; his own message clears it too; a persona run never does.
 */
const A = "home";
const Z = "social";
const OUTSIDE = "203.0.113.7";
const T0 = Date.parse("2026-11-02T06:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

class FakeT3 implements T3Client {
  threads = new Map<string, T3ThreadMessage[]>();
  reads = 0;
  private pos = 0;
  add(threadId: string, role: "user" | "assistant", text: string, when: string, status = "completed") {
    const list = this.threads.get(threadId) ?? [];
    list.push({ itemId: `item_${++this.pos}`, position: this.pos, role, text, status, truncated: false, updatedAt: when });
    this.threads.set(threadId, list);
  }
  async listProjects() {
    return [];
  }
  async listScheduledTasks() {
    return [];
  }
  async updateScheduledTask() {
    return undefined;
  }
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread(): Promise<{ threadId: string }> {
    throw new Error("the counts never launch a thread");
  }
  async sendToThread() {}
  async readThreadStatus() {
    return { status: "idle", raw: {} };
  }
  async readThreadMessages(threadId: string, opts: { afterPosition?: number; limit?: number } = {}): Promise<T3MessagePage> {
    this.reads++;
    const all = (this.threads.get(threadId) ?? []).filter((m) => opts.afterPosition === undefined || m.position > opts.afterPosition);
    const page = all.slice(0, opts.limit ?? 100);
    return { messages: page, nextPosition: page.length ? page[page.length - 1].position : (opts.afterPosition ?? null), hasMore: all.length > page.length, archived: false };
  }
}
class FakeDispatcher implements Dispatcher {
  async pick() {
    return { seat: "seat1", providerInstanceId: "claudeAgent_seat1" };
  }
  async done() {}
}

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.useRealTimers();
});

function setup(mode: AuthMode = "off", o: { cycle?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s19-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  // review cards are spine rows in review: one repo per milestone, rows appended by `review` below.
  const repos = Object.fromEntries(["home_repo", "ops", "social"].map((n) => [n, makeRepo(dir, n, { "docs/spines/root.md": spineText("PLAN-0", n, []) })]));
  const t3 = new FakeT3();
  const app = createApp(db, {
    auth: mode,
    read: { reposRoot: dir, seatsFile: path.join(dir, "seats.json"), listThreads: async () => [] },
    review: { live: { fetch: (async () => new Response("ok")) as unknown as typeof fetch, consoleHosts: [] } },
    ...(o.cycle === false ? {} : { cycle: { enabled: true, t3, dispatcher: new FakeDispatcher(), publicUrl: "http://127.0.0.1:18799", runState: async () => undefined } }),
    chatUnread: { staleMs: 0 },
  });
  db.prepare("INSERT OR IGNORE INTO tenants (id, name, skin, plan, created_at) VALUES (?, ?, 'social', 'internal', ?)").run(Z, Z, new Date().toISOString());
  const sa = createStore(db);
  const sz = createStore(db, { tenant: Z });
  const m1 = sa.createMilestone({ title: "home_repo", repo: "home_repo", path: "docs/spines/root.md", owner: "Sam", paused: false });
  const m2 = sa.createMilestone({ title: "infra", repo: "ops", path: "docs/spines/root.md", owner: "Sam", paused: false });
  const mZ = sz.createMilestone({ title: "social", repo: "social", path: "docs/spines/root.md", owner: "Sam", paused: false });
  const auth = createAuth(db);
  const zTok = auth.createToken({ tenant: Z, label: "social check" }).token;
  const aTok = auth.createToken({ tenant: A, label: "automated-checks" }).token;
  /** A live chat thread (as the desk / a milestone tab / a world desk would have launched it). */
  const chat = (key: string, threadId: string) =>
    db.prepare("INSERT INTO desk_session (desk_key, thread_id, project_id, seat, created_at, seed_version) VALUES (?, ?, 'p', 'seat1', ?, 99)").run(key, threadId, at(0));
  /** A row of the milestone's root spine: `review` with a live link, `pending_live` = review with no link yet, else done. */
  const review = (id: string, milestoneId: string, state = "review") => {
    const m = [m1, m2, mZ].find((x) => x.id === milestoneId)!;
    const f = path.join(repos[m.repo].dir, "docs/spines/root.md");
    const status = state === "review" || state === "pending_live" ? "review" : "done";
    const evidence = state === "review" ? `[live](https://team.example.com/${id})` : "none";
    fs.appendFileSync(f, `| ${id} | Ticket worker | seat2 | item ${id} | ${status} | none | none | main | ${evidence} | 2026-11-02 | followups: none; confirm: yes |\n`);
    // a row in review is a card only with its card file
    if (state === "review") addCard(repos[m.repo].dir, id, `https://team.example.com/${id}`);
  };
  const req = async (method: string, url: string, x: { bearer?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...(x.bearer ? { authorization: `Bearer ${x.bearer}` } : {}), ...(x.headers ?? {}) };
    if (x.body !== undefined) headers["content-type"] = "application/json";
    const res = await app.request(url, { method, headers, body: x.body === undefined ? undefined : JSON.stringify(x.body) }, { incoming: { socket: { remoteAddress: x.bearer ? OUTSIDE : "127.0.0.1" } } });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined, bytes: text.length };
  };
  /** /counts once the background pass has read the chats (the first read only starts it). */
  const counts = async (bearer?: string) => {
    await req("GET", "/api/counts", { bearer });
    await new Promise((r) => setTimeout(r, 30));
    return (await req("GET", "/api/counts", { bearer })).json;
  };
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { db, t3, req, counts, chat, review, m1, m2, mZ, zTok, aTok };
}

describe("T48-S19 unread rule", () => {
  it("counts the finished replies after both the last open and his own newest message", () => {
    const t = { threadId: "t", replies: [at(1), at(2), at(5), at(6)], lastOwnAt: at(4) };
    expect(unreadOf(t)).toBe(2);
    expect(unreadOf(t, at(5))).toBe(1);
    expect(unreadOf(t, at(3))).toBe(2);
    expect(unreadOf({ threadId: "t", replies: [at(1), at(2)] })).toBe(2);
    expect(unreadOf({ threadId: "t", replies: [at(1), at(2)] }, at(9))).toBe(0);
  });
});

describe("T48-S19 GET /api/counts", () => {
  it("is TENANT_SAFE (both skins call it) and so is the seen mark", () => {
    expect(isTenantSafe("GET", "/api/counts")).toBe(true);
    expect(isTenantSafe("POST", "/api/chat/seen")).toBe(true);
    expect(isTenantSafe("POST", "/api/counts")).toBe(false);
  });

  it("red = the status read model's needsYou, total and per milestone, the same numbers /api/status sends", async () => {
    const w = setup("off", { cycle: false });
    const st = (await w.req("GET", "/api/status")).json;
    const c = (await w.req("GET", "/api/counts")).json;
    expect(c.needsYou).toBe(st.needsYou);
    for (const m of st.milestones) {
      const want = m.loading ? null : m.needsYou;
      expect(c.milestones[m.milestoneId]?.needsYou ?? 0, m.milestoneId).toBe(want ?? 0);
    }
    expect(c.chat).toBeNull(); // no T3: unknown, never a 0 that hides replies
  });

  it("green = the cards (spine rows in review that are live, not snoozed, not older backlog), total and per milestone, total and per milestone", async () => {
    const w = setup("off", { cycle: false });
    w.review("rv_1", w.m1.id);
    w.review("rv_2", w.m1.id);
    w.review("rv_3", w.m2.id);
    w.review("rv_5", w.m1.id, "pending_live");
    w.review("rv_6", w.m1.id, "approved");
    w.review("rv_7", w.m2.id, "merged");
    const c = await w.counts();
    const list = (await w.req("GET", "/api/review-items")).json as { milestoneId?: string }[];
    // the count is the cards he acts on; not live yet has its own section
    expect(c.review).toBe(3);
    expect(c.review).toBe(list.length);
    expect(c.milestones[w.m1.id].review).toBe(2);
    expect(c.milestones[w.m2.id].review).toBe(1);
  });

  it("unread: replies after his last message, per chat; opening clears it; his own message clears it; never a list", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: T0 + 30 * 60_000 });
    const w = setup();
    w.chat("team", "th_desk");
    w.chat(`milestone:${w.m1.id}`, "th_m1");
    w.chat(`milestone:${w.m2.id}`, "th_m2");
    w.t3.add("th_desk", "user", "[team-desk seed]", at(0));
    w.t3.add("th_desk", "user", "what is open?", at(1));
    w.t3.add("th_desk", "assistant", "three asks", at(2));
    w.t3.add("th_desk", "assistant", "and one more", at(3));
    w.t3.add("th_desk", "assistant", "still writing…", at(4), "running"); // not finished: not counted yet
    w.t3.add("th_m1", "assistant", "repo desk hello", at(1));
    w.t3.add("th_m2", "user", "ship it", at(1));
    w.t3.add("th_m2", "assistant", "on it", at(1)); // same instant as his message: not newer
    let c = await w.counts();
    expect(c.chat).toBe(2);
    expect(c.milestones[w.m1.id].chat).toBe(1);
    expect(c.milestones[w.m2.id]?.chat).toBeUndefined();
    // small: numbers only, no message text
    const raw = await w.req("GET", "/api/counts");
    expect(JSON.stringify(raw.json)).not.toMatch(/three asks|repo desk hello/);
    expect(raw.bytes).toBeLessThan(600);

    // the owner opens the Team desk: 0; the milestone chat keeps its 1
    const seen = await w.req("POST", "/api/chat/seen", { body: { chat: "desk" }, headers: { "sec-fetch-site": "same-origin" } });
    expect(seen.status).toBe(200);
    expect(seen.json).toMatchObject({ key: "team", unread: 0 });
    c = await w.counts();
    expect(c.chat).toBe(0);
    expect(c.milestones[w.m1.id].chat).toBe(1);

    // a new reply after the open counts again; the running one finishing counts too
    vi.setSystemTime(T0 + 40 * 60_000);
    w.t3.add("th_desk", "assistant", "a new reply", at(41));
    c = await w.counts();
    expect(c.chat).toBe(1);

    // the milestone tab opened: 0
    expect((await w.req("POST", "/api/chat/seen", { body: { chat: "milestone", id: w.m1.id } })).json.unread).toBe(0);
    c = await w.counts();
    expect(c.milestones[w.m1.id]?.chat).toBeUndefined();

    // his own message in the milestone chat: replies before it are read
    w.t3.add("th_m1", "assistant", "reply A", at(42));
    c = await w.counts();
    expect(c.milestones[w.m1.id].chat).toBe(1);
    w.t3.add("th_m1", "user", "thanks", at(43));
    c = await w.counts();
    expect(c.milestones[w.m1.id]?.chat).toBeUndefined();
  });

  it("a persona run never marks Sam's chat read; a bad body is a 400", async () => {
    const w = setup();
    w.chat("team", "th_desk");
    w.t3.add("th_desk", "assistant", "hello", at(1));
    expect((await w.counts()).chat).toBe(1);
    expect((await w.req("POST", "/api/chat/seen", { body: { chat: "desk" }, headers: { "x-console-run": "run_x" } })).status).toBe(403);
    expect((await w.req("POST", "/api/chat/seen", { body: { chat: "desk" }, headers: { "x-run-id": "run_x" } })).status).toBe(403);
    expect((await w.req("POST", "/api/chat/seen", { body: { chat: "other" } })).status).toBe(400);
    expect((await w.counts()).chat).toBe(1);
  });
});

describe("T48-S19 per world (auth on)", () => {
  it("each world counts only its own: review, its milestones' chats and its own team desk; another world's id is a 404", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: T0 + 30 * 60_000 });
    const w = setup("on");
    w.review("rv_a", w.m1.id);
    w.review("rv_z1", w.mZ.id);
    w.review("rv_z2", w.mZ.id);
    w.chat("team", "th_desk");
    w.chat(`milestone:${w.m1.id}`, "th_m1");
    w.chat(`milestone:${w.mZ.id}`, "th_mz");
    w.chat(`world-desk:${Z}`, "th_wz");
    w.t3.add("th_desk", "assistant", "a1", at(1));
    w.t3.add("th_m1", "assistant", "a2", at(1));
    w.t3.add("th_mz", "assistant", "z1", at(1));
    w.t3.add("th_mz", "assistant", "z2", at(2));
    w.t3.add("th_wz", "assistant", "z3", at(1));
    w.t3.add("th_wz", "assistant", "z4", at(2));
    w.t3.add("th_wz", "assistant", "z5", at(3));

    const z = await w.counts(w.zTok);
    expect(z.review).toBe(2);
    expect(z.chat).toBe(3); // its team desk, not the home world's Team desk
    expect(Object.keys(z.milestones)).toEqual([w.mZ.id]);
    expect(z.milestones[w.mZ.id]).toMatchObject({ review: 2, chat: 2 });

    const a = await w.counts(w.aTok);
    expect(a.review).toBe(1);
    expect(a.chat).toBe(1);
    expect(a.milestones[w.mZ.id]).toBeUndefined();
    expect(a.milestones[w.m1.id]).toMatchObject({ review: 1, chat: 1 });

    // a social world repo opens its desk: its 3 clear, the home world's Team desk keeps 1
    expect((await w.req("POST", "/api/chat/seen", { bearer: w.zTok, body: { chat: "desk" } })).json).toMatchObject({ key: `world-desk:${Z}`, unread: 0 });
    expect((await w.req("POST", "/api/chat/seen", { bearer: w.zTok, body: { chat: "milestone", id: w.m1.id } })).status).toBe(404);
    expect((await w.counts(w.zTok)).chat).toBe(0);
    expect((await w.counts(w.aTok)).chat).toBe(1);
    expect((await w.counts(w.aTok)).milestones[w.m1.id].chat).toBe(1);
  });
});
