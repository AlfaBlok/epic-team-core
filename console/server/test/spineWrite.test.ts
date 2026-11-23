import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { answeredAsks, answeredSection, buildTree, treeTodoSection } from "../src/adapters/tree.js";
import { actionableCount, parkDecision } from "../src/cycle/park.js";
import { applyAnswer, createSpineWriter, flipAskLine, oneLine, pushPolicy, type AnswerTarget } from "../src/inbox/spineWrite.js";
import { parseAsks } from "../src/inbox/asks.js";
import type { ReadConfig } from "../src/routes/read.js";
import type { T3Client } from "../src/t3/client.js";
import type { Dispatcher } from "../src/t3/dispatcher.js";
// this file checks the text with our own owner's name (src/identity.ts; the suite's owner is neutral, hostedSetup.ts)

const SPINE = `# EPIC-909: Inbox spine

Spine ID: inbox-root
Integration policy: main-direct

## Current State

Status: active
Owner: EPIC-909 delivery manager (thread mcp:0a1b2c3d-1111-2222-3333-444455556666)
Waiting on: Sam (2 asks, see Waiting on)

## Waiting on

- [ask E909-A1: decide @Sam since 2026-10-20 row T4] Ship with one logger or two? — options: one | two — recommend: one — context: notes.md
- [ask: approve @Sam since 2026-10-21 row T5] Deploy T5 in place of the old reader? — recommend: yes — context: notes.md

## Issue Ledger

| Issue | Title | Needs | Status |
|---|---|---|---|
| T4 | Pick the logger layout | Sam | blocked |
| T5 | Deploy the reader | Sam go | blocked |
`;

const NO_SECTION = `# EPIC-910: Free text

Spine ID: other-root

## Current State

Status: blocked
Waiting on: Sam's go on P2

## Issue Ledger

| Issue | Title | Needs | Status |
|---|---|---|---|
| P2 | Ship it | Sam | blocked |
`;

const T = (over: Partial<AnswerTarget> = {}): AnswerTarget => ({
  id: "wj_t",
  source: "ask",
  question: "Ship with one logger or two?",
  row: "T4",
  path: "docs/spines/root.md",
  ...over,
});

let tmp: string;
let origin: string;
let repo: string;
let seq = 0;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
const file = (rel: string, dir = repo) => path.join(dir, rel);
const read = (rel: string, dir = repo) => fs.readFileSync(file(rel, dir), "utf8");
const put = (rel: string, text: string, dir = repo) => {
  fs.mkdirSync(path.dirname(file(rel, dir)), { recursive: true });
  fs.writeFileSync(file(rel, dir), text);
};
const commitAll = (dir: string, msg: string) => {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
};
/** A second clone of origin: "another agent" pushing to main. */
const otherClone = () => {
  const dir = path.join(tmp, `other${++seq}`);
  git(tmp, "clone", "-q", origin, dir);
  return dir;
};
const originHead = () => git(origin, "rev-parse", "main");
const writer = createSpineWriter();
const answer = (o: { target?: Partial<AnswerTarget>; text?: string; date?: string } = {}) =>
  writer.answer({ repoDir: repo, target: T(o.target), answer: o.text ?? "one", label: "wj_t", date: o.date ?? "2026-10-22" });

