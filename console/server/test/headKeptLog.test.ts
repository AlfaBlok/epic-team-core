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
