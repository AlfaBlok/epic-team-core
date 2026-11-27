import { describe, expect, it } from "vitest";
import { LOGIN_PAGE } from "../src/auth/loginPage.js";

// The sign-in page is one template string: a backslash written in the source is eaten by the template, so a regex in its
// script can break the whole page for everyone (27 Nov, rolled back). Every inline script must still parse.
describe("the sign-in page's script", () => {
  it("parses, and names Epic Leads for a start at /leads", () => {
    const html = LOGIN_PAGE();
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(() => new Function(s)).not.toThrow();
    expect(html).toContain("Start Epic Leads");
  });
});