// The writer runs git with this process's env: no global/system config (no identity, signing or hooks of the dev machine).
const savedEnv = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };
beforeEach(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-spinewrite-"));
  origin = path.join(tmp, "origin.git");
  git(tmp, "init", "-q", "--bare", "-b", "main", origin);
  const seed = path.join(tmp, "seed");
  git(tmp, "clone", "-q", origin, seed);
  git(seed, "checkout", "-q", "-b", "main");
  put("docs/spines/root.md", SPINE, seed);
  put("docs/spines/other.md", NO_SECTION, seed);
  put("docs/spines/notes.md", "# notes\n", seed);
  put("src/app.ts", "export {};\n", seed);
  commitAll(seed, "seed");
  git(seed, "push", "-q", "origin", "main");
  repo = path.join(tmp, "inbox");
  git(tmp, "clone", "-q", origin, repo);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", savedEnv.g], ["GIT_CONFIG_SYSTEM", savedEnv.s]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("pure edits", () => {
  it("M2-35c: parseAsks reads the done marker (with or without date and sha); open and plain answered lines have none", () => {
    const md = [
      "## Waiting on",
      "",
      "- [answered E909-A1 2026-10-22 @Sam · done 2026-10-23 abc1234] Q1? — answer: a",
      "- [answered E909-A2 2026-10-22 @Sam · done 2026-10-23] Q2? — answer: b",
      "- [answered 2026-10-22 @Sam · done] Q3? — answer: c",
      "- [answered E909-A4 2026-10-22 @Sam] Q4? — answer: d",
      "- [ask E909-A5: decide @Sam since 2026-10-22 row T1] Q5? — options: a | b",
    ].join("\n");
    const a = parseAsks(md);
    expect(a.map((x) => [x.code, x.state, x.doneAt, x.doneSha])).toEqual([
      ["E909-A1", "answered", "2026-10-23", "abc1234"],
      ["E909-A2", "answered", "2026-10-23", undefined],
      [null, "answered", "", undefined],
      ["E909-A4", "answered", undefined, undefined],
      ["E909-A5", "open", undefined, undefined],
    ]);
    expect(a[0].who).toBe("Sam");
  });

  it("flips v1 and v2 ask tags (code kept), appends the answer, never splits the parser's fields", () => {
    expect(flipAskLine("- [ask: decide @Sam since 2026-10-20 row T4] Q? — options: a | b — context: x.md", "a", "2026-10-22")).toBe(
      "- [answered 2026-10-22 @Sam] Q? — options: a | b — context: x.md — answer: a",
    );
    expect(flipAskLine("* [ask E909-A1: do @Sam since 2026-10-20] Patch it — steps: runbook.md\r", "done", "2026-10-22")).toBe(
      "* [answered E909-A1 2026-10-22 @Sam] Patch it — steps: runbook.md — answer: done\r",
    );
    expect(flipAskLine("- [answered 2026-10-22 @Sam] Q? — answer: a", "b", "2026-10-22")).toBeUndefined();
    expect(oneLine("APPROVED — after 18:00\nand then -- more")).toBe("APPROVED - after 18:00 and then - more");
  });

  it("appends under an existing ## Waiting on, or creates the section right after Current State", () => {
    const e = applyAnswer(SPINE, T({ source: "heuristic", question: "Go on P9?" }), "yes", "2026-10-22");
    expect(e.how).toBe("append");
    if (e.how !== "append") return;
    const lines = e.text.split("\n");
    expect(lines[e.line]).toBe("- [answered 2026-10-22 @Sam] Go on P9? — answer: yes");
    expect(lines[e.line - 1]).toMatch(/^- \[ask: approve/);
    expect(lines[e.line + 1]).toBe("");
    expect(lines[e.line + 2]).toBe("## Issue Ledger");

    const n = applyAnswer(NO_SECTION, T({ source: "heuristic", question: "Sam's go on P2" }), "APPROVED", "2026-10-22");
    expect(n.how).toBe("append");
    if (n.how !== "append") return;
    expect(n.text).toContain("Waiting on: Sam's go on P2\n\n## Waiting on\n\n- [answered 2026-10-22 @Sam] Sam's go on P2 — answer: APPROVED\n\n## Issue Ledger");
  });

  it("recognises an answered line as done and a vanished ask as missing", () => {
    const flipped = applyAnswer(SPINE, T(), "one", "2026-10-22");
    if (flipped.how !== "flip") throw new Error("expected flip");
    expect(applyAnswer(flipped.text, T(), "two", "2026-10-23").how).toBe("already");
    expect(applyAnswer(SPINE, T({ question: "Something else?" }), "x", "2026-10-22").how).toBe("missing");
    // A non-ask item with an identical answered line is not appended twice.
    const appended = applyAnswer(SPINE, T({ source: "heuristic", question: "Go on P9?" }), "yes", "2026-10-22");
    if (appended.how !== "append") throw new Error("expected append");
    expect(applyAnswer(appended.text, T({ source: "heuristic", question: "Go on P9?" }), "yes", "2026-10-22").how).toBe("already");
  });
});

describe("pushPolicy", () => {
  const pol = (agents: string, spine = SPINE) => {
    put("AGENTS.md", agents);
    put("docs/spines/root.md", spine);
    return pushPolicy(repo, "docs/spines/root.md");
  };
  it("main-direct (declared or by default) allows; pr-approval, PR/CI wording and Deploy gates refuse", () => {
    expect(pol("# x\n")).toEqual({ ok: true });
    expect(pol("Integration policy: main-direct\n")).toEqual({ ok: true });
    expect(pol("Integration policy: main-direct\nDeploy gate: .github/workflows/*, deploy/**\n")).toEqual({ ok: true });
    expect(pol("x\n", SPINE.replace("main-direct", "pr-approval"))).toMatchObject({ ok: false, reason: expect.stringContaining("pr-approval") });
    expect(pol("x\n", SPINE.replace("main-direct", "main-direct (memo: PR/CI for the deploy)"))).toMatchObject({ ok: false, reason: expect.stringContaining("PR or CI") });
    expect(pol("Deploy gate: docs/spines/**\n", SPINE.replace("Integration policy: main-direct\n", ""))).toMatchObject({ ok: false, reason: expect.stringContaining("under the Deploy gate") });
    expect(pol("Deploy gate: the production branch\n", SPINE.replace("Integration policy: main-direct\n", ""))).toMatchObject({ ok: false, reason: expect.stringContaining("not a plain path list") });
    // the memory service: the PR wording is about the Deploy gate, the spine is outside it: allowed; a gated file is not.
    const onGate = "main-direct (repo `AGENTS.md` Deploy gate applies: gated code paths go via a self-merged PR; this spine and other docs push straight to `main`; root spine D34).";
    expect(pol("Deploy gate: apps/**, packages/**\n", SPINE.replace("main-direct", onGate))).toEqual({ ok: true });
    expect(pol("Deploy gate: docs/spines/**\n", SPINE.replace("main-direct", onGate))).toMatchObject({ ok: false, reason: expect.stringContaining("under the Deploy gate") });
    expect(pol("x\n", SPINE.replace("main-direct", onGate))).toMatchObject({ ok: false, reason: expect.stringContaining("PR or CI") });
    // AGENTS.md declares it; the spine does not: AGENTS.md applies.
    expect(pol("Integration policy: pr-approval\n", SPINE.replace("Integration policy: main-direct\n", ""))).toMatchObject({ ok: false });
  });
});

