import { describe, expect, it } from "vitest";
import { krFrom } from "../src/scorecards.js";

/** The owner (vn_243861c3, 22 Nov 21:34Z: "another key result that I don't know where it's coming from"): every key
 * result says where it came from, his words, when and the link to the note, read from its set file's `targetFrom`. */
describe("krFrom", () => {
  it("reads his quoted words, the time and the note's link", () => {
    expect(krFrom('Sam vn_68cda1fe, 22 Nov 09:28Z: "100% of the my logins are on the multi-tenant. That\'s what I want to see"', "https://github.com/x/Log/2026-11-22.md#^e-543e5d")).toEqual({
      said: "100% of the my logins are on the multi-tenant. That's what I want to see",
      when: "22 Nov 09:28Z",
      url: "https://github.com/x/Log/2026-11-22.md#^e-543e5d",
    });
  });
  it("keeps the whole text when nothing is quoted, and drops a link that is not a web address", () => {
    expect(krFrom("Sam started E907-S3 on 22 Nov", "javascript:alert(1)")).toEqual({ said: "Sam started E907-S3 on 22 Nov", when: "22 Nov" });
  });
  it("says nothing when the file names no source", () => {
    expect(krFrom(undefined, undefined)).toBeUndefined();
    expect(krFrom("  ", "https://x.example/")).toBeUndefined();
  });
});
