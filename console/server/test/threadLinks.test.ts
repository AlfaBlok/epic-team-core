import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createStore, type Store } from "../src/store.js";
import { migrateCycle } from "../src/cycle/service.js";
import { createEnvironments, type Host } from "../src/cycle/environments.js";
import { threadUrl, withThreadEnvironments, type WaitingItem } from "../src/inbox/waiting.js";
import type { T3Client } from "../src/t3/client.js";
import { tempApp } from "./helpers.js";

/** Real thread ids seen on the worker server (2026-10-24): a delegated child carries literal `%3A`. */
const CHILD = "thread:delegated-task:command%3Amcp%3Ae2bcbed6-a191-4635-af48-c297a3a6ec08%3Adelegate-task%3Arun_6f33028c-S4";
const HOME = "mcp:31a11da3-bb09-47ff-8aa2-002feb5e13e7";
const ENV1 = "193cc672-5f6e-49b9-88c6-e064ca687e11";
const ENV3 = "5359a170-5adb-4e2d-8e6a-4569a169cfd9";

/** A T3 that knows some threads and its own environment id. */
function fakeT3(envId: string, threads: string[]) {
  const reads: string[] = [];
  const c = {
    reads,
    async readEnvironmentId() {
      return envId;
    },
    async readThreadStatus(id: string) {
      reads.push(id);
      if (!threads.includes(id)) throw new Error(`t3_thread_read: thread ${id} not found`);
      return { status: "completed", raw: {} };
    },
  };
  return c as typeof c & T3Client;
}

let db: DB | undefined;
afterEach(() => db?.close());

function setup(clients: Partial<Record<Host, T3Client>> = {}, env: NodeJS.ProcessEnv = {}) {
  db = openDb(":memory:");
  migrateCycle(db);
  const store: Store = createStore(db);
  const m = store.createMilestone({ title: "M", repo: "r", path: "p", owner: "", paused: false });
  // The persona says the main server on purpose: where a thread lives never comes from the persona's (current) host.
  const p = store.createPersona({ name: "Delivery Manager", remit: "x", skills: [], model: "", mayWrite: false, host: "main" });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 } as any, enabled: true });
  const link = (threadId: string, host: Host) =>
    db!.prepare("INSERT OR REPLACE INTO cycle_assignment_link (assignment_id, thread_id, host) VALUES (?, ?, ?)").run(a.id, threadId, host);
  const envs = createEnvironments({ db, clientFor: (h) => clients[h], env });
  const envOf = (runId: string) => store.getRun(runId)!.environmentId;
  return { store, a, link, envs, envOf };
}

