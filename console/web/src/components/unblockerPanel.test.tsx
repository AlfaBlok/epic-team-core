// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api, type UnblockerCounts, type UnblockerStats } from "@/api";
import { formatWait, UnblockerPanel } from "@/components/unblockerStats";
import { createMockClient } from "@/api/mock";
import { seed } from "@/api/seed";
import { SKINS, SkinProvider } from "@/lib/skin";

/** the Runs page Unblocker panel: numbers per milestone and window. */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const H = 3600_000;
const counts = (over: Partial<UnblockerCounts> = {}): UnblockerCounts => ({
  wakesFired: 2, wakesSkipped: 5, newAsks: 2, assessed: 3, answered: 1, left: 1, split: 1, reversed: 0,
  askToVerdict: { count: 2, medianMs: 5 * H + 10 * 60_000, worstMs: 11 * H, worstCode: "T0-A2", estimated: 0, waiting: 1, oldestWaitingMs: 30 * 60_000, oldestWaitingCode: "T0-A3" },
  ...over,
});
const stats = (window: UnblockerStats["window"]): UnblockerStats => ({
  window,
  from: null,
  to: "2026-10-26T12:00:00Z",
  milestones: [
    { milestoneId: "m1", milestoneTitle: "whatgpt E0", ...counts({ score: { count: 1, median: 80, threshold: 70 } }) },
    { milestoneId: "m2", milestoneTitle: "infra PLAN-2", ...counts({ reversed: 1, askToVerdict: { count: 0, medianMs: null, worstMs: null, estimated: 0, waiting: 0, oldestWaitingMs: null } }) },
  ],
  total: counts({ wakesFired: 4, reversed: 1 }),
});

describe("T8-S27 Unblocker panel", () => {
  it("lists each milestone and the total; switches window; score/threshold only when present", async () => {
    const spy = vi.spyOn(api, "getUnblockerStats").mockImplementation(async (q) => stats(q.window));
    render(<UnblockerPanel />);
    const rows = await screen.findAllByTestId("ub-row");
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("whatgpt E0");
    expect(rows[0].textContent).toContain("2 / 5"); // fired / skipped
    expect(rows[0].textContent).toContain("5 h 10 min / 11 h (T0-A2)");
    expect(rows[0].textContent).toContain("1 waiting");
    expect(rows[0].querySelector("[data-testid=ub-score]")!.textContent).toBe("80 / 70");
    expect(rows[1].querySelector("[data-testid=ub-score]")!.textContent).toBe("–");
    expect(rows[1].querySelector("[data-testid=ub-timing]")!.textContent).toBe("–");
    expect(rows[2].textContent).toContain("All projects");
    expect(spy).toHaveBeenLastCalledWith({ window: "24h" });
    fireEvent.click(screen.getByText("Last 7 days"));
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith({ window: "7d" }));
    fireEvent.click(screen.getByText("All"));
    await waitFor(() => expect(spy).toHaveBeenLastCalledWith({ window: "all" }));
  });

  it("answered includes split (as T8-S7 counts it); nothing in the social skin", async () => {
    vi.spyOn(api, "getUnblockerStats").mockImplementation(async (q) => stats(q.window));
    render(<UnblockerPanel />);
    const rows = await screen.findAllByTestId("ub-row");
    const cells = [...rows[0].querySelectorAll("td")].map((td) => td.textContent);
    expect(cells.slice(1, 7)).toEqual(["2 / 5", "2", "3", "2", "1", "0"]);
    cleanup();
    const { container } = render(
      <SkinProvider skin={SKINS.social}>
        <UnblockerPanel />
      </SkinProvider>,
    );
    expect(container.textContent).toBe("");
  });

  it("formatWait and the mock client", async () => {
    expect(formatWait(null)).toBe("–");
    expect(formatWait(40_000)).toBe("<1 min");
    expect(formatWait(26 * H)).toBe("1 day 2 h");
    const mock = createMockClient({ db: seed(new Date()) });
    const s = await mock.getUnblockerStats({ window: "all" });
    expect(s.window).toBe("all");
    expect(s.total.wakesFired + s.total.wakesSkipped).toBeGreaterThanOrEqual(0);
  });
});
