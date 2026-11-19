import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import type { SpineNode, SpinesJson, SpinesRunner } from "../src/adapters/spines.js";
import { createRefresher, ownerOrder, sameOutput, unreadPath } from "../src/readModel/refresher.js";
import { createBook } from "../src/book/service.js";

/**
 * the console indexer does only the work a commit needs. A wake (last_run_at) no longer rebuilds every view
 * of every world, a commit that touches only paths no view reads rebuilds nothing, a spines.py re-run that says the same
 * rebuilds nothing a second time, and the Epic Book reads only a moved repo's new commits and rebuilds only its part.
 */

let root: string;
const dbs: DB[] = [];
const write = (rel: string, text: string) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const setHead = (sha: string) => write("fold/.git/refs/heads/main", `${sha}\n`);
const SPINE = `# PLAN-7: Fold
Spine ID: PLAN-7

## Current State

Status: active
Waiting on: none

## Issue Ledger

| Issue | Owner | Title | Status |
|---|---|---|---|
| T7-S1 | worker | First row | ready |
`;
const node = (over: Partial<SpineNode> & { path: string; title: string }): SpineNode => ({ id: over.path, parent: null, status: "active", rollup_status: "active", dod: [], children: [], ...over });
const output = (): SpinesJson => ({ root: "docs/spines/root.md", orphans: [], mismatches: [], nodes: [node({ path: "docs/spines/root.md", title: "PLAN-7: Fold" })] });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s166-"));
  write("fold/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/fold.git\n`);
  write("fold/.git/HEAD", "ref: refs/heads/main\n");
  setHead("a".repeat(40));
  write("fold/docs/spines/root.md", SPINE);
});
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function setup(o: { changed?: string[]; spines?: SpinesRunner; now?: () => number } = {}) {
  const db = openDb(path.join(root, "c.db"));
  dbs.push(db);
  const store = createStore(db);
  const m = store.createMilestone({ title: "Fold", repo: "Acme/fold", path: "docs/spines/root.md", owner: "", paused: false });
  const p = store.createPersona({ name: "Worker", remit: "work", skills: [], model: "claude-opus-5-5", mayWrite: true });
  const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true });
  const written: string[] = [];
  let runs = 0;
  const spines: SpinesRunner = o.spines ?? (async () => (runs++, output()));
  const changes = { files: o.changed ?? [], asked: 0 };
  const r = createRefresher({
    db,
    reposRoot: root,
    spines,
    worlds: [""],
    // status views follow runs on their own clock; held still here so only the views a commit or a wake moves count.
    statusEveryMs: 3600_000,
    statusMaxAgeMs: 3600_000,
    changedFiles: () => (changes.asked++, changes.files),
    ...(o.now ? { now: o.now } : {}),
    onWritten: (k) => written.push(k),
  });
  const pass = async () => {
    await r.tick();
    await r.idle();
    await r.tick();
    await r.idle();
  };
  return { db, store, m, a, r, written, pass, changes, runs: () => runs };
}

