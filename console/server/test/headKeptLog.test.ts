import { describe, expect, it } from "vitest";
import { headKeptLog } from "../src/freshness.js";

// a git log answer is kept until the checkout's HEAD moves; anything else goes to git every time
describe("git log kept per HEAD", () => {
  it("one git run per HEAD for the same log, fresh after a move, never kept for other commands or relative dates", async () => {
    let head = "a".repeat(40);
    const calls: string[] = [];
    const git = headKeptLog(async (_d, args) => (calls.push(args.join(" ")), `${head.slice(0, 1)}:${args.join(" ")}`), { head: () => head });
    expect(await git("/r", ["log", "-n", "60", "--format=%ct", "--", "docs"])).toBe("a:log -n 60 --format=%ct -- docs");
    await git("/r", ["log", "-n", "60", "--format=%ct", "--", "docs"]);
    expect(calls).toHaveLength(1);
    await git("/r", ["log", "--since=2026-11-24T10:00:00Z", "--format=%ct"]);
    await git("/r", ["log", "--since=2026-11-24T10:00:00Z", "--format=%ct"]);
    expect(calls).toHaveLength(2);
    await git("/r", ["log", "--since=2 days ago"]);
    await git("/r", ["log", "--since=2 days ago"]);
    await git("/r", ["show", "abc^:x.md"]);
    await git("/r", ["show", "abc^:x.md"]);
    expect(calls).toHaveLength(6);
    head = "b".repeat(40);
    expect(await git("/r", ["log", "-n", "60", "--format=%ct", "--", "docs"])).toBe("b:log -n 60 --format=%ct -- docs");
    expect(calls).toHaveLength(7);
  });
  it("a failed run is not kept", async () => {
    let n = 0;
    const git = headKeptLog(async () => (++n === 1 ? Promise.reject(new Error("busy")) : "ok"), { head: () => "c".repeat(40) });
    await expect(git("/r", ["log"])).rejects.toThrow("busy");
    expect(await git("/r", ["log"])).toBe("ok");
  });
});

// a HEAD move keeps every log whose paths the new commits did not touch (one git log per move)
describe("git log kept across HEAD moves that do not touch its paths", () => {
  it("a commit to another spine keeps the answer; a commit to its spine asks again; a rewrite asks everything again", async () => {
    const { execFileSync } = await import("node:child_process");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { gitOut } = await import("../src/freshness.js");
    const { headSha } = await import("../src/gitRefs.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-kept-"));
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
    const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { env, encoding: "utf8" });
    const commit = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
      g("add", ".");
      g("commit", "-qm", `${file}: ${text}`);
    };
    g("init", "-q");
    commit("docs/spines/a.md", "1");
    commit("docs/spines/b.md", "1");
    const calls: string[] = [];
    const real = gitOut(10_000);
    const git = headKeptLog((d, a) => (calls.push(a.join(" ")), real(d, a)), { head: headSha });
    const logA = () => git(dir, ["log", "-n", "5", "--format=%s", "--", "docs/spines/a.md"]);
    const logB = () => git(dir, ["log", "-n", "5", "--format=%s", "--", "docs/spines"]);
    expect(await logA()).toBe("docs/spines/a.md: 1\n");
    await logB();
    expect(calls).toHaveLength(2);
    commit("docs/spines/b.md", "2");
    expect(await logA()).toBe("docs/spines/a.md: 1\n"); // kept: the move's one log said only b.md moved
    expect(await logB()).toContain("docs/spines/b.md: 2"); // its folder was touched: asked again
    expect(calls.filter((c) => c.startsWith("log -n")), JSON.stringify(calls)).toHaveLength(3);
    expect(calls.filter((c) => c.startsWith("log --left-right"))).toHaveLength(1);
    commit("docs/spines/a.md", "2");
    expect(await logA()).toBe("docs/spines/a.md: 2\ndocs/spines/a.md: 1\n");
    g("reset", "-q", "--hard", "HEAD~2");
    commit("docs/other.md", "x");
    expect(await logA()).toBe("docs/spines/a.md: 1\n"); // the a.md: 2 commit was left behind: asked again
  });
});
