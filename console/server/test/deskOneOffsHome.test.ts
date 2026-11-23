import { describe, expect, it } from "vitest";
import { SEED_VERSION, endpointLines } from "../src/desk/desk.js";

// a new one-off with no epic of its own goes to the one-offs repo's root spine.
describe("the desk files a new one-off in the one-offs repo", () => {
  it("names the one-offs repo's root spine, never the home repo's old one-offs spine as the place to file", () => {
    const line = endpointLines("http://console").find((l) => l.startsWith("- One-offs:"));
    expect(line).toBeDefined();
    expect(line).toMatch(/docs\/spines\/root\.md` of [\w.-]+\/one-offs/);
    expect(line).not.toMatch(/else in `docs\/spines\/one-offs\.md`/);
    expect(SEED_VERSION).toBeGreaterThanOrEqual(51);
  });
});
