import { describe, expect, it } from "vitest";
import { audioAnswer } from "../src/voice/replyNote.js";

// "link broken" (26 Nov): an iPhone plays audio only when the server answers byte ranges.
describe("the Listen page's sound file answers byte ranges", () => {
  const mp3 = Buffer.from("0123456789");
  it("no range: the whole file, saying ranges are welcome", async () => {
    const r = audioAnswer(mp3, undefined);
    expect(r.status).toBe(200);
    expect(r.headers.get("accept-ranges")).toBe("bytes");
    expect(Buffer.from(await r.arrayBuffer()).toString()).toBe("0123456789");
  });
  it("Safari's first probe bytes=0-1: a 206 with two bytes", async () => {
    const r = audioAnswer(mp3, "bytes=0-1");
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 0-1/10");
    expect(Buffer.from(await r.arrayBuffer()).toString()).toBe("01");
  });
  it("open end and suffix ranges", async () => {
    expect(Buffer.from(await audioAnswer(mp3, "bytes=7-").arrayBuffer()).toString()).toBe("789");
    expect(Buffer.from(await audioAnswer(mp3, "bytes=-2").arrayBuffer()).toString()).toBe("89");
    expect(audioAnswer(mp3, "bytes=3-99").headers.get("content-range")).toBe("bytes 3-9/10");
  });
  it("outside the file: 416", () => {
    expect(audioAnswer(mp3, "bytes=20-").status).toBe(416);
  });
});
