import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepoPuller, gitRunner } from "../src/cycle/repoPull.js";
import { hostGit, prepareCheckout } from "../src/cycle/preWake.js";

/**
 * a pull refused because a local edit "would be overwritten by
 * merge", when that edit already equals the file in HEAD or upstream, restores the file and goes through; real local
 * work is kept and the pull error stands.
 */

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
let tmp: string;
let origin: string;
let clone: string;

/** origin + a clone one commit behind it; the commit it lacks changes AGENTS.md. */
function setup() {
  const seed = path.join(tmp, "seed");
  fs.mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(seed, "AGENTS.md"), "a\nb\n");
  fs.writeFileSync(path.join(seed, "x.txt"), "1\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "one");
  git(tmp, "clone", "-q", "--bare", seed, origin);
  git(tmp, "clone", "-q", origin, clone);
  fs.writeFileSync(path.join(seed, "AGENTS.md"), "a\n");
  git(seed, "commit", "-qam", "two");
  git(seed, "push", "-q", origin, "main");
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e63s11-"));
  origin = path.join(tmp, "origin.git");
  clone = path.join(tmp, "clone");
  setup();
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("T63-S11 pull past local edits that are already upstream", () => {
  it("run-end / freshness pull: the upstream-equal AGENTS.md edit is restored, logged, and the pull goes through", async () => {
    fs.writeFileSync(path.join(clone, "AGENTS.md"), "a\n");
    const logs: string[] = [];
    const r = await createRepoPuller({ git: gitRunner(), log: (m) => logs.push(m), contentionRetryMs: 5 }).pull(clone);
    expect(r).toEqual({ ok: true });
    expect(git(clone, "rev-parse", "HEAD")).toBe(git(origin, "rev-parse", "main"));
    expect(git(clone, "status", "--porcelain")).toBe("");
    expect(logs.join("\n")).toMatch(/restored AGENTS\.md \(local edits already in HEAD or upstream, nothing lost\), retrying the pull/);
  });

  it("an edit that is not upstream is real work: kept byte for byte, the pull still fails", async () => {
    fs.writeFileSync(path.join(clone, "AGENTS.md"), "mine\n");
    fs.writeFileSync(path.join(clone, "x.txt"), "2\n");
    const r = await createRepoPuller({ git: gitRunner(), log: () => {}, contentionRetryMs: 5 }).pull(clone);
    expect(r.ok).toBe(false);
    expect(fs.readFileSync(path.join(clone, "AGENTS.md"), "utf8")).toBe("mine\n");
    expect(fs.readFileSync(path.join(clone, "x.txt"), "utf8")).toBe("2\n");
  });

  it("pre-wake pull heals the same way, so a wake never starts on a stale checkout", async () => {
    fs.writeFileSync(path.join(clone, "AGENTS.md"), "a\n");
    const r = await prepareCheckout(hostGit({}), "main", clone, 5);
    expect(r).toMatchObject({ pull: { ok: true } });
    expect(git(clone, "rev-parse", "HEAD")).toBe(git(origin, "rev-parse", "main"));
  });
});
