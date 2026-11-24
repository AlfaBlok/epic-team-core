import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { settleWritten } from "../src/inbox/pending.js";
import { createSpineWriter, CONSOLE_TRAILER } from "../src/inbox/spineWrite.js";
import { createCheckoutSync } from "../src/status/checkoutSync.js";

/**
 * seen in production: a world's origin history was rewritten (a purge of personal data). The console's write clone
 * kept the old history: agents' commits and some of its own, all on origin again under new SHAs. Every write was
 * refused ("diverged ... local commit(s) not made by the console") for 30 hours, an owner's answer among them; nothing
 * alarmed (only the shared checkouts were watched); and the card kept "Try 1 failed" after the asker wrote it in.
 */

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
const put = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const commit = (dir: string, msg: string) => (git(dir, "add", "-A"), git(dir, "commit", "-q", "-m", msg));

const SPINE = `# EPIC-909: testers

Spine ID: inbox-root
Integration policy: main-direct

## Waiting on

- [ask E909-A1: approve @Sam since 2026-11-23 row T5] Ask the testers what stopped them? — recommend: yes

## Issue Ledger

| Issue | Title | Status |
|---|---|---|
| T5 | Ask the testers | blocked |
`;

let tmp: string;
let origin: string;
let repo: string;
const saved = { g: process.env.GIT_CONFIG_GLOBAL, s: process.env.GIT_CONFIG_SYSTEM };
beforeEach(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s250-"));
  origin = path.join(tmp, "origin.git");
  git(tmp, "init", "-q", "--bare", "-b", "main", origin);
  const seed = path.join(tmp, "seed");
  git(tmp, "clone", "-q", origin, seed);
  git(seed, "checkout", "-q", "-b", "main");
  put(seed, "docs/spines/root.md", SPINE);
  put(seed, "docs/testers.md", "# testers\n");
  commit(seed, "seed");
  git(seed, "push", "-q", "origin", "main");
  repo = path.join(tmp, "clone");
  git(tmp, "clone", "-q", origin, repo);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of [["GIT_CONFIG_GLOBAL", saved.g], ["GIT_CONFIG_SYSTEM", saved.s]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/**
 * an agent's commits pushed to origin and pulled by the clone, then origin rewritten: the email the first commit
 * showed (a later commit shortened it) purged from history, force-pushed, and work goes on. `keepEmail`: the purge
 * also changed the last snapshot (the clone then holds content origin lacks).
 */
function rewriteOrigin(keepEmail = false): { oldHead: string } {
  const agent = path.join(tmp, "agent");
  git(tmp, "clone", "-q", origin, agent);
  put(agent, "docs/testers.md", "# testers\nsam@example.com\n");
  commit(agent, "E909-S2 card check");
  if (!keepEmail) put(agent, "docs/testers.md", "# testers\ns…@example.com\n");
  put(agent, "docs/round3.md", "round 3\n");
  commit(agent, "E909-S3 round 3");
  put(agent, "docs/spines/root.md", SPINE.replace("| blocked |", "| review |"));
  commit(agent, `Outcomes E909-S3\n\n${CONSOLE_TRAILER}`);
  git(agent, "push", "-q", "origin", "main");
  git(repo, "pull", "-q", "--ff-only");
  const oldHead = git(repo, "rev-parse", "HEAD");
  git(agent, "reset", "-q", "--hard", "HEAD~3");
  put(agent, "docs/testers.md", "# testers\ns…@example.com\n");
  commit(agent, "E909-S2 card check");
  put(agent, "docs/round3.md", "round 3\n");
  commit(agent, "E909-S3 round 3");
  put(agent, "docs/spines/root.md", SPINE.replace("| blocked |", "| review |"));
  commit(agent, `Outcomes E909-S3\n\n${CONSOLE_TRAILER}`);
  git(agent, "push", "-q", "-f", "origin", "main");
  put(agent, "docs/after.md", "after the rewrite\n");
  commit(agent, "after");
  git(agent, "push", "-q", "origin", "main");
  return { oldHead };
}

describe("a console checkout whose origin was rewritten under it", () => {
  it("writes again: the old history, all on origin by content, goes to a backup branch; nothing is pushed back", async () => {
    const { oldHead } = rewriteOrigin();
    for (const bg of [false, true]) {
      if (bg) {
        // the same again for the background-push writer
        git(repo, "reset", "-q", "--hard", oldHead);
        git(repo, "fetch", "-q", "origin");
      }
      const heals: { backup: string; dropped: string[] }[] = [];
      const w = createSpineWriter({ onHeal: (h) => heals.push(h), ...(bg ? { backgroundPush: true } : {}) } as Parameters<typeof createSpineWriter>[0]);
      const r = await w.answer({
        repoDir: repo,
        target: { id: "wj_t", source: "ask", code: "E909-A1", question: "Ask the testers what stopped them?", row: "T5", path: "docs/spines/root.md" },
        answer: bg ? "yes again" : "yes",
        label: "wj_t",
        date: "2026-11-24",
      });
      expect(r.status, r.reason).toBe("written");
      expect(heals).toHaveLength(1);
      expect(heals[0].dropped).toHaveLength(3);
      expect(git(repo, "rev-parse", heals[0].backup)).toBe(oldHead); // kept, never lost
      const log = git(origin, "log", "--format=%H", "main").split("\n");
      expect(log).not.toContain(oldHead); // the purged history never goes back to origin
      expect(git(origin, "show", "main:docs/testers.md")).not.toContain("sam@example.com");
      if (!bg) expect(git(origin, "show", "main:docs/spines/root.md")).toContain("[answered E909-A1");
    }
  });

  it("still refuses when the old history holds content origin lacks (the purged email itself)", async () => {
    const { oldHead } = rewriteOrigin(true);
    const r = await createSpineWriter().answer({
      repoDir: repo,
      target: { id: "wj_t", source: "ask", code: "E909-A1", question: "Ask the testers what stopped them?", row: "T5", path: "docs/spines/root.md" },
      answer: "yes",
      label: "wj_t",
      date: "2026-11-24",
    });
    expect(r).toMatchObject({ status: "skipped", reason: expect.stringContaining("not made by the console") });
    expect(git(repo, "rev-parse", "HEAD")).toBe(oldHead);
  });

  it("still refuses an agent's own unpushed commit origin does not hold", async () => {
    rewriteOrigin();
    git(repo, "reset", "-q", "--hard", "origin/main");
    put(repo, "docs/mine.md", "an agent's work, never pushed\n");
    commit(repo, "E909-S4 work in progress");
    const r = await createSpineWriter().answer({
      repoDir: repo,
      target: { id: "wj_t", source: "ask", code: "E909-A1", question: "Ask the testers what stopped them?", row: "T5", path: "docs/spines/root.md" },
      answer: "yes",
      label: "wj_t",
      date: "2026-11-24",
    });
    expect(r).toMatchObject({ status: "skipped", reason: expect.stringContaining("not made by the console") });
    expect(git(repo, "log", "-1", "--format=%s")).toBe("E909-S4 work in progress");
  });
});

describe("checkout sync watches the console's write clones", () => {
  const gitOut = () => async (dir: string, args: string[]) => git(dir, ...args);
  it("a write clone ahead of origin alerts after 5 min and shows on the shared checkout's wake; one only behind does not", async () => {
    const shared = path.join(tmp, "shared");
    git(tmp, "clone", "-q", origin, shared);
    let t = Date.parse("2026-11-24T03:00:00Z");
    const alerts: string[] = [];
    const s = createCheckoutSync({ dirs: () => [shared], clones: () => [{ shared, clone: repo }], git: gitOut(), now: () => t, alert: (x) => alerts.push(x), heal: async () => ({ ok: true }) });
    // behind only: normal for a clone (it fast-forwards at its next write)
    const other = path.join(tmp, "other");
    git(tmp, "clone", "-q", origin, other);
    put(other, "docs/more.md", "more\n");
    commit(other, "more");
    git(other, "push", "-q", "origin", "main");
    git(repo, "fetch", "-q", "origin");
    git(shared, "pull", "-q", "--ff-only");
    await s.tick();
    t += 10 * 60_000;
    await s.tick();
    expect(alerts).toEqual([]);
    // ahead: refuses every write to the repo
    put(repo, "docs/stray.md", "x\n");
    commit(repo, "stray");
    await s.tick();
    t += 6 * 60_000;
    await s.tick();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/clone \(console write copy\) checkout .* diverged from origin\/main \(ahead 1, behind 1\)/);
    expect(s.health()).toMatchObject({ state: "alert", out: [{ repo: "clone (console write copy)", ahead: 1 }] });
    expect(s.section(shared)).toMatch(/Console checkout out of sync/);
  });
});

describe("an answer the asker wrote in after the console's try failed", () => {
  it("its job is done: the card no longer shows the failed try", () => {
    const db = openDb(path.join(tmp, "c.db"));
    try {
      const ins = db.prepare(
        `INSERT INTO jordi_responses (id, item_id, item, kind, text, delivery, created_at, spine_status, spine_reason, job_state, job_attempts, job_error) VALUES (?, 'wj_1', '{}', 'feedback', 'did we send it?', ?, '2026-11-24T03:31:29.507Z', ?, 'r', ?, 1, 'local main is diverged from origin/main')`,
      );
      ins.run("jr_written", "sent", "written", "failed");
      ins.run("jr_not_written", "queued", "skipped", "failed");
      ins.run("jr_retrying", "sent", "written", "pending");
      settleWritten(db, () => undefined);
      const row = (id: string) => db.prepare("SELECT job_state, job_error FROM jordi_responses WHERE id = ?").get(id);
      expect(row("jr_written")).toEqual({ job_state: "done", job_error: null });
      expect(row("jr_not_written")).toMatchObject({ job_state: "failed" }); // still not in the spine: Retry stays
      expect(row("jr_retrying")).toMatchObject({ job_state: "pending" });
    } finally {
      db.close();
    }
  });
});
