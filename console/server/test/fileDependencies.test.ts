import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { depsChanged, noteFile, trackDeps } from "../src/adapters/fileDeps.js";
import { headOf } from "../src/adapters/gitHead.js";
import { lastCommitLookup } from "../src/adapters/outcome.js";
import { spinesPyRunner } from "../src/adapters/spines.js";
import { buildTree } from "../src/adapters/tree.js";
import { createTreeMemo } from "../src/adapters/treeMemo.js";
import { readDoc } from "../src/adapters/doc.js";
import { resetRepoScans } from "../src/adapters/repos.js";
import { openDb, type DB } from "../src/db.js";
import { requestReads } from "../src/inbox/asker.js";
import { scanTree } from "../src/inbox/refs.js";
import { waitingForMilestone } from "../src/inbox/waiting.js";
import { createStore } from "../src/store.js";

/** cold polls stay cheap: trees revalidate by file stamps, per-tree waiting work and hot DB reads are reused. */
const spine = (id: string, rows: string) =>
  `# EPIC: ${id}\n\nSpine ID: ${id}\n\n## Current State\n\nStatus: active\n\n## Issue Ledger\n\n| Issue | Title | Status |\n|---|---|---|\n${rows}`;

let root: string;
let db: DB | undefined;
const write = (rel: string, text: string) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
/** Bump a file's mtime well past the previous one (stamps compare mtime+size). */
const touch = (rel: string, text: string) => {
  write(rel, text);
  const t = new Date(Date.now() + 5_000);
  fs.utimesSync(path.join(root, rel), t, t);
};
const M = { id: "ms_e33", repo: "Acme/fold", path: "docs/spines/root.md", paused: false, title: "Fold" };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e33s3-"));
  write("fold/.git/config", `[remote "origin"]\n\turl = https://github.com/Acme/fold.git\n`);
  write("fold/docs/spines/a.md", spine("A", "| A-1 | One | ready |\n"));
  write("fold/docs/spines/root.md", spine("root", "| [A](a.md) | Epic A | active |\n| R-1 | Row | blocked: waiting on Sam |\n"));
  resetRepoScans(0);
});
afterEach(() => {
  resetRepoScans();
  db?.close();
  db = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("T33-S3 file dependencies", () => {
  it("records what a build read (nested tracking feeds the outer one) and sees edits, creations and deletions", () => {
    const a = path.join(root, "fold/docs/spines/a.md");
    const missing = path.join(root, "fold/docs/spines/new.md");
    const { deps } = trackDeps(() => {
      readDoc(a);
      trackDeps(() => readDoc(missing));
      noteFile(path.join(root, "fold/docs/spines"));
    });
    expect([...deps.keys()].sort()).toEqual([path.join(root, "fold/docs/spines"), a, missing].sort());
    expect(depsChanged(deps)).toBe(false);
    write("fold/docs/spines/new.md", spine("N", ""));
    expect(depsChanged(deps)).toBe(true);
    const again = trackDeps(() => readDoc(a)).deps;
    touch("fold/docs/spines/a.md", spine("A", "| A-1 | One | done |\n"));
    expect(depsChanged(again)).toBe(true);
  });

  it("noteFile outside a tracked build records nothing", () => {
    expect(() => noteFile(path.join(root, "x"))).not.toThrow();
  });
});

describe("T33-S3 tree memo revalidates by file stamps", () => {
  const load = (spines: object) => async () => ({ spines, dir: path.join(root, "fold") });

  it("past the TTL an unchanged tree is served again; an edited spine is rebuilt", async () => {
    let t = 0;
    let builds = 0;
    const spines = {};
    const memo = createTreeMemo<ReturnType<typeof buildTree>, object>(3_000, () => t);
    const make = () => (builds++, buildTree(root, M));
    const first = await memo.get("k", load(spines), make);
    t = 60_000; // a 30 s poll later, twice over
    expect(await memo.get("k", load(spines), make)).toBe(first);
    expect(builds).toBe(1);
    touch("fold/docs/spines/a.md", spine("A", "| A-1 | One | ready |\n| A-2 | Two | ready |\n"));
    t = 61_000; // within the TTL of the last check: not looked at yet
    expect(await memo.get("k", load(spines), make)).toBe(first);
    t = 64_000;
    const after = await memo.get("k", load(spines), make);
    expect(after).not.toBe(first);
    expect(builds).toBe(2);
    expect(JSON.stringify(after)).toContain("A-2");
  });

  it("a new spines.py output object is still a miss, and invalidate still drops the tree at once", async () => {
    let builds = 0;
    const memo = createTreeMemo<ReturnType<typeof buildTree>, object>(3_000, () => 0);
    const make = () => (builds++, buildTree(root, M));
    const s = {};
    await memo.get("k", load(s), make);
    await memo.get("k", load({}), make);
    expect(builds).toBe(2);
    memo.invalidate(path.join(root, "fold"));
    await memo.get("k", load({}), make);
    expect(builds).toBe(3);
  });
});

describe("T33-S3 spines.py output identity", () => {
  it("an unchanged output answers with the same object; a changed one with a new object", async () => {
    const skill = path.join(root, "skill");
    const out = path.join(root, "spines-out.json");
    write("skill/scripts/spines.py", `import sys\nsys.stdout.write(open(${JSON.stringify(out)}).read())\n`);
    fs.writeFileSync(out, JSON.stringify({ root: null, nodes: [], orphans: [] }));
    const run = spinesPyRunner(skill);
    const a = await run(path.join(root, "fold"));
    expect(await run(path.join(root, "fold"))).toBe(a);
    fs.writeFileSync(out, JSON.stringify({ root: "docs/spines/root.md", nodes: [], orphans: [] }));
    const c = await run(path.join(root, "fold"));
    expect(c).not.toBe(a);
    expect(c.root).toBe("docs/spines/root.md");
  });
});

describe("T33-S3 per-tree waiting work", () => {
  it("the same tree object is not rescanned or re-blamed; callers get their own copies; a new owner recomputes", async () => {
    db = openDb(path.join(root, "c.db"));
    const store = createStore(db);
    const m = store.createMilestone({ title: "Fold", repo: "Acme/fold", path: "docs/spines/root.md", owner: "", paused: false });
    const tree = buildTree(root, { ...M, id: m.id });
    let blames = 0;
    const blame = async () => (blames++, ["2026-10-01T00:00:00.000Z"]);
    const d = { store, reposRoot: root, treeFor: async () => tree, blame };
    const one = await waitingForMilestone(d, m);
    expect(one.some((i) => i.source === "heuristic")).toBe(true);
    const calls = blames;
    expect(calls).toBeGreaterThan(0);
    one[0].title = "mutated by a caller";
    const two = await waitingForMilestone(d, m);
    expect(blames).toBe(calls);
    expect(two.map((i) => i.id)).toEqual(one.map((i) => i.id));
    expect(two[0].title).not.toBe("mutated by a caller");
    const p = store.createPersona({ name: "Worker", remit: "", skills: [], model: "x", mayWrite: false });
    store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true });
    const three = await waitingForMilestone(d, m);
    expect(blames).toBeGreaterThan(calls);
    expect(three.find((i) => i.source === "heuristic")?.owner.personaName).toBe("Worker");
    // a rebuilt tree (a spine changed) is new work
    const before = blames;
    await waitingForMilestone({ ...d, treeFor: async () => buildTree(root, { ...M, id: m.id }) }, m);
    expect(blames).toBeGreaterThan(before);
  });

  it("scanTree answers one scan per tree object, as independent copies", () => {
    write("fold/docs/spines/a.md", spine("A", "| A-1 | One, waits on ops/PLAN-10-A7 | ready |\n"));
    const tree = buildTree(root, M);
    const dir = path.join(root, "fold");
    const a = scanTree(tree, dir, "fold");
    expect(a.waits).toHaveLength(1);
    a.waits[0].code = "changed";
    a.rows.clear();
    const b = scanTree(tree, dir, "fold");
    expect(b.waits[0].code).toBe("PLAN-10-A7");
    expect(b.rows.size).toBeGreaterThan(0);
  });
});

