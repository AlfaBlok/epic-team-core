import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createFreshness, gitOut, narrativeAge, parseVerifiedAt, type GitOut } from "../src/freshness.js";
import type { SpinesRunner } from "../src/adapters/spines.js";

// source freshness: real git repos (bare origin + the console's checkout + an "agent" clone that pushes).
const ROOT = (rows: string, verified = "2026-01-01T00:00Z") => `# EPIC: Fresh root

Spine ID: fresh-root

## Current State

Status: active
Verified at: ${verified}

## Issue Ledger

| Issue | Title | Status |
|---|---|---|
| R-1 | First | active |
${rows}`;
const CHILD = `# EPIC: Child\n\nSpine ID: fresh-child\nParent spine: root.md\n\n## Current State\n\nStatus: active\n\n## Issue Ledger\n\n| Issue | Title | Status |\n|---|---|---|\n| C-1 | Child ticket | active |\n`;

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function repos() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e13s6-"));
  const origin = path.join(tmp, "origin.git");
  const agent = path.join(tmp, "agent");
  const reposRoot = path.join(tmp, "github");
  const checkout = path.join(reposRoot, "fresh");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, agent], { stdio: "ignore" });
  git(agent, "checkout", "-q", "-b", "main");
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(agent, rel)), { recursive: true });
    fs.writeFileSync(path.join(agent, rel), text);
  };
  const push = (msg: string, files: Record<string, string>) => {
    for (const [rel, text] of Object.entries(files)) write(rel, text);
    git(agent, "add", ".");
    git(agent, "commit", "-q", "-m", msg);
    git(agent, "push", "-q", "origin", "main");
    return git(agent, "rev-parse", "HEAD");
  };
  push("init", { "docs/spines/root.md": ROOT("") });
  fs.mkdirSync(reposRoot);
  execFileSync("git", ["clone", "-q", origin, checkout], { stdio: "ignore" });
  cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return { tmp, origin, agent, reposRoot, checkout, push, head: () => git(checkout, "rev-parse", "HEAD") };
}

/** Counting git runner over the real one. */
function countingGit() {
  const real = gitOut();
  const calls: string[][] = [];
  const g: GitOut = (dir, args) => (calls.push(args), real(dir, args));
  return { g, calls, pulls: () => calls.filter((a) => a[0] === "pull").length };
}

