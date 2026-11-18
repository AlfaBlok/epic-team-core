import { describe, expect, it } from "vitest";
import { createFreshness } from "../src/freshness.js";
import { indexerTickMs } from "../src/indexer/core.js";
import { indexerEnv } from "../src/indexer/launch.js";

/**
 * The schedule page's slow-downs: the indexer's pass every 30 s instead of 5 s, and the freshness poll
 * stops asking GitHub every 5 min about checkouts whose origin is gone (2,360 failed git calls a day on 12 test worlds).
 */
describe("schedule slow-downs", () => {
  it("the indexer's pass runs every 30 s by default; CONSOLE_INDEXER_TICK_MS overrides and reaches the indexer", () => {
    expect(indexerTickMs({})).toBe(30_000);
    expect(indexerTickMs({ CONSOLE_INDEXER_TICK_MS: "10000" })).toBe(10_000);
    expect(indexerTickMs({ CONSOLE_INDEXER_TICK_MS: "5" })).toBe(30_000); // nonsense falls back
    const env = indexerEnv({ dbPath: "/x", reposRoot: "/r" }, 1, { CONSOLE_INDEXER_TICK_MS: "15000" } as NodeJS.ProcessEnv);
    expect(env.CONSOLE_INDEXER_TICK_MS).toBe("15000");
  });

  it("a checkout with no origin is asked again only after a growing wait, up to 6 h; one answer clears it", async () => {
    let t = 0;
    const calls: string[] = [];
    let broken = true;
    const git = async (dir: string, args: string[]) => {
      if (args[0] === "ls-remote") {
        calls.push(dir);
        if (broken && dir === "/gone") throw new Error("fatal: 'origin' does not appear to be a git repository");
        return "abc\trefs/heads/main\n";
      }
      if (args[0] === "rev-parse") return "abc\n";
      return "";
    };
    const logs: string[] = [];
    const f = createFreshness({ git, now: () => t, log: (m) => logs.push(m), headFromFiles: false });
    const poll5 = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await f.poll(["/gone", "/fine"]);
        t += 5 * 60_000;
      }
    };
    await poll5(12 * 24); // a whole day at the console's 5 min poll
    const gone = calls.filter((d) => d === "/gone").length;
    const fine = calls.filter((d) => d === "/fine").length;
    expect(fine).toBe(288); // a real repo is still asked every poll
    expect(gone).toBeLessThanOrEqual(9); // 10, 20, 40 … min, then every 6 h (was 288)
    expect(logs.at(-1)).toMatch(/asked again in 360 min/);
    broken = false;
    t += 6 * 3600_000;
    await f.poll(["/gone"]);
    const before = calls.length;
    t += 5 * 60_000;
    await f.poll(["/gone"]);
    expect(calls.length).toBe(before + 1); // answered once: back on the normal poll
  });
});
