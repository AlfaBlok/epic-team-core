import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepoPuller, gitRunner } from "../src/cycle/repoPull.js";
import { hostGit, prepareCheckout, preWakeLine } from "../src/cycle/preWake.js";
import { CONSOLE_COMMIT_TRAILER, recoverPull } from "../src/cycle/syncRecover.js";
import { CONSOLE_TRAILER } from "../src/inbox/spineWrite.js";
import { mainHost } from "../src/identity.js";
import { createCheckoutSync } from "../src/status/checkoutSync.js";
import { gitOut } from "../src/freshness.js";

/**
 * a console checkout a plain `git pull --ff-only` cannot move follows main again by itself, and never loses
 * what it did not write.
 */

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
const write = (dir: string, f: string, body: string) => fs.writeFileSync(path.join(dir, f), body);
const read = (dir: string, f: string) => fs.readFileSync(path.join(dir, f), "utf8");
let tmp: string;
let origin: string;
let seed: string;
let clone: string;
const env = { ...process.env };

/** origin with one commit, a clone of it, then origin moves on by one commit (README.md line 1 → "A"). */
beforeEach(() => {
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "t";
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "t@t";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e6s135-"));
  origin = path.join(tmp, "origin.git");
  seed = path.join(tmp, "seed");
  clone = path.join(tmp, "clone");
  fs.mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  write(seed, "README.md", "a\nb\nc\nd\ne\n");
  write(seed, "spine.md", "1\n2\n3\n4\n5\n6\n7\n8\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "one");
  git(tmp, "clone", "-q", "--bare", seed, origin);
  git(seed, "remote", "add", "origin", origin);
  git(tmp, "clone", "-q", origin, clone);
  write(seed, "README.md", "A\nb\nc\nd\nE\n");
  git(seed, "commit", "-qam", "two");
  git(seed, "push", "-q", "origin", "main");
});
afterEach(() => {
  process.env = { ...env };
  fs.rmSync(tmp, { recursive: true, force: true });
});

const at = (d: string) => git(d, "rev-parse", "HEAD");
const originMain = () => git(origin, "rev-parse", "main");
const puller = (logs: string[] = []) => createRepoPuller({ git: gitRunner(), log: (m) => logs.push(m), contentionRetryMs: 5 });

describe("the console's checkouts follow main by themselves", () => {
  it("a local commit whose change main already has (not patch-equal) is dropped, the checkout lands on main", async () => {
    write(clone, "README.md", "A\nb\nc\nd\ne\n"); // only line 1: main's commit also changed line 5, so no patch-id match
    git(clone, "commit", "-qam", "duplicate of two");
    const before = git(clone, "rev-list", "--left-right", "--count", "HEAD...origin/main");
    const logs: string[] = [];
    const r = await puller(logs).pull(clone);
    expect(before).not.toBe("0\t0");
    expect(r).toEqual({ ok: true });
    expect(at(clone)).toBe(originMain());
    expect(logs.join("\n")).toMatch(/self-healed .*dropped 1 local commit\(s\) already on origin\/main/);
  });

  it("a console commit main lacks is rebased onto main (kept, ahead by one, behind none)", async () => {
    write(clone, "spine.md", "1\n2\n3\n4\n5\n6\n7\nconsole\n");
    git(clone, "commit", "-qam", `press\n\n${CONSOLE_TRAILER}`);
    const r = await puller().pull(clone);
    expect(r).toEqual({ ok: true });
    expect(git(clone, "rev-list", "--left-right", "--count", "HEAD...origin/main")).toBe("1\t0");
    expect(read(clone, "spine.md")).toMatch(/console/);
    expect(read(clone, "README.md")).toBe("A\nb\nc\nd\nE\n");
    expect(CONSOLE_COMMIT_TRAILER).toBe(CONSOLE_TRAILER);
  });

  it("someone else's unpushed commit is never moved: the pull fails with why, HEAD unchanged", async () => {
    write(clone, "spine.md", "1\n2\n3\n4\n5\n6\n7\nagent\n");
    git(clone, "commit", "-qam", "agent work");
    const head = at(clone);
    const r = await puller().pull(clone);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/self-heal: local commit .* not on origin\/main and not the console's/);
    expect(at(clone)).toBe(head);
  });

  it("an agent's uncommitted edit that merges cleanly is stashed, the pull goes through, the edit is back", async () => {
    write(clone, "spine.md", "1\n2\n3\n4\n5\n6\n7\nwip\n"); // another agent's write in progress
    const r = await puller().pull(clone);
    expect(r).toEqual({ ok: true });
    expect(at(clone)).toBe(originMain());
    expect(read(clone, "spine.md")).toBe("1\n2\n3\n4\n5\n6\n7\nwip\n");
    expect(git(clone, "stash", "list")).toBe("");
  });

  it("an uncommitted edit that clashes with main is kept byte for byte; nothing is stashed or reset", async () => {
    write(clone, "README.md", "mine\nb\nc\nd\ne\n");
    const head = at(clone);
    const r = await puller().pull(clone);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/clash with origin\/main \(kept, nothing reset\); left by: README.md, last written by “one”/);
    expect(read(clone, "README.md")).toBe("mine\nb\nc\nd\ne\n");
    expect(at(clone)).toBe(head);
    expect(git(clone, "stash", "list")).toBe("");
  });

  it("the reason names the script that left the file (its Written-by trailer)", async () => {
    write(seed, "README.md", "A2\nb\nc\nd\nE\n");
    git(seed, "commit", "-qam", "words refresh", "-m", "Written-by: scripts/his_words.py refresh\nRun: t");
    git(seed, "push", "-q", "origin", "main");
    git(clone, "pull", "-q", "--ff-only");
    write(seed, "README.md", "A3\nb\nc\nd\nE\n");
    git(seed, "commit", "-qam", "three");
    git(seed, "push", "-q", "origin", "main");
    write(clone, "README.md", "left\nb\nc\nd\nE\n");
    const r = await puller().pull(clone);
    expect(!r.ok && r.reason).toMatch(/left by: README.md by scripts\/his_words.py refresh/);
  });

  it("an untracked file holding main's exact bytes is cleared; a different one is kept and stops the pull", async () => {
    write(seed, "new.md", "fresh\n");
    git(seed, "add", "new.md");
    git(seed, "commit", "-qm", "three");
    git(seed, "push", "-q", "origin", "main");
    write(clone, "new.md", "other\n");
    expect((await puller().pull(clone)).ok).toBe(false);
    expect(read(clone, "new.md")).toBe("other\n");
    write(clone, "new.md", "fresh\n");
    expect(await puller().pull(clone)).toEqual({ ok: true });
    expect(at(clone)).toBe(originMain());
  });

  it("'Cannot fast-forward to multiple branches' (a racing fetch): fetch + merge by name heals it", async () => {
    const fail = async () => {
      throw new Error("fatal: Cannot fast-forward to multiple branches.");
    };
    const r = await createRepoPuller({ git: fail, recover: gitRunner(), healLock: false, log: () => {}, contentionRetryMs: 5 }).pull(clone);
    expect(r).toEqual({ ok: true });
    expect(at(clone)).toBe(originMain());
  });

  it("a lock held for a moment: the step is tried again after the pause", async () => {
    const real = gitRunner();
    let fetches = 0;
    const r = await recoverPull(
      async (args) => {
        if (args[0] === "fetch" && fetches++ === 0) throw new Error("error: cannot lock ref 'refs/remotes/origin/main'");
        return real(clone, args);
      },
      { retryMs: 5 },
    );
    expect(r.ok).toBe(true);
    expect(fetches).toBe(2);
    expect(at(clone)).toBe(originMain());
  });

  it("pre-wake on the main server: a duplicate commit no longer holds the wake's checkout behind", async () => {
    write(clone, "README.md", "A\nb\nc\nd\ne\n");
    git(clone, "commit", "-qam", "duplicate of two");
    const pw = await prepareCheckout(hostGit(), mainHost(), clone, 5);
    expect("error" in pw).toBe(false);
    if ("error" in pw) return;
    expect(pw.pull).toEqual({ ok: true });
    expect(at(clone)).toBe(originMain());
    expect(preWakeLine(mainHost(), pw)).toMatch(/self-healed .*dropped 1 local commit/);
  });

  it("a detached HEAD or a branch with no upstream is left alone, the pull's own reason stands", async () => {
    git(clone, "checkout", "-q", "--detach");
    const r = await recoverPull((args) => gitRunner()(clone, args));
    expect(r).toMatchObject({ ok: false, tried: false });
  });

  it("checkout sync pulls a checkout left behind through the self-heal, at most every 5 min, and clears it", async () => {
    write(clone, "README.md", "A\nb\nc\nd\ne\n");
    git(clone, "commit", "-qam", "duplicate of two");
    git(clone, "fetch", "-q");
    let t = 0;
    let heals = 0;
    const p = puller();
    const sync = createCheckoutSync({ dirs: () => [clone], git: gitOut(), now: () => t, heal: (d) => (heals++, p.pull(d)) });
    expect(await sync.tick()).toEqual([]);
    expect(heals).toBe(1);
    expect(at(clone)).toBe(originMain());
    // behind again, with someone's unpushed work: one try, then not again inside 5 min; the alert path stands
    write(clone, "spine.md", "x\n");
    git(clone, "commit", "-qam", "agent work");
    write(seed, "README.md", "B\n");
    git(seed, "commit", "-qam", "three");
    git(seed, "push", "-q", "origin", "main");
    git(clone, "fetch", "-q");
    t = 60_000;
    expect((await sync.tick())[0]).toMatchObject({ ahead: 1, behind: 1 });
    t = 120_000;
    await sync.tick();
    expect(heals).toBe(1);
    t = 7 * 60_000;
    const v = await sync.tick();
    expect(heals).toBe(2);
    expect(v[0]).toMatchObject({ alert: true });
  });
});