describe("read model: only the work a commit needs", () => {
  it("a wake (last_run_at moved, same owner) rebuilds no view", async () => {
    const s = setup();
    await s.pass();
    expect(s.written.length).toBeGreaterThan(0);
    s.written.length = 0;
    s.db.prepare("UPDATE assignments SET last_run_at = ? WHERE id = ?").run(new Date().toISOString(), s.a.id);
    await s.pass();
    expect(s.written).toEqual([]);
    s.r.stop();
  });

  it("console writes re-check every view at most every 5 min; one inside the gap is done when it ends", async () => {
    let t = Date.parse("2026-11-19T12:00:00Z");
    const s = setup({ now: () => t });
    await s.pass();
    s.written.length = 0;
    s.r.dirty(); // a run update, a press: the first one re-checks at once
    await s.pass();
    const all = s.written.length;
    expect(all).toBeGreaterThan(0);
    s.written.length = 0;
    t += 30_000;
    s.r.dirty(); // inside the gap: kept, nothing rebuilt yet
    await s.pass();
    expect(s.written).toEqual([]);
    t += 300_000; // the gap ended: the kept write re-checks
    await s.pass();
    expect(s.written.length).toBe(all);
    s.written.length = 0;
    t += 1_000;
    await s.pass(); // nothing due any more
    expect(s.written).toEqual([]);
    s.r.stop();
  });

  it("owner order: a newer run of the one already first changes nothing; another assignment overtaking it does", () => {
    const row = (id: string, at: string | null, enabled = 1) => ({ id, milestone_id: "m", persona_id: `p-${id}`, enabled, last_run_at: at });
    const before = ownerOrder([row("a", "2026-11-19T10:00Z"), row("b", "2026-11-19T09:00Z")]);
    expect(ownerOrder([row("a", "2026-11-19T11:00Z"), row("b", "2026-11-19T09:00Z")])).toEqual(before);
    expect(ownerOrder([row("a", "2026-11-19T10:00Z"), row("b", "2026-11-19T12:00Z")])).not.toEqual(before);
    expect(ownerOrder([row("a", "2026-11-19T10:00Z", 0), row("b", "2026-11-19T09:00Z")])).not.toEqual(before);
  });

  it("a commit touching only unread paths (code, dated logs) rebuilds nothing and runs no spines.py", async () => {
    const s = setup({ changed: ["hosted/console/server/src/app.ts", "docs/outcomes/2026-11-19.jsonl", "docs/voice-notes/x.md"] });
    await s.pass();
    const runs = s.runs();
    s.written.length = 0;
    setHead("b".repeat(40));
    await s.pass();
    expect(s.changes.asked).toBe(1);
    expect(s.written).toEqual([]);
    expect(s.runs()).toBe(runs);
    expect(s.r.skippedCommits()).toBe(1);
    s.r.stop();
  });

  it("a commit touching a card or a spine still rebuilds", async () => {
    const s = setup({ changed: ["hosted/x.ts", "docs/cards/E907-S3.md"] });
    await s.pass();
    s.written.length = 0;
    setHead("c".repeat(40));
    await s.pass();
    expect(s.written.length).toBeGreaterThan(0);
    expect(s.r.skippedCommits()).toBe(0);
    s.r.stop();
  });

  it("git cannot say what changed (a rewritten history): rebuilds as before", async () => {
    const s = setup();
    (s.changes as { files: string[] | undefined }).files = undefined;
    await s.pass();
    s.written.length = 0;
    setHead("d".repeat(40));
    await s.pass();
    expect(s.written.length).toBeGreaterThan(0);
    s.r.stop();
  });

  it("a spines.py re-run that says the same does not rebuild the views a second time; one that differs does", async () => {
    let title = "PLAN-7: Fold";
    let runs = 0;
    // a real run takes seconds: the views are rebuilt from the last output first, then the run lands.
    const spines: SpinesRunner = async () => {
      runs++;
      const out = { ...output(), nodes: [node({ path: "docs/spines/root.md", title })] };
      await new Promise((r) => setTimeout(r, 60));
      return out;
    };
    const s = setup({ changed: ["docs/spines/root.md"], spines });
    await s.pass();
    s.written.length = 0;
    setHead("e".repeat(40));
    await s.pass();
    expect(runs).toBe(2);
    expect(s.written.length).toBeGreaterThan(0);
    expect(new Set(s.written).size).toBe(s.written.length); // each view once: at the commit, not again after the same output
    // a commit whose re-run says something else: its views are written at the commit and again with the new output
    s.written.length = 0;
    title = "PLAN-7: Fold, renamed";
    setHead("f".repeat(40));
    await s.pass();
    expect(runs).toBe(3);
    expect(new Set(s.written).size).toBeLessThan(s.written.length);
    s.r.stop();
  });

  it("unread paths are only code, dated logs, transcripts, proposals and landing pages", () => {
    for (const p of ["hosted/a.ts", "core/x.ts", "browser/y.mjs", "video/z.json", "docs/outcomes/2026-11-19.jsonl", "docs/voice-notes/a.md", "docs/proposals/p.html", "docs/landing/i.html"]) expect(unreadPath(p)).toBe(true);
    for (const p of ["docs/spines/root.md", "docs/cards/E907-S4.md", "docs/outcomes/what-counts.json", "docs/asks/log.jsonl", "docs/status/x.webp", "desk/inbox/n.md", "docs/priorities.json", "docs/pursuits.json", "scripts/pressing.py", "AGENTS.md"]) expect(unreadPath(p)).toBe(false);
  });

  it("sameOutput compares what the outputs say", () => {
    expect(sameOutput(output(), output())).toBe(true);
    expect(sameOutput(output(), { ...output(), orphans: ["x"] as never })).toBe(false);
    expect(sameOutput(undefined, output())).toBe(false);
  });
});

