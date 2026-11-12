// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api, type RedLine } from "@/api";
import { OwnerPriorityTag, RedLineBand } from "@/components/ownerPriority";

// one red band on
// top of the Team home with the line, and every item on it marked in red ("On the red line"), its why opening with the line.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const line: RedLine = {
  sentence: "Get customer one paying on EpicTeam this week.",
  why: "You asked for it three times since Sunday.",
  state: "proposed",
  ask: "T48-A6",
  at: "2026-11-10T07:00:00Z",
  items: [
    { repo: "home_repo", ref: "T88-S3" },
    { repo: "home_repo", ref: "T97-A2" },
    { repo: "home_repo", ref: "T81-A6" },
  ],
};

describe("T48-S35 the red marker", () => {
  it("an item on the line says so in red; a tap opens with the line, then its why", () => {
    render(<OwnerPriorityTag p={{ level: "low", why: "Quiet for a week.", ref: "T88-S3", redLine: { sentence: line.sentence, state: "proposed", at: "2026-11-10" } }} />);
    const tag = screen.getByTestId("owner-priority");
    expect(tag.textContent).toBe("On the red line");
    expect(tag.hasAttribute("data-red-line")).toBe(true);
    expect(tag.className).not.toContain("bg-red-600"); // the red line is a word, no red pill
    fireEvent.click(tag);
    expect(screen.getByTestId("owner-priority-red-line").textContent).toBe(`Red line: ${line.sentence}`);
    expect(screen.getByTestId("owner-priority-why").textContent).toContain("Quiet for a week.");
  });
  it("an item off the line keeps its level", () => {
    render(<OwnerPriorityTag p={{ level: "high", why: "x", ref: "T1-S1" }} />);
    expect(screen.getByTestId("owner-priority").textContent).toBe("High priority");
    expect(screen.getByTestId("owner-priority").hasAttribute("data-red-line")).toBe(false);
  });
});

describe("T48-S35 the band on top", () => {
  it("shows the sentence, where it stands with him and how many items lead the lists", async () => {
    vi.spyOn(api, "redLine").mockResolvedValue({ redLine: line });
    render(<RedLineBand />);
    // a slim row (the count of items on it); the sentence is its hover, a proposed line says so on the row.
    // Iteration 2: a tap unfolds only its cards (slimRow.test.tsx).
    await waitFor(() => expect(screen.getByTestId("red-line-count").textContent).toBe("3"));
    expect(screen.getByTestId("red-line-row").getAttribute("title")).toBe(line.sentence);
    expect(screen.getByTestId("red-line-row").textContent).toContain("proposed");
  });
  it("nothing when no line was written", async () => {
    const spy = vi.spyOn(api, "redLine").mockResolvedValue({ redLine: null });
    const { container } = render(<RedLineBand />);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });
});