describe("T33-S3 HEAD without git", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

  it("reads loose, packed and detached HEADs and a linked worktree's, like git rev-parse", () => {
    const repo = path.join(root, "r");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    expect(headOf(repo)).toBeUndefined(); // no commit yet
    fs.writeFileSync(path.join(repo, "f.md"), "x\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "one");
    expect(headOf(repo)).toBe(git(repo, "rev-parse", "HEAD"));
    git(repo, "pack-refs", "--all");
    expect(headOf(repo)).toBe(git(repo, "rev-parse", "HEAD"));
    const wt = path.join(root, "wt");
    git(repo, "worktree", "add", "-q", "-b", "side", wt);
    fs.writeFileSync(path.join(wt, "g.md"), "y\n");
    git(wt, "add", ".");
    git(wt, "commit", "-qm", "two");
    expect(headOf(wt)).toBe(git(wt, "rev-parse", "HEAD"));
    git(repo, "checkout", "-q", "--detach");
    expect(headOf(repo)).toBe(git(repo, "rev-parse", "HEAD"));
    expect(headOf(path.join(root, "nowhere"))).toBeUndefined();
  });

  it("the last commit on a path is not re-read while HEAD stays, and is re-read once HEAD moves", async () => {
    const repo = path.join(root, "r");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "f.md"), "x\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "one");
    let t = 0;
    let runs = 0;
    const lookup = lastCommitLookup(async () => (runs++, `2026-10-0${runs}T00:00:00Z`), 30_000, () => t);
    expect(await lookup(repo, "f.md")).toBe("2026-10-01T00:00:00Z");
    t = 120_000; // past the TTL, same HEAD
    expect(await lookup(repo, "f.md")).toBe("2026-10-01T00:00:00Z");
    expect(runs).toBe(1);
    fs.writeFileSync(path.join(repo, "f.md"), "y\n");
    git(repo, "commit", "-qam", "two");
    expect(await lookup(repo, "f.md")).toBe("2026-10-02T00:00:00Z");
    // HEAD moves again inside the TTL (a console write just after a read): read again, never the old time
    fs.writeFileSync(path.join(repo, "f.md"), "z\n");
    git(repo, "commit", "-qam", "three");
    expect(await lookup(repo, "f.md")).toBe("2026-10-03T00:00:00Z");
  });
});

