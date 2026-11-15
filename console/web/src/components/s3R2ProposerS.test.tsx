// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type ReviewItem } from "@/api";
import type { CardFace } from "@/api/review-types";
import { WaitingForReview, cardButtons } from "@/components/review";
import { BackToHome } from "@/pages/EpicDeck";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * the Input reviewer's and the
 * Prioritizer's proposals are switches on their one card on Team home; each opens its goal in the console, and the goal
 * leads back to Team home.
 */
const FACE: CardFace = {
  project: { name: "Agent team", url: "https://team.example.com/" },
  goal: { text: "We measure every week how well your voice notes become the right goals", code: "PLAN-76" },
  tasks: { done: 1, total: 4 },
  title: "Input reviewer: I checked your newest voice note and proposed one new goal.",
  taskGoal: "Each day a teammate checks that your newest voice notes became goals.",
  delivered: [{ ok: true, text: "I read your voice notes up to 8 Nov." }, { ok: true, text: "One request has no goal anywhere." }],
  evidence: { url: "https://team.example.com/", label: "Open your Team home" },
  tree: [{ mark: "this", text: "This task: the input reviewer" }],
  next: [{ title: "Keep the decks alive with what you say", why: "Nothing in the team does it yet.", recommend: "start", target: "PLAN-81", kind: "new", also: ["Prioritizer"], targetName: "What you say lands in the deck within a day" }],
  closesGoal: false,
  openInGoal: [],
  from: { name: "Input reviewer", url: "/milestones/ms_1?tab=personas", line: "It checks that each new voice note became goals.", runs: "Daily at 13:30 Madrid on the home_repo root." },
};
const ITEM: ReviewItem = {
  id: "rv_i",
  title: "Input reviewer",
  liveUrl: FACE.evidence.url,
  ref: "T76-S2",
  repo: "home_repo",
  path: "docs/spines/epic-76-goal-graph-quality.md",
  milestoneId: "ms_1",
  state: "review",
  status: "review",
  liveStatus: 200,
  checkedAt: "2026-11-08T12:00:00Z",
  createdAt: "2026-11-08",
  verdict: { kind: "card" },
  face: FACE,
};

describe("T76-S2/S3 r2 a proposer's card", () => {
  it("shows the proposed goal as a switch that opens it in the console and names the other persona", async () => {
    vi.spyOn(api, "listReviewItems").mockImplementation(async (q?: { state?: string }) => (q?.state ? [] : [ITEM]));
    render(<MemoryRouter><WaitingForReview fold="review" /></MemoryRouter>);
    const c = await screen.findByTestId("review-card");
    // the From band is under More (the heading opens it)
    fireEvent.click(within(c).getByTestId("review-title"));
    expect(within(c).getByTestId("review-from").textContent).toContain("From the Input reviewer");
    expect(within(c).getByTestId("review-next").textContent).toContain("New goals it proposes, each on or off");
    expect(within(c).getByTestId("review-switch-also").textContent).toBe("Also proposed by the Prioritizer");
    expect(within(c).getByTestId("review-switch-goal").textContent).toContain("Starts as a new goal: What you say lands in the deck within a day.");
    expect(within(c).getByTestId("review-switch-open").getAttribute("href")).toBe("/deck/home_repo/PLAN-81?from=home");
    expect(c.textContent).not.toMatch(/approv/i);
  });

  it("one button sends the choice and says a Delivery Manager starts what is on", async () => {
    vi.spyOn(api, "listReviewItems").mockImplementation(async (q?: { state?: string }) => (q?.state ? [] : [ITEM]));
    const complete = vi.spyOn(api, "completeReviewItem").mockResolvedValue({ ...ITEM, state: "approved" });
    render(<MemoryRouter><WaitingForReview fold="review" /></MemoryRouter>);
    const c = await screen.findByTestId("review-card");
    // E979-G20261113 iteration 2 (vn_78c963b6): the button names what it does, "Start <n>"; the details are its title
    const send = within(c).getByTestId("review-complete");
    expect(send.textContent).toBe("Start 1");
    expect(send.getAttribute("title")).toBe("The goal you switched on starts, and a Delivery Manager is sent to it.");
    fireEvent.click(send);
    await waitFor(() => expect(complete).toHaveBeenCalledWith("rv_i", { start: [0], park: [], why: [""] }));
  });

  it("off says the goal is parked, not dropped", () => {
    expect(cardButtons(FACE, [false])[0].sub).toBe("The one switched off is parked with your reason and not suggested again.");
  });

  it("the goal opened from the card leads back to Team home", () => {
    render(<MemoryRouter><BackToHome draft /></MemoryRouter>);
    expect(screen.getByTestId("deck-back-home-link").getAttribute("href")).toBe("/");
    expect(screen.getByTestId("deck-back-home").textContent).toContain("This goal is a proposal. Switch it on or off on its card there");
  });
});
