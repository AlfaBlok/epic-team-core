import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createPostStats, loadPostStatsDay } from "../src/postStats.js";

/** One row per post per day, loaded from the day files; the campaign manager and the pictures query it. */

const day = (date: string, views: number, likes: number) => ({
  date, readAt: `${date}T01:20:00Z`,
  accounts: [
    { handle: "@Alpha", platform: "x", product: "Alpha", readAt: `${date}T01:20:00Z`, posts: [
      { id: "300", url: "https://x.example.com/Alpha/status/300", at: "2026-11-17T20:00:00Z", kind: "post", likes, replies: 1, reposts: 0, views,
        source: "public read", campaign: "alpha-campaign", product: "Alpha", ledgerRow: "E907-S1", message: "3", dms: null, notMeasured: { dms: "a DM is not tied to one post" } },
      { id: "301", url: "https://x.example.com/Alpha/status/301", at: "2026-11-17T21:00:00Z", kind: "post", likes: 0, replies: 0, reposts: 0, views: null,
        source: "public read", campaign: "alpha-campaign", product: "Alpha", ledgerRow: "E907-S2", message: "3", notMeasured: { views: "the public read gave no number today" } },
      { id: "302", url: "https://x.example.com/Alpha/status/302", kind: "reply", likes: 1, replies: 0, views: 5, source: "public read" },
      { nope: 1 },
    ] },
    { handle: "u/sam", platform: "forum", product: "Alpha", posts: [
      { id: "f1", url: "https://forum.example.com/r/mcp/comments/f1/", at: "2026-11-17T10:00:00Z", likes: 4, replies: 2, views: null,
        campaign: "alpha-campaign", product: "Alpha", ledgerRow: "E907-S3", message: "1", notMeasured: { views: "Forum shows views only to the author" } },
    ] },
  ],
  missing: [{ platform: "pro", id: "urn:1", url: "https://pro.example.com/feed/update/urn:1/", campaign: "alpha-campaign", product: "Alpha",
    ledgerRow: "E907-S4", message: "1", date: "2026-11-17", why: "Pro shows a page post's numbers only signed in" }],
  channels: [
    { campaign: "alpha-campaign", product: "Alpha", channel: "forum", livePosts: 1, measured: 1, dms: 2, dmsWhy: null, notMeasured: null },
    { campaign: "alpha-campaign", product: "Alpha", channel: "pro", livePosts: 1, measured: 0, dms: null, dmsWhy: "no chat", notMeasured: "Pro …" },
    { campaign: "alpha-campaign", product: "Alpha", channel: "x", livePosts: 2, measured: 2, dms: 1, dmsNew: 1, dmLinks: ["https://x.example.com/messages/1-2", 7],
      dmSeen: ["https://x.example.com/messages/1-2"], dmsWhy: null, dmsSource: "social_dms browser: 1 conversations listed", notMeasured: null },
  ],
});

function home() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "post-stats-"));
  const dir = path.join(root, "x-stats");
  fs.mkdirSync(dir);
  return { dir, db: new Database(":memory:") };
}

describe("post stats store", () => {
  it("loads a day: measured posts, unmeasured live posts with why, never a 0 for unknown", () => {
    const { db } = home();
    const s = createPostStats({ db, reposRoot: "/nowhere", dir: () => null });
    expect(s.query()).toMatchObject({ dates: [], date: null, posts: [] });
    expect(loadPostStatsDay(db, JSON.stringify(day("2026-11-18", 40, 2)))).toBe(5);
    const li = db.prepare("SELECT * FROM post_stats WHERE channel = 'pro'").get() as Record<string, unknown>;
    expect(li.measured).toBe(0);
    expect(li.views).toBeNull();
    expect(JSON.parse(String(li.not_measured)).all).toMatch(/signed in/);
    const r301 = db.prepare("SELECT views FROM post_stats WHERE post_id = '301'").get() as { views: number | null };
    expect(r301.views).toBeNull();
  });

  it("answers per message with what each gained since the day before, and filters", () => {
    const { dir, db } = home();
    fs.writeFileSync(path.join(dir, "2026-11-17.json"), JSON.stringify(day("2026-11-17", 10, 1)));
    fs.writeFileSync(path.join(dir, "2026-11-18.json"), JSON.stringify(day("2026-11-18", 40, 2)));
    fs.writeFileSync(path.join(dir, "notes.json"), "{}");
    const s = createPostStats({ db, reposRoot: "/nowhere", dir: () => dir });
    const b = s.query({ product: "alpha" });
    expect(b.dates).toEqual(["2026-11-17", "2026-11-18"]);
    expect(b.date).toBe("2026-11-18");
    const m3 = b.groups.find((g) => g.key === "M3")!;
    expect(m3).toMatchObject({ posts: 2, measured: 2, views: 40, likes: 2, gained: { views: 30, likes: 1, replies: 0 } });
    const m1 = b.groups.find((g) => g.key === "M1")!;
    expect(m1).toMatchObject({ posts: 2, measured: 1, views: null, likes: 4 });
    expect(b.groups.find((g) => g.key === "none")).toMatchObject({ posts: 1, views: 5 });
    expect(b.channels.find((c) => c.channel === "forum")?.dms).toBe(2);
    // an inbox read gives the day's DMs, how many are new since the day before and their links, never words
    expect(b.channels.find((c) => c.channel === "x")).toMatchObject({ dms: 1, dmsNew: 1, dmLinks: ["https://x.example.com/messages/1-2"] });
    expect(b.channels.find((c) => c.channel === "pro")).toMatchObject({ dms: null, dmsNew: null, dmLinks: [], dmsWhy: "no chat" });
    const byCh = s.query({ group: "message-channel", message: "1" });
    expect(byCh.groups.map((g) => g.key)).toEqual(["M1|forum", "M1|pro"]);
    expect(s.query({ date: "2026-11-17", channel: "x" }).posts.map((p) => p.postId).sort()).toEqual(["300", "301", "302"]);
    expect(s.query({ message: "none" }).posts.map((p) => p.postId)).toEqual(["302"]);
    expect(s.query({ date: "../etc" }).date).toBe("2026-11-18");
    // a changed file is loaded again; an unchanged one is not
    fs.writeFileSync(path.join(dir, "2026-11-18.json"), JSON.stringify(day("2026-11-18", 90, 2)));
    fs.utimesSync(path.join(dir, "2026-11-18.json"), new Date(), new Date(Date.now() + 5000));
    expect(s.query({ group: "post", channel: "x" }).groups.find((g) => g.key === "x|300")?.views).toBe(90);
  });
});