function app(r: ReturnType<typeof repos>, over: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e13s6-db-"));
  const db = openDb(path.join(dir, "c.db"));
  const dropped: string[] = [];
  // A spines.py stand-in that always fails (the tree falls back to the doc parse) but records cache drops.
  const spines = Object.assign((async () => Promise.reject(new Error("no spines.py"))) as SpinesRunner, { invalidate: (d: string) => dropped.push(d) });
  const cg = countingGit();
  const a = createApp(db, {
    read: { reposRoot: r.reposRoot, seatsFile: path.join(dir, "seats.json"), listThreads: async () => [], spines },
    browser: { browserUrl: "http://127.0.0.1:9" },
    freshness: { enabled: true, pollMs: 0, git: cg.g, ...over },
  });
  const m = createStore(db).createMilestone({ title: "Fresh", repo: "fresh", path: "docs/spines/root.md", owner: "", paused: false });
  const call = async (method: string, url: string) => {
    const res = await a.request(url, { method });
    return { status: res.status, json: await res.json() };
  };
  cleanups.push(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { call, m, dropped, cg };
}

describe("T13-S6 pull on open", () => {
  it("opening a milestone whose repo was never pulled pulls once; concurrent opens share it; within 60 s no pull", async () => {
    const r = repos();
    const { call, m, cg, dropped } = app(r);
    const sha = r.push("new ticket", { "docs/spines/root.md": ROOT("| R-2 | Second | active |\n") });
    const [a, b, t] = await Promise.all([call("GET", `/api/milestones/${m.id}`), call("GET", `/api/milestones/${m.id}`), call("GET", `/api/milestones/${m.id}/tree`)]);
    expect([a.status, b.status, t.status]).toEqual([200, 200, 200]);
    expect(cg.pulls()).toBe(1);
    expect(r.head()).toBe(sha);
    expect(dropped).toEqual([r.checkout]);
    expect(JSON.stringify(t.json)).toContain("R-2");
    await call("GET", `/api/milestones/${m.id}/tree`);
    await call("GET", `/api/waiting-on-owner?milestoneId=${m.id}`);
    expect(cg.pulls()).toBe(1);
  });

  it("a dirty tree is never forced: the pull fails, the error is reported and the page still serves", async () => {
    const r = repos();
    const { call, m } = app(r);
    r.push("remote edit", { "docs/spines/root.md": ROOT("| R-9 | Remote | active |\n") });
    fs.appendFileSync(path.join(r.checkout, "docs/spines/root.md"), "\nlocal edit\n");
    const before = r.head();
    expect((await call("GET", `/api/milestones/${m.id}`)).status).toBe(200);
    expect(r.head()).toBe(before);
    expect(fs.readFileSync(path.join(r.checkout, "docs/spines/root.md"), "utf8")).toContain("local edit");
    const f = (await call("GET", `/api/milestones/${m.id}/freshness`)).json;
    expect(f.error).toMatch(/local changes/);
    expect(f.behind).toBe(1);
  });

  it("waits at most openWaitMs for a slow pull, then serves", async () => {
    const r = repos();
    const real = gitOut();
    const slow: GitOut = (d, a) => (a[0] === "pull" ? new Promise((res) => setTimeout(res, 400)).then(() => real(d, a)) : real(d, a));
    const { call, m } = app(r, { git: slow, openWaitMs: 50 });
    const t0 = Date.now();
    expect((await call("GET", `/api/milestones/${m.id}`)).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(380);
    expect((await call("GET", `/api/milestones/${m.id}/freshness`)).json.pulling).toBe(true);
    await new Promise((res) => setTimeout(res, 600)); // let the pull land before cleanup
  });
});

describe("T13-S6 ls-remote poll", () => {
  it("remote differs → one pull and a cache drop; equal → no pull; a child spine added remotely shows in the parent's counts", async () => {
    const r = repos();
    const { call, m, cg, dropped } = app(r, { enabled: false });
    const fresh = createFreshness({ git: cg.g, invalidate: (d) => dropped.push(d) });
    const before = (await call("GET", `/api/milestones/${m.id}/tree`)).json;
    await fresh.poll([r.checkout, r.checkout]);
    expect(cg.pulls()).toBe(0);
    r.push("child spine", { "docs/spines/root.md": ROOT("| [CH](child.md) | Child | active |\n"), "docs/spines/child.md": CHILD });
    await fresh.poll([r.checkout]);
    expect(cg.pulls()).toBe(1);
    expect(dropped).toEqual([r.checkout]);
    const after = (await call("GET", `/api/milestones/${m.id}/tree`)).json;
    const total = (t: { counts: Record<string, number> }) => Object.values(t.counts).reduce((a, b) => a + b, 0);
    expect(total(after)).toBeGreaterThan(total(before));
    expect(JSON.stringify(after)).toContain("C-1");
  });

  it("local ahead of origin (unpushed console write) → no pull", async () => {
    const r = repos();
    const cg = countingGit();
    git(r.checkout, "commit", "-q", "--allow-empty", "-m", "local");
    await createFreshness({ git: cg.g }).poll([r.checkout]);
    expect(cg.pulls()).toBe(0);
  });
});

describe("T13-S6 Refresh", () => {
  it("returns pulled, behind and sha; drops the cache; rate-limited to once per 5 s", async () => {
    const r = repos();
    const { call, m, dropped } = app(r, { openMaxAgeMs: 3_600_000 });
    const f0 = (await call("GET", `/api/milestones/${m.id}/freshness`)).json;
    expect(f0.sha).toBe(r.head());
    expect(f0.behind).toBe(0);
    const sha = r.push("more", { "docs/spines/root.md": ROOT("| R-3 | Third | active |\n") });
    const res = await call("POST", `/api/milestones/${m.id}/refresh`);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ pulled: true, behind: 0, sha });
    expect(dropped).toContain(r.checkout);
    const again = await call("POST", `/api/milestones/${m.id}/refresh`);
    expect(again.status).toBe(429);
    expect(again.json.rateLimited).toBe(true);
  });

  it("Team footer: oldest synced time over live repos, no pull", async () => {
    const r = repos();
    const { call, cg } = app(r, { enabled: false });
    const f = (await call("GET", "/api/freshness")).json;
    expect(f.repos).toHaveLength(1);
    expect(f.oldestSyncedAt).toBe(f.repos[0].syncedAt);
    expect(cg.pulls()).toBe(0);
  });
});

describe("T13-S6 narrative age", () => {
  it("parses Verified at (bare date = end of day)", () => {
    expect(parseVerifiedAt("2026-10-24T22:10Z (wake run_x)")).toBe(Date.parse("2026-10-24T22:10:00Z"));
    expect(parseVerifiedAt("2026-10-24")).toBe(Date.parse("2026-10-24T23:59:59Z"));
    expect(parseVerifiedAt("see log")).toBeUndefined();
  });

  it("flags Current State behind a newer child commit", async () => {
    const r = repos();
    r.push("child", { "docs/spines/root.md": ROOT("| [CH](child.md) | Child | active |\n"), "docs/spines/child.md": CHILD });
    const { call, m } = app(r);
    const f = (await call("GET", `/api/milestones/${m.id}/freshness`)).json;
    expect(f.narrative.verifiedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(f.narrative.behindMinutes).toBeGreaterThan(60);
    expect(f.narrative.behindHours).toBeGreaterThan(0);
    expect(await narrativeAge(gitOut(), r.checkout, "2999-01-01", ["docs/spines/child.md"])).not.toHaveProperty("behindHours");
  });
});
