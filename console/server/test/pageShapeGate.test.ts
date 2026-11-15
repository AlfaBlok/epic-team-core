import { describe, expect, it } from "vitest";
import { checkLive } from "../src/review/review.js";
import { firstScreen, textWallProblem, TEXT_WALL_PREFIX } from "../src/review/pageShape.js";

/**
 * root L-59: the review gate holds a card whose evidence page on the page host opens with text.
 * The owner: "I just want to see boxes and arrows and diagrams."
 */
const bar = '<div data-page-parent="PLAN-907" style="all:initial"><a href="x">&uarr; Pages</a><span>E907-S3 keeps this page</span></div>';
const prose = (n: number) => `<p>${"word ".repeat(n)}</p>`;
const wall = `<!doctype html><html><head><style>.box{}</style></head><body>${bar}<h1>Report</h1>${prose(120)}${prose(120)}<svg></svg></body></html>`;
const shell = `<!doctype html><html><body data-page-shell>${bar}<header class="ps-head"><h1>Answer</h1></header><section class="ps-diagram"><svg></svg></section>${prose(300)}</body></html>`;
const boxes = `<html><body><h1>Answer</h1><div class="boxes"><div>a</div></div>${prose(300)}</body></html>`;

const host = "host1.example.com";
const serve = (body: string, type = "text/html; charset=utf-8") =>
  (async () => new Response(body, { status: 200, headers: { "content-type": type } })) as unknown as typeof fetch;

describe("page shape: a diagram in the first screen", () => {
  it("flags a page that opens with prose, even with a picture further down", () => {
    expect(textWallProblem(wall)).toMatch(/^the evidence page opens with text/);
  });
  it("passes a shell page with its diagram slot filled, and a boxed summary", () => {
    expect(textWallProblem(shell)).toBeUndefined();
    expect(textWallProblem(boxes)).toBeUndefined();
  });
  it("never counts the page server's parent bar as the page's picture", () => {
    expect(firstScreen(`<body>${bar}<p>hi</p></body>`)).not.toContain("data-page-parent");
    expect(textWallProblem(`<body>${bar}${prose(200)}</body>`)).toBeDefined();
  });
  it("checkLive fails a text-wall page on a page host only", async () => {
    const r = await checkLive(`http://${host}:9300/`, undefined, { fetch: serve(wall), pageHosts: () => [host] });
    expect(r.ok).toBe(false);
    expect(r.error?.startsWith(TEXT_WALL_PREFIX)).toBe(true);
    expect((await checkLive(`http://${host}:9300/`, undefined, { fetch: serve(shell), pageHosts: () => [host] })).ok).toBe(true);
    // a product site or the console is not judged here
    expect((await checkLive("https://notes.example.com/", undefined, { fetch: serve(wall), pageHosts: () => [host] })).ok).toBe(true);
    // a video or image on the page host is not HTML
    expect((await checkLive(`http://${host}:9300/clip.mp4`, undefined, { fetch: serve("x", "video/mp4"), pageHosts: () => [host] })).ok).toBe(true);
    // no page list: no page check
    expect((await checkLive(`http://${host}:9300/`, undefined, { fetch: serve(wall) })).ok).toBe(true);
  });
});
