// tests never write or push the real checkout or its origin (a run pushed fixture ask, 674d6aeb).
// This file proves the guard (test/realCheckoutGuard.ts, a setup file for every worker) is on and refuses, and shows
// the pattern a spine-writing test uses: a temp clone of a temp bare origin.
import { execFile, execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSpineWriter } from "../src/inbox/spineWrite.js";
import { REFUSED, gitTarget, refusal } from "./realCheckoutGuard.js";

const guard = (globalThis as any).__e62s9 as { drain(): string[] };
/** The checkout this suite runs from (a real one: worktree or main checkout of the code repo). */
const REAL = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** A temp bare origin with one spine and a temp clone of it: the only kind of repo a test writes. */
function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e62s9-"));
  dirs.push(root);
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const git = (args: string[], cwd = root) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" });
  git(["init", "-q", "--bare", "-b", "main", origin]);
  git(["clone", "-q", origin, work]);
  fs.mkdirSync(path.join(work, "docs", "spines"), { recursive: true });
  fs.writeFileSync(path.join(work, "docs", "spines", "m2.md"), "# M2\n\n## Current State\nWaiting on: none\n");
  git(["add", "-A"], work);
  git(["commit", "-qm", "seed"], work);
  git(["push", "-q", "origin", "HEAD:main"], work);
  return { origin, work, git };
}

describe("E962-S9 real-checkout guard", () => {
  it("is installed in every worker: a commit in the real checkout is refused and fails the test", () => {
    // --dry-run: even with no guard this would write nothing
    const r = spawnSync("git", ["-C", REAL, "commit", "--allow-empty", "--dry-run", "-m", "e62s9 probe"], { encoding: "utf8" });
    expect(r.status).toBe(128);
    expect(r.stderr).toContain(REFUSED);
    expect(guard.drain()).toEqual([`git commit in ${REAL}`]); // drained, so this test passes; any other test fails
  });

  it("refuses fetch and push against the real checkout's origin (async execFile, cwd form)", async () => {
    const err = await new Promise<string>((resolve) =>
      execFile("git", ["push", "--dry-run", "/nonexistent/e62s9", "HEAD"], { cwd: REAL }, (_e, _o, stderr) => resolve(String(stderr))),
    );
    expect(err).toContain(REFUSED);
    expect(refusal(["fetch", "origin", "main"], REAL)).toBe(`git fetch in ${REAL}`);
    expect(refusal(["ls-remote", "origin"], REAL)).toBeDefined();
    expect(guard.drain()).toHaveLength(1);
  });

  it("lets tests read the real checkout and do anything inside the temp dir", () => {
    expect(refusal(["log", "-1", "--format=%h"], REAL)).toBeUndefined();
    expect(refusal(["-C", REAL, "status", "--porcelain"], "/")).toBeUndefined();
    expect(refusal(["branch", "--show-current"], REAL)).toBeUndefined();
    expect(refusal(["branch", "-D", "x"], REAL)).toBeDefined();
    expect(refusal(["config", "--get", "remote.origin.url"], REAL)).toBeUndefined();
    expect(refusal(["config", "user.name", "x"], REAL)).toBeDefined();
    expect(refusal(["commit", "-m", "x"], os.tmpdir())).toBeUndefined();
    expect(gitTarget(["-c", "a=b", "-C", "/x", "-C", "y", "push"], "/")).toMatchObject({ dir: "/x/y", sub: "push" });
  });

  it("rewrites any push to GitHub to a dead path, whatever the repo", () => {
    const { work, git } = tempRepo();
    git(["remote", "add", "gh", "https://github.com/Acme/home_repo.git"], work);
    expect(git(["remote", "get-url", "--push", "gh"], work).trim()).toMatch(/e62s9-push-refused/);
    git(["remote", "set-url", "gh", "git@github.com:Acme/home_repo.git"], work);
    expect(git(["remote", "get-url", "--push", "gh"], work).trim()).toMatch(/e62s9-push-refused/);
  });

  it("the spine writer refuses the real checkout (and the refusal fails the test), writes a temp clone of a temp bare origin", async () => {
    const w = createSpineWriter();
    const edit = { path: "docs/spines/m2-team-console.md", edit: (t: string) => ({ text: t + "\nx\n", msg: "probe", body: "probe" }) };
    const real = await w.edit({ repoDir: REAL, ...edit } as any);
    expect(real).toMatchObject({ status: "skipped" });
    expect(JSON.stringify(real)).toContain("tests write only temp checkouts");
    expect(guard.drain()).toEqual([`spine write to ${REAL}`]);

    const { origin, work, git } = tempRepo();
    const ok = await w.edit({ repoDir: work, path: "docs/spines/m2.md", edit: (t: string) => ({ text: t + "\nprobe\n", msg: "probe", body: "probe" }) } as any);
    expect(ok).toMatchObject({ status: "written" });
    expect(git(["log", "-1", "--format=%s", "main"], origin).trim()).toBe("probe");
  });
});

describe("E962-S9 guard keeps child_process behaviour", () => {
  it("promisify(execFile) still resolves { stdout, stderr } and is guarded", async () => {
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const ok = await run("git", ["--version"]);
    expect(ok.stdout).toMatch(/^git version/);
    await expect(run("git", ["-C", REAL, "fetch", "origin"])).rejects.toMatchObject({ stderr: expect.stringContaining(REFUSED) });
    expect(guard.drain()).toEqual([`git fetch in ${REAL}`]);
  });
});