describe("Epic Book: a moved HEAD reads only its new commits and rebuilds only its repo", () => {
  const rec = (sha: string, date: string, subject: string, file: string) => `\x1e${sha}\x1f${date}\x1f${subject}\n\n${file}\n`;
  const OLD = rec("a000001", "2026-11-18T10:00:00Z", "E907-S1: first", "docs/spines/root.md");
  const NEW = rec("a000002", "2026-11-19T10:00:00Z", "E907-S2: second", "docs/spines/root.md");
  const spinesOut = output();
  const repos = [
    { name: "one", path: "/x/one", hasEpicSpine: true },
    { name: "two", path: "/x/two", hasEpicSpine: true },
  ];

  it("reads h1..h2 after an ancestry check, keeps the old commits, rebuilds one repo's part, and makes no new book when nothing moved", async () => {
    const heads: Record<string, string> = { "/x/one": "h1", "/x/two": "t1" };
    const calls: string[][] = [];
    const git = async (dir: string, args: string[]) => {
      calls.push([path.basename(dir), ...args]);
      if (args[0] === "merge-base") return "";
      return args.some((a) => a.includes("..")) ? NEW : OLD;
    };
    const t = Date.parse("2026-11-19T12:00:00Z");
    const b = createBook({ repos: () => repos, spines: async () => spinesOut, git, head: (d) => heads[d], now: () => t, idleMaxAgeMs: 3600_000 });
    const first = await b.rebuild();
    expect(calls.filter((c) => c[1] === "log")).toHaveLength(2);
    expect(b.stats()).toMatchObject({ built: 2, reused: 0, incremental: 0 });

    calls.length = 0;
    heads["/x/one"] = "h2";
    b.invalidate();
    b.tick();
    await new Promise((r) => setTimeout(r, 0));
    await b.get();
    await new Promise((r) => setTimeout(r, 0));
    const after = (await b.get()).book!;
    expect(calls).toEqual([
      ["one", "merge-base", "--is-ancestor", "h1", "h2"],
      ["one", ...calls[1].slice(1, -1), "h1..h2"],
    ]);
    expect(b.stats()).toMatchObject({ built: 3, reused: 1, incremental: 1 });
    expect(after).not.toBe(first);
    expect(after.repos.find((r) => r.name === "two")).toBe(first.repos.find((r) => r.name === "two"));
    const timeline = after.repos.find((r) => r.name === "one")!.epics[0].timeline.map((e) => e.sha);
    expect(timeline).toEqual(["a000002", "a000001"]);

    // invalidated again but nothing moved: the same book, nothing stored or spawned
    calls.length = 0;
    b.invalidate();
    b.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect((await b.get()).book).toBe(after);
    expect(calls).toEqual([]);
  });

  it("a HEAD that is not a descendant (a rewritten history) reads the whole log again", async () => {
    const heads: Record<string, string> = { "/x/one": "h1" };
    const calls: string[][] = [];
    const git = async (dir: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "merge-base") throw new Error("exit 1");
      return OLD;
    };
    const b = createBook({ repos: () => [repos[0]], spines: async () => spinesOut, git, head: (d) => heads[d], now: () => Date.parse("2026-11-19T12:00:00Z") });
    await b.rebuild();
    calls.length = 0;
    heads["/x/one"] = "zz";
    await b.rebuild();
    expect(calls.map((c) => c[0])).toEqual(["merge-base", "log"]);
    expect(calls[1].some((a) => a.includes(".."))).toBe(false);
    expect(b.stats().incremental).toBe(0);
  });
});
