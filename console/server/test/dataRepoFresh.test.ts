import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createFreshness, type GitOut } from "../src/freshness.js";
import { mountFreshness } from "../src/routes/freshness.js";

// the owner's workspace data repo (his objectives, linked into the home checkout) has no milestone, so the
// milestone poll never asked it and it moved only with the 15-min background sync. It is now asked every minute.

afterEach(() => vi.useRealTimers());

/** a fake git: ls-remote answers `remote`, rev-parse HEAD answers `local[dir]`, a pull moves local to remote. */
function fakeGit(remote: string, local: Record<string, string>) {
  const calls: string[] = [];
  const origin = { remote };
  const git: GitOut = async (dir, args) => {
    calls.push(`${path.basename(dir)} ${args[0]}`);
    if (args[0] === "ls-remote") return `${origin.remote}\trefs/heads/main\n`;
    if (args[0] === "rev-parse") return `${local[dir] ?? "a"}\n`;
    if (args[0] === "merge-base") throw new Error("not an ancestor");
    if (args[0] === "pull") {
      local[dir] = origin.remote;
      return "";
    }
    return "";
  };
  return { git, calls, origin };
}

describe("the workspace data repo is polled every minute", () => {
  it("a poll with skip 0 asks a repo pulled a moment ago (the milestone poll's skip would wait 5 min)", async () => {
    const local: Record<string, string> = { "/r/data": "a" };
    const { git, calls } = fakeGit("b", local);
    const f = createFreshness({ git, pollSkipMs: 5 * 60_000, healLock: false, log: () => undefined });
    await f.poll(["/r/data"]); // pulls a → b
    expect(local["/r/data"]).toBe("b");
    calls.length = 0;
    await f.poll(["/r/data"]); // skipped: pulled within 5 min
    expect(calls.filter((c) => c.endsWith("ls-remote"))).toEqual([]);
    await f.poll(["/r/data"], 0); // the data poll: asked again
    expect(calls.filter((c) => c.endsWith("ls-remote"))).toEqual(["data ls-remote"]);
  });

  it("watchHead: a checkout moved by another process (the background sync) drops its caches at the next poll", async () => {
    const local: Record<string, string> = { "/r/data": "a" };
    const { git, origin } = fakeGit("a", local);
    const dropped: string[] = [];
    const f = createFreshness({ git, healLock: false, log: () => undefined, invalidate: (d) => dropped.push(d) });
    await f.poll(["/r/data"], 0, true); // first look: a
    expect(dropped).toEqual([]);
    origin.remote = "c";
    local["/r/data"] = "c"; // the cron pulled it; origin agrees, so nothing to pull here
    await f.poll(["/r/data"], 0, true);
    expect(dropped).toEqual(["/r/data"]);
    await f.poll(["/r/data"], 0, true); // unchanged: not dropped again
    expect(dropped).toEqual(["/r/data"]);
  });

  it("mountFreshness polls the data checkout a live repo points to, within a minute, and drops its caches", async () => {
    vi.useFakeTimers();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e6s217-"));
    const reposRoot = path.join(tmp, "github");
    const home = path.join(reposRoot, "home");
    const data = path.join(reposRoot, "home-data");
    fs.mkdirSync(path.join(home, "docs"), { recursive: true });
    fs.mkdirSync(path.join(home, ".git"), { recursive: true });
    fs.mkdirSync(path.join(data, ".git"), { recursive: true });
    fs.writeFileSync(path.join(home, "docs", "workspace-data.json"), JSON.stringify({ repo: "o/home-data", checkout: "home-data" }));
    const store = createStore(openDb(path.join(tmp, "c.db")));
    store.createMilestone({ title: "Home", repo: "home", path: "docs/spines/root.md", owner: "", paused: false });
    const local: Record<string, string> = { [home]: "b", [data]: "a" };
    const { git } = fakeGit("b", local);
    const dropped: string[] = [];
    const fresh = mountFreshness(new Hono(), {
      enabled: true,
      git,
      healLock: false,
      log: () => undefined,
      store,
      reposRoot,
      treeFor: async () => ({ root: { children: [] } }) as never,
      invalidate: (dir) => dropped.push(dir),
    });
    try {
      await vi.advanceTimersByTimeAsync(61_000);
      expect(local[data]).toBe("b");
      expect(dropped).toContain(data);
    } finally {
      fresh.stop();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
