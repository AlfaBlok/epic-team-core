import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HERO_FILE, readTopJourneys } from "../src/book/features.js";

/** The ranked top of the hero journeys, read from the one catalog file. */
const withHero = (body: unknown, fn: (dir: string) => void) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "top-journeys-"));
  try {
    fs.mkdirSync(path.join(dir, path.dirname(HERO_FILE)), { recursive: true });
    fs.writeFileSync(path.join(dir, HERO_FILE), typeof body === "string" ? body : JSON.stringify(body));
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe("the hero journeys top list", () => {
  it("joins each ranked id to its journey, in rank order; unknown ids and missing whys drop", () => {
    const file = {
      top: {
        rankedAt: "2026-11-15",
        journeys: [
          { rank: 2, id: "b", why: "Saves time." },
          { rank: 1, id: "a", why: "Wins work.", belief: "People want it." },
          { rank: 3, id: "ghost", why: "x" },
          { rank: 4, id: "c" },
        ],
      },
      journeys: [
        { id: "a", title: "Say it once.", screen: "https://team.example/", demo: { clip: "http://clips/a.mp4" } },
        { id: "b", title: "One card." },
        { id: "c", title: "No why." },
      ],
    };
    withHero(file, (dir) => {
      const t = readTopJourneys(dir, "Acme/home_repo")!;
      expect(t.rankedAt).toBe("2026-11-15");
      expect(t.journeys).toEqual([
        { rank: 1, id: "a", title: "Say it once.", why: "Wins work.", belief: "People want it.", screen: "https://team.example/", clip: "http://clips/a.mp4" },
        { rank: 2, id: "b", title: "One card.", why: "Saves time." },
      ]);
      expect(t.href).toBe(`https://github.com/Acme/home_repo/blob/main/${HERO_FILE}`);
    });
  });

  it("gives nothing with no top, a broken file or no file", () => {
    withHero({ journeys: [{ id: "a", title: "T" }] }, (dir) => expect(readTopJourneys(dir)).toBeUndefined());
    withHero("{not json", (dir) => expect(readTopJourneys(dir)).toBeUndefined());
    expect(readTopJourneys(os.tmpdir() + "/no-such-top-journeys")).toBeUndefined();
  });

  it("this repo's catalog ranks 5 to 10 journeys", () => {
    const t = readTopJourneys(path.resolve(__dirname, "../../../.."))!;
    expect(t.journeys.length).toBeGreaterThanOrEqual(5);
    expect(t.journeys.length).toBeLessThanOrEqual(10);
    expect(t.journeys.map((j) => j.rank)).toEqual(t.journeys.map((_, i) => i + 1));
  });
});
