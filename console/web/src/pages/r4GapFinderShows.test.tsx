// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api, type Assignment, type Persona, type ReviewItem } from "@/api";
import { SidebarNav } from "@/components/Layout";
import { WaitingForReview } from "@/components/review";
import { fromGapFinder, gapFinderState } from "@/lib/gapFinder";
import { GapFinderPage } from "@/pages/GapFinder";
import { LevelMeter } from "@/voice/NoteProvider";
import { levelOfSamples } from "@/voice/noteEngine";

// the Gap finder sits in the sidebar's folded Tools; this test reads it open.
beforeEach(() => localStorage.setItem("sidebar.tools.open", "1"));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * "what if the gap finder is not installed? … this is a feature that shows up if this
 * guy is installed only" and "a mini widget that basically captured the intensity of my voice, 0 to 100, just to make sure
 * that things were being captured". The Gap finder's menu entry, page and Team home card show only while it is switched on;
 * off, its page says how to switch it on. Every voice note shows a live 0 to 100 level from its own microphone stream.
 */
const GAP: Persona = { id: "pe_gap", name: "Gap finder" } as Persona;
const OTHER: Persona = { id: "pe_dm", name: "Delivery manager" } as Persona;
const as = (personaId: string, enabled: boolean): Assignment => ({ id: `as_${personaId}`, personaId, milestoneId: "ms_root", enabled }) as Assignment;
const team = (personas: Persona[], assignments: Assignment[]) => {
  vi.spyOn(api, "listPersonas").mockResolvedValue(personas);
  vi.spyOn(api, "listAssignments").mockResolvedValue(assignments);
};
const ON = () => team([GAP, OTHER], [as("pe_gap", true), as("pe_dm", true)]);
const OFF = () => team([GAP, OTHER], [as("pe_gap", false), as("pe_dm", true)]);

const page = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/gap-finder" element={<GapFinderPage />} />
        <Route path="/gap-finder/:date" element={<GapFinderPage />} />
      </Routes>
    </MemoryRouter>,
  );

const card = (id: string, from?: { name: string; page?: string }): ReviewItem =>
  ({
    id,
    title: id,
    ref: id,
    repo: "home_repo",
    path: "docs/spines/x.md",
    milestoneId: "ms_root",
    state: "review",
    status: "review",
    createdAt: "2026-11-08",
    liveUrl: "https://team.example.com/",
    verdict: { kind: "card" },
    face: {
      project: { name: "Agent team" },
      goal: { text: "A goal", code: "PLAN-1" },
      tasks: { done: 0, total: 1 },
      title: `Card ${id}`,
      taskGoal: "A task goal",
      delivered: [{ ok: true, text: "Done" }],
      evidence: { url: "https://team.example.com/", label: "Open" },
      tree: [],
      next: [],
      closesGoal: false,
      openInGoal: [],
      ...(from ? { from } : {}),
    },
  }) as ReviewItem;

