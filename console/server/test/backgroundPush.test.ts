import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { gitRunner } from "../src/cycle/repoPull.js";
import { groupEdits } from "../src/inbox/groupWrite.js";
import { createSpineWriter, secretShaped, withPress, type DroppedPush, type EditInput } from "../src/inbox/spineWrite.js";
import { mountPresses } from "../src/press/mount.js";
import { createPresses } from "../src/press/presses.js";
import { withRepoLock } from "../src/repoLock.js";

/**
 * a press is committed in the console's checkout and
 * answered at once, the push follows in the background and is retried; a commit that cannot be rebased puts its presses
 * back in the outbox; press commits skip the hooks unless a line looks like a secret; a stuck git call never holds a
 * checkout's lock for ever; and a Changes wanted whose row moved on still lands his words.
 */
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});
const until = async (ok: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return ok();
};

const spine = (code: string) => `# ${code}: a spine\n\nIntegration policy: main-direct\n\n## Issue Ledger\n\n| Issue | Status |\n|---|---|\n| ${code}-S1 | review |\n| ${code}-S2 | review |\n`;

function world() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s82-"));
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
  const hooks = path.join(tmp, "hooks");
  fs.mkdirSync(hooks);
  const count = path.join(tmp, "hook-runs");
  fs.writeFileSync(path.join(hooks, "pre-commit"), `#!/bin/sh\necho x >> "${count}"\nexit 0\n`, { mode: 0o755 });
  git(repo, "config", "core.hooksPath", hooks);
  const runs = () => (fs.existsSync(count) ? fs.readFileSync(count, "utf8").split("\n").filter(Boolean).length : 0);
  const onOrigin = (rel: string) => git(origin, "show", `main:${rel}`);
  /** Someone else pushes a change to origin (an agent's commit). */
  const otherPush = (file: string, from: RegExp, to: string) => {
    git(seed, "pull", "-q", "--ff-only");
    const f = path.join(seed, file);
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(from, to));
    git(seed, "commit", "-q", "-am", "an agent's commit");
    git(seed, "push", "-q", "origin", "HEAD:main");
  };
  return { tmp, origin, seed, repo, runs, onOrigin, otherPush };
}

const setRow = (row: string, to: string) => (text: string) => {
  const t = text.replace(new RegExp(`^\\| ${row} \\| [^|]+ \\|$`, "m"), `| ${row} | ${to} |`);
  return t === text ? { skip: `${row} is not there` } : { text: t, msg: `Review ${row}: ${to} (Sam, via console)`, body: `Sam set ${row} to ${to}.` };
};
const edit = (repo: string, file: string, row: string, to: string, more: Partial<EditInput> = {}): EditInput => ({ repoDir: repo, path: `docs/spines/${file}`, label: row, group: true, edit: setRow(row, to), ...more });

