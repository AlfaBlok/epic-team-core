import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { groupEdits } from "../src/inbox/groupWrite.js";
import { createCloneWriter } from "../src/inbox/writeClone.js";
import { createSpineWriter, timeWrites, type EditInput } from "../src/inbox/spineWrite.js";
import { mountPresses, PRESS_TEST_SLOTS } from "../src/press/mount.js";
import { createPresses } from "../src/press/presses.js";

/**
 * press writes landing close together share one commit and one push (the hooks once), a write that skipped the
 * fetch never answers from a stale copy, and the owner's presses never wait behind the daily press test's.
 */
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

const spine = (code: string) => `# ${code}: a spine\n\nIntegration policy: main-direct\n\n## Issue Ledger\n\n| Issue | Status |\n|---|---|\n| ${code}-S1 | review |\n| ${code}-S2 | review |\n`;

function world() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e72s12-"));
  cleanup.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const origin = path.join(tmp, "origin.git");
  git(tmp, "init", "-q", "--bare", "-b", "main", origin);
  const seed = path.join(tmp, "seed");
  git(tmp, "clone", "-q", origin, seed);
  fs.mkdirSync(path.join(seed, "docs/spines"), { recursive: true });
  fs.writeFileSync(path.join(seed, "docs/spines/a.md"), spine("PLAN-1"));
  fs.writeFileSync(path.join(seed, "docs/spines/b.md"), spine("PLAN-2"));
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", "origin", "HEAD:main");
  const repo = path.join(tmp, "repo");
  git(tmp, "clone", "-q", origin, repo);
  git(repo, "config", "user.email", "console@test");
  git(repo, "config", "user.name", "console");
  // a pre-commit hook that counts its runs and refuses a staged file holding BAD (a secret scanner's refusal)
  const hooks = path.join(tmp, "hooks");
  fs.mkdirSync(hooks);
  const count = path.join(tmp, "hook-runs");
  fs.writeFileSync(path.join(hooks, "pre-commit"), `#!/bin/sh\necho x >> "${count}"\nif git diff --cached | grep -q BAD; then echo "refused: BAD" >&2; exit 1; fi\nexit 0\n`, { mode: 0o755 });
  git(repo, "config", "core.hooksPath", hooks);
  const runs = () => (fs.existsSync(count) ? fs.readFileSync(count, "utf8").split("\n").filter(Boolean).length : 0);
  const subjects = () => git(origin, "log", "--format=%s", "main").split("\n");
  const onOrigin = (rel: string) => git(origin, "show", `main:${rel}`);
  return { tmp, origin, seed, repo, runs, subjects, onOrigin };
}

const setRow = (row: string, to: string) => (text: string) => {
  const t = text.replace(new RegExp(`^\\| ${row} \\| [^|]+ \\|$`, "m"), `| ${row} | ${to} |`);
  return t === text ? { skip: `${row} is not there` } : { text: t, msg: `Review ${row}: ${to} (Sam, via console)`, body: `Sam set ${row} to ${to}.` };
};
const edit = (repo: string, file: string, row: string, to: string, more: Partial<EditInput> = {}): EditInput => ({
  repoDir: repo,
  path: `docs/spines/${file}`,
  label: row,
  group: true,
  edit: setRow(row, to),
  ...more,
});

