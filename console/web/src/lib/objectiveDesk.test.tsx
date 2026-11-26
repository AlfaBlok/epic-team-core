// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { forgetDesks, useObjectiveDesk } from "@/lib/objectiveDesk";

/**
 * The owner's screenshot: Buy a new phone's Chat chapter flashed "No team runs this objective yet" and the
 * chat came back a moment later. A slow, pending or failed read is never "no team": only a fresh read that answered
 * with no milestone is.
 */
afterEach(() => {
  cleanup();
  forgetDesks();
});

const never = () => new Promise<{ milestoneId: string | null }>(() => {});

describe("the objective Chat chapter's desk", () => {
  it("opens on the milestone the scorecards read names, with no extra read", () => {
    const read = vi.fn(never);
    const { result } = renderHook(() => useObjectiveDesk("phone", "ms_1", read));
    expect(result.current.desk).toEqual({ state: "ready", id: "ms_1" });
    expect(read).not.toHaveBeenCalled();
  });

  it("a pending read shows it is looking, never no team", () => {
    const { result } = renderHook(() => useObjectiveDesk("phone", undefined, never));
    expect(result.current.desk.state).toBe("checking");
  });

  it("a failed read shows the error with a retry, and the retry opens the chat", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce({ milestoneId: "ms_1" });
    const { result } = renderHook(() => useObjectiveDesk("phone", undefined, read));
    await waitFor(() => expect(result.current.desk).toEqual({ state: "failed", message: "timeout" }));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.desk).toEqual({ state: "ready", id: "ms_1" }));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("says no team only when the fresh read answered with none", async () => {
    const { result } = renderHook(() => useObjectiveDesk("phone", undefined, async () => ({ milestoneId: null })));
    await waitFor(() => expect(result.current.desk.state).toBe("none"));
  });

  it("a scorecards read that drops the milestone keeps the chat while a slow read checks", () => {
    const { result, rerender } = renderHook(({ ms }: { ms?: string }) => useObjectiveDesk("phone", ms, never), { initialProps: { ms: "ms_1" as string | undefined } });
    expect(result.current.desk).toEqual({ state: "ready", id: "ms_1" });
    rerender({ ms: undefined });
    expect(result.current.desk).toEqual({ state: "ready", id: "ms_1" });
  });

  it("a scorecards read that drops the milestone keeps the chat when the fresh read fails", async () => {
    const read = vi.fn().mockRejectedValue(new Error("502"));
    const { result, rerender } = renderHook(({ ms }: { ms?: string }) => useObjectiveDesk("phone", ms, read), { initialProps: { ms: "ms_1" as string | undefined } });
    rerender({ ms: undefined });
    await waitFor(() => expect(read).toHaveBeenCalled());
    await act(async () => {});
    expect(result.current.desk).toEqual({ state: "ready", id: "ms_1" });
  });
});
