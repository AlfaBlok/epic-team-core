import { describe, expect, it } from "vitest";
import { movedFrom, noFreeSlot } from "@/lib/social";

// a missed post the console moved says when it now goes out; a passed held post with nothing free in 3 days asks for a time.
describe("T34-S32 moved and no-free-slot posts", () => {
  it("reads the console's last Moved note", () => {
    expect(movedFrom({ feedback: "Approved 2026-11-08 10:00 UTC; Moved 2026-11-11 03:00 UTC from 2026-11-09 18:00" })).toBe("2026-11-09 18:00");
    expect(movedFrom({ feedback: "Moved 2026-11-10 03:00 UTC from 2026-11-08T18:00; Moved 2026-11-11 03:00 UTC from 2026-11-09T18:00" })).toBe("2026-11-09 18:00");
    expect(movedFrom({ feedback: "Approved 2026-11-08 10:00 UTC" })).toBeUndefined();
    expect(movedFrom({ feedback: undefined })).toBeUndefined();
  });
  it("no free slot: held, slot passed, no nextSlot, not a reply", () => {
    const now = new Date("2026-11-11T03:00:00Z");
    expect(noFreeSlot({ status: "held", slot: "2026-11-09 18:00", kind: "post" }, now)).toBe(true);
    expect(noFreeSlot({ status: "held", slot: "2026-11-09 18:00", kind: "post", nextSlot: "2026-11-11T18:00Z" }, now)).toBe(false);
    expect(noFreeSlot({ status: "held", slot: "2026-11-12 18:00", kind: "post" }, now)).toBe(false);
    expect(noFreeSlot({ status: "held", slot: "2026-11-09 18:00", kind: "outreach" }, now)).toBe(false);
    expect(noFreeSlot({ status: "scheduled", slot: "2026-11-09 18:00", kind: "post" }, now)).toBe(false);
  });
});
