import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { resetRepoScans } from "../src/adapters/repos.js";
import type { SpineNode, SpinesJson } from "../src/adapters/spines.js";
import { assembleBook, buildRepoBook, CAPABILITIES_FILE, slimBook, type Book } from "../src/book/build.js";
import { BOOK_STALE_MS, bookUpdated, milestoneBook, type MilestoneBook } from "../src/book/milestone.js";
import { CATALOG_FILES, createBookRefresh, PROBE_SCRIPT, RETRY_MS, slotOf } from "../src/book/refresh.js";
import { openDb, type DB } from "../src/db.js";
import { createSpineWriter, type ScaffoldInput } from "../src/inbox/spineWrite.js";
import { createStore } from "../src/store.js";
import type { ReadConfig } from "../src/routes/read.js";

/** the books' daily refresh (pull, capability probe committed, rebuild), last updated, stale after 2 days. */

const H = 3600_000;
const D = 24 * H;
const T0 = Date.parse("2026-11-01T10:00:00Z");

const node = (over: Partial<SpineNode> & { path: string; title: string }): SpineNode => ({
  id: over.path,
  parent: null,
  status: "active",
  rollup_status: "active",
  dod: [],
  children: [],
  ...over,
});
const ROOT = "docs/spines/root.md";
const spines: SpinesJson = {
  root: ROOT,
  orphans: [],
  mismatches: [],
  nodes: [
    node({ path: ROOT, title: "home_repo", goal: "Run a team." }),
    node({ path: "docs/spines/epic-40.md", title: "EPIC-940: Lanes", parent: ROOT }),
    node({ path: "docs/spines/epic-9.md", title: "EPIC-909: Elsewhere" }),
  ],
};
const commit = (sha: string, date: string, files: string[], subject = "x") => ({ sha, date, subject, files });

describe("E947-S3 last updated", () => {
  it("slotOf: today's 05:00Z from 05:00 on, yesterday's before", () => {
    expect(new Date(slotOf(Date.parse("2026-11-01T10:00:00Z"))).toISOString()).toBe("2026-11-01T05:00:00.000Z");
    expect(new Date(slotOf(Date.parse("2026-11-01T04:59:00Z"))).toISOString()).toBe("2026-10-31T05:00:00.000Z");
  });

  it("bookUpdated: the newest of spine, probe and refresh; stale only past 2 days", () => {
    const u = bookUpdated({ spineAt: "2026-10-20T00:00:00Z", probeAt: "2026-10-31T09:00:00Z", refreshedAt: "2026-10-30T05:00:00Z" }, T0);
    expect(u).toEqual({ at: "2026-10-31T09:00:00.000Z", spineAt: "2026-10-20T00:00:00.000Z", probeAt: "2026-10-31T09:00:00.000Z", refreshedAt: "2026-10-30T05:00:00.000Z", stale: false });
    expect(bookUpdated({ refreshedAt: new Date(T0 - BOOK_STALE_MS - 1).toISOString() }, T0).stale).toBe(true);
    expect(bookUpdated({ refreshedAt: new Date(T0 - BOOK_STALE_MS + 1).toISOString() }, T0).stale).toBe(false);
    expect(bookUpdated({}, T0)).toMatchObject({ at: null, stale: true });
  });

  it("the book's spine date is the newest commit touching the milestone's spine or one under it; /api/book stays slim", () => {
    const repo = buildRepoBook({ name: "home_repo", path: "/nowhere" }, spines, [
      commit("c3", "2026-10-31T08:00:00Z", ["docs/spines/epic-9.md"]), // not under the root milestone
      commit("c2", "2026-10-29T08:00:00Z", ["docs/spines/epic-40.md"]),
      commit("c1", "2026-10-20T08:00:00Z", [ROOT]),
    ]);
    expect(repo.epics.map((e) => e.spineChangedAt)).toEqual(["2026-10-20T08:00:00Z", "2026-10-29T08:00:00Z", "2026-10-31T08:00:00Z"]);
    const book: Book = assembleBook([repo], new Date(T0));
    const mb = milestoneBook(book, { id: "ms_1", repoName: "home_repo", path: ROOT }, { refreshedAt: null, now: T0 })!;
    expect(mb.updated).toMatchObject({ at: "2026-10-29T08:00:00.000Z", spineAt: "2026-10-29T08:00:00.000Z", probeAt: null, refreshedAt: null, stale: true });
    expect(milestoneBook(book, { id: "ms_1", repoName: "home_repo", path: ROOT }, { refreshedAt: "2026-11-01T05:00:00Z", now: T0 })!.updated.stale).toBe(false);
    expect("spineChangedAt" in slimBook(book).repos[0].epics[0]).toBe(false);
  });
});

