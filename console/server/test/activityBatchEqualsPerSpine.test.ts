import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Tree, TreeNode } from "../src/adapters/tree.js";
import { activityBatch, dayStart, doneRows, git, limitGit, parseCatFile, spineActivity, type Git } from "../src/cycle/movement.js";
import { createMovement } from "../src/cycle/movementRoutes.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";

// /api/moving-now off the event loop. A cold call ran 3-4 git processes per epic (~190 on the main server), and starting a
// child from the ~240 MB console is synchronous, so every other request stalled ~4 s (measure 2026-10-28, cause 1).

const EPICS = 48;
let root: string;
let db: DB | undefined;
const repo = () => path.join(root, "r");
const sh = (args: string[], date?: string) =>
  execFileSync("git", ["-C", repo(), ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
    stdio: "pipe",
  }).toString();
const spine = (i: number, rows: string) =>
  `# EPIC-${i}: Épique ${i} — ünïcode\n\n## Current State\n\nStatus: active\n\n## Issue Ledger\n\n| Issue | Title | Status |\n|---|---|---|\n${rows}`;
const write = (i: number, rows: string) => fs.writeFileSync(path.join(repo(), `docs/spines/epic-${i}.md`), spine(i, rows));
const commit = (msg: string, date: string) => {
  sh(["add", "-A"]);
  sh(["commit", "-qm", msg], date);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e33s4-"));
  fs.mkdirSync(path.join(repo(), "docs/spines"), { recursive: true });
  sh(["init", "-q", "-b", "main"]);
  const yesterday = new Date(Date.parse(dayStart(Date.now())) - 6 * 3600_000).toISOString();
  for (let i = 0; i < EPICS; i++) write(i, `| E${900 + i}-S1 | a | done |\n| E${900 + i}-S2 | b | ready |\n`);
  commit("yesterday", yesterday);
  // today: half the epics close S2, one on a side branch merged with a conflict resolution, one spine is new today
  const today = new Date().toISOString();
  for (let i = 0; i < EPICS; i += 2) write(i, `| E${900 + i}-S1 | a | done |\n| E${900 + i}-S2 | b | done |\n`);
  commit("today", today);
  sh(["checkout", "-q", "-b", "side"]);
  write(1, `| E901-S1 | a | done |\n| E901-S2 | b | review |\n`);
  commit("side", today);
  sh(["checkout", "-q", "main"]);
  write(1, `| E901-S1 | a | done |\n| E901-S2 | b | blocked |\n`);
  commit("main", today);
  try {
    sh(["merge", "-q", "side", "-m", "merge"], today);
  } catch {
    write(1, `| E901-S1 | a | done |\n| E901-S2 | b | done |\n`);
    commit("merge resolved", today);
  }
  fs.writeFileSync(path.join(repo(), "docs/spines/new.md"), spine(99, "| N1 | n | done |\n"));
  commit("new", today);
});
afterEach(() => {
  db?.close();
  db = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

const rels = () => [...Array.from({ length: EPICS }, (_, i) => `docs/spines/epic-${i}.md`), "docs/spines/new.md", "docs/spines/absent.md"];

/** The per-spine computation replaced (3-4 git processes per spine): the reference the batch must equal. */
async function perSpine(g: Git, dir: string, rel: string, now: number) {
  const last = (await g(dir, ["log", "-1", "--format=%cI", "HEAD", "--", rel]).catch(() => "")).trim() || undefined;
  const show = (rev: string) => g(dir, ["show", `${rev}:${rel}`]).catch(() => "");
  const nowText = await show("HEAD");
  if (!nowText) return { ...(last ? { lastCommitAt: last } : {}), doneToday: [] as string[] };
  const before = (await g(dir, ["rev-list", "-1", `--before=${dayStart(now)}`, "HEAD"]).catch(() => "")).trim();
  const was = before ? doneRows(await show(before)) : new Set<string>();
  return { ...(last ? { lastCommitAt: last } : {}), doneToday: [...doneRows(nowText)].filter((id) => !was.has(id)) };
}

describe("activityBatch", () => {
  it("equals the per-spine answer for every spine (merges, a spine new today, a missing one, non-ASCII text) in 3 git processes", async () => {
    const calls: string[][] = [];
    const g: Git = (d, a, i) => (calls.push(a), git(d, a, i));
    const now = Date.now();
    const got = await activityBatch(g, repo(), rels(), now);
    expect(calls).toHaveLength(3);
    for (const rel of rels()) expect([rel, got.get(rel)]).toEqual([rel, await perSpine(git, repo(), rel, now)]);
    expect(got.get("docs/spines/epic-0.md")!.doneToday).toEqual(["E900-S2"]);
    expect(got.get("docs/spines/epic-3.md")!.doneToday).toEqual([]);
    expect(got.get("docs/spines/new.md")!.doneToday).toEqual(["N1"]);
    expect(got.get("docs/spines/absent.md")).toEqual({ doneToday: [] });
  });

  it("limitGit starts at most one git process per turn of the event loop (each start is synchronous)", async () => {
    let started = 0;
    const g = limitGit(async () => (started++, new Promise<string>((r) => setTimeout(() => r(""), 50))), 4);
    const all = Promise.all(Array.from({ length: 4 }, () => g("/r", [])));
    expect(started).toBe(0);
    for (let turn = 1; turn <= 4; turn++) {
      await new Promise((r) => setImmediate(r));
      expect(started).toBe(turn);
    }
    await all;
  });

  it("parseCatFile walks sizes in bytes and reads missing objects", () => {
    const a = "héllo\n";
    const out = `abc blob ${Buffer.byteLength(a)}\n${a}\nHEAD:x missing\ndef blob 2\nok\n`;
    expect(parseCatFile(out, ["1", "2", "3"])).toEqual([{ oid: "abc", text: a }, undefined, { oid: "def", text: "ok" }]);
    expect(parseCatFile("", ["1"])).toEqual([undefined]);
  });
});

// ---------- the event loop during a cold /api/moving-now ----------

/** Starting a child from the ~240 MB console blocks the event loop ~22 ms (4.3 s spawn self time / ~190 spawns, profile A). */
const SPAWN_MS = 22;
const busy = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end);
};

