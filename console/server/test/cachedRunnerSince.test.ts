import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { cachedRunner, type SpinesJson, type SpinesRunner } from "../src/adapters/spines.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { answerSpinesAsk, isSpinesAsk, workerSpinesRunner, type SpinesReply } from "../src/readModel/spinesBridge.js";

/**
 * after a restart the first tree read took 17-26 s on
 * the main server. The console now warms the trees right after a start (focus milestones first, one at a time), and the read-model
 * worker shares the main thread's spines.py runs instead of running its own next to them.
 */
const fixture = (root = "EPIC.md"): SpinesJson => ({
  root,
  orphans: [],
  mismatches: [],
  nodes: [{ id: root, path: root, title: "Root", parent: null, status: "active", rollup_status: "active", dod: [], children: [] }],
});
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A runner that counts its runs and holds each until released. */
function heldRunner() {
  const runs: { dir: string; release: () => void }[] = [];
  const run: SpinesRunner = (dir) =>
    new Promise((resolve) => {
      runs.push({ dir, release: () => resolve(fixture()) });
    });
  return { run, runs };
}

describe("T35-S3 cachedRunner.since", () => {
  it("shares a run in flight that started at or after t", async () => {
    const h = heldRunner();
    const c = cachedRunner(h.run, 60_000, Date.now, () => {});
    const t = Date.now();
    const a = c("/r");
    const b = c.since!("/r", t);
    expect(h.runs).toHaveLength(1);
    h.runs[0].release();
    expect(await b).toBe(await a);
  });

  it("queues one run after a run that started before t, and starts one when none is in flight", async () => {
    const h = heldRunner();
    const c = cachedRunner(h.run, 60_000, Date.now, () => {});
    const old = c("/r");
    await tick(5);
    const b = c.since!("/r", Date.now());
    const b2 = c.since!("/r", Date.now()); // a second ask meanwhile shares the queued run
    expect(h.runs).toHaveLength(1);
    h.runs[0].release();
    await old;
    await tick();
    expect(h.runs).toHaveLength(2);
    h.runs[1].release();
    expect(await b).toBe(await b2);
    expect(await b).toEqual(await old);
    // Nothing in flight: a new run (the cached output is older than t).
    await tick(5);
    const c3 = c.since!("/r", Date.now());
    await tick();
    expect(h.runs).toHaveLength(3);
    h.runs[2].release();
    await c3;
    // The new output is the cache's now.
    expect(await c("/r")).toBe(await c3);
  });
});

describe("T35-S3 cachedRunner keeps what it can", () => {
  it("since answers from the last output when its run started at or after t (no second run after a finished prewarm)", async () => {
    const h = heldRunner();
    const c = cachedRunner(h.run, 60_000, Date.now, () => {});
    const t = Date.now();
    await tick(2);
    const pre = c("/r");
    h.runs[0].release();
    const v = await pre;
    expect(await c.since!("/r", t)).toBe(v);
    expect(h.runs).toHaveLength(1);
    // A t after that run started: a new run.
    const later = c.since!("/r", Date.now() + 1);
    await tick();
    expect(h.runs).toHaveLength(2);
    h.runs[1].release();
    await later;
  });

  it("an unchanged output keeps the same object (the trees built from it stay memoized); a changed one replaces it", async () => {
    let out = fixture();
    let n = 0;
    const c = cachedRunner(async () => (n++, structuredClone(out)), 0, Date.now, () => {});
    const a = await c("/r");
    c.invalidate("/r");
    const b = await c("/r");
    expect(n).toBe(2);
    expect(b).toBe(a);
    out = fixture("OTHER.md");
    c.invalidate("/r");
    const d = await c("/r");
    expect(d).not.toBe(a);
    expect(d.root).toBe("OTHER.md");
  });
});

