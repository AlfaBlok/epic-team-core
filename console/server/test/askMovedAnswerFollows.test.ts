// An answer follows its ask code when the ask line moved to another spine of the repo after the inbox read it
// (an owner's yes once looked in the epic the line had left, and sat queued).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSpineWriter, type AnswerTarget } from "../src/inbox/spineWrite.js";

const ASK = "- [ask E909-A17: approve @Sam since 2026-11-22 row T9] Resize the box to the next size? — recommend: yes";
const spine = (title: string, waiting: string[]) => `# ${title}

Integration policy: main-direct

## Current State

Status: active
Waiting on: ${waiting.length ? "E909-A17" : "none"}

## Waiting on

${waiting.join("\n")}

## Issue Ledger

| Issue | Title | Needs | Status |
|---|---|---|---|
| T9 | Resize the box | Sam | blocked |
`;

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
let tmp: string;
let origin: string;
let repo: string;
const put = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), "utf8");
/** another agent moves the ask line from one spine to another and pushes (after the inbox read it). */
const move = (from: string, to: string) => {
  const other = path.join(tmp, `mover${Math.random().toString(36).slice(2)}`);
  git(tmp, "clone", "-q", origin, other);
  put(other, from, spine("EPIC-906", []));
  put(other, to, spine("M6", [ASK]));
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", "move E909-A17");
  git(other, "push", "-q", "origin", "main");
};
const T = (over: Partial<AnswerTarget> = {}): AnswerTarget => ({
  id: "repo:E909-A17",
  source: "ask",
  question: "Resize the box to the next size?",
  row: "T9",
  code: "E909-A17",
  line: 10,
  path: "docs/spines/epic-106.md",
  ...over,
});
const writer = createSpineWriter();
const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };

beforeEach(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-askmoved-"));
  origin = path.join(tmp, "origin.git");
  git(tmp, "init", "-q", "--bare", "-b", "main", origin);
  const seed = path.join(tmp, "seed");
  git(tmp, "clone", "-q", origin, seed);
  git(seed, "checkout", "-q", "-b", "main");
  put(seed, "docs/spines/epic-106.md", spine("EPIC-906", [ASK]));
  put(seed, "docs/spines/m6.md", spine("M6", []));
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", "origin", "main");
  repo = path.join(tmp, "console");
  git(tmp, "clone", "-q", origin, repo);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_SYSTEM", saved.s]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("an answer follows its ask code to the spine the line moved to", () => {
  it("move the ask, then answer it: written in the new spine, never queued", async () => {
    move("docs/spines/epic-106.md", "docs/spines/m6.md");
    const w = await writer.answer({ repoDir: repo, target: T(), answer: "APPROVED", label: "jr_t", date: "2026-11-23" });
    expect(w).toMatchObject({ status: "written", path: "docs/spines/m6.md", movedFrom: "docs/spines/epic-106.md" });
    expect(w.sha).toBeTruthy();
    expect(read("docs/spines/m6.md")).toContain("- [answered E909-A17 2026-11-23 @Sam] Resize the box to the next size?");
    expect(read("docs/spines/m6.md")).toContain("— answer: APPROVED");
    expect(read("docs/spines/m6.md")).not.toMatch(/^Waiting on: E909-A17/m);
    expect(read("docs/spines/epic-106.md")).not.toContain("E909-A17");
    // it is on origin, not only in the console's checkout
    expect(git(origin, "show", "main:docs/spines/m6.md")).toContain("[answered E909-A17");
  });

  it("an ask moved and already answered there is found answered, not refused", async () => {
    move("docs/spines/epic-106.md", "docs/spines/m6.md");
    await writer.answer({ repoDir: repo, target: T(), answer: "APPROVED", label: "jr_t", date: "2026-11-23" });
    const again = await writer.answer({ repoDir: repo, target: T(), answer: "APPROVED", label: "jr_t", date: "2026-11-23" });
    expect(again).toMatchObject({ status: "written", path: "docs/spines/m6.md" });
  });

  it("the line still where the inbox read it: written there, nothing moved", async () => {
    const w = await writer.answer({ repoDir: repo, target: T(), answer: "APPROVED", label: "jr_t", date: "2026-11-23" });
    expect(w).toMatchObject({ status: "written", path: "docs/spines/epic-106.md" });
    expect(w.movedFrom).toBeUndefined();
  });

  it("the code in no spine of the repo: skipped with a reason that says so, the answer kept by the caller", async () => {
    const other = path.join(tmp, "gone");
    git(tmp, "clone", "-q", origin, other);
    put(other, "docs/spines/epic-106.md", spine("EPIC-906", []));
    git(other, "commit", "-q", "-am", "drop the ask");
    git(other, "push", "-q", "origin", "main");
    const w = await writer.answer({ repoDir: repo, target: T(), answer: "APPROVED", label: "jr_t", date: "2026-11-23" });
    expect(w.status).toBe("skipped");
    expect(w.reason).toMatch(/E909-A17 is in no spine of this repo now .*your answer is kept/);
  });

  it("the spine file itself gone (renamed): the answer follows the code into the new file", async () => {
    const other = path.join(tmp, "rename");
    git(tmp, "clone", "-q", origin, other);
    git(other, "rm", "-q", "docs/spines/epic-106.md");
    put(other, "docs/spines/m6.md", spine("M6", [ASK]));
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "fold epic-106 into m6");
    git(other, "push", "-q", "origin", "main");
    const w = await writer.answer({ repoDir: repo, target: T(), answer: "APPROVED", label: "jr_t", date: "2026-11-23" });
    expect(w).toMatchObject({ status: "written", path: "docs/spines/m6.md", movedFrom: "docs/spines/epic-106.md" });
  });
});