describe("T79-S1 r4 the Gap finder shows only while it is switched on", () => {
  it("is on when a persona named Gap finder has a switched-on assignment; its settings link goes where to switch it", () => {
    expect(gapFinderState([GAP], [as("pe_gap", true)])).toEqual({ on: true, settings: "/milestones/ms_root?tab=personas" });
    expect(gapFinderState([GAP], [as("pe_gap", false)])).toEqual({ on: false, settings: "/milestones/ms_root?tab=personas" });
    expect(gapFinderState([GAP], [])).toEqual({ on: false, settings: "/personas?edit=pe_gap" });
    expect(gapFinderState([OTHER], [as("pe_dm", true)])).toEqual({ on: false, settings: "/personas" });
    expect(fromGapFinder({ name: "Gap finder" })).toBe(true);
    expect(fromGapFinder({ name: "Prioritizer", page: "/gap-finder" })).toBe(true);
    expect(fromGapFinder({ name: "Prioritizer" })).toBe(false);
    expect(fromGapFinder(undefined)).toBe(false);
  });

  it("off: the page lists no runs and says in one line how to switch it on, linking its settings", async () => {
    OFF();
    const fetch = vi.spyOn(globalThis, "fetch");
    page("/gap-finder");
    const off = await screen.findByTestId("gap-finder-off");
    expect(off.textContent).toContain("The Gap finder is switched off in this team");
    expect(screen.getByTestId("gap-finder-switch-on").getAttribute("href")).toBe("/milestones/ms_root?tab=personas");
    expect(screen.queryByTestId("gap-finder-runs")).toBeNull();
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("runs.json"), expect.anything());
  });

  it("off: a run's page says the same, not installed at all links the Personas page", async () => {
    team([OTHER], [as("pe_dm", true)]);
    page("/gap-finder/2026-11-08");
    await screen.findByTestId("gap-finder-off");
    expect(screen.getByTestId("gap-finder-switch-on").getAttribute("href")).toBe("/personas");
    expect(screen.queryByTestId("gap-finder-frame")).toBeNull();
  });

  it("on: the page lists its runs", async () => {
    ON();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ runs: [{ date: "2026-11-08", title: "Run", page: "2026-11-08.html", row: "T79-G20261108", gaps: 2 }] }), { status: 200 }));
    page("/gap-finder");
    await screen.findByTestId("gap-finder-run");
    expect(screen.queryByTestId("gap-finder-off")).toBeNull();
  });

  it("the main-menu entry shows when it is on and not when it is off", async () => {
    ON();
    const on = render(<MemoryRouter><SidebarNav /></MemoryRouter>);
    expect((await screen.findByTestId("nav-gap-finder")).getAttribute("href")).toBe("/gap-finder");
    on.unmount();
    OFF();
    render(<MemoryRouter><SidebarNav /></MemoryRouter>);
    await screen.findByTestId("nav-messages");
    await waitFor(() => expect(api.listAssignments).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.queryByTestId("nav-gap-finder")).toBeNull();
  });

  it("its Team home card shows when it is on; off, it is on no list while the other cards stay", async () => {
    const items = [card("rv_gap", { name: "Gap finder", page: "/gap-finder" }), card("rv_other")];
    vi.spyOn(api, "listReviewItems").mockImplementation(async (q?: { state?: string }) => (q?.state ? [] : items));
    ON();
    const on = render(<MemoryRouter><WaitingForReview fold="review" /></MemoryRouter>);
    await screen.findByText("Card rv_gap");
    expect(screen.getByText("Card rv_other")).toBeTruthy();
    on.unmount();
    OFF();
    render(<MemoryRouter><WaitingForReview fold="review" /></MemoryRouter>);
    await screen.findByText("Card rv_other");
    await waitFor(() => expect(screen.queryByText("Card rv_gap")).toBeNull());
  });
});

describe("T79-S1 r4 the voice level meter", () => {
  it("turns the microphone's samples into 0 to 100: silence 0, loud speech near the top", () => {
    expect(levelOfSamples(new Uint8Array(512).fill(128))).toBe(0);
    const loud = Uint8Array.from({ length: 512 }, (_, i) => (i % 2 ? 128 + 40 : 128 - 40));
    expect(levelOfSamples(loud)).toBeGreaterThan(0.9);
    const quiet = Uint8Array.from({ length: 512 }, (_, i) => (i % 2 ? 129 : 127));
    expect(levelOfSamples(quiet)).toBeGreaterThan(0);
    expect(levelOfSamples(quiet)).toBeLessThan(0.5);
  });

  it("reads the note's own level many times a second, a bar and its number 0 to 100", () => {
    vi.useFakeTimers();
    let now = 0.6;
    render(<LevelMeter engine={{ readLevel: () => now }} phase="recording" tid="note" />);
    act(() => void vi.advanceTimersByTime(100));
    const m = screen.getByTestId("note-level");
    expect(m.getAttribute("role")).toBe("meter");
    expect(m.getAttribute("aria-valuenow")).toBe("60");
    expect(screen.getByTestId("note-level-num").textContent).toBe("60");
    expect((screen.getByTestId("note-level-bar").firstChild as HTMLElement).style.width).toBe("60%");
    // up at once, down slowly so a word is seen
    now = 0;
    act(() => void vi.advanceTimersByTime(80));
    expect(Number(m.getAttribute("aria-valuenow"))).toBeGreaterThan(40);
    act(() => void vi.advanceTimersByTime(3000));
    expect(m.getAttribute("aria-valuenow")).toBe("0");
  });

  it("reads 0 when paused, and with reduced motion shows the number alone", () => {
    vi.useFakeTimers();
    const mm = vi.fn().mockReturnValue({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined });
    vi.stubGlobal("matchMedia", mm);
    try {
      const r = render(<LevelMeter engine={{ readLevel: () => 0.42 }} phase="recording" tid="note" />);
      act(() => void vi.advanceTimersByTime(600));
      expect(screen.getByTestId("note-level-num").textContent).toBe("42");
      expect(screen.queryByTestId("note-level-bar")).toBeNull();
      r.rerender(<LevelMeter engine={{ readLevel: () => 0.42 }} phase="paused" tid="note" />);
      expect(screen.getByTestId("note-level-num").textContent).toBe("0");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
