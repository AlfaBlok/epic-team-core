import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createXStatsReader, parseXStatsDay, X_STATS_DIR } from "../src/xStats.js";

/** X stats of the team's accounts, one file a day in the home repo. */

const day = (date: string, likes: number, views: number) => ({
  date, readAt: `${date}T00:15:00Z`, windowDays: 7, since: "2026-11-06T00:15:00Z",
  accounts: [
    { handle: "@Alpha", product: "Alpha", state: "read", listedBy: "fxtwitter timeline", followers: 5, postsAllTime: 9, totals: { likes, replies: 1, reposts: 0, quotes: 0, views },
      posts: [{ id: "1", url: "https://x.com/Alpha/status/1", at: `${date}T00:00:00Z`, kind: "post", text: "hi", likes, replies: 1, reposts: 0, quotes: 0, views, source: "fxtwitter" }, { bad: 1 }], notes: [], readAt: `${date}T00:15:00Z` },
    { handle: "@Beta", product: "Beta", state: "not read", totals: {}, posts: [], notes: ["held"] },
    { nope: true },
  ],
});

describe("x stats", () => {
  it("parses a day and drops broken entries", () => {
    const d = parseXStatsDay(JSON.stringify(day("2026-11-13", 2, 40)));
    expect(d.accounts.map((a) => a.handle)).toEqual(["@Alpha", "@Beta"]);
    expect(d.accounts[0].posts).toHaveLength(1);
    expect(d.accounts[0].totals.views).toBe(40);
    expect(d.accounts[1].totals).toEqual({ likes: 0, replies: 0, reposts: 0, quotes: 0, views: 0 });
  });

  it("reads the home repo's days: the newest by default, an asked one, every day's totals", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "x-stats-"));
    const repo = path.join(root, "home_repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    const r = createXStatsReader({ reposRoot: root, home: "home_repo" });
    expect(r.get()).toEqual({ dates: [], day: null, history: [] });
    fs.mkdirSync(path.join(repo, X_STATS_DIR), { recursive: true });
    fs.writeFileSync(path.join(repo, X_STATS_DIR, "2026-11-12.json"), JSON.stringify(day("2026-11-12", 1, 10)));
    fs.writeFileSync(path.join(repo, X_STATS_DIR, "2026-11-13.json"), JSON.stringify(day("2026-11-13", 2, 40)));
    fs.writeFileSync(path.join(repo, X_STATS_DIR, "notes.json"), "{}");
    const b = r.get();
    expect(b.dates).toEqual(["2026-11-12", "2026-11-13"]);
    expect(b.day?.date).toBe("2026-11-13");
    expect(b.history.map((h) => h.accounts["@Alpha"].views)).toEqual([10, 40]);
    expect(r.get("2026-11-12").day?.accounts[0].totals.likes).toBe(1);
    expect(r.get("../etc").day?.date).toBe("2026-11-13");
  });
});
