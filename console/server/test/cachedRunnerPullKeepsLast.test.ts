import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { cachedRunner, type SpinesJson, type SpinesRunner } from "../src/adapters/spines.js";
import { createTreeMemo } from "../src/adapters/treeMemo.js";
import { createFreshness } from "../src/freshness.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";

/**
 * 5 s after the console pulled the code repo the first tree
 * read took 10 s: it waited for the post-pull spines.py run (13-23 s on the main server), then rebuilt the trees. A pull now keeps
 * the last output and trees, serves them at once and rebuilds in the background; the console's own write still waits.
 */
const fixture = (title = "Root"): SpinesJson => ({
  root: "EPIC.md",
  orphans: [],
  mismatches: [],
  nodes: [{ id: "EPIC.md", path: "EPIC.md", title, parent: null, status: "active", rollup_status: "active", dod: [], children: [] }],
});
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A runner whose runs wait until released, each with the output given at release. */
function heldRunner() {
  const runs: { release: (v: SpinesJson) => void }[] = [];
  const run: SpinesRunner = () => new Promise((resolve) => runs.push({ release: resolve }));
  return { run, runs };
}

describe("T35-S4 cachedRunner: a pull keeps the last output", () => {
  it("stale invalidate answers the last output at once, queues one run, and swaps when it is done", async () => {
    const h = heldRunner();
    const c = cachedRunner(h.run, 60_000, Date.now, () => {});
    const first = c("/r");
    h.runs[0].release(fixture("old"));
    const old = await first;
    c.invalidate("/r", { stale: true });
    expect(await c("/r")).toBe(old); // no wait
    await tick();
    expect(h.runs).toHaveLength(2);
    const settled = c.settled!("/r")!;
    h.runs[1].release(fixture("new"));
    expect((await settled).nodes[0].title).toBe("new");
    expect((await c("/r")).nodes[0].title).toBe("new");
    expect(c.settled!("/r")).toBeUndefined();
  });

  it("a write (plain invalidate) still waits for the run after it; a stale invalidate with nothing cached waits too", async () => {
    const h = heldRunner();
    const c = cachedRunner(h.run, 60_000, Date.now, () => {});
    const first = c("/r");
    h.runs[0].release(fixture("old"));
    await first;
    c.invalidate("/r");
    let got: SpinesJson | undefined;
    void c("/r").then((v) => (got = v));
    await tick();
    expect(got).toBeUndefined();
    h.runs[1].release(fixture("written"));
    await tick();
    expect(got?.nodes[0].title).toBe("written");

    const h2 = heldRunner();
    const c2 = cachedRunner(h2.run, 60_000, Date.now, () => {});
    c2.invalidate("/r", { stale: true });
    let got2: SpinesJson | undefined;
    void c2("/r").then((v) => (got2 = v));
    await tick();
    expect(got2).toBeUndefined();
    h2.runs[0].release(fixture("first"));
    await tick();
    expect(got2?.nodes[0].title).toBe("first");
  });
});

describe("T35-S4 tree memo: stale-while-revalidate after a pull", () => {
  it("serves the stale tree at once, rebuilds it in the background from the fresh loader, then swaps", async () => {
    const memo = createTreeMemo<string, string>(60_000);
    let spines = "s1";
    let builds = 0;
    let releaseFresh: () => void = () => {};
    const make = (s: string | undefined) => (builds++, `tree:${s}`);
    const load = () => ({ spines, dir: "/r" });
    const fresh = () => new Promise<{ spines: string; dir: string }>((r) => (releaseFresh = () => r({ spines, dir: "/r" })));
    expect(await memo.get("k", load, make, true, fresh)).toBe("tree:s1");
    memo.invalidate("/r", { stale: true });
    spines = "s2";
    expect(await memo.get("k", load, make, true, fresh)).toBe("tree:s1");
    expect(memo.info("k")?.stale).toBe(true);
    expect(await memo.get("k", load, make, true, fresh)).toBe("tree:s1"); // one rebuild per key at a time
    await tick();
    releaseFresh();
    await memo.rebuilt("k");
    expect(builds).toBe(2);
    expect(memo.info("k")?.stale).toBe(false);
    expect(await memo.get("k", load, make, true, fresh)).toBe("tree:s2");
    expect(builds).toBe(2);
  });

  it("background rebuilds run one at a time, and other work runs between two of them", async () => {
    const memo = createTreeMemo<string, string>(60_000);
    const order: string[] = [];
    let spines = "s1";
    const load = () => ({ spines, dir: "/r" });
    const make = (key: string) => (s: string | undefined) => {
      if (s === "s2") {
        order.push(`build ${key}`);
        setImmediate(() => order.push(`request after ${key}`)); // a request that arrived during this build
      }
      return `${key}:${s}`;
    };
    await memo.get("a", load, make("a"), true, load);
    await memo.get("b", load, make("b"), true, load);
    memo.invalidate("/r", { stale: true });
    spines = "s2";
    expect(await memo.get("a", load, make("a"), true, load)).toBe("a:s1");
    expect(await memo.get("b", load, make("b"), true, load)).toBe("b:s1");
    await memo.rebuilt("a");
    await memo.rebuilt("b");
    await tick();
    expect(order).toEqual(["build a", "request after a", "build b", "request after b"]);
    expect(await memo.get("b", load, make("b"), true, load)).toBe("b:s2");
  });

  it("a write drops the trees: the next read waits and builds; a pull of another dir leaves them fresh", async () => {
    const memo = createTreeMemo<string, string>(60_000);
    let spines = "s1";
    const load = () => ({ spines, dir: "/r" });
    const make = (s: string | undefined) => `tree:${s}`;
    await memo.get("k", load, make, true, load);
    memo.invalidate("/other", { stale: true });
    expect(memo.info("k")?.stale).toBe(false);
    memo.invalidate("/r");
    spines = "s2";
    expect(memo.info("k")).toBeUndefined();
    expect(await memo.get("k", load, make, true, load)).toBe("tree:s2");
  });

  it("a rebuild that started before a write is not stored", async () => {
    const memo = createTreeMemo<string, string>(60_000);
    let spines = "s1";
    let releaseFresh: () => void = () => {};
    const load = () => ({ spines, dir: "/r" });
    const fresh = () => new Promise<{ spines: string; dir: string }>((r) => (releaseFresh = () => r({ spines: "pre-write", dir: "/r" })));
    const make = (s: string | undefined) => `tree:${s}`;
    await memo.get("k", load, make, true, fresh);
    memo.invalidate("/r", { stale: true });
    await memo.get("k", load, make, true, fresh);
    await tick();
    memo.invalidate("/r"); // the console's own write
    spines = "written";
    releaseFresh();
    await tick(5);
    expect(await memo.get("k", load, make, true, fresh)).toBe("tree:written");
  });
});

