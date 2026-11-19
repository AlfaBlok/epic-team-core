import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { resetRepoScans } from "../src/adapters/repos.js";
import type { SpineNode, SpinesJson } from "../src/adapters/spines.js";
import { buildRepoBook, codeMatcher, epicNumber, parseDecisions, parseGitLog, stateOf, type Book } from "../src/book/build.js";
import { bookStore, createBook, headOf } from "../src/book/service.js";
import { openDb, type DB } from "../src/db.js";
import type { ReadConfig } from "../src/routes/read.js";

/** the Epic Book, generated from spines.py + Decisions + git log, cached, no git spawn on the request path. */

const EPIC40 = `# EPIC-940: Lanes and radar

## Goal

Sam sees his lanes.

## Current State

Status: active
Waiting on: none

## Decisions

| Date | Outcome | Decision / Attempt | Durable Summary | Evidence | Revisit When |
|---|---|---|---|---|---|
| 2026-10-28 | accepted | Created from the voice note | one node | root.md | never |
| 2026-10-31 | accepted | Sam asked for the Epic Book | home team.example.com/book | chat | never |
| not a date | x | ignored | ignored | - | - |
`;

const node = (over: Partial<SpineNode> & { path: string; title: string }): SpineNode => ({
  id: over.path,
  parent: null,
  status: "active",
  rollup_status: "active",
  dod: [],
  children: [],
  ...over,
});

const LOG = [
  ["a1b2c3d", "2026-10-31T23:00:00+01:00", "E940-S2: Epic Book route", "core/console/server/src/book/build.ts"],
  ["b2c3d4e", "2026-10-30T10:00:00+00:00", "EPIC-990: not ours", "docs/spines/epic-990.md"],
  ["c3d4e5f", "2026-10-29T10:00:00+00:00", "spine tidy", "docs/spines/epic-940-lanes.md"],
  ["d4e5f6a", "2026-10-28T10:00:00+00:00", "E904-S1: other epic", "x.ts"],
  ["e5f6a7b", "2026-10-27T10:00:00+00:00", "Merge remote-tracking branch 'origin/main' into wt/e940-s2", "docs/spines/epic-940-lanes.md"],
]
  .map(([h, d, s, f]) => `\x1e${h}\x1f${d}\x1f${s}\n\n${f}\n`)
  .join("");

