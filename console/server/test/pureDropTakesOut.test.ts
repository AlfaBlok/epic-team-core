import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import type { Milestone } from "../src/store.js";
import { dropFromWaitingField, nextAskCode, pastAskLines, raiseAsk, retireAsk } from "../src/inbox/raise.js";
import { createSpineWriter } from "../src/inbox/spineWrite.js";

/**
 * answering an ask takes its code out of Current State's `Waiting on:` in the same spine
 * write, and a code freed by a line leaving the spine (a retired credits notice, an owner's cleanup) is never reused.
 */

const A1 = "- [ask T9-A1: decide @Sam since 2026-10-20 row T4] Ship with one logger or two? — options: one | two — recommend: one";
const SPINE = `# PLAN-9: Inbox spine

Integration policy: main-direct

## Current State

Status: active
Waiting on: Sam: T9-A1

## Waiting on

${A1}

## Issue Ledger

| Issue | Title | Status |
|---|---|---|
| T4 | Pick the logger layout | blocked |
`;
const REL = "docs/spines/root.md";

let tmp: string;
let origin: string;
let repo: string;
let db: DB;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
const onMain = () => git(origin, ["show", `main:${REL}`]);
const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };

beforeEach(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e62s11-"));
  origin = path.join(tmp, "origin.git");
  git(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
  const seed = path.join(tmp, "seed");
  git(tmp, ["clone", "-q", origin, seed]);
  git(seed, ["checkout", "-q", "-b", "main"]);
  fs.mkdirSync(path.join(seed, "docs/spines"), { recursive: true });
  fs.writeFileSync(path.join(seed, REL), SPINE);
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-q", "-m", "seed"]);
  git(seed, ["push", "-q", "origin", "main"]);
  repo = path.join(tmp, "inbox");
  git(tmp, ["clone", "-q", origin, repo]);
  db = openDb(path.join(tmp, "console.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_SYSTEM", saved.s]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const milestone = { id: "ms_x", repo: "inbox", path: REL, title: "Inbox" } as unknown as Milestone;
const deps = () => ({ db, store: { getMilestone: () => milestone }, reposRoot: tmp, writer: createSpineWriter() });

describe("pure", () => {
  it("drop takes out only the item naming the code, and a part left with no ask code goes", () => {
    const f = (v: string) => `# E\n\n## Current State\n\nWaiting on: ${v}\n`;
    const multi = f("Sam: T42-A11 (connect Memo webhooks), T43-A1 (buy socialapp.dev, epicteam.app), T59-A5 (the checklist)");
    expect(dropFromWaitingField(multi, "T43-A1")).toContain("Waiting on: Sam: T42-A11 (connect Memo webhooks), T59-A5 (the checklist)\n");
    expect(dropFromWaitingField(f("Sam: PLAN-29-A1 (create the accounts), snoozed by him until 2026-11-04."), "PLAN-29-A1")).toContain("Waiting on: nobody\n");
    expect(dropFromWaitingField(f("Sam: T9-A1; Ops: T9-A2"), "T9-A2")).toContain("Waiting on: Sam: T9-A1\n");
    // a code that only starts the same (vs) is not touched
    expect(dropFromWaitingField(f("Sam: T9-A12"), "T9-A1")).toContain("Waiting on: Sam: T9-A12\n");
  });
  it("next code counts the codes the file had before (git history), not only the ones in it now", () => {
    expect(nextAskCode(SPINE)).toBe("T9-A2");
    expect(nextAskCode(SPINE, "- [ask T9-A4: decide @Sam since 2026-10-01] Old?\n- [ask X1-A9: decide] other prefix")).toBe("T9-A5");
    expect(nextAskCode("# PLAN-62: The repo\n", "- [answered PLAN-62-A3 2026-10-01 @Sam] q — answer: yes")).toBe("PLAN-62-A4");
  });
});

describe("in a temp repo", () => {
  it("answering an ask flips its line and drops it from Current State's Waiting on in one commit", async () => {
    const head = git(origin, ["rev-parse", "main"]);
    const w = await createSpineWriter().answer({
      repoDir: repo,
      target: { id: "x", source: "ask", question: "Ship with one logger or two?", code: "T9-A1", path: REL, row: "T4" },
      answer: "one",
      label: "T9-A1",
    });
    expect(w.status).toBe("written");
    const text = onMain();
    expect(text).toMatch(/^- \[answered T9-A1 \d{4}-\d{2}-\d{2} @Sam\] Ship with one logger or two\?.*— answer: one$/m);
    expect(text).toContain("Waiting on: nobody\n");
    expect(git(origin, ["rev-list", "--count", `${head}..main`])).toBe("1");
  });

  it("a code freed by a retired line is never reused by a later ask", async () => {
    const m = milestone;
    const first = await raiseAsk(deps(), m, { question: "Credits are out: top up?", askedBy: "the credits gate" });
    expect(first).toMatchObject({ status: "written", code: "T9-A2" });
    expect(onMain()).toContain("Waiting on: Sam: T9-A1; Sam: T9-A2\n");
    const gone = await retireAsk(deps(), m, REL, "T9-A2", "credits are back");
    expect(gone.status).toBe("written");
    expect(onMain()).not.toContain("T9-A2");
    expect(pastAskLines(repo, REL)).toContain("[ask T9-A2:");
    const second = await raiseAsk(deps(), m, { question: "Credits are out again: top up?", askedBy: "the credits gate" });
    expect(second).toMatchObject({ status: "written", code: "T9-A3" });
    expect(onMain()).toContain("Waiting on: Sam: T9-A1; Sam: T9-A3\n");
  });
});

describe("an answer taken back", () => {
  it("puts the code back in a coded Waiting on, and leaves a prose one alone", async () => {
    const { restoreToWaitingField } = await import("../src/inbox/spineWrite.js");
    const f = (v: string) => `# E\n\n## Current State\n\nWaiting on: ${v}\n`;
    expect(restoreToWaitingField(f("nobody"), "T9-A1", "Sam")).toContain("Waiting on: Sam: T9-A1\n");
    expect(restoreToWaitingField(f("Sam: T9-A2"), "T9-A1", "Sam")).toContain("Waiting on: Sam: T9-A2; Sam: T9-A1\n");
    expect(restoreToWaitingField(f("Sam (see Waiting on)"), "T9-A1", "Sam")).toBe(f("Sam (see Waiting on)"));
  });
});