describe("T6-S82 background push", () => {
  it("a press answers at its local commit; the push follows and names the press; the hooks are skipped for a clean line", async () => {
    const w = world();
    const pushedDirs: string[] = [];
    const sw = createSpineWriter({ backgroundPush: true, onPushed: (d) => pushedDirs.push(d), log: () => undefined });
    const writer = groupEdits(sw);
    const r = await withPress("pr_one", () => writer.edit(edit(w.repo, "a.md", "PLAN-1-S1", "done (approved)")));
    expect(r).toMatchObject({ status: "written", pushing: true });
    expect(r.sha).toBeTruthy();
    expect(r.ms?.push).toBeUndefined();
    expect(fs.readFileSync(path.join(w.repo, "docs/spines/a.md"), "utf8")).toContain("| PLAN-1-S1 | done (approved) |");
    expect(await sw.pushes!.drain(10_000)).toBe(true);
    expect(w.onOrigin("docs/spines/a.md")).toContain("| PLAN-1-S1 | done (approved) |");
    expect(git(w.origin, "log", "-1", "--format=%B", "main")).toMatch(/^Press: pr_one$/m);
    expect(pushedDirs).toEqual([w.repo]);
    expect(w.runs()).toBe(0);
  });

  it("a press whose words look like a secret runs the hooks after all (gitleaks decides)", async () => {
    const w = world();
    const sw = createSpineWriter({ backgroundPush: true, log: () => undefined });
    const writer = groupEdits(sw);
    const key = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    await writer.edit(edit(w.repo, "a.md", "PLAN-1-S1", `active (feedback: use ${key})`));
    expect(w.runs()).toBe(1);
    await sw.pushes!.drain(10_000);
    expect(secretShaped(`token = ${key}`)).toBe(true);
    expect(secretShaped("Okay, man, so this video is a great opportunity to learn")).toBe(false);
  });

  it("origin moved on (another file): the background push rebases and lands", async () => {
    const w = world();
    const sw = createSpineWriter({ backgroundPush: true, log: () => undefined });
    const writer = groupEdits(sw);
    w.otherPush("docs/spines/b.md", /\| PLAN-2-S2 \| review \|/, "| PLAN-2-S2 | active |");
    // the writer's checkout has not fetched: its commit goes on the old main, the push races and rebases
    const r = await writer.edit(edit(w.repo, "a.md", "PLAN-1-S1", "done (approved)", { fetchFreshMs: 60_000 }));
    expect(r.status).toBe("written");
    expect(await sw.pushes!.drain(15_000)).toBe(true);
    expect(w.onOrigin("docs/spines/a.md")).toContain("| PLAN-1-S1 | done (approved) |");
    expect(w.onOrigin("docs/spines/b.md")).toContain("| PLAN-2-S2 | active |");
  });

  it("a commit that cannot be rebased (the same row changed on origin) is kept on a backup branch and its presses go back", async () => {
    const w = world();
    const gone: DroppedPush[] = [];
    const sw = createSpineWriter({ backgroundPush: true, onDropped: (d) => gone.push(d), log: () => undefined });
    const writer = groupEdits(sw);
    // fetch now so the next write takes the "fresh" path and skips its own fetch
    await withPress("pr_warm", () => writer.edit(edit(w.repo, "b.md", "PLAN-2-S1", "done (approved)")));
    await sw.pushes!.drain(10_000);
    w.otherPush("docs/spines/a.md", /\| PLAN-1-S1 \| review \|/, "| PLAN-1-S1 | active (an agent took it) |");
    const r = await withPress("pr_late", () => writer.edit(edit(w.repo, "a.md", "PLAN-1-S1", "done (approved)", { fetchFreshMs: 60_000 })));
    expect(r.status).toBe("written");
    expect(await sw.pushes!.drain(15_000)).toBe(true);
    expect(gone).toHaveLength(1);
    expect(gone[0].presses).toEqual(["pr_late"]);
    expect(gone[0].backup).toMatch(/^backup\/console-/);
    expect(w.onOrigin("docs/spines/a.md")).toContain("| PLAN-1-S1 | active (an agent took it) |");
    // the checkout is back on origin, clean; the commit is on the backup branch
    expect(git(w.repo, "rev-parse", "HEAD")).toBe(git(w.origin, "rev-parse", "main"));
    expect(git(w.repo, "log", "-1", "--format=%B", gone[0].backup!)).toMatch(/^Press: pr_late$/m);
  });

  it("origin unreachable: the commit stays, the push is tried again until it lands", async () => {
    const w = world();
    const sw = createSpineWriter({ backgroundPush: true, pushRetryMs: [150], log: () => undefined });
    const writer = groupEdits(sw);
    await writer.edit(edit(w.repo, "a.md", "PLAN-1-S1", "done (approved)"));
    const away = `${w.origin}.away`;
    fs.renameSync(w.origin, away);
    const r = await writer.edit(edit(w.repo, "a.md", "PLAN-1-S2", "done (approved)", { fetchFreshMs: 60_000 }));
    expect(r.status).toBe("written");
    expect(await until(() => (sw.pushes!.pending()[0]?.tries ?? 0) >= 1)).toBe(true);
    fs.renameSync(away, w.origin);
    expect(await sw.pushes!.drain(10_000)).toBe(true);
    expect(w.onOrigin("docs/spines/a.md")).toContain("| PLAN-1-S2 | done (approved) |");
  });

  it("a write while a push is pending keeps the unpushed press commit (never dropped) and both reach origin", async () => {
    const w = world();
    const sw = createSpineWriter({ backgroundPush: true, pushRetryMs: [60_000], log: () => undefined });
    const writer = groupEdits(sw);
    await writer.edit(edit(w.repo, "a.md", "PLAN-1-S1", "done (approved)"));
    await sw.pushes!.drain(10_000);
    const away = `${w.origin}.away`;
    fs.renameSync(w.origin, away);
    await writer.edit(edit(w.repo, "a.md", "PLAN-1-S2", "done (approved)", { fetchFreshMs: 60_000 }));
    expect(await until(() => (sw.pushes!.pending()[0]?.tries ?? 0) >= 1)).toBe(true);
    fs.renameSync(away, w.origin);
    w.otherPush("docs/spines/b.md", /\| PLAN-2-S1 \| review \|/, "| PLAN-2-S1 | active |");
    // a sync write (not a press): it finds one console commit ahead and origin moved on: rebased, kept, pushed with it
    const r = await createSpineWriterSync(sw, w.repo);
    expect(r.status).toBe("written");
    expect(w.onOrigin("docs/spines/a.md")).toContain("| PLAN-1-S2 | done (approved) |");
    expect(w.onOrigin("docs/spines/b.md")).toContain("| PLAN-2-S2 | done |");
    expect(await sw.pushes!.drain(5_000)).toBe(true);
  });
});

