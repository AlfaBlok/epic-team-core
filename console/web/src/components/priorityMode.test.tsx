// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api, type PriorityModeView } from "@/api";
import { PriorityModeSection } from "@/components/priorityMode";

/** E906-S95: the Priority mode panel on the Runs page: name one or two tickets, press, see who is parked, Resume. */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const OFF: PriorityModeView = { on: false, parked: [], log: [], focusRunning: [] };
const ON: PriorityModeView = {
  on: true,
  session: { id: "pm_1", rows: ["E906-S95"], by: "Owner", reason: "", startedAt: "2026-11-12T22:00:00Z", assignments: [] },
  parked: [{ sessionId: "pm_1", runId: "run_a", kind: "worker", ticket: "E948-S60", assignmentId: "as_1", rank: 2, state: "asked", parkedAt: "2026-11-12T22:00:00Z" }],
  log: [{ at: "2026-11-12T22:00:00Z", event: "park", runId: "run_a", ticket: "E948-S60", detail: "asked to save state and stop (rank 2)" }],
  focusRunning: ["run_f"],
};

describe("PriorityModeSection", () => {
  it("starts only with one or two row codes, then shows the parked workers and Resume", async () => {
    let state = OFF;
    vi.spyOn(api, "getPriorityMode").mockImplementation(async () => state);
    const start = vi.spyOn(api, "startPriorityMode").mockImplementation(async () => (state = ON));
    const resume = vi.spyOn(api, "resumePriorityMode").mockResolvedValue({ ...ON, on: false });
    render(<PriorityModeSection />);
    const box = await screen.findByTestId("priority-rows");
    const go = screen.getByTestId("priority-start") as HTMLButtonElement;
    fireEvent.change(box, { target: { value: "e906-s95 e948-s60 e901-s1" } });
    expect(go.disabled).toBe(true); // three rows
    fireEvent.change(box, { target: { value: "e906-s95" } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(start).toHaveBeenCalledWith({ rows: ["E906-S95"], reason: undefined }));
    expect((await screen.findByTestId("priority-on")).textContent).toContain("On for E906-S95");
    expect(screen.getByTestId("priority-parked").textContent).toContain("E948-S60 · rank 2 · asked to save and stop");
    fireEvent.click(screen.getByTestId("priority-resume"));
    await waitFor(() => expect(resume).toHaveBeenCalled());
  });
});
