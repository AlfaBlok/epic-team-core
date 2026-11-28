import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSpineWriter } from "../src/inbox/spineWrite.js";
import { createCloneWriter } from "../src/inbox/writeClone.js";
import { DIRTY_CHECKOUT } from "../src/inbox/routes.js";
import { git, makeRepo } from "./reviewFixture.js";

/**
 * (28 Nov 10:20Z): a release stopped the console while a commit (and its gitleaks hook) ran in the console's own
 * clone; systemd killed git, which left `.git/index.lock` and a staged `docs/status/deck-updates.md`. The clone's clean-up
 * ran `reset --hard`, which failed on the lock unchecked, logged "cleaned leftovers" every two minutes, and every write to
 * that clone was refused "the checkout has uncommitted changes" for 45 minutes: his presses spun at "writing it to the
 * project… 294 s" and six of his answers failed. One crashed write must never block every later write.
 */
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.reverse()) f();
  cleanup = [];
});

describe("one crashed write never blocks the console's later writes", () => {
  it("a dead write's index.lock and staged line in the console's clone are cleared, and the next write lands", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s230-"));
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = makeRepo(root, "r1", { "a.md": "a\n", "deck-updates.md": "updates\n" }, { cards: false });
    const logs: string[] = [];
    const w = createCloneWriter(createSpineWriter(), { root: path.join(root, "_write"), log: (m) => logs.push(m), checkTtlMs: 0 });
    const edit = (text: string) => w.edit({ repoDir: repo.dir, path: "a.md", label: "t", edit: () => ({ text, msg: "edit a", body: "b" }) });
    expect((await edit("a1\n")).status).toBe("written");
    const clone = w.cloneOf(repo.dir)!;

    // the killed commit: a staged line and the lock git never removed
    fs.writeFileSync(path.join(clone, "deck-updates.md"), "updates\na line the killed write staged\n");
    git(clone, "add", "deck-updates.md");
    fs.writeFileSync(path.join(clone, ".git", "index.lock"), "");

    const r = await edit("a2\n");
    expect(r.status).toBe("written");
    expect(git(repo.bare, "show", "main:a.md")).toBe("a2");
    expect(fs.existsSync(path.join(clone, ".git", "index.lock"))).toBe(false);
    expect(git(clone, "status", "--porcelain")).toBe("");
    const said = logs.join("\n");
    expect(said).toMatch(/removed the dead write's index\.lock/);
    expect(said).toMatch(/cleaned leftovers .*deck-updates\.md/);
    // and the writes after it land too
    expect((await edit("a3\n")).status).toBe("written");
    expect(git(repo.bare, "show", "main:a.md")).toBe("a3");
  });

  it("a leftover it truly cannot clean is said plainly, never logged as cleaned", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s230b-"));
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const repo = makeRepo(root, "r1", { "a.md": "a\n" }, { cards: false });
    const logs: string[] = [];
    // a git still running in the clone holds its lock: the lock is kept (the healer says busy)
    const w = createCloneWriter(createSpineWriter(), { root: path.join(root, "_write"), log: (m) => logs.push(m), checkTtlMs: 0, heal: async () => "busy 4242" });
    const edit = (text: string) => w.edit({ repoDir: repo.dir, path: "a.md", label: "t", edit: () => ({ text, msg: "edit a", body: "b" }) });
    expect((await edit("a1\n")).status).toBe("written");
    const clone = w.cloneOf(repo.dir)!;
    fs.writeFileSync(path.join(clone, "a.md"), "junk\n");
    git(clone, "add", "a.md");
    fs.writeFileSync(path.join(clone, ".git", "index.lock"), "");
    await edit("a2\n");
    const said = logs.join("\n");
    expect(said).toMatch(/kept index\.lock/);
    expect(said).toMatch(/could not clean leftovers/);
    expect(said).not.toMatch(/cleaned leftovers/);
  });

  it("an answer refused on such a leftover is tried again, never failed for good", () => {
    expect(DIRTY_CHECKOUT.test("the checkout has uncommitted changes (M  docs/status/deck-updates.md)")).toBe(true);
    expect(DIRTY_CHECKOUT.test("the checkout is on feature, not main")).toBe(false);
  });
});