/** A non-press edit through the same writer (it pushes in the request). */
function createSpineWriterSync(sw: ReturnType<typeof createSpineWriter>, repo: string) {
  return sw.edit({ repoDir: repo, path: "docs/spines/b.md", label: "PLAN-2-S2", edit: setRow("PLAN-2-S2", "done") });
}

describe("T6-S82 a stuck git call never holds a checkout", () => {
  it("the repo lock lets the next caller go after its limit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s82-lock-"));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const logs: string[] = [];
    void withRepoLock(dir, () => new Promise<void>(() => undefined), { maxWaitMs: 200, log: (m) => logs.push(m) });
    const t0 = Date.now();
    const r = await withRepoLock(dir, async () => "ran", { maxWaitMs: 200, log: (m) => logs.push(m) });
    expect(r).toBe("ran");
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(logs.join("\n")).toMatch(/held it over/);
  });

  it("a pull whose helper hangs and holds the pipes is killed with its children on the timeout", async () => {
    const w = world();
    git(w.repo, "config", "alias.hang", "!sh -c 'sleep 30 & sleep 30'");
    const t0 = Date.now();
    await expect(gitRunner(300)(w.repo, ["hang"])).rejects.toThrow(/timed out/);
    expect(Date.now() - t0).toBeLessThan(3_000);
  });
});

