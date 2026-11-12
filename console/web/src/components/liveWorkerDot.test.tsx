// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type Milestone, type MilestoneStatusView } from "@/api";
import { MilestoneStrip, StateWord } from "@/components/status";
import { HeaderMarks } from "@/components/mark";
import { SidebarNav } from "@/components/Layout";

/**
 * Working with a live worker ("1 worker running") showed a grey dot in the sidebar, the FLOW
 * chip and the "Working · worker … started" strip. Now all three read the server's `flow.live` (workers T3 confirms
 * live, the Activity header's rule): green and pulsing when > 0 (static under prefers-reduced-motion), grey otherwise.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const NOW = Date.parse("2026-11-02T05:00:00Z");
const working = (live?: number, id = "ms_1"): MilestoneStatusView => ({
  milestoneId: id,
  outcome: { word: "not_yet", source: "derived" },
  flow: {
    word: "working",
    reason: "Delivery Manager is running",
    run: { id: "run_w", assignmentId: "as_1", startedAt: "2026-11-02T04:29:00Z", parentRunId: "run_p", summary: "E9-2f worker" },
    ...(live ? { live } : {}),
  },
  items: [],
  needsYou: 0,
  reasons: [],
});
const dot = (el: Element) => el.querySelector('[data-testid="state-dot"]')!.className;
const isGreenPulse = (cls: string) => cls.includes("bg-emerald-500") && cls.includes("animate-pulse") && cls.includes("motion-reduce:animate-none");
const isGreyStill = (cls: string) => cls.includes("bg-zinc-500") && !cls.includes("animate-pulse") && !cls.includes("emerald");

describe("T6-S51 live-worker dot", () => {
  it("StateWord: Working + live → green pulsing (reduced motion: static), title says how many; no live → grey, still", () => {
    render(<StateWord word="working" live={1} />);
    const w = screen.getByTestId("state-word");
    expect(isGreenPulse(dot(w))).toBe(true);
    expect(w.getAttribute("data-live")).toBe("1");
    expect(w.getAttribute("title")).toBe("1 worker running");
    cleanup();
    render(<StateWord word="working" />);
    expect(isGreyStill(dot(screen.getByTestId("state-word")))).toBe(true);
    cleanup();
    // live only colours Working: a stale count on another word changes nothing
    render(<StateWord word="monitoring" live={2} />);
    expect(isGreyStill(dot(screen.getByTestId("state-word")))).toBe(true); // only a live worker is green
  });

  it("detail page: the FLOW chip and the 'Working · worker … started' strip are green together, grey together", () => {
    const m = { id: "ms_1", title: "Memo", repo: "acme-ai/memo", path: "docs/x.md" } as Milestone;
    for (const [live, green] of [[1, true], [undefined, false]] as const) {
      render(
        <MemoryRouter>
          <HeaderMarks m={m} status={working(live)} treeHref="?tab=tree" />
          <MilestoneStrip status={working(live)} now={NOW} timeZone="UTC" />
        </MemoryRouter>,
      );
      const chip = dot(screen.getByTestId("flow-badge"));
      const strip = screen.getByTestId("state-strip");
      expect(strip.textContent).toContain("worker E9-2f started 31 min ago");
      expect(isGreenPulse(chip), `chip live=${live}`).toBe(green);
      expect(isGreenPulse(dot(strip)), `strip live=${live}`).toBe(green);
      expect(isGreyStill(chip)).toBe(!green);
      cleanup();
    }
  });

  it("sidebar FOCUS entry: green pulsing for the milestone with a live worker, grey for the one without", async () => {
    const a = await api.createMilestone({ title: "Live epic", repo: "Acme/home_repo", path: "docs/spines/m6-team-unattended.md", owner: "Sam" });
    const b = await api.createMilestone({ title: "Guess epic", repo: "Acme/home_repo", path: "docs/spines/root.md", owner: "Sam" });
    vi.spyOn(api, "listStatus").mockResolvedValue({ milestones: [working(1, a.id), working(undefined, b.id)], items: [], needsYou: 0, at: new Date(NOW).toISOString() });
    render(
      <MemoryRouter>
        <SidebarNav />
      </MemoryRouter>,
    );
    // the sidebar says one word per project, "running" in green while a worker is live.
    const word = async (t: string) => (await screen.findByText(t)).closest("a")!.querySelector('[data-testid="sidebar-state"]')!;
    await vi.waitFor(async () => expect((await word("Live epic")).getAttribute("data-state")).toBe("running"));
    expect((await word("Live epic")).className).toContain("emerald");
    expect((await word("Guess epic")).getAttribute("data-state")).toBe("idle");
    expect((await word("Guess epic")).className).not.toContain("emerald");
  });
});
