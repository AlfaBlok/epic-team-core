// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { api, type ReviewItem } from "@/api";
import { SnoozingLinesFor } from "@/components/waiting";
import { resetSnoozes, snoozeReview } from "@/lib/snooze";

// a Snooze on a review card whose row had already left review (18 Nov 20:47Z) used to end as a failed press.
// The console now lands it and says why; the card's line says so instead of "Snoozed … until …" or an error.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetSnoozes();
});

const LEFT = "This card had already left review, so there was nothing to snooze.";

describe("Snooze on a card that left review", () => {
  it("the card's line says it had left review, never an error", async () => {
    vi.spyOn(api, "snoozeReviewItem").mockResolvedValue({ moot: true, snoozedUntil: null, message: LEFT } as never);
    render(<SnoozingLinesFor items={[{ id: "rv_1", label: "The test page" }]} />);
    await snoozeReview({ id: "rv_1", ref: "T1-S1", title: "The test page" } as ReviewItem, { hours: 3 });
    await waitFor(() => expect(screen.getByTestId("snoozed-line").textContent).toBe(`The test page: ${LEFT}`));
    expect(screen.queryByText(/Snooze failed/)).toBeNull();
  });
});