describe("T6-S82 his words are never dropped", () => {
  function app(relaunch: (id: string) => Response | Promise<Response>, comment: (b: Record<string, unknown>) => Response) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s82-db-"));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const db = openDb(path.join(dir, "console.db"));
    cleanup.push(() => db.close());
    const presses = createPresses(db);
    const a = new Hono();
    const api = new Hono();
    const card = { repo: "home_repo", path: "docs/spines/epic-48.md", ref: "T48-S37", title: "the clip" };
    mountPresses(api, { db, presses, fetch: (r) => a.fetch(r), answerFirst: true, authMode: "off", log: () => undefined, cardOf: (id) => (id === "rv_x" ? card : undefined) });
    api.post("/review-items/:id/relaunch", (c) => relaunch(c.req.param("id")));
    api.post("/closed-cards/comment", async (c) => comment(await c.req.json()));
    a.route("/api", api);
    const press = (words: string) =>
      a.fetch(new Request("http://console.local/api/review-items/rv_x/relaunch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ feedback: words }) }));
    return { presses, press };
  }
  const notInReview = (status: string) => new Response(JSON.stringify({ error: { code: "spine_write_skipped", message: `not written: row T48-S37 is not in review any more (it reads “${status.slice(0, 120)}”); nothing written` } }), { status: 409, headers: { "content-type": "application/json" } });

  it("a Changes wanted whose row left review lands his words as a Decisions row and the press says so", async () => {
    const got: Record<string, unknown>[] = [];
    const { presses, press } = app(
      () => notInReview("active (an agent picked it up)"),
      (b) => {
        got.push(b);
        return new Response(JSON.stringify({ sha: "abc1234" }), { status: 200, headers: { "content-type": "application/json" } });
      },
    );
    const r = await press("Show the problem first, then the solution.");
    expect(r.status).toBe(202);
    const id = ((await r.json()) as { press: { id: string } }).press.id;
    expect(await until(() => presses.get(id)?.state !== "landing")).toBe(true);
    const p = presses.get(id)!;
    expect(p).toMatchObject({ state: "landed", sha: "abc1234" });
    expect(p.reason).toMatch(/his words were written as a Decisions row of T48-S37/);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ kind: "review", repo: "home_repo", path: "docs/spines/epic-48.md", ref: "T48-S37" });
    expect(String(got[0].text)).toMatch(/Changes wanted pressed .* the row had moved on .*\] Show the problem first, then the solution\.$/);
  });

  it("a Changes wanted the card refuses as too long (after the press said saved) lands his words whole as a Decisions row", async () => {
    const got: Record<string, unknown>[] = [];
    const tooLong = () => new Response(JSON.stringify({ error: { code: "validation_error", message: "feedback is required, or a file in attachments (at most 4000 characters)" } }), { status: 400, headers: { "content-type": "application/json" } });
    const { presses, press } = app(tooLong, (b) => {
      got.push(b);
      return new Response(JSON.stringify({ sha: "def5678" }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const words = `${"I don't know if we're ready to promote it. ".repeat(260)}THE-END`;
    const r = await press(words);
    expect(r.status).toBe(202);
    const id = ((await r.json()) as { press: { id: string } }).press.id;
    expect(await until(() => presses.get(id)?.state !== "landing")).toBe(true);
    expect(presses.get(id)).toMatchObject({ state: "landed", sha: "def5678" });
    expect(presses.get(id)!.reason).toMatch(/the card refused them .*his words were written as a Decisions row of T48-S37/);
    expect(got).toHaveLength(1);
    expect(String(got[0].text)).toMatch(/^\[Changes wanted pressed .* the card refused it: feedback is required/);
    expect(String(got[0].text).endsWith(words)).toBe(true);
  });

  it("a refused press with no words stays failed (nothing to keep)", async () => {
    const got: unknown[] = [];
    const bad = () => new Response(JSON.stringify({ error: { code: "validation_error", message: "feedback is required" } }), { status: 400, headers: { "content-type": "application/json" } });
    const { presses, press } = app(bad, (b) => {
      got.push(b);
      return new Response("{}", { status: 200 });
    });
    const r = await press("   ");
    const id = ((await r.json()) as { press?: { id: string } }).press?.id;
    if (id) {
      expect(await until(() => presses.get(id)?.state !== "landing")).toBe(true);
      expect(presses.get(id)?.state).toBe("failed");
    }
    expect(got).toHaveLength(0);
  });

  it("an earlier try of the same press already wrote the words (cut off by a restart): that is its landing, no second row", async () => {
    const got: unknown[] = [];
    const words = "Okay, man, so this video is a great opportunity to learn, and I think I want mock-ups.";
    const { presses, press } = app(
      () => notInReview(`active (iteration 4, relaunched by Sam 2026-11-11: ${words})`),
      (b) => {
        got.push(b);
        return new Response("{}", { status: 200 });
      },
    );
    const id = ((await (await press(words)).json()) as { press: { id: string } }).press.id;
    expect(await until(() => presses.get(id)?.state !== "landing")).toBe(true);
    expect(presses.get(id)).toMatchObject({ state: "landed" });
    expect(presses.get(id)!.reason).toMatch(/already carries these words/);
    expect(got).toHaveLength(0);
  });

  it("requeue puts a landed press back in the outbox, due now", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s82-db-"));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const db = openDb(path.join(dir, "console.db"));
    cleanup.push(() => db.close());
    const presses = createPresses(db);
    const id = presses.open({ action: "review approve", target: "rv_1", who: "Sam", route: "/review-items/rv_1/approve", request: { method: "POST", path: "/api/review-items/rv_1/approve", body: "{}" }, due: true });
    presses.settle(id, { verdict: { kind: "landed", sha: "abc" }, status: 200, ms: 5, retry: true });
    expect(presses.requeue([id, "pr_unknown"], "its commit could not be pushed")).toBe(1);
    expect(presses.get(id)).toMatchObject({ state: "landing", result: "queued" });
    expect(presses.due().map((d) => d.id)).toEqual([id]);
  });
});

describe("T6-S82 on staging", () => {
  it("staging's refusal of every push is the end of the push (the local commit is the landing), never retried", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s82-stg-"));
    cleanup.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const origin = path.join(tmp, "origin.git");
    git(tmp, "init", "-q", "--bare", "-b", "main", origin);
    const repo = path.join(tmp, "repo");
    git(tmp, "clone", "-q", origin, repo);
    git(repo, "config", "user.email", "c@t");
    git(repo, "config", "user.name", "c");
    fs.mkdirSync(path.join(repo, "docs/spines"), { recursive: true });
    fs.writeFileSync(path.join(repo, "docs/spines/a.md"), spine("PLAN-1"));
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "seed");
    git(repo, "push", "-q", "origin", "HEAD:main");
    // staging's pre-push hook (staging.ts installNoPushHooks)
    const hooks = path.join(tmp, "hooks");
    fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, "pre-push"), '#!/bin/sh\necho "staging: git push is off here (T44-S11), refused push to $1 ($2)" >&2\nexit 1\n', { mode: 0o755 });
    git(repo, "config", "core.hooksPath", hooks);
    const logs: string[] = [];
    const sw = createSpineWriter({ backgroundPush: true, pushRetryMs: [50], log: (m) => logs.push(m) });
    const r = await groupEdits(sw).edit(edit(repo, "a.md", "PLAN-1-S1", "done (approved)"));
    expect(r.status).toBe("written");
    expect(await sw.pushes!.drain(5_000)).toBe(true);
    expect(sw.pushes!.active()).toBe(0);
    expect(logs.join("\n")).toMatch(/no push on staging/);
    expect(logs.join("\n")).not.toMatch(/again in/);
  });
});