describe("spine writer (real git: bare origin + clone)", () => {
  it("flips the ask line, commits only that file with the answer, pushes to origin main", async () => {
    const before = originHead();
    const r = await answer();
    expect(r).toMatchObject({ status: "written", path: "docs/spines/root.md" });
    expect(r.sha).toMatch(/^[0-9a-f]{7,}$/);
    const want = SPINE.replace(
      "- [ask E909-A1: decide @Sam since 2026-10-20 row T4] Ship with one logger or two? — options: one | two — recommend: one — context: notes.md",
      "- [answered E909-A1 2026-10-22 @Sam] Ship with one logger or two? — options: one | two — recommend: one — context: notes.md — answer: one",
    );
    expect(read("docs/spines/root.md")).toBe(want);
    expect(originHead()).not.toBe(before);
    expect(originHead().startsWith(r.sha!)).toBe(true);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "log", "-1", "--format=%s")).toBe("Answer E909-A1: answered (Sam, via console)");
    expect(git(repo, "log", "-1", "--format=%an <%ae>")).toBe("Agent Team Console <console@example.com>"); // no identity configured: the console's
    expect(git(origin, "show", "--stat", "--format=", "main").split("\n").filter(Boolean)).toHaveLength(2); // the file + the summary line
    expect(git(origin, "show", "--name-only", "--format=", "main")).toBe("docs/spines/root.md");
    // The other ask is untouched.
    expect(read("docs/spines/root.md")).toContain("- [ask: approve @Sam since 2026-10-21 row T5]");
  });

  it("approve / deny words: the commit says APPROVED, the note stays on one line", async () => {
    const r = await answer({ target: { question: "Deploy T5 in place of the old reader?", row: "T5" }, text: "APPROVED — after 18:00" });
    expect(r.status).toBe("written");
    expect(read("docs/spines/root.md")).toContain("- [answered 2026-10-22 @Sam] Deploy T5 in place of the old reader? — recommend: yes — context: notes.md — answer: APPROVED - after 18:00");
    expect(git(origin, "log", "-1", "--format=%s", "main")).toMatch(/^Answer wj_t: APPROVED \(Sam, via console\)$/);
  });

  it("a non-ask item gets a new [answered] line under ## Waiting on (section created when absent)", async () => {
    const r = await answer({ target: { source: "heuristic", question: "Sam's go on P2", path: "docs/spines/other.md", row: undefined }, text: "APPROVED" });
    expect(r.status).toBe("written");
    expect(read("docs/spines/other.md")).toContain("## Waiting on\n\n- [answered 2026-10-22 @Sam] Sam's go on P2 — answer: APPROVED\n\n## Issue Ledger");
    expect(git(origin, "show", "--name-only", "--format=", "main")).toBe("docs/spines/other.md");
  });

  it("is idempotent: answering an already [answered] line commits nothing", async () => {
    await answer();
    const head = originHead();
    const again = await answer({ text: "two" });
    expect(again).toMatchObject({ status: "written", reason: "already answered in the spine" });
    expect(again.sha).toBeUndefined();
    expect(originHead()).toBe(head);
    expect(read("docs/spines/root.md")).toContain("answer: one");
    expect(read("docs/spines/root.md")).not.toContain("answer: two");
  });

  it("E963-S11: a tracked edit already on origin (checkout behind) is restored, fast-forwarded, and the answer lands", async () => {
    // the main server 2026-11-03: AGENTS.md held, uncommitted, the very edit origin had made; every answer was skipped as dirty
    const other = otherClone();
    put("src/app.ts", "export const y = 2;\n", other);
    commitAll(other, "upstream edit");
    git(other, "push", "-q", "origin", "main");
    git(repo, "fetch", "-q", "origin");
    put("src/app.ts", "export const y = 2;\n");
    const r = await answer();
    expect(r).toMatchObject({ status: "written" });
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(read("docs/spines/root.md")).toContain("answer: one");
    expect(git(repo, "rev-parse", "HEAD")).toBe(originHead());
  });

  it("E963-S11: a tracked edit that is in neither HEAD nor origin is real work: kept, the write is skipped", async () => {
    put("src/app.ts", "export const mine = 3;\n");
    expect(await answer()).toMatchObject({ status: "skipped", reason: expect.stringContaining("uncommitted changes (M src/app.ts") });
    expect(read("src/app.ts")).toBe("export const mine = 3;\n");
  });

  it("refuses on a dirty tree (tracked change or untracked file) and retries fine once clean", async () => {
    const head = originHead();
    put("src/app.ts", "export const x = 1;\n");
    const r = await answer();
    expect(r).toMatchObject({ status: "skipped", reason: expect.stringContaining("uncommitted changes") });
    expect(read("docs/spines/root.md")).toBe(SPINE);
    expect(originHead()).toBe(head);
    git(repo, "checkout", "--", "src/app.ts");
    put("scratch.txt", "x");
    expect(await answer()).toMatchObject({ status: "skipped", reason: expect.stringContaining("uncommitted changes (?? scratch.txt)") });
    fs.rmSync(file("scratch.txt"));
    const retry = await answer(); // Retry = the same call again
    expect(retry.status).toBe("written");
    expect(originHead()).not.toBe(head);
  });

  it("resyncs a stale index (staged entries, files equal to HEAD) instead of refusing", async () => {
    put("docs/spines/root.md", "# stale\n");
    git(repo, "add", "docs/spines/root.md");
    put("docs/spines/root.md", SPINE); // worktree back to HEAD, index still stale: status shows MM
    const r = await answer();
    expect(r.status).toBe("written");
    expect(read("docs/spines/root.md")).toContain("answer: one");
  });

  it("refuses when the checkout is not on main", async () => {
    git(repo, "checkout", "-q", "-b", "feature");
    expect(await answer()).toMatchObject({ status: "skipped", reason: "the checkout is on feature, not main" });
    expect(read("docs/spines/root.md")).toBe(SPINE);
  });

  it("behind origin: fast-forwards first, then writes; diverged or ahead: refuses", async () => {
    const other = otherClone();
    put("docs/spines/notes.md", "# notes\nmore\n", other);
    commitAll(other, "notes");
    git(other, "push", "-q", "origin", "main");
    const r = await answer();
    expect(r.status).toBe("written");
    expect(read("docs/spines/notes.md")).toBe("# notes\nmore\n"); // fast-forwarded
    expect(git(repo, "rev-parse", "HEAD")).toBe(originHead());

    // Ahead: an unpushed local commit would travel with the push, so refuse.
    put("docs/spines/notes.md", "# notes\nlocal\n");
    commitAll(repo, "local only");
    const head = originHead();
    expect(await answer({ target: { question: "Deploy T5 in place of the old reader?" } })).toMatchObject({ status: "skipped", reason: expect.stringContaining("1 commit(s) ahead of origin/main") });
    expect(originHead()).toBe(head);

    // Diverged: both sides have a new commit.
    put("docs/spines/notes.md", "# notes\nremote\n", other);
    commitAll(other, "remote notes");
    git(other, "pull", "-q", "--rebase", "origin", "main");
    git(other, "push", "-q", "origin", "main");
    expect(await answer({ target: { question: "Deploy T5 in place of the old reader?" } })).toMatchObject({ status: "skipped", reason: expect.stringContaining("diverged") });
  });

  it("refuses under pr-approval, an Integration policy that mentions CI, and a Deploy gate over the spine", async () => {
    const head = originHead();
    const setPolicy = (text: string) => {
      put("docs/spines/root.md", text);
      commitAll(repo, "policy");
      git(repo, "push", "-q", "origin", "main");
    };
    setPolicy(SPINE.replace("main-direct", "pr-approval"));
    expect(await answer()).toMatchObject({ status: "skipped", reason: expect.stringContaining("not main-direct") });
    setPolicy(SPINE.replace("main-direct", "main-direct, but CI gates the deploy"));
    expect(await answer()).toMatchObject({ status: "skipped", reason: expect.stringContaining("PR or CI") });
    setPolicy(SPINE);
    put("AGENTS.md", "Deploy gate: docs/spines/**\n");
    commitAll(repo, "gate");
    git(repo, "push", "-q", "origin", "main");
    expect(await answer()).toMatchObject({ status: "skipped", reason: expect.stringContaining("under the Deploy gate") });
    expect(read("docs/spines/root.md")).toBe(SPINE);
    expect(head).not.toBe(originHead()); // only the policy commits above reached origin, no answer
    expect(git(origin, "log", "--format=%s", "main")).not.toContain("Answer");
  });

  it("refuses when the ask line changed on origin since the item was listed (nothing written)", async () => {
    const other = otherClone();
    put("docs/spines/root.md", SPINE.replace("Ship with one logger or two?", "Ship with one logger, or a second for the archiver?"), other);
    commitAll(other, "reword");
    git(other, "push", "-q", "origin", "main");
    const head = originHead();
    const r = await answer();
    expect(r).toMatchObject({ status: "skipped", reason: expect.stringContaining("not in docs/spines/root.md any more") });
    expect(originHead()).toBe(head);
    expect(read("docs/spines/root.md")).not.toContain("answered");
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("not a git checkout / no origin remote: skipped; unreachable origin: failed and the checkout stays as it was", async () => {
    const plain = path.join(tmp, "plain");
    put("docs/spines/root.md", SPINE, plain);
    expect(await writer.answer({ repoDir: plain, target: T(), answer: "x", label: "x" })).toMatchObject({ status: "skipped", reason: "not a git checkout" });

    git(repo, "remote", "set-url", "origin", path.join(tmp, "gone.git"));
    const r = await answer();
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/git fetch origin main failed/);
    expect(read("docs/spines/root.md")).toBe(SPINE);
    git(repo, "remote", "remove", "origin");
    expect(await answer()).toMatchObject({ status: "skipped", reason: "the checkout has no origin remote to push to" });
  });

  it("a push race (origin moves between fetch and push) is rebased once and pushed", async () => {
    const other = otherClone();
    // The pre-commit hook runs after our fetch: another agent pushes then.
    const hook = path.join(repo, ".git", "hooks", "pre-commit");
    fs.writeFileSync(
      hook,
      `#!/bin/sh\nunset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE\ncd "${other}" && echo raced >> docs/spines/notes.md && git add -A && git commit -q -m raced && git push -q origin main\n`,
      { mode: 0o755 },
    );
    const r = await answer();
    expect(r.status).toBe("written");
    expect(git(origin, "log", "--format=%s", "-3", "main").split("\n")).toEqual(["Answer E909-A1: answered (Sam, via console)", "raced", "seed"]);
    expect(read("docs/spines/notes.md")).toContain("raced");
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("a push race on the same line cannot rebase: failed, checkout restored to origin/main (Retry can run)", async () => {
    const other = otherClone();
    const hook = path.join(repo, ".git", "hooks", "pre-commit");
    fs.writeFileSync(
      hook,
      `#!/bin/sh\nunset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE\ncd "${other}" && sed -i.bak 's/recommend: one/recommend: two/' docs/spines/root.md && rm docs/spines/root.md.bak && git add -A && git commit -q -m clash && git push -q origin main\n`,
      { mode: 0o755 },
    );
    const r = await answer();
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/rebase onto origin\/main failed/);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "rev-parse", "HEAD")).toBe(originHead());
    fs.rmSync(hook);
    const retry = await answer(); // the ask now reads `recommend: two`; the line still matches by question
    expect(retry.status).toBe("written");
    expect(read("docs/spines/root.md")).toContain("recommend: two — context: notes.md — answer: one");
  });

  it("serialises writes per repo: two concurrent answers both land, as two commits", async () => {
    const [a, b] = await Promise.all([
      answer(),
      answer({ target: { question: "Deploy T5 in place of the old reader?", row: "T5" }, text: "APPROVED" }),
    ]);
    expect([a.status, b.status]).toEqual(["written", "written"]);
    const text = read("docs/spines/root.md");
    expect(text).toContain("[answered E909-A1 2026-10-22 @Sam]");
    expect(text).toContain("[answered 2026-10-22 @Sam] Deploy T5");
    expect(git(origin, "log", "--format=%s", "main").split("\n").filter((s) => s.startsWith("Answer"))).toHaveLength(2);
  });
});

