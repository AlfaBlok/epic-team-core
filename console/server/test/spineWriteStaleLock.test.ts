import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSpineWriter, type EditInput } from "../src/inbox/spineWrite.js";

/**
 * a console restart killed a git in one of the console's write clones and left `.git/index.lock`; every spine write
 * there then failed "fast-forward to origin/main failed" for 36 h (a world's idea cards, two of the owner's presses). The spine writer now clears a lock older than 10 min with no git running in
 * the checkout, logs it, and retries the step once; a young lock still fails the write.
 */

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
let tmp: string;
let origin: string;
let repo: string;
let lock: string;
const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };

/** origin one commit ahead of the console's clone, and a lock of the given age in the clone. */
function setup(lockAgeMin: number) {
  const seed = path.join(tmp, "seed");
  git(tmp, "init", "-q", "--bare", "-b", "main", origin);
  git(tmp, "clone", "-q", origin, seed);
  git(seed, "checkout", "-q", "-b", "main");
  fs.mkdirSync(path.join(seed, "docs/inbox"), { recursive: true });
  fs.writeFileSync(path.join(seed, "docs/spines.md"), "# Spine: x\n\nIntegration policy: main-direct\n");
  fs.writeFileSync(path.join(seed, "docs/inbox/cards.json"), '{"cards":[]}\n');
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "seed");
  git(seed, "push", "-q", "origin", "main");
  git(tmp, "clone", "-q", origin, repo);
  fs.writeFileSync(path.join(seed, "other.txt"), "someone else\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "origin moves on");
  git(seed, "push", "-q", "origin", "main");
  fs.writeFileSync(lock, "");
  const t = (Date.now() - lockAgeMin * 60_000) / 1000;
  fs.utimesSync(lock, t, t);
}

const card = (): EditInput => ({
  repoDir: repo,
  path: "docs/inbox/cards.json",
  label: "team card idea",
  verify: false,
  edit: () => ({ text: '{"cards":[{"id":"tc_1","kind":"idea"}]}\n', msg: "Sam: idea card", body: "test" }),
});

beforeEach(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stale-lock-write-"));
  origin = path.join(tmp, "origin.git");
  repo = path.join(tmp, "clone");
  lock = path.join(repo, ".git", "index.lock");
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_SYSTEM", saved.s]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("spine write clears a stale git lock by itself", () => {
  it("a 36 h old index.lock with no git running is removed, logged, and the card lands on origin", async () => {
    setup(36 * 60);
    const logs: string[] = [];
    const r = await createSpineWriter({ log: (m) => logs.push(m) }).edit(card());
    expect(r.status).toBe("written");
    expect(fs.existsSync(lock)).toBe(false);
    expect(git(origin, "show", "main:docs/inbox/cards.json")).toContain("tc_1");
    expect(git(origin, "show", "main:other.txt")).toBe("someone else");
    expect(logs.join("\n")).toMatch(/removed stale \.git\/index\.lock .*2160 min old, no git running\), retrying the fast-forward once/);
  });

  it("a lock 1 min old is kept: another git may hold it, the write fails as before", async () => {
    setup(1);
    const logs: string[] = [];
    const r = await createSpineWriter({ log: (m) => logs.push(m) }).edit(card());
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/fast-forward to origin\/main failed/);
    expect(fs.existsSync(lock)).toBe(true);
    expect(logs.join("\n")).not.toMatch(/removed stale/);
  });
});