describe("T35-S4 pull on open: only a repo's first pull is waited for", () => {
  it("the first open waits for its pull (up to openWaitMs); a later re-pull starts and the open answers at once", async () => {
    let pulls = 0;
    const git = async (_dir: string, args: string[]) => {
      if (args[0] !== "rev-parse" && args[0] !== "status") {
        pulls++;
        await tick(300);
      }
      return "";
    };
    const f = createFreshness({ git, openMaxAgeMs: 0, openWaitMs: 2_000, reopenWaitMs: 0, log: () => {} });
    let t0 = Date.now();
    await f.onOpen("/r");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    const before = pulls;
    await tick(5);
    t0 = Date.now();
    await f.onOpen("/r");
    expect(Date.now() - t0).toBeLessThan(100);
    await tick(50);
    expect(pulls).toBeGreaterThan(before); // the re-pull did start
  });
});

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe("T35-S4 the first tree read after a pull does not wait", () => {
  it("Refresh (a pull): the next read answers the last tree with stale: true, the new one replaces it once built", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e35s4-"));
    const repo = path.join(root, "alpha");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git/config"), `[remote "origin"]\n\turl = https://github.com/Acme/alpha.git\n`);
    fs.writeFileSync(path.join(repo, "EPIC.md"), `# EPIC: alpha\n\n## Current State\n\nStatus: active\n`);
    let title = "Before pull";
    let delayMs = 0;
    let runs = 0;
    const slow: SpinesRunner = async () => {
      runs++;
      await tick(delayMs);
      return fixture(title);
    };
    const spines = cachedRunner(slow, 60_000, Date.now, () => {});
    const db: DB = openDb(path.join(root, "c.db"));
    const app = createApp(db, {
      read: { reposRoot: root, seatsFile: path.join(root, "seats.json"), listThreads: async () => [], spines },
      freshness: { enabled: false, git: async () => "" },
      treeTtlMs: 3_000, // the production memo (tests default to none)
    });
    cleanup = () => {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    };
    const m = createStore(db).createMilestone({ title: "alpha", repo: "Acme/alpha", path: "EPIC.md", owner: "", paused: false });
    const read = async () => {
      const t0 = Date.now();
      const res = await app.request(`/api/milestones/${m.id}/tree`);
      expect(res.status).toBe(200);
      return { ms: Date.now() - t0, tree: (await res.json()) as { root: { title: string }; stale?: boolean; builtAt?: string } };
    };
    const cold = await read();
    expect(cold.tree.root.title).toBe("Before pull");
    expect(cold.tree.stale).toBeUndefined();
    expect(typeof cold.tree.builtAt).toBe("string");

    // The pull brings a new spine; spines.py for it takes a while (13-23 s for the code repo on the main server; 600 ms here).
    title = "After pull";
    delayMs = 600;
    const refreshed = await app.request(`/api/milestones/${m.id}/refresh`, { method: "POST" });
    expect(refreshed.status).toBe(200);
    const first = await read();
    expect(first.ms).toBeLessThan(400);
    expect(first.tree.root.title).toBe("Before pull");
    expect(first.tree.stale).toBe(true);

    // The rewarm after the pull builds the new tree once spines.py is done; reads then get it without waiting.
    const until = Date.now() + 5_000;
    let after = await read();
    while (after.tree.root.title !== "After pull" && Date.now() < until) {
      await tick(50);
      after = await read();
    }
    expect(after.tree.root.title).toBe("After pull");
    expect(after.tree.stale).toBeUndefined();
    expect(after.ms).toBeLessThan(400);
    expect(Date.parse(after.tree.builtAt!)).toBeGreaterThan(Date.parse(cold.tree.builtAt!));
    expect(runs).toBe(2); // one run before, one after the pull: the stale read and the rewarm share it
  });
});