describe("T6-S82 the clone's full check runs once, not before every press", () => {
  it("a clean clone skips the check (no ls-tree) until a write leaves it unsure; a leftover is caught and cleaned on the next write", async () => {
    const { createCloneWriter } = await import("../src/inbox/writeClone.js");
    const { makeRepo } = await import("./reviewFixture.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s82-check-"));
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = makeRepo(root, "r1", { "a.md": "a\n" }, { cards: false });
    // count the git calls the clone check makes (its size cap lists the whole tree with ls-tree)
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const calls = path.join(root, "calls.log");
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\n[ "$1" = -C ] && echo "$3" >> ${calls} || echo "$1" >> ${calls}\nexec ${real} "$@"\n`, { mode: 0o755 });
    const PATH = process.env.PATH;
    process.env.PATH = `${bin}:${PATH}`;
    cleanup.push(() => void (process.env.PATH = PATH));
    const logs: string[] = [];
    const w = createCloneWriter(createSpineWriter(), { root: path.join(root, "_write"), log: (m) => logs.push(m) });
    const edit = (text: string) => w.edit({ repoDir: repo.dir, path: "a.md", label: "t", edit: () => ({ text, msg: "edit a", body: "b" }) });
    const lsTrees = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter((l) => l === "ls-tree").length : 0);
    expect((await edit("a1\n")).status).toBe("written");
    expect(lsTrees()).toBe(1);
    expect((await edit("a2\n")).status).toBe("written");
    expect((await edit("a3\n")).status).toBe("written");
    expect(lsTrees()).toBe(1); // checked once
    expect(git(repo.bare, "show", "main:a.md")).toBe("a3");
    // something left in the clone after all: the writer's own guards refuse that write, and the next one checks in full
    const clone = w.cloneOf(repo.dir)!;
    fs.writeFileSync(path.join(clone, "a.md"), "junk\n");
    const refused = await edit("a4\n");
    expect(refused.status).not.toBe("written");
    expect(refused.reason).toMatch(/uncommitted changes/);
    expect((await edit("a4\n")).status).toBe("written");
    expect(lsTrees()).toBe(2);
    expect(logs.join("\n")).toMatch(/cleaned leftovers/);
    expect(git(repo.bare, "show", "main:a.md")).toBe("a4");
  });
});
