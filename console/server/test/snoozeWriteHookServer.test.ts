import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createSpineWriter } from "../src/inbox/spineWrite.js";
import { snoozeDate } from "../src/inbox/routes.js";
import type { ReadConfig } from "../src/routes/read.js";

/**
 * a snooze took 16-21 s on production: fetch, the repo's epicspine pre-commit hook (2-6 s of advisory tree
 * scans), push. A snooze now commits with --no-verify, skips a fetch younger than 30 s, and reports its steps in a
 * Server-Timing header. Answers keep the hook.
 */

const ASK = "- [ask T9-A3: decide @Sam since 2026-10-22 row T6] Pick the launch date — context: the shop opens soon — recommend: Monday — unblocks: T6";
const SPINE = `# PLAN-9: Inbox spine

Spine ID: inbox-root
Integration policy: main-direct

## Current State

Status: active
Waiting on: Sam (see Waiting on)

## Waiting on

${ASK}

## Issue Ledger

| Issue | Title | Needs | Status |
|---|---|---|---|
| T6 | Launch | Sam | blocked |
`;

let tmp: string;
let origin: string;
let repo: string;
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
const put = (rel: string, text: string, dir: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const savedEnv = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };
/** A pre-commit hook that refuses every commit (stands in for a slow or failing epicspine hook). */
const refusingHook = () => fs.writeFileSync(path.join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho hook ran >&2\nexit 1\n", { mode: 0o755 });
beforeEach(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s10-"));
  origin = path.join(tmp, "origin.git");
  git(tmp, "init", "-q", "--bare", "-b", "main", origin);
  const seed = path.join(tmp, "seed");
  git(tmp, "clone", "-q", origin, seed);
  git(seed, "checkout", "-q", "-b", "main");
  put("docs/spines/root.md", SPINE, seed);
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "seed");
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

describe("T48-S10 snooze write: no hook, Server-Timing", () => {
  let db: DB;
  afterEach(() => db?.close());
  const setup = () => {
    db = openDb(path.join(tmp, "console.db"));
    const readCfg: ReadConfig = { reposRoot: tmp, seatsFile: path.join(tmp, "seats.json"), listThreads: async () => [] };
    const app = createApp(db, { read: readCfg });
    return async (method: string, url: string, body?: unknown) => {
      const res = await app.request(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : undefined, timing: res.headers.get("Server-Timing") };
    };
  };

  it("snooze and unsnooze commit past a refusing pre-commit hook; the reply names its steps; the body has no timings", async () => {
    refusingHook();
    const call = setup();
    const m = (await call("POST", "/api/milestones", { title: "Inbox", repo: "Acme/inbox", path: "docs/spines/root.md" })).json;
    const ask = ((await call("GET", `/api/waiting-on-owner?milestoneId=${m.id}`)).json as any[]).find((i) => i.code === "T9-A3");
    const r = await call("POST", `/api/waiting-on-owner/${ask.id}/snooze`, { days: 3, milestoneId: m.id });
    expect(r.status).toBe(200);
    expect(r.json.spine.status).toBe("written");
    expect(r.json.spine.ms).toBeUndefined();
    expect(r.timing).toMatch(/guards;dur=\d+, fetch;dur=\d+, commit;dur=\d+, push;dur=\d+, total;dur=\d+/);
    expect(git(origin, "show", "main:docs/spines/root.md")).toContain(`${ASK} — snoozed until: ${snoozeDate(3)}`);
    // Within 30 s of its own push the checkout does not fetch again.
    const u = await call("POST", `/api/waiting-on-owner/${ask.id}/snooze`, { until: null, milestoneId: m.id });
    expect(u.status).toBe(200);
    expect(u.timing).not.toMatch(/fetch;/);
    expect(git(origin, "show", "main:docs/spines/root.md")).toBe(SPINE.trim());
  });
});

describe("T48-S10 writer options", () => {
  const edit = (w = createSpineWriter(), extra: { verify?: boolean; fetchFreshMs?: number } = {}, tag = "x") =>
    w.edit({ repoDir: repo, path: "docs/spines/root.md", label: "T9-A3", ...extra, edit: (t) => ({ text: t.replace(ASK, `${ASK} — ${tag}`), msg: `edit ${tag}`, body: "b" }) });

  it("the hook still runs by default (answers and other edits keep it)", async () => {
    refusingHook();
    const r = await edit();
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/git commit failed: .*hook ran/);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("a skipped fetch that missed another push still lands: the push is rebased once", async () => {
    const w = createSpineWriter();
    expect((await edit(w, { verify: false, fetchFreshMs: 30_000 }, "one")).status).toBe("written");
    // Another agent pushes to a different file in the meantime.
    const other = path.join(tmp, "other");
    git(tmp, "clone", "-q", origin, other);
    put("docs/notes.md", "raced\n", other);
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "raced");
    git(other, "push", "-q", "origin", "main");
    const r = await edit(w, { verify: false, fetchFreshMs: 30_000 }, "two");
    expect(r.status).toBe("written");
    expect(r.ms?.fetch).toBeUndefined();
    expect(r.ms?.rebase).toBeGreaterThanOrEqual(0);
    expect(git(origin, "log", "--format=%s", "-3", "main").split("\n")).toEqual(["edit two", "raced", "edit one"]);
  });
});
