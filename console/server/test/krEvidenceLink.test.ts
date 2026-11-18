import { describe, expect, it } from "vitest";
import { krEvidence } from "../src/scorecards.js";
import { objectiveText } from "../src/voice/inbox.js";

// the owner on a live call: "I want to see a link to the evidence for the color".
describe("a key result's evidence link", () => {
  it("keeps a link to open, absolute or a console path", () => {
    expect(krEvidence({ what: "the testers page", url: "https://example.com/testers/" })).toEqual({ what: "the testers page", url: "https://example.com/testers/" });
    expect(krEvidence({ what: "the kit", url: "/sets/x?tab=kit" })).toEqual({ what: "the kit", url: "/sets/x?tab=kit" });
    expect(krEvidence({ url: "https://a.b/" })).toEqual({ what: "the evidence", url: "https://a.b/" });
  });
  it("reads anything without a link as no evidence", () => {
    for (const e of [undefined, null, "https://a.b/", {}, { what: "x" }, { what: "x", url: "javascript:alert(1)" }, { what: "x", url: "docs/a.md" }]) expect(krEvidence(e)).toBeUndefined();
  });
  it("the call says what shows each colour, or that nothing does yet", () => {
    const t = objectiveText(
      { id: "o", name: "O", light: "red", krs: "0 of 2", keyResults: [{ label: "A", state: "red", value: "0", evidence: "the testers page" }, { label: "B", state: "red" }], stands: "not moved today" },
      1,
      1,
    );
    expect(t).toContain("evidence: the testers page");
    expect(t).toContain("evidence: none yet");
  });
});