describe("E947-S3 createBookRefresh", () => {
  let dir: string;
  let db: DB;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e47s3-"));
    db = openDb(path.join(dir, "c.db"));
    for (const r of ["withprobe", "plain"]) fs.mkdirSync(path.join(dir, r, "docs/status"), { recursive: true });
    fs.mkdirSync(path.join(dir, "withprobe/browser/scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "withprobe", CAPABILITIES_FILE), "{}\n");
    fs.writeFileSync(path.join(dir, "withprobe", PROBE_SCRIPT), "");
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const setup = (over: { rebuild?: () => Promise<Book>; scaffold?: "written" | "skipped" } = {}) => {
    let now = T0;
    const calls: string[] = [];
    const r = createBookRefresh({
      db,
      repos: () => [
        { name: "withprobe", path: path.join(dir, "withprobe"), hasEpicSpine: true },
        { name: "plain", path: path.join(dir, "plain"), hasEpicSpine: true },
        { name: "nospine", path: path.join(dir, "nospine"), hasEpicSpine: false },
      ],
      book: { rebuild: over.rebuild ?? (async () => (calls.push("rebuild"), assembleBook([], new Date(now)))) },
      invalidate: (d) => calls.push(`invalidate ${path.basename(d)}`),
      pull: async (d) => (calls.push(`pull ${path.basename(d)}`), path.basename(d) === "plain" ? { ok: false, reason: "not ff" } : { ok: true }),
      probe: async (d) => void calls.push(`probe ${path.basename(d)}`),
      writer: {
        scaffold: async (o: ScaffoldInput) => {
          const s = await o.scaffold(o.repoDir);
          calls.push(`scaffold ${o.path} ${JSON.stringify(s)}`);
          return over.scaffold === "skipped" ? { status: "skipped", reason: "the checkout has uncommitted changes" } : { status: "written", sha: "abc1234", path: o.path };
        },
      } as never,
      now: () => now,
      log: () => undefined,
    });
    return { r, calls, at: (t: number) => (now = t) };
  };

  it("pulls every spine repo, probes only where the table and probe live, rebuilds, records", async () => {
    const { r, calls } = setup();
    expect(r.due()).toBe(true);
    const run = await r.tick();
    expect(calls).toEqual([
      "pull withprobe",
      "probe withprobe",
      // the catalog drawn from the table may change in the same commit
      `scaffold ${CAPABILITIES_FILE} ${JSON.stringify({ ok: true, files: [CAPABILITIES_FILE, ...CATALOG_FILES] })}`,
      "invalidate withprobe",
      "pull plain",
      "invalidate plain",
      "rebuild",
    ]);
    expect(run).toMatchObject({
      ok: true,
      reason: "daily",
      repos: [
        { name: "withprobe", pull: "ok", probe: { status: "written", sha: "abc1234" } },
        { name: "plain", pull: "failed", pullError: "not ff" },
      ],
    });
    expect(r.lastOkAt()).toBe(new Date(T0).toISOString());
    expect(r.list()).toHaveLength(1);
    expect(r.due()).toBe(false);
    expect(await r.tick()).toBeUndefined();
  });

  it("a skipped probe is recorded with its reason; the book counts as refreshed; the probe is retried hourly, 4 runs a day at most", async () => {
    const { r, at } = setup({ scaffold: "skipped" });
    const run = await r.tick();
    expect(run!.repos[0].probe).toEqual({ status: "skipped", reason: "the checkout has uncommitted changes" });
    expect(run!.ok).toBe(true);
    expect(r.lastOkAt()).toBe(new Date(T0).toISOString());
    expect(r.due()).toBe(false);
    for (let i = 1; i <= 3; i++) {
      at(T0 + i * RETRY_MS);
      expect(r.due()).toBe(true);
      await r.tick();
    }
    at(T0 + 4 * RETRY_MS);
    expect(r.due()).toBe(false);
    expect(r.list()).toHaveLength(4);
  });

  it("due again in the next day's slot; a failed rebuild retries after an hour, never sooner", async () => {
    let fail = true;
    const { r, at } = setup({ rebuild: async () => (fail ? Promise.reject(new Error("spines.py down")) : assembleBook([], new Date(T0))) });
    const run = await r.tick();
    expect(run).toMatchObject({ ok: false, error: "spines.py down" });
    expect(r.lastOkAt()).toBeUndefined();
    at(T0 + RETRY_MS - 1);
    expect(r.due()).toBe(false);
    at(T0 + RETRY_MS);
    expect(r.due()).toBe(true);
    fail = false;
    expect(await r.tick()).toMatchObject({ ok: true });
    at(T0 + 19 * H - 1); // 04:59Z next day: still yesterday's slot
    expect(r.due()).toBe(false);
    at(T0 + 19 * H);
    expect(r.due()).toBe(true);
  });

  it("one run at a time: a second call joins the running one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const { r } = setup({ rebuild: async () => (await gate, assembleBook([], new Date(T0))) });
    const a = r.run();
    const b = r.run();
    expect(r.running()).toBe(true);
    release();
    expect(await a).toBe(await b);
    expect(r.list()).toHaveLength(1);
  });
});

describe("E947-S3 the probe commit goes through the spine writer's guards", () => {
  let dir: string;
  let db: DB;
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e47s3g-"));
    db = openDb(path.join(dir, "c.db"));
    git(dir, "init", "-q", "--bare", "-b", "main", "origin.git");
    git(dir, "clone", "-q", path.join(dir, "origin.git"), "repo");
    const repo = path.join(dir, "repo");
    git(repo, "checkout", "-q", "-b", "main");
    fs.mkdirSync(path.join(repo, "docs/spines"), { recursive: true });
    fs.mkdirSync(path.join(repo, "docs/status"), { recursive: true });
    fs.mkdirSync(path.join(repo, "browser/scripts"), { recursive: true });
    fs.writeFileSync(path.join(repo, ROOT), "# EPIC: repo\n\nIntegration policy: main-direct\n");
    fs.writeFileSync(path.join(repo, CAPABILITIES_FILE), `{"checkedAt": "old"}\n`);
    fs.writeFileSync(path.join(repo, PROBE_SCRIPT), "");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    git(repo, "push", "-q", "origin", "main");
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("commits and pushes exactly the table; a dirty checkout is skipped and left as it was", async () => {
    const repo = path.join(dir, "repo");
    const r = createBookRefresh({
      db,
      repos: () => [{ name: "repo", path: repo, hasEpicSpine: true }],
      book: { rebuild: async () => assembleBook([], new Date()) },
      invalidate: () => undefined,
      probe: async (d) => fs.writeFileSync(path.join(d, CAPABILITIES_FILE), `{"checkedAt": "new"}\n`),
      writer: createSpineWriter(),
      log: () => undefined,
    });
    const run = await r.run();
    expect(run.repos[0].probe?.status).toBe("written");
    expect(git(path.join(dir, "origin.git"), "log", "-1", "--format=%s", "main")).toBe("daily capability probe (console)");
    expect(git(path.join(dir, "origin.git"), "show", `main:${CAPABILITIES_FILE}`)).toBe(`{"checkedAt": "new"}`);

    fs.writeFileSync(path.join(repo, "stray.txt"), "someone's work\n");
    const run2 = await r.run();
    expect(run2.repos[0].probe).toMatchObject({ status: "skipped" });
    expect(run2.repos[0].probe?.reason).toMatch(/uncommitted changes/);
    expect(fs.readFileSync(path.join(repo, "stray.txt"), "utf8")).toBe("someone's work\n");
  });
});

describe("E947-S3 API", () => {
  let root: string;
  let db: DB | undefined;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e47s3a-"));
    fs.mkdirSync(path.join(root, "home_repo/.git"), { recursive: true });
    fs.mkdirSync(path.join(root, "home_repo/docs/spines"), { recursive: true });
    for (const n of spines.nodes) fs.writeFileSync(path.join(root, "home_repo", n.path), `# ${n.title}\n\n## Current State\n\nStatus: ${n.status}\n`);
    resetRepoScans(0);
  });
  afterEach(() => {
    resetRepoScans();
    db?.close();
    db = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("a book never refreshed is stale and listed on /book; after a refresh it shows today's date and leaves the list", async () => {
    db = openDb(path.join(root, "c.db"));
    const read: ReadConfig = { reposRoot: root, seatsFile: path.join(root, "seats.json"), listThreads: async () => [], spines: async () => spines };
    const now = Date.now();
    const a = createApp(db, {
      read,
      browser: { browserUrl: "http://127.0.0.1:9" },
      book: { git: async () => "" },
      bookRefresh: { pull: async () => ({ ok: true }), probe: async () => undefined, now: () => now },
    });
    const m = createStore(db).createMilestone({ title: "home_repo", repo: "Acme/home_repo", path: ROOT, owner: "", paused: false });

    const before = (await (await a.request(`/api/book/${m.id}`)).json()) as { book: MilestoneBook };
    expect(before.book.updated).toMatchObject({ at: null, refreshedAt: null, stale: true });
    const list = (await (await a.request("/api/book")).json()) as { book: { builtAt: string }; staleBooks: { milestoneId: string }[]; refreshedAt: string | null; dailyRefreshAt: string | null };
    expect(list.staleBooks.map((s) => s.milestoneId)).toEqual([m.id]);
    expect(list.dailyRefreshAt).toBeNull();
    expect(list.refreshedAt).toBe(list.book.builtAt); // rework: the last rebuild counts as refreshed

    expect((await a.request("/api/book-refresh")).status).toBe(200);
    const post = await a.request("/api/book-refresh", { method: "POST" });
    expect(post.status).toBe(202);
    let st: { running: boolean; due: boolean; lastOkAt: string | null; runs: { ok: boolean }[] } | undefined;
    for (let i = 0; i < 50; i++) {
      st = (await (await a.request("/api/book-refresh")).json()) as typeof st;
      if (!st!.running && st!.runs.length) break;
      await new Promise((res) => setTimeout(res, 20));
    }
    expect(st).toMatchObject({ running: false, due: false, lastOkAt: new Date(now).toISOString(), runs: [{ ok: true }] });

    const after = (await (await a.request(`/api/book/home_repo`)).json()) as { book: MilestoneBook };
    expect(after.book.updated).toMatchObject({ at: new Date(now).toISOString(), refreshedAt: new Date(now).toISOString(), stale: false });
    expect(((await (await a.request("/api/book")).json()) as { staleBooks: unknown[] }).staleBooks).toEqual([]);
  });
});