describe("T35-S3 read-model worker asks the main thread for spines.py", () => {
  /** The worker side wired to the main thread's cached runner through a fake channel. */
  function bridge(startedAt: number) {
    const h = heldRunner();
    const main = cachedRunner(h.run, 60_000, Date.now, () => {});
    const replies: SpinesReply[] = [];
    let w: ReturnType<typeof workerSpinesRunner>;
    w = workerSpinesRunner((m) => {
      expect(isSpinesAsk(m)).toBe(true);
      answerSpinesAsk(main, m, (r) => (replies.push(r), w.onReply(r)));
    }, startedAt);
    return { h, main, w, replies };
  }

  it("the worker's first read shares the start's prewarm (one spines.py run, not two)", async () => {
    const workerStart = Date.now();
    const { h, main, w } = bridge(workerStart);
    const prewarm = main("/home_repo"); // index.ts prewarm, started after the worker was spawned
    w.run.invalidate("/home_repo"); // the refresher's pump invalidates before every run, the first one too
    const fromWorker = w.run("/home_repo");
    await tick();
    expect(h.runs).toHaveLength(1);
    h.runs[0].release();
    expect(await fromWorker).toEqual(await prewarm);
  });

  it("after the worker saw a change, it waits for a run that started after it (the request side's cache gets it too)", async () => {
    const { h, main, w } = bridge(Date.now());
    const first = w.run("/r");
    await tick();
    h.runs[0].release();
    await first;
    await tick(5);
    const stale = main("/r"); // fresh hit: no run
    expect(h.runs).toHaveLength(1);
    w.run.invalidate("/r");
    const after = w.run("/r");
    await tick();
    expect(h.runs).toHaveLength(2);
    h.runs[1].release();
    const v = await after;
    expect(v).toBe(await stale); // same output: same object, nothing rebuilt
    expect(await main("/r")).toBe(v);
  });

  it("a failed run with no output yet rejects on the worker side", async () => {
    const main: SpinesRunner = async () => {
      throw new Error("spines.py: boom\ntrace");
    };
    let w: ReturnType<typeof workerSpinesRunner>;
    w = workerSpinesRunner((m) => answerSpinesAsk(main, m, (r) => w.onReply(r)), Date.now());
    await expect(w.run("/r")).rejects.toThrow("spines.py: boom");
    expect(w.onReply({ type: "log", msg: "x" })).toBe(false);
  });
});

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe("T35-S3 trees warm after a start", () => {
  it("reads every unsettled milestone's tree once, focus first, one spines.py run per repo; the first open then runs nothing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e35s3-"));
    for (const name of ["alpha", "beta", "gamma"]) {
      const repo = path.join(root, name);
      fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
      fs.writeFileSync(path.join(repo, ".git/config"), `[remote "origin"]\n\turl = https://github.com/Acme/${name}.git\n`);
      fs.writeFileSync(path.join(repo, "EPIC.md"), `# EPIC: ${name}\n\n## Current State\n\nStatus: active\n`);
    }
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const slow: SpinesRunner = async (dir) => {
      order.push(path.basename(dir));
      maxActive = Math.max(maxActive, ++active);
      await tick(30);
      active--;
      return fixture();
    };
    const spines = cachedRunner(slow, 60_000, Date.now, () => {});
    const db: DB = openDb(path.join(root, "c.db"));
    let done: (r: { milestones: number; ms: number }) => void = () => {};
    const warmed = new Promise<{ milestones: number; ms: number }>((r) => (done = r));
    const app = createApp(db, {
      read: { reposRoot: root, seatsFile: path.join(root, "seats.json"), listThreads: async () => [], spines },
      warmTrees: { afterMs: 0, onDone: done },
    });
    cleanup = () => {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    };
    const store = createStore(db);
    const mk = (name: string, bigRoot?: number) => store.createMilestone({ title: name, repo: `Acme/${name}`, path: "EPIC.md", owner: "", paused: false, ...(bigRoot !== undefined ? { bigRoot } : {}) });
    mk("alpha");
    const beta = mk("beta", 0); // the focus milestone: warmed first although created after alpha
    const gamma = mk("gamma");
    store.setSettled(gamma.id, true);

    const r = await warmed;
    expect(r.milestones).toBe(store.listMilestones().length);
    expect(order[0]).toBe("beta");
    expect(maxActive).toBe(1);
    // One run per repo the warm read; none for the settled one's repo unless the waiting list reads it.
    expect(order.filter((d) => d === "beta")).toHaveLength(1);
    expect(order.filter((d) => d === "alpha")).toHaveLength(1);
    const runs = order.length;
    const t0 = Date.now();
    const res = await app.request(`/api/milestones/${beta.id}/tree`);
    expect(res.status).toBe(200);
    const tree = (await res.json()) as { source?: string; root: { title: string } };
    expect(tree.source).not.toBe("fallback");
    expect(order.length).toBe(runs); // spines.py did not run again
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("no warm-up unless asked (tests and CONSOLE_TREE_WARM=0)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e35s3-"));
    const db: DB = openDb(path.join(root, "c.db"));
    cleanup = () => {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    };
    let runs = 0;
    createApp(db, { read: { reposRoot: root, seatsFile: path.join(root, "seats.json"), listThreads: async () => [], spines: async () => (runs++, fixture()) } });
    createStore(db).createMilestone({ title: "x", repo: "x", path: "EPIC.md", owner: "", paused: false });
    await tick(50);
    expect(runs).toBe(0);
  });
});
