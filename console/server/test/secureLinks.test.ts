import { afterEach, describe, expect, it } from "vitest";
import { secureCopyOf, secureDeep, secureLinksIn, setSecurePages } from "../src/steps/secureLinks.js";

// links to a steps page open its secure copy, so Voice records at the first press.

const O = "https://team.example.org";
afterEach(() => setSecurePages(undefined));

describe("secure copy links", () => {
  it("a registered page, a page beside it on the same host and port, and nothing else", () => {
    setSecurePages(() => [
      { id: "sp_aaaaaaaa", url: "http://host1.example.com:9319/", title: "Deck feedback" },
      { id: "sp_bbbbbbbb", url: "http://host1.example.com:9196/t/E907-S7/", title: "Mac ticket" },
      { id: "sp_cccccccc", url: "http://host1.example.com:9196/t/E907-S8/", title: "Older ticket" },
      { id: "sp_dddddddd", url: "http://host1.example.com:9500/", title: "TEST page" },
    ]);
    expect(secureCopyOf("http://host1.example.com:9319/", O)).toBe(`${O}/steps/view/sp_aaaaaaaa/`);
    expect(secureCopyOf("http://host1.example.com:9319/shots/a.webp?x=1#top", O)).toBe(`${O}/steps/view/sp_aaaaaaaa/shots/a.webp?x=1#top`);
    // its own registration first, else the newest on the origin
    expect(secureCopyOf("http://host1.example.com:9196/t/E907-S8", O)).toBe(`${O}/steps/view/sp_cccccccc/t/E907-S8`);
    expect(secureCopyOf("http://host1.example.com:9196/mac/", O)).toBe(`${O}/steps/view/sp_bbbbbbbb/mac/`);
    expect(secureCopyOf("http://host1.example.com:9400/", O)).toBe("http://host1.example.com:9400/");
    expect(secureCopyOf("http://host1.example.com:9500/", O)).toBe("http://host1.example.com:9500/");
    // a test console (plain http) keeps the plain links
    expect(secureCopyOf("http://host1.example.com:9319/", "http://localhost:8750")).toBe("http://host1.example.com:9319/");
  });

  it("inside text and a card, keeping a sentence's full stop", () => {
    setSecurePages(() => [{ id: "sp_aaaaaaaa", url: "http://h:9319/" }]);
    expect(secureLinksIn("see [the deck](http://h:9319/) and http://h:9319/x.", O)).toBe(`see [the deck](${O}/steps/view/sp_aaaaaaaa/) and ${O}/steps/view/sp_aaaaaaaa/x.`);
    const face = { evidence: { url: "http://h:9319/", label: "deck" }, delivered: [{ ok: true, text: "✓ live at http://h:9319/" }], n: 3 };
    expect(secureDeep(face, O)).toEqual({ evidence: { url: `${O}/steps/view/sp_aaaaaaaa/`, label: "deck" }, delivered: [{ ok: true, text: `✓ live at ${O}/steps/view/sp_aaaaaaaa/` }], n: 3 });
  });
});