describe("T72-S12 presses landing together share one commit", () => {
  it("three press writes in one repo: one commit, one push, the hooks once; each press gets that commit", async () => {
    const w = world();
    // press commits run the hooks only on a secret-shaped line now; "full" keeps them on for this check
    const writer = groupEdits(createSpineWriter({ pressHooks: "full" }));
    const ws = await Promise.all([
      writer.edit(edit(w.repo, "a.md", "PLAN-1-S1", "done (approved)")),
      writer.edit(edit(w.repo, "b.md", "PLAN-2-S1", "active (feedback)")),
      writer.edit(edit(w.repo, "a.md", "PLAN-1-S2", "superseded (denied)")),
    ]);
    expect(ws.map((x) => x.status)).toEqual(["written", "written", "written"]);
    expect(new Set(ws.map((x) => x.sha)).size).toBe(1);
    expect(ws[0].sha).toBeTruthy();
    expect(w.runs()).toBe(1);
    expect(w.subjects()).toHaveLength(2); // seed + one batch
    expect(w.subjects()[0]).toContain("via console");
    expect(git(w.origin, "log", "-1", "--format=%B", "main")).toContain("Review PLAN-2-S1: active (feedback)");
    expect(w.onOrigin("docs/spines/a.md")).toContain("| PLAN-1-S1 | done (approved) |");
    expect(w.onOrigin("docs/spines/a.md")).toContain("| PLAN-1-S2 | superseded (denied) |");
    expect(w.onOrigin("docs/spines/b.md")).toContain("| PLAN-2-S1 | active (feedback) |");
    expect(writer.batches()).toMatchObject({ batches: 1, edits: 3, largest: 3 });
  });

  it("each press's own tally names the batch's steps (lock, fetch, commit, push, write) and the batch size", async () => {
    const w = world();
    const writer = groupEdits(createSpineWriter());
    const [a, b] = await Promise.all([
      timeWrites(() => writer.edit(edit(w.repo, "a.md", "PLAN-1-S1", "done (approved)"))),
      timeWrites(() => writer.edit(edit(w.repo, "b.md", "PLAN-2-S1", "done (approved)"))),
    ]);
    for (const t of [a, b]) {
      expect(Object.keys(t.steps)).toEqual(expect.arrayContaining(["lock", "fetch", "commit", "push", "write", "batch"]));
      expect(t.steps.batch).toBe(2);
    }
  });

  it("a press whose edit is refused is refused alone; the others land", async () => {
    const w = world();
    const writer = groupEdits(createSpineWriter());
    const ws = await Promise.all([writer.edit(edit(w.repo, "a.md", "PLAN-1-S1", "done (approved)")), writer.edit(edit(w.repo, "a.md", "PLAN-9-S9", "done"))]);
    expect(ws[0].status).toBe("written");
    expect(ws[1]).toMatchObject({ status: "skipped", reason: "PLAN-9-S9 is not there" });
    expect(w.onOrigin("docs/spines/a.md")).toContain("| PLAN-1-S1 | done (approved) |");
  });

  it("a hook that refuses the batch's commit: each press is written on its own, so only the bad one fails", async () => {
    const w = world();
    const writer = groupEdits(createSpineWriter({ pressHooks: "full" }));
    const ws = await Promise.all([
      writer.edit(edit(w.repo, "a.md", "PLAN-1-S1", "done (approved)")),
      writer.edit(edit(w.repo, "b.md", "PLAN-2-S1", "BAD words")),
      writer.edit(edit(w.repo, "a.md", "PLAN-1-S2", "active (feedback)")),
    ]);
    expect(ws.map((x) => x.status)).toEqual(["written", "failed", "written"]);
    expect(ws[1].reason).toMatch(/git commit failed/);
    expect(w.onOrigin("docs/spines/a.md")).toContain("| PLAN-1-S1 | done (approved) |");
    expect(w.onOrigin("docs/spines/a.md")).toContain("| PLAN-1-S2 | active (feedback) |");
    expect(w.onOrigin("docs/spines/b.md")).not.toContain("BAD");
    expect(git(w.repo, "status", "--porcelain")).toBe("");
  });

  it("a press while a batch is being written waits and goes in the next batch, not one write each", async () => {
    const w = world();
    const writer = groupEdits(createSpineWriter());
    const first = writer.edit(edit(w.repo, "a.md", "PLAN-1-S1", "done (approved)"));
    await new Promise((r) => setTimeout(r, 200)); // the first batch is being written now
    const later = await Promise.all([writer.edit(edit(w.repo, "a.md", "PLAN-1-S2", "done (approved)")), writer.edit(edit(w.repo, "b.md", "PLAN-2-S2", "done (approved)"))]);
    await first;
    expect(later[0].sha).toBe(later[1].sha);
    expect(w.subjects()).toHaveLength(3); // seed + the first press + one batch of two
    expect(writer.batches()).toMatchObject({ batches: 2, edits: 3, largest: 2 });
  });

  it("a write that skipped the fetch looks again on origin before it answers 'already made' (never a stale copy)", async () => {
    const w = world();
    const writer = groupEdits(createSpineWriter());
    const fresh = { fetchFreshMs: 60_000 };
    expect((await writer.edit(edit(w.repo, "a.md", "PLAN-1-S1", "snoozed", fresh))).status).toBe("written");
    // another writer puts the row back in review on origin; the checkout has not fetched it (it pushed moments ago)
    git(w.seed, "pull", "-q", "origin", "main");
    fs.writeFileSync(path.join(w.seed, "docs/spines/a.md"), fs.readFileSync(path.join(w.seed, "docs/spines/a.md"), "utf8").replace("| PLAN-1-S1 | snoozed |", "| PLAN-1-S1 | review |"));
    git(w.seed, "commit", "-qam", "back in review");
    git(w.seed, "push", "-q", "origin", "HEAD:main");
    const again = await writer.edit(edit(w.repo, "a.md", "PLAN-1-S1", "snoozed", fresh));
    expect(again.status).toBe("written");
    expect(again.sha).toBeTruthy();
    expect(w.subjects().filter((s) => s.includes("PLAN-1-S1: snoozed"))).toHaveLength(2);
  });

  it("through the console's own clone (T72-S1): the clone is readied once, one commit and push, the shared checkout follows", async () => {
    const w = world();
    const clones = createCloneWriter(createSpineWriter(), { root: path.join(w.tmp, "write"), log: () => undefined });
    const writer = groupEdits(clones);
    const ws = await Promise.all([writer.edit(edit(w.repo, "a.md", "PLAN-1-S1", "done (approved)")), writer.edit(edit(w.repo, "b.md", "PLAN-2-S1", "done (approved)"))]);
    expect(ws.map((x) => x.status)).toEqual(["written", "written"]);
    expect(ws[0].sha).toBe(ws[1].sha);
    expect(clones.cloneOf(w.repo)).toBeTruthy();
    expect(w.subjects()).toHaveLength(2);
    expect(git(w.repo, "rev-parse", "--short", "HEAD")).toBe(ws[0].sha);
    expect(fs.readFileSync(path.join(w.repo, "docs/spines/b.md"), "utf8")).toContain("| PLAN-2-S1 | done (approved) |");
    expect(clones.lagging()).toEqual([]);
  });

  it("a press not marked group writes on its own at once, as before", async () => {
    const w = world();
    const writer = groupEdits(createSpineWriter());
    const ws = await Promise.all([writer.edit(edit(w.repo, "a.md", "PLAN-1-S1", "done", { group: false })), writer.edit(edit(w.repo, "b.md", "PLAN-2-S1", "done", { group: false }))]);
    expect(ws[0].sha).not.toBe(ws[1].sha);
    expect(w.runs()).toBe(2);
  });
});

