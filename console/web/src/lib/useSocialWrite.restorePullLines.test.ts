import { describe, expect, it } from "vitest";
import type { SocialWriteResult } from "@/api/types";
import { describeWrite, undoOf } from "@/lib/useSocialWrite";

// Undo says where the post went back to, with its slot; a passed slot is said plainly, never a silent hold.
const res = (action: string, info: Record<string, unknown>) =>
  ({ tenantId: "t", repo: "r", data: {} as never, action, id: "P-0048", commit: "abc1234def", push: { state: "pushed" }, files: [], info }) as SocialWriteResult;

describe("T34-S25 restore and pull lines", () => {
  it("restore: back on schedule, slot passed, draft, held", () => {
    expect(describeWrite(res("restore", { status: "scheduled", slot: "2026-11-02T14:00:00Z", slotPassed: false }))).toBe("P-0048 is back on schedule: it goes out at 2026-11-02 14:00 UTC: saved as abc1234 · pushed");
    expect(describeWrite(res("restore", { status: "held", slot: "2026-11-02T14:00:00Z", slotPassed: true }))).toContain("P-0048 is back, but its slot (2026-11-02 14:00 UTC) has passed: post it now or pick a new time");
    expect(describeWrite(res("restore", { status: "draft" }))).toContain("P-0048 is back as a draft");
    expect(describeWrite(res("restore", { status: "held", slotPassed: false }))).toContain("P-0048 is back, waiting for your review");
  });
  it("Undo after Pull only when nothing live was deleted", () => {
    const w = () => undefined;
    expect(undoOf({ action: "posts/P-0048/pull" }, res("pull", { effect: "unschedule" }), w)?.label).toBe("Undo");
    expect(undoOf({ action: "posts/P-0048/pull" }, res("pull", { effect: "delete_live" }), w)).toBeUndefined();
    expect(undoOf({ action: "posts/P-0048/drop" }, res("drop", {}), w)?.label).toBe("Undo");
  });
});