const node = (over: Partial<TreeNode>): TreeNode => ({ key: over.id ?? "k", id: "x", kind: "ticket", title: "", status: "ready", color: "grey", children: [], flags: [], ...over });
const tree = (milestoneId: string): Tree => ({
  milestoneId,
  root: node({
    id: "root",
    key: "root",
    kind: "spine",
    status: "active",
    path: "docs/spines/new.md",
    children: Array.from({ length: EPICS }, (_, i) =>
      node({ id: `epic-${i}`, key: `root/epic-${i}`, kind: "spine", status: "active", path: `docs/spines/epic-${i}.md`, children: [node({ id: `E${900 + i}-S2`, key: `root/epic-${i}/E${900 + i}-S2`, ready: true })] }),
    ),
  }),
  source: "spines",
} as unknown as Tree);

async function harness(activity: ReturnType<typeof spineActivity>) {
  db = openDb(path.join(root, "console.db"));
  const store = createStore(db);
  store.createMilestone({ title: "M", repo: "Acme/r", path: "docs/spines/new.md", owner: "", paused: false });
  const movement = createMovement({ store, treeFor: async (m) => tree(m.id), repoDir: () => repo(), seats: () => [], enabled: false, activity });
  const api = new Hono();
  api.get("/ping", (c) => c.text("ok"));
  movement.mount(api);
  const app = new Hono().route("/api", api);
  let server: ReturnType<typeof serve> | undefined;
  const base = await new Promise<string>((resolve) => {
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info: AddressInfo) => resolve(`http://127.0.0.1:${info.port}`));
  });
  /**
   * Cold /api/moving-now while a cheap request goes out every 20 ms: each cheap answer's wall time and the CPU this process
   * spent while it was out (on a busy host wall time also counts the wait for a CPU; what the server blocks is CPU),
   * and the strip.
   */
  const run = async () => {
    const pings: number[] = [];
    const cpu: number[] = [];
    let moving = true;
    const strip = fetch(`${base}/api/moving-now`).then((r) => r.json() as Promise<{ epics: { path: string; doneToday: string[] }[] }>).finally(() => (moving = false));
    while (moving) {
      const t = performance.now();
      const c = process.cpuUsage();
      await fetch(`${base}/api/ping`).then((r) => r.text());
      const d = process.cpuUsage(c);
      pings.push(performance.now() - t);
      cpu.push((d.user + d.system) / 1000);
      await new Promise((r) => setTimeout(r, 20));
    }
    return { pings, cpu, slowest: Math.max(...cpu), strip: await strip };
  };
  return { run, close: () => server?.close() };
}

describe("a cold /api/moving-now does not stall other requests", () => {
  it(`48 epics: 3 git processes, a cheap request answers fast throughout (each spawn blocks ${SPAWN_MS} ms)`, async () => {
    let spawns = 0;
    const g: Git = (d, a, i) => {
      spawns++;
      busy(SPAWN_MS);
      return git(d, a, i);
    };
    const h = await harness(spineActivity(limitGit(g)));
    try {
      const { cpu, slowest, strip } = await h.run();
      expect(spawns).toBe(3);
      expect(cpu.length).toBeGreaterThan(0);
      // 3 spawns block ~66 ms in all: at most one cheap request can land behind them (CPU ms, not wall:)
      expect(cpu.filter((ms) => ms > 150).length).toBeLessThanOrEqual(1);
      expect(slowest).toBeLessThan(300);
      expect(strip.epics.find((e) => e.path === "docs/spines/epic-0.md")!.doneToday).toEqual(["E900-S2"]);
      // warm: same HEAD, no git at all
      spawns = 0;
      await h.run();
      expect(spawns).toBe(0);
    } finally {
      h.close();
    }
  }, 30_000);

  it("control: the per-spine way (3-4 processes per epic) holds every cheap request for seconds", async () => {
    let spawns = 0;
    let blocked = 0;
    const g: Git = (d, a, i) => {
      spawns++;
      const t = performance.now();
      busy(SPAWN_MS);
      blocked += performance.now() - t;
      return git(d, a, i);
    };
    // the limiter as deployed before: up to 4 starts back to back in one turn
    const lg: Git = (() => {
      let running = 0;
      const queue: (() => void)[] = [];
      const next = () => {
        if (running < 4) queue.shift()?.();
      };
      return (d, a, i) =>
        new Promise<string>((resolve, reject) => {
          queue.push(() => {
            running++;
            g(d, a, i).then(resolve, reject).finally(() => (running--, next()));
          });
          next();
        });
    })();
    const old = ((dir: string, rel: string, now = Date.now()) => perSpine(lg, dir, rel, now)) as ReturnType<typeof spineActivity>;
    const h = await harness(old);
    try {
      const r = await h.run();
      expect(spawns).toBeGreaterThanOrEqual(EPICS * 3);
      expect(blocked).toBeGreaterThan(3000);
      // every cheap request in those seconds waits behind a spawn burst (seen: 18 of 20 at 180-280 ms)
      expect(r.pings.filter((ms) => ms > 150).length).toBeGreaterThanOrEqual(10);
    } finally {
      h.close();
    }
  }, 60_000);
});
