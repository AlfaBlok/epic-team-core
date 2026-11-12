import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cachedRunner, checkoutVersion, type SpinesJson } from "../src/adapters/spines.js";
import { createFreshness, type GitOut } from "../src/freshness.js";
import { FRESHNESS_OPEN_MAX_AGE_MS, FRESHNESS_POLL_MS } from "../src/routes/freshness.js";

/**
 * the console re-ran `spines.py --json` for every read repo each 60 s TTL and polled
 * every repo's remote every 20 s (0.6-0.7 core of the main server's 1.5-core agent slice). Now a stale cache hit scans again only
 * when the checkout moved (or after 30 min), and a repo is polled at most every 5 min.
 */

let tmp: string;
beforeEach(() => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e6s58-"))));
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
const out = (paths: string[]): SpinesJson => ({
  root: paths[0] ?? null,
  nodes: paths.map((p, i) => ({ id: `E${i}`, path: p, title: p, parent: i ? paths[0] : null, status: "active", rollup_status: "active", dod: [], children: [] })),
  orphans: [],
  mismatches: [],
});

function repo() {
  const dir = path.join(tmp, "r");
  fs.mkdirSync(path.join(dir, "docs", "spines"), { recursive: true });
  git(tmp, "init", "-q", "-b", "main", dir);
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "docs", "spines", "root.md"), "# root\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "one");
  return dir;
}

describe("T6-S58 checkoutVersion", () => {
  it("moves on a commit, an edit of a listed spine, a new file in its folder; not on time alone", () => {
    const dir = repo();
    const last = out(["docs/spines/root.md"]);
    const v1 = checkoutVersion(dir, last);
    expect(v1).toBeDefined();
    expect(checkoutVersion(dir, last)).toBe(v1);
    // an uncommitted edit of the listed spine
    fs.writeFileSync(path.join(dir, "docs", "spines", "root.md"), "# root\n\nedited\n");
    const v2 = checkoutVersion(dir, last);
    expect(v2).not.toBe(v1);
    // a new spine next to it (folder mtime)
    const t = new Date(Date.now() + 5_000);
    fs.writeFileSync(path.join(dir, "docs", "spines", "child.md"), "# child\n");
    fs.utimesSync(path.join(dir, "docs", "spines"), t, t);
    const v3 = checkoutVersion(dir, last);
    expect(v3).not.toBe(v2);
    // a commit (HEAD + index)
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "two");
    expect(checkoutVersion(dir, last)).not.toBe(v3);
  });

  it("is undefined where HEAD cannot be read from the files (a fixture dir): the cache keeps its old TTL", () => {
    expect(checkoutVersion(path.join(tmp, "nope"))).toBeUndefined();
  });
});

describe("T6-S58 cachedRunner scans again only when the checkout moved", () => {
  const setup = (maxAgeMs = 30 * 60_000) => {
    let t = 0;
    let ver = "a";
    const runs: number[] = [];
    const run = cachedRunner(
      async () => (runs.push(t), out(["docs/spines/root.md"])),
      60_000,
      () => t,
      () => {},
      { version: () => ver, maxAgeMs },
    );
    return { run, runs, tick: (ms: number) => (t += ms), set: (v: string) => (ver = v) };
  };
  const settle = () => new Promise((r) => setTimeout(r, 5));

  it("an unchanged checkout: no scan after the TTL, one after the 30-min backstop", async () => {
    const s = setup();
    await s.run("/r");
    expect(s.runs).toHaveLength(1);
    for (let i = 0; i < 29; i++) {
      s.tick(61_000);
      await s.run("/r");
      await settle();
    }
    expect(s.runs).toHaveLength(1); // 29 TTLs (~29.5 min), nothing moved: no scan
    s.tick(61_000);
    await s.run("/r");
    await settle();
    expect(s.runs).toHaveLength(2); // the backstop
  });

  it("a moved checkout: the next stale read scans once (in the background), then quiet again", async () => {
    const s = setup();
    await s.run("/r");
    s.tick(10_000);
    s.set("b");
    await s.run("/r");
    await settle();
    expect(s.runs).toHaveLength(1); // inside the TTL: answered from the cache
    s.tick(61_000);
    await s.run("/r");
    await settle();
    expect(s.runs).toHaveLength(2);
    s.tick(61_000);
    await s.run("/r");
    await settle();
    expect(s.runs).toHaveLength(2);
  });

  it("invalidate (a pull or a console write) still scans at once", async () => {
    const s = setup();
    await s.run("/r");
    s.run.invalidate("/r");
    await s.run("/r");
    expect(s.runs).toHaveLength(2);
  });

  it("no version (undefined): the old 60 s TTL", async () => {
    let t = 0;
    const runs: number[] = [];
    const run = cachedRunner(async () => (runs.push(t), out([])), 60_000, () => t, () => {}, { version: () => undefined });
    await run("/r");
    t += 61_000;
    await run("/r");
    await settle();
    expect(runs).toHaveLength(2);
  });
});

describe("T6-S58 freshness: each repo polled at most every 5 min", () => {
  it("defaults: ls-remote poll and pull on open every 5 min", () => {
    expect(FRESHNESS_POLL_MS).toBe(5 * 60_000);
    expect(FRESHNESS_OPEN_MAX_AGE_MS).toBe(5 * 60_000);
  });

  it("the poll skips a repo pulled within pollSkipMs and asks again after it", async () => {
    let t = 1_000_000;
    const calls: string[] = [];
    const fake: GitOut = async (_d, a) => {
      calls.push(a[0]);
      if (a[0] === "ls-remote") return "b".repeat(40) + "\trefs/heads/main\n";
      if (a[0] === "rev-parse") return "a".repeat(40) + "\n";
      if (a[0] === "merge-base") throw new Error("not ancestor");
      return "";
    };
    const f = createFreshness({ git: fake, now: () => t, pollSkipMs: 300_000, healLock: false, log: () => {} });
    await f.pullAndDrop("/r");
    calls.length = 0;
    t += 60_000;
    await f.poll(["/r"]);
    expect(calls).not.toContain("ls-remote");
    t += 300_000;
    await f.poll(["/r"]);
    expect(calls).toContain("ls-remote");
  });
});
