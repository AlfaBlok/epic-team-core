import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cachedRunner, limiter, spinesPyRunner } from "../src/adapters/spines.js";

/**
 * the console ran up to 7 `spines.py --json` scans at once on the main server (one per repo), all in the 1.5-core user
 * slice. Now one scan at a time across every repo and runner (FIFO), and the per-repo cache keeps a result 60 s.
 */

describe("T6-S48 limiter", () => {
  it("max 1: never two jobs at once, FIFO, a failed job frees its slot", async () => {
    const limit = limiter(1);
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const job = (name: string, ms: number, fail = false) =>
      limit(async () => {
        active++;
        peak = Math.max(peak, active);
        order.push(name);
        await new Promise((r) => setTimeout(r, ms));
        active--;
        if (fail) throw new Error(name);
        return name;
      });
    const all = await Promise.allSettled([job("a", 30), job("b", 5, true), job("c", 10), job("d", 1)]);
    expect(peak).toBe(1);
    expect(order).toEqual(["a", "b", "c", "d"]);
    expect(all.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled"]);
    expect(await job("e", 1)).toBe("e"); // slot free again
  });
});

describe("T6-S48 spinesPyRunner: one real scan at a time across repos", () => {
  it("seven repos asked at once run one after another (no overlap in the process log)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e6s48-spines-"));
    try {
      fs.mkdirSync(path.join(dir, "scripts"));
      const log = path.join(dir, "log");
      // stands in for spines.py: logs start/end with the repo, sleeps, prints valid JSON
      fs.writeFileSync(
        path.join(dir, "scripts", "spines.py"),
        `echo "start $3" >> ${log}; sleep 0.1; echo "end $3" >> ${log}; echo '{"root":null,"nodes":[],"orphans":[],"mismatches":[]}'\n`,
      );
      const run = cachedRunner(spinesPyRunner(dir, { python: "sh", limit: limiter(1) }));
      const repos = Array.from({ length: 7 }, (_, i) => `/r${i}`);
      const out = await Promise.all(repos.map((r) => run(r)));
      expect(out.every((o) => Array.isArray(o.nodes))).toBe(true);
      const lines = fs.readFileSync(log, "utf8").trim().split("\n");
      expect(lines).toHaveLength(14);
      for (let i = 0; i < lines.length; i += 2) {
        const repo = lines[i].replace(/^start /, "");
        expect(lines[i]).toBe(`start ${repo}`);
        expect(lines[i + 1]).toBe(`end ${repo}`); // the next scan starts only after this one ended
      }
      // a second read inside the 60 s TTL is answered from the cache: no new scan
      await Promise.all(repos.map((r) => run(r)));
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(14);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("cachedRunner keeps a result 60 s by default (was 30 s)", async () => {
    let t = 0;
    let calls = 0;
    const run = cachedRunner(async () => (calls++, { root: null, nodes: [], orphans: [], mismatches: [] }), undefined, () => t);
    await run("/a");
    t = 45_000;
    await run("/a");
    expect(calls).toBe(1);
    t = 61_000;
    await run("/a"); // stale: answers, refreshes in the background
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
  });
});
