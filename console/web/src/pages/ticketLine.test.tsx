import { describe, expect, it } from "vitest";
import { plainStatus, ticketLine } from "./Chat";

// Where his words went, in his words (the owner, 22 Nov: "I've read this several times and I don't know what you're
// talking about"): the task's plain name and where it stands, or "Not picked up yet"; never a row code, "ticket" or "request".
describe("the line under his message", () => {
  it("names the task in plain words, or says it is not picked up yet", () => {
    expect(ticketLine(undefined)).toBeUndefined();
    expect(ticketLine([])).toBe("Not picked up yet");
    expect(ticketLine([{ code: "E940-S98", repo: "acme", path: "docs/spines/epic-40.md", status: "review", title: "Inbox counts fixed" }])).toBe("Your words went to: Inbox counts fixed (in your inbox)");
    expect(ticketLine([{ code: "E940-S98", repo: "a", path: "x", status: "ready", title: "Inbox counts fixed" }, { code: "E900-S8", repo: "b", path: "y" }])).toBe("Your words went to: Inbox counts fixed (queued), and 1 more");
    for (const l of [ticketLine([{ code: "E940-S98", repo: "a", path: "x", status: "doing" }])!]) expect(l).not.toMatch(/E\d+-S\d+|ticket|request|row/i);
  });
  it("says where it stands in plain words", () => {
    expect(plainStatus("active")).toBe("being worked on");
    expect(plainStatus("done")).toBe("done");
    expect(plainStatus("blocked")).toBe("waiting on an answer");
    expect(plainStatus(undefined)).toBeUndefined();
  });
});