describe("E940-S2 pure parts", () => {
  it("reads the Decisions table, newest first, skipping rows without a date", () => {
    const d = parseDecisions(EPIC40);
    expect(d.map((x) => x.date)).toEqual(["2026-10-31", "2026-10-28"]);
    expect(d[0]).toMatchObject({ outcome: "accepted", decision: "Sam asked for the Epic Book", summary: "home team.example.com/book" });
    expect(parseDecisions("# x\n\nno decisions")).toEqual([]);
  });

  it("parses git log records with their files, dates in UTC", () => {
    const c = parseGitLog(LOG);
    expect(c).toHaveLength(5);
    expect(c[0]).toEqual({ sha: "a1b2c3d", date: "2026-10-31T22:00:00.000Z", subject: "E940-S2: Epic Book route", files: ["core/console/server/src/book/build.ts"] });
  });

  it("knows an epic's number and matches only its own codes", () => {
    expect(epicNumber("EPIC-940: Lanes")).toBe(940);
    expect(epicNumber("EPIC-906: M6 — Team runs unattended")).toBe(906);
    expect(epicNumber("M2 — Team console")).toBe(2);
    expect(epicNumber("home_repo")).toBeUndefined();
    const re = codeMatcher(940);
    for (const s of ["EPIC-940: x", "E940-S2: y", "Merge wt/e940-s2: E940-S2 z", "E940-4 met", "row E940-S12"]) expect(re.test(s), s).toBe(true);
    for (const s of ["EPIC-9400: x", "E994-S1: y", "E9400-S1", "XE940-S2"]) expect(re.test(s), s).toBe(false);
  });

  it("calls an epic moving, stuck, parked or done", () => {
    expect(stateOf("active", null, 0)).toBe("moving");
    expect(stateOf("ready", null, 0)).toBe("moving");
    expect(stateOf("blocked", null, 0)).toBe("stuck");
    expect(stateOf("active", "Sam: E922-A1", 0)).toBe("stuck");
    expect(stateOf("active", null, 1)).toBe("stuck");
    expect(stateOf("draft", "x", 1)).toBe("parked");
    expect(stateOf("deferred", null, 0)).toBe("parked");
    expect(stateOf("review", null, 0)).toBe("done");
    expect(stateOf("superseded", null, 0)).toBe("done");
  });

  it("builds a repo's chapter: goal, why, timeline of its commits and decisions, next, stuck", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e940s2-"));
    try {
      fs.mkdirSync(path.join(dir, "docs/spines"), { recursive: true });
      fs.writeFileSync(path.join(dir, "docs/spines/epic-940-lanes.md"), EPIC40);
      const spines: SpinesJson = {
        root: "docs/spines/root.md",
        orphans: [],
        mismatches: [],
        nodes: [
          node({ path: "docs/spines/root.md", title: "home_repo", current_state: { waiting_on: "none" } as never }),
          node({
            path: "docs/spines/epic-940-lanes.md",
            title: "EPIC-940: Lanes and radar",
            parent: "docs/spines/root.md",
            goal: "Sam sees his lanes.",
            serves: "[home_repo](root.md): the root",
            current_state: { status: "active", waiting_on: "Sam: E940-A1 (pick the lanes)", next_action: "build the Book", last_attempted: "2026-10-31 S2", verified_at: "2026-10-31" } as never,
            done_means: [
              { id: "E940-1", text: "a", done: true },
              { id: "E940-4", text: "b", done: false },
            ],
            ...({ waiting_on: [{ code: "E940-A1", who: "Sam", question: "Which lanes?", state: "open" }, { code: "E940-A0", who: "Sam", question: "old", state: "answered" }] } as object),
          }),
        ],
      };
      const r = buildRepoBook({ name: "home_repo", path: dir, remote: "Acme/home_repo" }, spines, parseGitLog(LOG));
      const e = r.epics[1];
      expect(e).toMatchObject({
        code: "EPIC-940",
        depth: 1,
        state: "stuck",
        goal: "Sam sees his lanes.",
        serves: "home_repo: the root",
        next: "build the Book",
        waitingOn: "Sam: E940-A1 (pick the lanes)",
        asks: [{ code: "E940-A1", who: "Sam", question: "Which lanes?" }],
        dod: { done: 1, total: 2 },
        href: "https://github.com/Acme/home_repo/blob/main/docs/spines/epic-940-lanes.md",
      });
      // its own code and its spine file, never, E904- or a sync merge of main; decisions interleaved by date, newest first
      expect(e.timeline.map((t) => t.sha ?? t.kind)).toEqual(["a1b2c3d", "decision", "c3d4e5f", "decision"]);
      expect(r.epics[0]).toMatchObject({ code: "root", state: "moving", waitingOn: null });
      expect(r.counts).toEqual({ moving: 1, stuck: 1, parked: 0, done: 0 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("E940-S2 service: cached, background, no git on the request path", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e940s2-svc-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const spines: SpinesJson = { root: "docs/spines/root.md", orphans: [], mismatches: [], nodes: [node({ path: "docs/spines/root.md", title: "EPIC-901: root" })] };
  const repo = (name = "r") => ({ name, path: `/x/${name}`, hasEpicSpine: true });

  it("reads HEAD from the .git files: loose ref, packed ref, detached", () => {
    fs.mkdirSync(path.join(dir, ".git/refs/heads"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".git/HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(dir, ".git/packed-refs"), `# pack\n${"b".repeat(40)} refs/heads/main\n`);
    expect(headOf(dir)).toBe("b".repeat(40));
    fs.writeFileSync(path.join(dir, ".git/refs/heads/main"), `${"a".repeat(40)}\n`);
    expect(headOf(dir)).toBe("a".repeat(40));
    fs.writeFileSync(path.join(dir, ".git/HEAD"), `${"c".repeat(40)}\n`);
    expect(headOf(dir)).toBe("c".repeat(40));
    expect(headOf(path.join(dir, "missing"))).toBeUndefined();
  });

  it("builds once, serves from memory, rebuilds in the background only when a HEAD moved (or the book is old)", async () => {
    let t = 0;
    let head = "h1";
    let gitCalls = 0;
    let spinesCalls = 0;
    let release: (() => void) | undefined;
    const git = async () => {
      gitCalls++;
      if (release === undefined && gitCalls > 1) await new Promise<void>((r) => (release = r));
      return LOG;
    };
    const b = createBook({ repos: () => [repo()], spines: async () => (spinesCalls++, spines), git, now: () => t, head: () => head, ttlMs: 1_000, maxAgeMs: 10_000 });
    const first = await b.get();
    expect(first.book?.repos.map((r) => r.name)).toEqual(["r"]);
    expect([gitCalls, spinesCalls]).toEqual([1, 1]);

    t = 500;
    expect((await b.get()).book).toBe(first.book); // fresh: from memory
    t = 2_000;
    expect((await b.get()).book).toBe(first.book); // stale but no HEAD moved: kept, nothing spawned
    await new Promise((r) => setTimeout(r, 0));
    expect([gitCalls, spinesCalls]).toEqual([1, 1]);

    head = "h2";
    t = 4_000;
    const during = await b.get(); // HEAD moved: the rebuild runs git in the background, the request does not wait
    expect(during.book).toBe(first.book);
    expect(during.building).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(gitCalls).toBe(2);
    release!();
    await new Promise((r) => setTimeout(r, 0));
    const after = await b.get();
    expect(after.building).toBe(false);
    expect(after.book).not.toBe(first.book);

    t = 4_000 + 10_000; // old enough: rebuilt even with the same HEADs (uncommitted spine edits), git not re-run
    await b.get();
    await new Promise((r) => setTimeout(r, 0));
    // the moved HEAD read only its new commits (an ancestry check, then the log of h1..h2), never the whole log again.
    expect([gitCalls, spinesCalls]).toEqual([3, 3]);
  });

  it("the very first read waits at most softMs, and a failing repo keeps the others", async () => {
    const never = new Promise<string>(() => {});
    const b = createBook({ repos: () => [repo("slow")], spines: async () => spines, git: () => never, head: () => undefined, softMs: 20 });
    const v = await b.get();
    expect(v).toEqual({ book: null, building: true });

    const c = createBook({
      repos: () => [repo("bad"), repo("good"), { ...repo("plain"), hasEpicSpine: false }],
      spines: async (d) => {
        if (d.endsWith("bad")) throw new Error("spines.py exploded");
        return spines;
      },
      git: async () => {
        throw new Error("fatal: not a git repository");
      },
      head: () => undefined,
      log: () => {},
    });
    const w = await c.get();
    expect(w.book?.repos.map((r) => [r.name, r.error])).toEqual([["good", "git log failed: fatal: not a git repository"]]);
  });

  it("invalidate makes the next read start a rebuild", async () => {
    let builds = 0;
    const b = createBook({ repos: () => [repo()], spines: async () => (builds++, spines), git: async () => "", now: () => 0, head: () => "h", ttlMs: 60_000 });
    await b.get();
    await b.get();
    expect(builds).toBe(1);
    b.invalidate();
    await b.get();
    await new Promise((r) => setTimeout(r, 0));
    expect(builds).toBe(2);
  });
});

describe("E929-S4 rework: the book is always there (stored, refreshed behind it)", () => {
  let dir: string;
  let db: DB | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e29s4b-"));
  });
  afterEach(() => {
    db?.close();
    db = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const spines: SpinesJson = { root: "docs/spines/root.md", orphans: [], mismatches: [], nodes: [node({ path: "docs/spines/root.md", title: "EPIC-901: root" })] };
  const repo = { name: "r", path: "/x/r", hasEpicSpine: true };
  const never = new Promise<never>(() => {});

  it("a restart serves the stored book at once, building behind it", async () => {
    db = openDb(path.join(dir, "c.db"));
    const before = createBook({ repos: () => [repo], spines: async () => spines, git: async () => LOG, head: () => "h", store: bookStore(db) });
    const built = (await before.get()).book!;
    // the restarted process: a cold build that never finishes (the host under load); the read must not wait for it
    const after = createBook({ repos: () => [repo], spines: () => never, git: () => never, head: () => "h", softMs: 60_000, store: bookStore(db) });
    const t0 = Date.now();
    const v = await after.get();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(v.book?.builtAt).toBe(built.builtAt);
    expect(v.book?.repos.map((r) => r.name)).toEqual(["r"]);
    expect(v.building).toBe(true); // a stored book is rebuilt (its sources may have moved while the server was down)
  });

  it("a stale or failed refresh is retried by the timer, with no reader", async () => {
    db = openDb(path.join(dir, "c.db"));
    let t = 0;
    let head = "h1";
    let fail = false;
    let builds = 0;
    const b = createBook({
      repos: () => {
        if (fail) throw new Error("host overloaded");
        return [repo];
      },
      spines: async () => (builds++, spines),
      git: async () => LOG,
      now: () => t,
      head: () => head,
      idleMaxAgeMs: 30_000,
      log: () => {},
      store: bookStore(db),
    });
    const settle = () => new Promise((r) => setTimeout(r, 0));
    expect(b.tick()).toBe(true); // no book yet: built
    await settle();
    expect(builds).toBe(1);
    expect(b.tick()).toBe(false); // nothing moved
    head = "h2"; // a spine change pulled or committed: rebuilt without anyone opening the page
    expect(b.tick()).toBe(true);
    await settle();
    expect(builds).toBe(2);

    fail = true;
    t = 40_000; // old: the rebuild fails, the last book stays served
    expect(b.tick()).toBe(true);
    await settle();
    const kept = b.builtAt();
    expect(kept).toBe(0); // the last good book (built at t=0) is still the one served
    expect(bookStore(db).load()?.builtAt).toBe(new Date(0).toISOString());
    fail = false;
    expect(b.tick()).toBe(true); // retried on the next tick, not left stale
    await settle();
    const v = await b.get();
    expect(v.error).toBeUndefined();
    expect(v.book?.builtAt).toBe(new Date(40_000).toISOString());
    // and the retried book is the stored one a restart will serve
    expect(bookStore(db).load()?.builtAt).toBe(new Date(40_000).toISOString());
  });
});

describe("E940-S2 GET /api/book", () => {
  let root: string;
  let db: DB | undefined;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e940s2-app-"));
    fs.mkdirSync(path.join(root, "home_repo/.git"), { recursive: true });
    fs.mkdirSync(path.join(root, "home_repo/docs/spines"), { recursive: true });
    fs.writeFileSync(path.join(root, "home_repo/docs/spines/root.md"), EPIC40);
    resetRepoScans(0);
  });
  afterEach(() => {
    resetRepoScans();
    db?.close();
    db = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("answers the book from the spines, gzipped when asked; 503 without spines.py", async () => {
    db = openDb(path.join(root, "c.db"));
    const spines: SpinesJson = { root: "docs/spines/root.md", orphans: [], mismatches: [], nodes: [node({ path: "docs/spines/root.md", title: "EPIC-940: Lanes and radar", goal: "Sam sees his lanes." })] };
    const read: ReadConfig = { reposRoot: root, seatsFile: path.join(root, "seats.json"), listThreads: async () => [], spines: async () => spines };
    let gitCalls = 0;
    const app = createApp(db, { read, browser: { browserUrl: "http://127.0.0.1:9" }, book: { git: async () => (gitCalls++, LOG) } });
    const res = await app.request("/api/book");
    expect(res.status).toBe(200);
    const v = (await res.json()) as { book: Book; building: boolean };
    expect(v.book.repos[0].epics[0]).toMatchObject({ code: "EPIC-940", goal: "Sam sees his lanes.", decisions: [{ date: "2026-10-31" }, { date: "2026-10-28" }] });
    expect(v.book.repos[0].epics[0].timeline[0]).toMatchObject({ sha: "a1b2c3d" });
    const gz = await app.request("/api/book", { headers: { "accept-encoding": "gzip" } });
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(gitCalls).toBe(1);

    // rework: a restarted console (same console.db, a cold build that does not finish) answers the stored book at once
    const restarted = createApp(db, { read: { ...read, spines: () => new Promise<never>(() => {}) }, browser: { browserUrl: "http://127.0.0.1:9" } });
    const t0 = Date.now();
    const r = (await (await restarted.request("/api/book")).json()) as { book: Book; building: boolean; refreshedAt: string };
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(r.book.repos[0].epics[0]).toMatchObject({ code: "EPIC-940" });
    expect(r.building).toBe(true);
    expect(r.refreshedAt).toBe(v.book.builtAt); // the last rebuild, not only the daily pull

    const bare = createApp(openDb(path.join(root, "d.db")), { read: { ...read, spines: undefined }, browser: { browserUrl: "http://127.0.0.1:9" } });
    expect((await bare.request("/api/book")).status).toBe(503);
  });
});