describe("T33-S3 hot DB reads", () => {
  it("listRuns / listAssignments / listPersonas answer from memory until any write, own or another connection's", () => {
    const file = path.join(root, "c.db");
    db = openDb(file);
    const store = createStore(db);
    const m = store.createMilestone({ title: "Fold", repo: "Acme/fold", path: "docs/spines/root.md", owner: "", paused: false });
    const p = store.createPersona({ name: "Worker", remit: "", skills: [], model: "x", mayWrite: false });
    const a = store.createAssignment({ milestoneId: m.id, personaId: p.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true });
    store.createRun({ assignmentId: a.id, outcome: "progressed", summary: "one" });
    const first = store.listRuns({ assignmentId: a.id });
    expect(first.map((r) => r.summary)).toEqual(["one"]);
    first[0].summary = "mutated";
    expect(store.listRuns({ assignmentId: a.id })[0].summary).toBe("one"); // fresh objects per call
    store.createRun({ assignmentId: a.id, outcome: "progressed", summary: "two", startedAt: "2099-01-01T00:00:00.000Z" });
    expect(store.listRuns({ assignmentId: a.id }).map((r) => r.summary)).toEqual(["two", "one"]);
    expect(store.listRuns({ milestoneId: m.id, limit: 1 }).map((r) => r.summary)).toEqual(["two"]);
    // another connection commits: seen on the next read
    const other = openDb(file);
    try {
      other.prepare("UPDATE personas SET name = 'Renamed' WHERE id = ?").run(p.id);
      other.prepare("UPDATE assignments SET enabled = 0 WHERE id = ?").run(a.id);
    } finally {
      other.close();
    }
    expect(store.listPersonas().find((x) => x.id === p.id)?.name).toBe("Renamed");
    expect(store.listAssignments({ milestoneId: m.id })[0].enabled).toBe(false);
  });

  it("requestReads answers a repeated read once per request", () => {
    db = openDb(path.join(root, "c.db"));
    const store = createStore(db);
    const r2 = requestReads(store);
    expect(r2.listRuns({ assignmentId: "x" })).toBe(r2.listRuns({ assignmentId: "x" }));
    expect(r2.listRuns({ assignmentId: "x" })).not.toBe(r2.listRuns({ assignmentId: "y" }));
  });
});
