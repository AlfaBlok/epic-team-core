import { describe, expect, it } from "vitest";
import { detectBrowser, expiryState, parsePatterns } from "./auth";

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

describe("browser auth helpers", () => {
  it("detects the browser from the user agent", () => {
    expect(detectBrowser(CHROME)).toBe("chrome");
    expect(detectBrowser(CHROME, true)).toBe("brave");
    expect(detectBrowser(CHROME + " Edg/129.0.0.0")).toBe("edge");
    expect(detectBrowser("Mozilla/5.0 (Macintosh; rv:131.0) Gecko/20100101 Firefox/131.0")).toBe("firefox");
    expect(detectBrowser("Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15")).toBe("safari");
  });
  it("parses patterns", () => {
    expect(parsePatterns(" *.Reddit.com, x.com\n*.airbnb.*  x.com ")).toEqual(["*.reddit.com", "x.com", "*.airbnb.*"]);
    expect(parsePatterns("  ")).toEqual([]);
  });
  it("flags expiry under 3 days", () => {
    const now = new Date("2026-10-15T00:00:00Z");
    expect(expiryState(undefined, now)).toBe("none");
    expect(expiryState("2026-10-14T00:00:00Z", now)).toBe("expired");
    expect(expiryState("2026-10-17T00:00:00Z", now)).toBe("soon");
    expect(expiryState("2026-10-20T00:00:00Z", now)).toBe("ok");
  });
});
