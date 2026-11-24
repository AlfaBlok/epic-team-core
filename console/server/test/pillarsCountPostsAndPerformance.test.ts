import { describe, expect, it } from "vitest";
import { pillarBriefLines, pillarIds, pillarStats, postReading } from "../src/social/pillars.js";

// the owner 24 Nov: "what pillars are we touching on ... so many posts on this, so many posts on that ...
// And how are these posts performing ... What's the feedback loop?"
const lines = [
  { id: "1", benefit: "You show up every day." },
  { id: "2", benefit: "Nothing goes out you didn't want." },
  { id: "3", benefit: "Conversations keep going." },
];

describe("pillars: posts counted per benefit, and how they did", () => {
  it("reads the pillar numbers a Benefit cell names", () => {
    expect(pillarIds("1, 5")).toEqual(["1", "5"]);
    expect(pillarIds(" 2 ")).toEqual(["2"]);
    expect(pillarIds("")).toEqual([]);
    expect(pillarIds(null)).toEqual([]);
  });

  it("reads an X and a Reddit reading", () => {
    expect(postReading({ id: "a", metrics: "8 views, 0 likes, 0 reposts, 0 bookmarks, 1 reply counted by fxtwitter", replies: 0 })).toEqual({ views: 8, likes: 0, replies: 0, read: true });
    expect(postReading({ id: "b", metrics: "score 1, 0 comments at 2026-11-13 15:35 UTC", replies: null })).toEqual({ views: 0, likes: 0, replies: 0, read: true });
    expect(postReading({ id: "c", metrics: "" }).read).toBe(false);
  });

  it("counts top-level posts per pillar, leaves pulled ones and replies out, sums the live readings, and names the posts on none", () => {
    const s = pillarStats(lines, [
      { id: "P-1", kind: "post", status: "measured", benefit: "1", title: "One", link: "https://x.com/a/status/1", metrics: "8 views, 2 likes", replies: 1 },
      { id: "P-2", kind: "post", status: "measured", benefit: "1, 2", title: "Two", metrics: "2 views, 0 likes", replies: 0 },
      { id: "P-3", kind: "post", status: "scheduled", benefit: "2" },
      { id: "P-4", kind: "post", status: "posted", benefit: "", title: "None" },
      { id: "P-5", kind: "post", status: "pulled", benefit: "3" },
      { id: "P-6", kind: "reply", status: "posted", benefit: "3" },
      { id: "P-7", kind: "post", status: "draft", benefit: "9" },
    ]);
    expect(s.total).toBe(5);
    expect(s.offPillar).toEqual({ count: 2, ids: ["P-4", "P-7"] });
    const [one, two, three] = s.pillars;
    expect([one.posts, one.live, one.planned, one.measured, one.views, one.likes, one.replies, one.viewsPerPost]).toEqual([2, 2, 0, 2, 10, 2, 1, 5]);
    expect(one.best).toMatchObject({ id: "P-1", link: "https://x.com/a/status/1", views: 8 });
    expect([two.posts, two.live, two.planned, two.views]).toEqual([2, 1, 1, 2]);
    expect([three.posts, three.viewsPerPost, three.best]).toEqual([0, null, null]);
    expect(one.share + two.share + three.share).toBe(100);
  });

  it("gives the Writer each pillar's numbers and the least used one", () => {
    const out = pillarBriefLines(pillarStats(lines, [{ id: "P-1", kind: "post", status: "scheduled", benefit: "1" }, { id: "P-2", kind: "post", status: "scheduled", benefit: "2" }]));
    expect(out[0]).toMatch(/^Benefits so far/);
    expect(out.some((l) => /^- 3\. 0 posts/.test(l))).toBe(true);
    expect(out.at(-1)).toMatch(/Least used pillar: 3\./);
    expect(pillarBriefLines(pillarStats([], []))).toEqual([]);
  });
});