describe("T6-S11 thread links", () => {
  it("links t3code://threads/<env>/<id> with both segments URL-encoded; falls back to t3-thread://v1/<raw id>", () => {
    // Checked in T3's web client: /<env>/<encoded id> opens both kinds; the raw `%3A` child id lands on a new draft.
    expect(threadUrl(CHILD, ENV3)).toBe(
      `t3code://threads/${ENV3}/thread%3Adelegated-task%3Acommand%253Amcp%253Ae2bcbed6-a191-4635-af48-c297a3a6ec08%253Adelegate-task%253Arun_6f33028c-S4`,
    );
    expect(threadUrl(HOME, ENV1)).toBe(`t3code://threads/${ENV1}/mcp%3A31a11da3-bb09-47ff-8aa2-002feb5e13e7`);
    expect(threadUrl(CHILD)).toBe(`t3-thread://v1/${CHILD}`);
    // T3's desktop parser (promptLinkAppPath) copies the path as is: the router gets the encoded segment.
    const u = new URL(threadUrl(CHILD, ENV3));
    expect(u.host).toBe("threads");
    expect(decodeURIComponent(u.pathname.split("/")[2])).toBe(CHILD);
  });

  it("stamps a run from the home thread's host, its children from the parent, never from the persona", async () => {
    const worker = fakeT3(ENV3, [HOME]);
    const s = setup({ worker });
    await s.envs.refreshHost("worker");
    s.link(HOME, "worker");
    const wake = s.store.createRun({ assignmentId: s.a.id, outcome: "running", summary: "", threadId: HOME });
    expect(s.envOf(wake.id)).toBe(ENV3);
    const child = s.store.createRun({ assignmentId: s.a.id, outcome: "running", summary: "", threadId: CHILD, parentRunId: wake.id });
    expect(s.envOf(child.id)).toBe(ENV3);
    // Run now: the run exists before the thread does; the thread id arrives by update.
    const later = s.store.createRun({ assignmentId: s.a.id, outcome: "running", summary: "" });
    expect(s.envOf(later.id)).toBeUndefined();
    s.store.updateRun(later.id, { threadId: HOME });
    expect(s.envOf(later.id)).toBe(ENV3);
    expect(s.envs.forThread(CHILD)).toBe(ENV3);
  });

  it("a stamped run keeps its environment when the persona moves host (link reset)", async () => {
    const s = setup({}, { CONSOLE_T3_ENV_MAIN: ENV1, CONSOLE_T3_ENV_WORKER: ENV3 });
    s.link("mcp:old-home", "main");
    const old = s.store.createRun({ assignmentId: s.a.id, outcome: "idle", summary: "", threadId: "mcp:old-home" });
    s.link(HOME, "worker"); // persona moved to the worker server: new home thread
    const now = s.store.createRun({ assignmentId: s.a.id, outcome: "running", summary: "", threadId: HOME });
    expect([s.envOf(old.id), s.envOf(now.id)]).toEqual([ENV1, ENV3]);
    expect(s.envs.forThread("mcp:old-home")).toBe(ENV1);
  });

  it("stamps runs written before the host's environment id was known once it is read", async () => {
    const worker = fakeT3(ENV3, []);
    const s = setup({ worker });
    s.link(HOME, "worker");
    const r = s.store.createRun({ assignmentId: s.a.id, outcome: "running", summary: "", threadId: HOME });
    const c = s.store.createRun({ assignmentId: s.a.id, outcome: "running", summary: "", threadId: CHILD, parentRunId: r.id });
    expect(s.envOf(r.id)).toBeUndefined();
    await s.envs.refreshHost("worker");
    expect([s.envOf(r.id), s.envOf(c.id)]).toEqual([ENV3, ENV3]);
  });

  it("backfill asks each reachable T3 for threads it cannot place, once per retry window", async () => {
    let t = 1_000_000;
    const main = fakeT3(ENV1, ["mcp:on-main"]);
    const worker = fakeT3(ENV3, ["mcp:on-worker"]);
    db = openDb(":memory:");
    migrateCycle(db);
    const store = createStore(db);
    const m = store.createMilestone({ title: "M", repo: "r", path: "p", owner: "", paused: false });
    const p = store.createPersona({ name: "x", remit: "x", skills: [], model: "", mayWrite: false });
    const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 } as any, enabled: true });
    const run = (threadId: string, parentRunId?: string) => store.createRun({ assignmentId: a.id, outcome: "idle", summary: "", threadId, parentRunId }).id;
    const r1 = run("mcp:on-main");
    const r3 = run("mcp:on-worker");
    const kid = run(CHILD, r3);
    const gone = run("mcp:gone");
    const envs = createEnvironments({ db, clientFor: (h) => (h === "main" ? main : worker), now: () => t, retryMs: 60_000 });
    await envs.refreshHost("main");
    await envs.refreshHost("worker");
    const res = await envs.backfill();
    const env = (id: string) => store.getRun(id)!.environmentId;
    expect([env(r1), env(r3), env(kid), env(gone)]).toEqual([ENV1, ENV3, ENV3, undefined]);
    expect(res.unresolved).toBe(1);
    expect([...main.reads, ...worker.reads]).not.toContain(CHILD); // placed through its parent, no T3 read
    const before = main.reads.length + worker.reads.length;
    await envs.backfill(); // within the retry window: no T3 reads
    expect(main.reads.length + worker.reads.length).toBe(before);
    t += 61_000;
    await envs.backfill();
    expect(main.reads.filter((x) => x === "mcp:gone")).toHaveLength(2);
  });

  it("backfill skips a host it cannot reach without starting it (cold worker)", async () => {
    const main = fakeT3(ENV1, []);
    const s = setup({ main }, { CONSOLE_T3_ENV_WORKER: ENV3 });
    await s.envs.refreshHost("main");
    const r = s.store.createRun({ assignmentId: s.a.id, outcome: "idle", summary: "", threadId: "mcp:on-worker" });
    await s.envs.backfill();
    expect(s.envOf(r.id)).toBeUndefined();
    expect(main.reads).toEqual(["mcp:on-worker"]);
  });

  it("an inbox item gets the environment of its owner thread and run-thread link", () => {
    const item = {
      owner: { kind: "delivery-manager", threadId: HOME, label: "DM" },
      contextLinks: [
        { label: "run thread", url: threadUrl(CHILD), threadId: CHILD },
        { label: "doc", url: "https://github.com/x" },
      ],
    } as Pick<WaitingItem, "owner" | "contextLinks">;
    const out = withThreadEnvironments(item, (id) => (id === HOME || id === CHILD ? ENV3 : undefined));
    expect(out.owner.environmentId).toBe(ENV3);
    expect(out.contextLinks[0]).toMatchObject({ environmentId: ENV3, url: threadUrl(CHILD, ENV3) });
    expect(out.contextLinks[1]).toEqual({ label: "doc", url: "https://github.com/x" });
    // Unknown: unchanged (the UI falls back to t3-thread:// + copy id).
    expect(withThreadEnvironments(item, () => undefined)).toEqual(item);
  });

  it("GET /api/runs carries environmentId", async () => {
    const prev = process.env.CONSOLE_T3_ENV_MAIN;
    process.env.CONSOLE_T3_ENV_MAIN = ENV1;
    const t = tempApp();
    try {
      const m = (await t.call("POST", "/api/milestones", { title: "M", repo: "r", path: "p" })).json;
      const p = (await t.call("POST", "/api/personas", { name: "x", remit: "x" })).json;
      const a = (await t.call("POST", "/api/assignments", { milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 } })).json;
      t.db.prepare("INSERT INTO cycle_assignment_link (assignment_id, thread_id, host) VALUES (?, ?, 'main')").run(a.id, HOME);
      const parent = (await t.call("POST", "/api/runs", { assignmentId: a.id, outcome: "running", summary: "", threadId: HOME })).json;
      const child = (await t.call("POST", "/api/runs", { assignmentId: a.id, outcome: "running", summary: "", threadId: CHILD, parentRunId: parent.id })).json;
      expect([parent.environmentId, child.environmentId]).toEqual([ENV1, ENV1]);
      const runs = (await t.call("GET", `/api/runs?milestoneId=${m.id}`)).json as any[];
      expect(runs.map((r) => r.environmentId)).toEqual([ENV1, ENV1]);
    } finally {
      t.cleanup();
      if (prev === undefined) delete process.env.CONSOLE_T3_ENV_MAIN;
      else process.env.CONSOLE_T3_ENV_MAIN = prev;
    }
  });
});
