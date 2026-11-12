import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitOut } from "../src/freshness.js";
import { CONSOLE_TRAILER, createSpineWriter, runner } from "../src/inbox/spineWrite.js";
import { createLeases } from "../src/review/leases.js";
import { createCheckoutSync } from "../src/status/checkoutSync.js";
import { createStore } from "../src/store.js";
import { openDb } from "../src/db.js";
import { git, makeRepo, spineText } from "./reviewFixture.js";

/**
 * the lease sweep must never block the console. the main server 2026-11-03 07:54Z: the sweep committed
 * `Lease expired` (a row blocked on), the push never finished, the checkout stayed diverged and every
 * console spine write was refused. Temp repos only.
 */
const FILE = "docs/notes.md";
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
let tmp: string;
let repo: ReturnType<typeof makeRepo>;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e63s9-"));
  repo = makeRepo(tmp, "home_repo", { "docs/spines/root.md": "# EPIC: home_repo\n\nIntegration policy: main-direct\n", [FILE]: lines(40) });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A second checkout of the same origin (another host, another console process). */
function clone(name: string) {
  const dir = path.join(tmp, name);
  git(tmp, "clone", "-q", repo.bare, dir);
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  return dir;
}
const setLine = (n: number, to: string) => (text: string) => {
  const l = text.split("\n");
  l[n - 1] = to;
  return { text: l.join("\n"), msg: `set line ${n}`, body: `T63-S9 test: line ${n} = ${to}` };
};
const sync = (dir: string) => git(dir, "rev-list", "--left-right", "--count", "HEAD...origin/main").replace(/\s+/, " ");