// ---------- API, card state and wake prompt ----------

class FakeT3 {
  calls: { op: string; args: any }[] = [];
  async listProjects() {
    return [];
  }
  async listScheduledTasks() {
    return [];
  }
  async updateScheduledTask() {}
  async deleteScheduledTask() {}
  async runScheduledTaskNow() {}
  async launchThread(input: any) {
    this.calls.push({ op: "launchThread", args: input });
    return { threadId: "thread_1" };
  }
  async sendToThread(threadId: string, message: string) {
    this.calls.push({ op: "sendToThread", args: { threadId, message } });
  }
  async readThreadStatus() {
    return { status: "idle", raw: {} };
  }
}

describe("API: answer lands in the spine, state read from the spine, wake lists it", () => {
  let db: DB;
  let t3: FakeT3;
  const setup = () => {
    db = openDb(path.join(tmp, "console.db"));
    t3 = new FakeT3();
    const read: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] };
    const app = createApp(db, {
      read,
      cycle: { enabled: true, t3: t3 as unknown as T3Client, dispatcher: { pick: async () => ({ seat: "seat1", providerInstanceId: "x" }), done: async () => {} } as unknown as Dispatcher, publicUrl: "http://console.test" },
    });
    const call = async (method: string, url: string, body?: unknown) => {
      const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : undefined, text };
    };
    return { call };
  };
  afterEach(() => db?.close());

  const items = async (call: ReturnType<typeof setup>["call"], mid: string) => (await call("GET", `/api/waiting-on-owner?milestoneId=${mid}`)).json as any[];

  it("respond writes + pushes the line, no owner message; card state: answered, pending work → done once the owner deletes the line", async () => {
    const { call } = setup();
    const m = (await call("POST", "/api/milestones", { title: "Inbox", repo: "Acme/inbox", path: "docs/spines/root.md" })).json;
    const dm = (await call("POST", "/api/personas", { name: "Delivery Manager", remit: "runs it", model: "opus" })).json;
    await call("POST", "/api/assignments", { milestoneId: m.id, personaId: dm.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true });
    const ask = (await items(call, m.id)).find((i) => i.source === "ask" && i.question.startsWith("Ship with"));
    expect(ask).toMatchObject({ state: "open", row: "T4", path: "docs/spines/root.md" });

    const r = await call("POST", `/api/waiting-on-owner/${ask.id}/respond`, { kind: "answer", text: "one", milestoneId: m.id });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ delivery: "sent", spine: { status: "written", path: "docs/spines/root.md" } });
    expect(r.json.spine.sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(t3.calls).toEqual([]); // no write-back message to the owner thread
    expect(git(origin, "show", "main:docs/spines/root.md")).toContain("- [answered E909-A1 ");
    expect(read("docs/spines/root.md")).toContain("— answer: one");

    // State comes from the spine: answered, pending work (with the answer), even while spines.py output would be cached.
    const after = (await items(call, m.id)).find((i) => i.question.startsWith("Ship with"));
    expect(after).toMatchObject({ state: "answered", answer: "one", response: { spine: { status: "written" } } });

    // Answering again is idempotent: no new commit.
    const head = originHead();
    const stale = await call("POST", `/api/waiting-on-owner/${ask.id}/respond`, { kind: "answer", text: "two", milestoneId: m.id }); // old id (double click)
    expect(stale).toMatchObject({ status: 200, json: { id: r.json.id } });
    const answeredId = after.id;
    // E948-S182: a coded ask keeps its card id when its line is answered (one ask, one card, by repo and code)
    expect(answeredId).toBe(ask.id);
    const again = await call("POST", `/api/waiting-on-owner/${answeredId}/respond`, { kind: "answer", text: "two", milestoneId: m.id });
    // the same card id: his stored answer back, written once, nothing new committed
    expect(again).toMatchObject({ status: 200, json: { id: r.json.id, spine: { status: "written" } } });
    expect(originHead()).toBe(head);

    // Wake: the answered line is listed for the owner; the milestone is not parked even though rows read red.
    const a = (await call("GET", "/api/assignments")).json[0];
    const wake = (await call("POST", `/api/assignments/${a.id}/wake?format=json`, {})).json;
    expect(wake.prompt).toContain("## Answered by Sam, act on these:");
    expect(wake.prompt).toMatch(/- docs\/spines\/root\.md:\d+ — Ship with one logger or two\? — answer: one\n/);
    expect(wake.prompt).toContain("instead of deleting it, commit and push");
    // where answered asks are listed, an answer that is itself a question is a research task.
    expect(wake.prompt).toContain("If an answer is itself a question");
    expect(wake.prompt).toContain("research it, write the findings and a recommendation under the ask");
    expect(wake.prompt).toContain("never leave the answer sitting");
    expect(wake.prompt.indexOf("## Answered by Sam")).toBeLessThan(wake.prompt.indexOf("## Epic tree"));

    // The owner acts and deletes the line: the card reads done (from the stored snapshot), then falls out of the list.
    put("docs/spines/root.md", read("docs/spines/root.md").split("\n").filter((l) => !l.startsWith("- [answered")).join("\n"));
    commitAll(repo, "owner cleaned up");
    const done = (await items(call, m.id)).find((i) => i.id === ask.id);
    expect(done).toMatchObject({ state: "done", answer: "one", response: { spine: { status: "written" } } });
    expect((await call("GET", `/api/assignments/${a.id}/cycle`)).status).toBe(200);
    const wake2 = (await call("POST", `/api/assignments/${a.id}/wake?format=json`, {})).json;
    expect(wake2.prompt).not.toContain("Answered by Sam");
  });

  it("E948-S155: an answered ask whose line the team rewords shows once, never its old wording as a second card", async () => {
    const { call } = setup();
    const m = (await call("POST", "/api/milestones", { title: "Inbox", repo: "Acme/inbox", path: "docs/spines/root.md" })).json;
    const ask = (await items(call, m.id)).find((i) => i.source === "ask" && i.question.startsWith("Ship with"));
    const r = await call("POST", `/api/waiting-on-owner/${ask.id}/respond`, { kind: "answer", text: "one", milestoneId: m.id });
    expect(r.json.spine).toMatchObject({ status: "written" });
    // the team rewords the answered line (same code), as E948-A18 was on 20 Nov
    put("docs/spines/root.md", read("docs/spines/root.md").replace("Ship with one logger or two?", "Ship with one logger, or two of them?"));
    commitAll(repo, "reworded");
    const all = (await items(call, m.id)).filter((i) => i.code === "E909-A1");
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ state: "answered", answer: "one", response: { spine: { status: "written" } } });
    expect(all[0].question).toContain("two of them?");
  });

  it("a card still open under another id for an ask he answered reads answered, a press on it returns his answer, and the lookup by its id finds it", async () => {
    // 22 Nov 03:22Z: his Send it on an ask was written, then an open copy of the ask (reworded at 03:19, another id) came
    // back as an urgent card; his press on it saved nothing new, and GET /owner-responses?itemId=<the new id> was empty.
    const { call } = setup();
    const m = (await call("POST", "/api/milestones", { title: "Inbox", repo: "Acme/inbox", path: "docs/spines/root.md" })).json;
    const ask = (await items(call, m.id)).find((i) => i.source === "ask" && i.question.startsWith("Ship with"));
    const r = await call("POST", `/api/waiting-on-owner/${ask.id}/respond`, { kind: "answer", text: "one", milestoneId: m.id });
    expect(r.json.spine).toMatchObject({ status: "written" });
    // the open line as a view older than the answer still has it, reworded (so its id is new), same code
    put("docs/spines/root.md", read("docs/spines/root.md").replace(/^- \[answered E909-A1[^\n]*$/m, "- [ask E909-A1: decide @Sam since 2026-10-20 row T4] Ship with one logger, or two of them? — options: one | two — recommend: one — context: notes.md"));
    commitAll(repo, "stale open copy");
    const all = (await items(call, m.id)).filter((i) => i.code === "E909-A1");
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(ask.id); // E948-S182: the same code is the same card id, reworded or not
    expect(all[0]).toMatchObject({ state: "answered", answer: "one", response: { id: r.json.id } });
    // a press on that card: his stored answer back, marked, and nothing written twice
    const before = read("docs/spines/root.md");
    const again = await call("POST", `/api/waiting-on-owner/${all[0].id}/respond`, { kind: "answer", text: "one", milestoneId: m.id });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ id: r.json.id, alreadyAnswered: true, spine: { status: "written" } });
    expect(read("docs/spines/root.md")).toBe(before);
    // the lookup by the id the card has now finds the same answer
    const found = (await call("GET", `/api/owner-responses?itemId=${all[0].id}`)).json as any[];
    expect(found.map((x) => x.id)).toEqual([r.json.id]);
  });

  it("a refused write keeps the answer, says why, and Retry writes it once the cause is gone", async () => {
    const { call } = setup();
    const m = (await call("POST", "/api/milestones", { title: "Inbox", repo: "Acme/inbox", path: "docs/spines/root.md" })).json;
    const ask = (await items(call, m.id)).find((i) => i.source === "ask" && i.question.startsWith("Ship with"));
    put("src/app.ts", "export const dirty = 1;\n");
    const r = await call("POST", `/api/waiting-on-owner/${ask.id}/respond`, { kind: "answer", text: "one", milestoneId: m.id });
    expect(r.json).toMatchObject({ delivery: "queued", spine: { status: "skipped", reason: expect.stringContaining("uncommitted changes") } });
    expect(read("docs/spines/root.md")).toBe(SPINE);
    const open = (await items(call, m.id)).find((i) => i.id === ask.id);
    expect(open).toMatchObject({ state: "open", response: { id: r.json.id, spine: { status: "skipped" } } });

    git(repo, "checkout", "--", "src/app.ts");
    const retry = await call("POST", `/api/owner-responses/${r.json.id}/deliver`);
    expect(retry.json).toMatchObject({ delivery: "sent", spine: { status: "written" } });
    expect((await items(call, m.id)).find((i) => i.question.startsWith("Ship with"))).toMatchObject({ state: "answered", answer: "one", response: { id: r.json.id } });
    // written now; its wake was skipped (no persona attached), so deliver retries only the wake, never a second write.
    const spineNow = read("docs/spines/root.md");
    const again = await call("POST", `/api/owner-responses/${r.json.id}/deliver`);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ delivery: "sent", spine: { status: "written" }, wake: { notified: "skipped", reason: "no persona attached to wake" } });
    expect(read("docs/spines/root.md")).toBe(spineNow);
  });

  it("M2-35c: a `· done <date> <sha>` marker keeps the answer in the spine, drops it from the wake prompt, card reads done", async () => {
    const { call } = setup();
    const m = (await call("POST", "/api/milestones", { title: "Inbox", repo: "Acme/inbox", path: "docs/spines/root.md" })).json;
    const dm = (await call("POST", "/api/personas", { name: "Delivery Manager", remit: "runs it", model: "opus" })).json;
    const asg = (await call("POST", "/api/assignments", { milestoneId: m.id, personaId: dm.id, cadence: { type: "interval", everyMinutes: 60 }, enabled: true })).json;
    const ask = (await items(call, m.id)).find((i) => i.source === "ask" && i.question.startsWith("Ship with"));
    await call("POST", `/api/waiting-on-owner/${ask.id}/respond`, { kind: "answer", text: "one", milestoneId: m.id });
    expect((await call("POST", `/api/assignments/${asg.id}/wake?format=json`, {})).json.prompt).toContain("## Answered by Sam");

    // The owner acts and appends the marker inside the tag instead of deleting the line. Dated today, since a
    // done card is shown only 3 days (DONE_SHOWN_MS) after its date.
    const today = new Date().toISOString().slice(0, 10);
    put("docs/spines/root.md", read("docs/spines/root.md").replace(/^(- \[answered E909-A1 [^\]]*)\]/m, `$1 · done ${today} abc1234]`));
    commitAll(repo, "owner marks done");
    const card = (await items(call, m.id)).find((i) => i.question.startsWith("Ship with"));
    expect(card).toMatchObject({ state: "done", doneAt: today, answer: "one" });
    expect(((await items(call, m.id)).filter((i) => i.question.startsWith("Ship with")))).toHaveLength(1);
    const wake = (await call("POST", `/api/assignments/${asg.id}/wake?format=json`, {})).json;
    expect(wake.prompt).not.toContain("Answered by Sam");
    expect(read("docs/spines/root.md")).toContain("answer: one"); // the answer stays in the spine
  });

  it("v2 tags (real fixtures): do / approve / decide asks flip with their code kept, duplicate codes resolve by question, Approve works, cards read answered with the code", async () => {
    const { call } = setup();
    const E5 = fs.readFileSync(path.join(__dirname, "fixtures", "E905-v2-ask.md"), "utf8");
    const E4 = fs.readFileSync(path.join(__dirname, "fixtures", "EPIC-904-A1-v2.md"), "utf8");
    put("docs/e5/E5.md", E5);
    put("docs/EPIC-904-A1-v2.md", E4);
    commitAll(repo, "fixtures");
    git(repo, "push", "-q", "origin", "main");
    const m5 = (await call("POST", "/api/milestones", { title: "E5", repo: "Acme/inbox", path: "docs/e5/E5.md" })).json;
    const m4 = (await call("POST", "/api/milestones", { title: "EPIC-904", repo: "Acme/inbox", path: "docs/EPIC-904-A1-v2.md" })).json;
    const open5 = await items(call, m5.id);
    const doAsk = open5.find((i) => i.code === "E905-A3");
    const approveAsk = open5.find((i) => i.code === "E905-A4" && i.ask === "approve");
    expect(doAsk).toMatchObject({ ask: "do", source: "ask", state: "open" });
    expect(approveAsk).toMatchObject({ ask: "approve", question: "Approve the exporter autoDeploy off?" });

    // One-click "done" on a do ask lands as an answered line that keeps the code.
    const r1 = await call("POST", `/api/waiting-on-owner/${doAsk.id}/respond`, { kind: "answer", text: "done", milestoneId: m5.id });
    expect(r1.json).toMatchObject({ delivery: "sent", spine: { status: "written" } });
    expect(git(origin, "log", "-1", "--format=%s", "main")).toBe("Answer E905-A3: answered (Sam, via console)");
    expect(read("docs/e5/E5.md")).toMatch(/^- \[answered E905-A3 \d{4}-\d{2}-\d{2} @Sam\] Patch the archiver for 1 h .* — answer: done$/m);

    // Approve on a v2 approve ask whose code is shared with a decide ask: only the approve line flips.
    const r2 = await call("POST", `/api/waiting-on-owner/${approveAsk.id}/respond`, { kind: "approve", text: "after the deploy", milestoneId: m5.id });
    expect(r2.status).toBe(201);
    expect(r2.json).toMatchObject({ kind: "approve", spine: { status: "written" } });
    const text = read("docs/e5/E5.md");
    expect(text).toMatch(/^- \[answered E905-A4 \d{4}-\d{2}-\d{2} @Sam\] Approve the exporter autoDeploy off\? — recommend: approve — context: notes\.md — answer: APPROVED - after the deploy$/m);
    expect(text).toContain("- [ask E905-A4: decide @Sam since 2026-10-01] Keep raw books forever or 6 months?");
    expect(text).toContain("- [ask: provide @Sam since 2026-10-21] The pg1 read-only password");
    expect(git(origin, "log", "-1", "--format=%s", "main")).toBe("Answer E905-A4: APPROVED (Sam, via console)");

    // State read from the spine: answered, pending work, with the code and the answer.
    const after = await items(call, m5.id);
    expect(after.find((i) => i.code === "E905-A3")).toMatchObject({ state: "answered", answer: "done", response: { id: r1.json.id } });
    expect(after.find((i) => i.question === "Approve the exporter autoDeploy off?")).toMatchObject({ code: "E905-A4", state: "answered", answer: "APPROVED - after the deploy" });
    expect(after.find((i) => i.code === "E905-A4" && i.ask === "decide")).toMatchObject({ state: "open" });

    // The approve ask (code, row 1) flips too.
    const e4 = (await items(call, m4.id)).find((i) => i.code === "EPIC-904-A1");
    expect(e4).toMatchObject({ ask: "approve", row: "1" });
    const r3 = await call("POST", `/api/waiting-on-owner/${e4.id}/respond`, { kind: "approve", text: "", milestoneId: m4.id });
    expect(r3.json).toMatchObject({ spine: { status: "written" } });
    expect(read("docs/EPIC-904-A1-v2.md")).toMatch(/^- \[answered EPIC-904-A1 \d{4}-\d{2}-\d{2} @Sam\] Approve the doctrine page .* — answer: APPROVED$/m);
    expect(t3.calls).toEqual([]);

    // "Ask owner to write asks" is unaffected: it is not an answer and still goes to the owner thread.
    const ask = await call("POST", "/api/waiting-on-owner/request-asks", { milestoneId: m5.id, path: "docs/e5/E5.md" });
    expect([201, 502, 400]).toContain(ask.status);
  });

  it("a heuristic item (free-text Waiting on) gets a new [answered] line under ## Waiting on", async () => {
    const { call } = setup();
    const m = (await call("POST", "/api/milestones", { title: "Other", repo: "Acme/inbox", path: "docs/spines/other.md" })).json;
    const item = (await items(call, m.id)).find((i) => i.source === "heuristic");
    const r = await call("POST", `/api/waiting-on-owner/${item.id}/respond`, { kind: "answer", text: "go", milestoneId: m.id });
    expect(r.json).toMatchObject({ spine: { status: "written" } });
    expect(read("docs/spines/other.md")).toMatch(/## Waiting on\n\n- \[answered \d{4}-\d{2}-\d{2} @Sam\] .* — answer: go\n\n## Issue Ledger/);
  });
});

