import { describe, expect, it } from "vitest";
import { alreadyAnsweredLine } from "./waiting";

// (the owner 22 Nov 03:35Z: "I press send and it disappears and then it comes back"): a press on a card he had
// already answered says when and what, never a plain second "Answered".
describe("alreadyAnsweredLine", () => {
  it("names the time and his answer", () => {
    const line = alreadyAnsweredLine({ createdAt: "2026-11-22T03:22:18.683Z", text: "Send it", kind: "answer" });
    expect(line).toMatch(/^Already answered at .+: “Send it”, the team has it$/);
  });
  it("an approve reads Approved, a bad date leaves the time out", () => {
    expect(alreadyAnsweredLine({ createdAt: "nope", text: "", kind: "approve" })).toBe("Already answered: Approved, the team has it");
  });
});
