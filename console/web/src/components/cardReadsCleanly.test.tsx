// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type ReviewItem } from "@/api";
import type { CardFace } from "@/api/review-types";
import { decisionChoices, joinSteps, WaitingForReview } from "@/components/review";
import { resetReviewGone } from "@/lib/inbox";

// (the owner 2026-11-14, vn_e751eeeb): "the ticket begins with saying something like, objective 2, five
// testers using the app, 0 of 5 ... it has nothing to do with the ticket itself. So why are you wasting my attention?"
// A review card opens with what was made (its title), then where it came from, then what was delivered, then the decision.
// It never shows an objective's score, and the steps a decision moves read as plain sentences, one a line.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetReviewGone();
});

const FACE: CardFace = {
  project: { name: "the app", url: "https://social.example.com/" },
  goal: { text: "Five testers use the app", code: "EPIC-907" },
  tasks: { done: 3, total: 9 },
  title: "A proven B2B playbook was set beside our tester hunt, with five changes that could bring testers.",
  taskGoal: "Find what a proven playbook does that our hunt for testers does not.",
  delivered: [
    { ok: true, text: "All 15 playbook steps compared with ours." },
    { ok: false, text: "Nothing was started. Which change to start is your call." },
  ],
  evidence: { url: "https://pages.example.com/playbook", label: "Open the comparison" },
  tree: [],
  source: "You shared a post on the Team desk on 14 November.",
  next: [
    { title: "Make the first three posts offer a standing offer for the app.", recommend: "start" },
    { title: "Three warm invites a day for both apps.", recommend: "start" },
  ],
  decision: "Which changes should we start? We recommend the offer and the invites.",
  options: ["Offer and invites: start both now", "None for now: keep the page as research"],
  closesGoal: false,
  openInGoal: [],
};
const ITEM = {
  id: "rv_e46",
  title: "playbook",
  liveUrl: "https://pages.example.com/playbook",
  ref: "E907-S3",
  repo: "memo",
  path: "docs/spines/epic-907.md",
  milestoneId: "ms_1",
  state: "review",
  status: "review",
  liveStatus: 200,
  checkedAt: "2026-11-14T23:00:00Z",
  createdAt: "2026-11-14",
  verdict: { kind: "card" },
  face: FACE,
} as unknown as ReviewItem;

const after = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("a review card reads cleanly top to bottom (vn_e751eeeb)", () => {
  it("opens with what was made, then where it came from, then what was delivered, then the decision; no objective score", async () => {
    vi.spyOn(api, "listReviewItems").mockImplementation(async (q?: { state?: string }) => (q?.state ? [] : [ITEM]));
    render(
      <MemoryRouter>
        <WaitingForReview fold="review" />
      </MemoryRouter>,
    );
    const c = await screen.findByTestId("review-card");
    expect(within(c).queryByTestId("review-objective")).toBeNull();
    expect(c.textContent).not.toMatch(/Objective \d|key results? green|moved today|still red/);
    const order = ["review-title", "review-source", "review-delivered", "review-decision-next", "review-decision"].map((id) => within(c).getByTestId(id));
    for (let i = 1; i < order.length; i++) expect(after(order[i - 1], order[i]), `${order[i - 1].dataset.testid} before ${order[i].dataset.testid}`).toBe(true);
    // the steps the decision moves: a short list, each its own sentence, never joined after a full stop
    const steps = within(c).getByTestId("review-decision-next");
    expect(steps.textContent).not.toMatch(/\.,/);
    expect(Array.from(steps.querySelectorAll("li")).map((l) => l.textContent)).toEqual(FACE.next.map((s) => s.title));
  });

  it("a button's sub-line names the steps in one sentence without doubled punctuation", () => {
    expect(joinSteps(["Make the offer standing.", "Three warm invites a day."])).toBe("Make the offer standing, Three warm invites a day");
    const yes = decisionChoices(FACE)!.find((c) => c.start)!;
    expect(yes.sub).toBe("The team starts: Make the first three posts offer a standing offer for the app, Three warm invites a day for both apps.");
  });
});
