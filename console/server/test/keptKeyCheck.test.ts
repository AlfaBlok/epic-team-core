// GET /api/connects answers from the last known key check at once and refreshes it after the answer.
import { describe, expect, it } from "vitest";
import { keptKeyCheck, type KeySeen } from "../src/auth/oauth.js";

describe("keptKeyCheck", () => {
  it("reads once, answers a known key at once, refreshes a minute-old one after the answer, reads again after a clear", async () => {
    let t = 0;
    let reads = 0;
    let has = false;
    let release: (() => void) | undefined;
    const seen = new Map<string, KeySeen>();
    const check = keptKeyCheck(seen, async () => {
      reads++;
      if (reads === 2) await new Promise<void>((r) => (release = r)); // the refresh is slow, like a busy sudo
      return has;
    }, () => t);
    expect(await check("K")).toBe(false);
    expect(reads).toBe(1);
    has = true;
    t = 30_000;
    expect(await check("K")).toBe(false); // known and fresh: no read
    expect(reads).toBe(1);
    t = 61_000;
    expect(await check("K")).toBe(false); // stale: the old answer at once, one refresh starts
    expect(await check("K")).toBe(false); // the refresh still runs: no second one
    expect(reads).toBe(2);
    release!();
    await new Promise((r) => setTimeout(r, 0));
    expect(await check("K")).toBe(true); // the refreshed answer
    seen.clear(); // a connect landed
    expect(await check("K")).toBe(true);
    expect(reads).toBe(3);
  });
});