describe("answered lines in the tree: wake section and park gate", () => {
  const M = { id: "ms_a", repo: "Acme/inbox", path: "docs/spines/root.md", paused: false, title: "Inbox" };
  it("lists every [answered] line (file, line, question, answer), none when there are none; counts as actionable", () => {
    const none = buildTree(tmp, M, undefined);
    expect(answeredAsks(none)).toEqual([]);
    expect(answeredSection(none)).toEqual([]);
    expect(treeTodoSection(none)).not.toContain("Answered by Sam");

    const text = SPINE.replace("- [ask E909-A1: decide @Sam since 2026-10-20 row T4] Ship with one logger or two? — options: one | two — recommend: one — context: notes.md", "- [answered E909-A1 2026-10-22 @Sam] Ship with one logger or two? — answer: one");
    put("docs/spines/root.md", text);
    const t = buildTree(tmp, M, undefined);
    const lineNo = text.split("\n").findIndex((l) => l.startsWith("- [answered")) + 1;
    expect(answeredAsks(t)).toEqual([{ path: "docs/spines/root.md", line: lineNo - 1, question: "Ship with one logger or two?", answer: "one" }]);
    const section = answeredSection(t).join("\n");
    expect(section).toContain("## Answered by Sam, act on these:");
    expect(section).toContain(`- docs/spines/root.md:${lineNo} — Ship with one logger or two? — answer: one`);
    expect(section).toContain("Do the work each answer unblocks within your remit, add the Decisions row, unblock the row, update Current State, then mark the line consumed: append");
    expect(treeTodoSection(t).startsWith("\n## Answered by Sam")).toBe(true);
    // The answered line is work for the owner: it adds one actionable item (rows still read red for the owner).
    put("docs/spines/root.md", text.replace(/- \[answered[^\n]*\n/, ""));
    const clean = buildTree(tmp, M, undefined);
    expect(actionableCount(t) - actionableCount(clean)).toBe(1);
  });

  it("a spines.py tree with every node red/green parks, unless an [answered] line is waiting", () => {
    const base = buildTree(tmp, M, undefined);
    const spines = { ...base, source: "spines" as const, root: { ...base.root, color: "red" as const, children: [], flags: [] } };
    expect(actionableCount(spines)).toBe(0);
    expect(parkDecision(spines)).toMatchObject({ park: true });
    const withAnswer = { ...spines, asks: { "docs/spines/root.md": [{ who: "Sam", ask: "unknown" as const, question: "Q?", options: [], recommend: null, context: null, since: null, row: null, state: "answered" as const, answer: "yes", code: null, steps: null, unblocks: null, effort: null }] } };
    expect(parkDecision(withAnswer)).toMatchObject({ park: false, actionable: 1 });
  });
});

describe("applyAnswer: asks whose question has inline code (M2-32)", () => {
  const Q = "Approve the switch to `m7/xtreme-logger` and the `prices.ref` export?";
  const BT = `# EPIC-902: X

## Waiting on

- [ask EPIC-902-A2: approve @Sam since 2026-10-21 row S8] ${Q} — recommend: yes — context: [S8](../tickets/S8.md)
`;
  const t = (over: Partial<AnswerTarget> = {}) => T({ question: Q, row: "S8", ...over });
  it("flips via the raw question", () => {
    const e = applyAnswer(BT, t(), "APPROVED", "2026-10-22");
    expect(e.how).toBe("flip");
    if (e.how === "flip") expect(e.text).toContain("[answered EPIC-902-A2 2026-10-22 @Sam]");
  });
  it("flips via the code when the question text changed", () => {
    expect(applyAnswer(BT, t({ question: "reworded", code: "EPIC-902-A2" }), "APPROVED", "2026-10-22").how).toBe("flip");
  });
  it("reports already for an answered backticked ask", () => {
    const e = applyAnswer(BT, t(), "APPROVED", "2026-10-22");
    if (e.how !== "flip") throw new Error("no flip");
    expect(applyAnswer(e.text, t(), "no", "2026-10-23").how).toBe("already");
    expect(applyAnswer(e.text, t({ question: "x", code: "EPIC-902-A2" }), "no", "2026-10-23").how).toBe("already");
  });
});