describe("T63-S9 a console spine write never leaves main diverged", () => {
  it("two writers racing on one origin: both commits land, neither checkout is left ahead", async () => {
    const other = clone("home_repo_b");
    const a = createSpineWriter();
    const b = createSpineWriter(); // separate writers: no shared in-process lock, so they really race on the push
    const results = [];
    for (let round = 0; round < 4; round++) {
      results.push(
        ...(await Promise.all([
          a.edit({ repoDir: repo.dir, path: FILE, label: "a", edit: setLine(3 + round, `a${round}`) }),
          b.edit({ repoDir: other, path: FILE, label: "b", edit: setLine(30 + round, `b${round}`) }),
        ])),
      );
    }
    expect(results.map((r) => r.status)).toEqual(Array(8).fill("written"));
    const origin = git(repo.bare, "show", `main:${FILE}`).split("\n");
    for (let r = 0; r < 4; r++) {
      expect(origin[2 + r]).toBe(`a${r}`);
      expect(origin[29 + r]).toBe(`b${r}`);
    }
    expect(repo.originLog().filter((s) => s.startsWith("set line"))).toHaveLength(8);
    for (const d of [repo.dir, other]) {
      git(d, "fetch", "-q", "origin");
      expect(sync(d).split(" ")[0]).toBe("0"); // never ahead: nothing of its own left unpushed
    }
  });

  it("a writer whose push loses the race fetches fresh, rebases its one commit and pushes again", async () => {
    const other = clone("home_repo_b");
    const w = createSpineWriter();
    const r = await w.edit({
      repoDir: repo.dir,
      path: FILE,
      label: "a",
      edit: (text) => {
        // between this writer's fetch and its push, someone else pushes
        fs.writeFileSync(path.join(other, "other.txt"), "x");
        git(other, "add", "other.txt");
        git(other, "commit", "-q", "-m", "someone else");
        git(other, "push", "-q", "origin", "main");
        return setLine(5, "mine")(text);
      },
    });
    expect([r.status, r.reason]).toEqual(["written", undefined]);
    expect(repo.originLog().slice(0, 2)).toEqual(["set line 5", "someone else"]);
    expect(sync(repo.dir)).toBe("0 0");
  });

  it("a push that fails drops the writer's own commit: main equals origin and the tree is clean", async () => {
    const before = git(repo.dir, "rev-parse", "HEAD");
    const hook = path.join(repo.bare, "hooks", "pre-receive");
    fs.writeFileSync(hook, "#!/bin/sh\necho 'refused by test' >&2\nexit 1\n", { mode: 0o755 });
    git(repo.bare, "config", "core.hooksPath", path.dirname(hook)); // a host-wide hooksPath must not hide it
    const r = await createSpineWriter().edit({ repoDir: repo.dir, path: FILE, label: "a", edit: setLine(7, "never") });
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/git push failed/);
    expect(git(repo.dir, "rev-parse", "HEAD")).toBe(before);
    expect(git(repo.dir, "rev-parse", "origin/main")).toBe(before);
    expect(git(repo.dir, "status", "--porcelain")).toBe("");
    expect(repo.read(FILE).split("\n")[6]).toBe("line 7");
    // and the next write works as soon as the push does
    fs.rmSync(hook);
    expect((await createSpineWriter().edit({ repoDir: repo.dir, path: FILE, label: "a", edit: setLine(7, "now") })).status).toBe("written");
    expect(sync(repo.dir)).toBe("0 0");
  });

  it("a git child that keeps the pipes open cannot hang a write: the whole group is killed at the timeout", async () => {
    const g = runner(repo.dir, { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" });
    const t0 = Date.now();
    const r = await g(["-c", "alias.hang=!sh -c 'sleep 30 & sleep 30'", "hang"], { timeout: 700 });
    expect(r.ok).toBe(false);
    expect(r.err).toMatch(/timed out after 700 ms/);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("an unpushed commit the console made (cut off before its push) is kept on a backup branch and dropped; anyone else's is left alone", async () => {
    // the console's own stray commit (its trailer), never pushed
    fs.writeFileSync(path.join(repo.dir, FILE), setLine(9, "stray")(repo.read(FILE)).text);
    git(repo.dir, "commit", "-q", "-am", "Lease expired T9-S1: run_A", "-m", `body\n\n${CONSOLE_TRAILER}`);
    const stray = git(repo.dir, "rev-parse", "HEAD");
    const healed: string[] = [];
    const w = createSpineWriter({ onHeal: (h) => healed.push(h.backup) });
    const r = await w.edit({ repoDir: repo.dir, path: FILE, label: "a", edit: setLine(11, "next") });
    expect(r.status).toBe("written");
    expect(healed).toEqual([`backup/console-${stray.slice(0, 8)}`]);
    expect(git(repo.dir, "rev-parse", healed[0])).toBe(stray);
    expect(repo.originLog()[0]).toBe("set line 11");
    expect(repo.originLog()).not.toContain("Lease expired T9-S1: run_A");
    expect(sync(repo.dir)).toBe("0 0");

    // a person's or agent's unpushed commit: refused, nothing moved
    fs.writeFileSync(path.join(repo.dir, "mine.txt"), "x");
    git(repo.dir, "add", "mine.txt");
    git(repo.dir, "commit", "-q", "-m", "T9-S2: my work");
    const head = git(repo.dir, "rev-parse", "HEAD");
    const refused = await w.edit({ repoDir: repo.dir, path: FILE, label: "a", edit: setLine(13, "no") });
    expect(refused.status).toBe("skipped");
    expect(refused.reason).toMatch(/not made by the console.*push or rebase them/);
    expect(git(repo.dir, "rev-parse", "HEAD")).toBe(head);
  });
});

describe("T63-S9 the lease sweep leaves rows that wait on someone else alone", () => {
  it("only an active (or claimed) row's lease expires; blocked and review rows keep theirs", async () => {
    const EPIC = "docs/spines/epic-9.md";
    const r2 = makeRepo(path.join(tmp, "w"), "home_repo", {
      "docs/spines/root.md": "# EPIC: home_repo\n\nIntegration policy: main-direct\n",
      [EPIC]: spineText("PLAN-9", "Things", [
        { id: "T9-S1", status: "active" },
        { id: "T9-S2", status: "blocked" },
        { id: "T9-S3", status: "review" },
        { id: "T9-S4", status: "claimed" },
      ]),
    });
    let text = r2.read(EPIC);
    for (const id of ["T9-S1", "T9-S2", "T9-S3", "T9-S4"]) {
      text = text.split("\n").map((l) => (l.startsWith(`| ${id} |`) ? l.replace("| seat2 |", `| run_${id.slice(-1)} — claimed 2026-11-02T20:00Z, lease until 2026-11-02T21:00Z |`) : l)).join("\n");
    }
    fs.writeFileSync(path.join(r2.dir, EPIC), text);
    git(r2.dir, "commit", "-q", "-am", "claims");
    git(r2.dir, "push", "-q", "origin", "main");
    const db = openDb(path.join(tmp, "console.db"));
    try {
      const store = createStore(db);
      store.createMilestone({ title: "home_repo", repo: "home_repo", path: "docs/spines/root.md", owner: "", paused: false });
      const leases = createLeases({ store: () => store, reposRoot: path.join(tmp, "w"), writer: createSpineWriter(), git: gitOut(), now: () => Date.parse("2026-11-03T08:00:00Z") });
      expect((await leases.view()).map((c) => [c.ref, c.expired])).toEqual([
        ["T9-S1", true],
        ["T9-S2", false],
        ["T9-S3", false],
        ["T9-S4", true],
      ]);
      const done = await leases.sweep();
      expect(done.map((d) => [d.ref, d.status])).toEqual([
        ["T9-S1", "written"],
        ["T9-S4", "written"],
      ]);
      expect(r2.rowLine(EPIC, "T9-S2")).toContain("run_2 — claimed");
      expect(r2.rowLine(EPIC, "T9-S2")).toContain("| blocked |");
      expect(r2.rowLine(EPIC, "T9-S3")).toContain("| review |");
      expect(git(r2.dir, "rev-list", "--left-right", "--count", "HEAD...origin/main").replace(/\s+/, " ")).toBe("0 0");
    } finally {
      db.close();
    }
  });
});

describe("T63-S9 a checkout out of sync with origin for over 5 minutes is an alert", () => {
  it("alerts once per episode and clears when the checkout matches again", async () => {
    let t = Date.parse("2026-11-03T08:00:00Z");
    const alerts: string[] = [];
    const s = createCheckoutSync({ dirs: () => [repo.dir], git: gitOut(), now: () => t, alert: (x) => alerts.push(x) });
    expect((await s.tick()).length).toBe(0);
    expect(s.health().state).toBe("ok");
    fs.writeFileSync(path.join(repo.dir, "x.txt"), "x");
    git(repo.dir, "add", "x.txt");
    git(repo.dir, "commit", "-q", "-m", "unpushed");
    await s.tick();
    expect(alerts).toEqual([]); // under 5 min: a write about to push
    t += 4 * 60_000;
    await s.tick();
    expect(alerts).toEqual([]);
    t += 2 * 60_000;
    await s.tick();
    await s.tick();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/home_repo checkout .* is 1 commit\(s\) ahead of origin\/main/);
    expect(s.health()).toMatchObject({ state: "alert", out: [{ repo: "home_repo", ahead: 1, behind: 0 }] });
    expect(s.section(repo.dir)).toMatch(/Console checkout out of sync/);
    git(repo.dir, "push", "-q", "origin", "main");
    git(repo.dir, "fetch", "-q", "origin");
    await s.tick();
    expect(s.health()).toMatchObject({ state: "ok", out: [] });
    expect(s.section(repo.dir)).toBeUndefined();
  });
});