describe("T72-S12 the press worker", () => {
  it("writes presses on different cards at once, and Sam's press never waits behind the daily press test's", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e72s12-db-"));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const db = openDb(path.join(dir, "console.db"));
    cleanup.push(() => db.close());
    const presses = createPresses(db);
    const app = new Hono();
    const api = new Hono();
    const landedAt = new Map<string, number>();
    let atOnce = 0;
    let most = 0;
    const worker = mountPresses(api, { db, presses, fetch: (r) => app.fetch(r), answerFirst: true, authMode: "off", log: () => undefined });
    api.post("/review-items/:id/approve", async (c) => {
      atOnce++;
      most = Math.max(most, atOnce);
      // a TEST press is slow (the daily test's git writes); the owner's is quick
      await new Promise((r) => setTimeout(r, c.req.header("x-console-run") === "press-test" ? 1_500 : 100));
      atOnce--;
      landedAt.set(c.req.param("id"), Date.now());
      return c.json({ item: { id: c.req.param("id"), state: "approved" } });
    });
    app.route("/api", api);
    const press = (id: string, test: boolean) =>
      app.fetch(new Request(`http://console.local/api/review-items/${id}/approve`, { method: "POST", headers: { "content-type": "application/json", ...(test ? { "x-console-run": "press-test" } : {}) }, body: "{}" }));
    const t0 = Date.now();
    for (let i = 1; i <= 6; i++) expect((await press(`rv_test${i}`, true)).status).toBe(202);
    await new Promise((r) => setTimeout(r, 50));
    expect((await press("rv_jordi", false)).status).toBe(202);
    const until = Date.now() + 10_000;
    while (landedAt.size < 7 && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    expect(landedAt.size).toBe(7);
    // the owner's press landed in its own 100 ms, long before the first TEST press (1.5 s) ended
    expect(landedAt.get("rv_jordi")! - t0).toBeLessThan(1_000);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(PRESS_TEST_SLOTS + 1);
    expect(presses.list({ state: "landed" })).toHaveLength(7);
    expect(worker.busy()).toEqual({ inFlight: 0, due: 0 });
  });
});
