// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type Assignment, type Persona, type ReviewItem } from "@/api";
import type { CardFace } from "@/api/review-types";
import { WaitingForReview } from "@/components/review";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// the Gap finder shows only while it is switched on; these tests run with it on.
beforeEach(() => {
  vi.spyOn(api, "listPersonas").mockResolvedValue([{ id: "pe_gap", name: "Gap finder" } as Persona]);
  vi.spyOn(api, "listAssignments").mockResolvedValue([{ id: "as_gap", personaId: "pe_gap", milestoneId: "ms_1", enabled: true } as Assignment]);
});

/**
 * a persona's card says who sent it and where it lives, with its settings linked; each follow-up is an On / Off
 * switch naming the goal it goes to and his words; Off asks for a one-line reason; one button sends every choice.
 */
const FACE: CardFace = {
  project: { name: "Agent team", url: "https://team.example.com/" },
  goal: { text: "Each day a persona finds what you asked for more than once", code: "PLAN-79" },
  tasks: { done: 1, total: 2 },
  title: "Gap finder found 2 things you asked for more than once that are not done yet.",
  taskGoal: "You see each day what you keep asking for and still do not have.",
  delivered: [
    { ok: true, text: "I read your 28 voice notes from 29 Oct to 8 Nov." },
    { ok: true, text: "2 of the things you asked for twice are not done yet." },
  ],
  evidence: { url: "https://team.example.com/landing/gap-finder/2026-11-08.html", label: "Open today's gap page" },
  tree: [{ mark: "this", text: "This task: the run of 8 Nov" }],
  next: [
    { title: "Show one voice note going all the way to the next post", why: "Asked in 4 voice notes.", recommend: "start", target: "PLAN-64", quote: '"I have been asking for this URL" 8 Nov', targetName: "We want you to see how your words reach the next round" },
    { title: "Count posts per day on the campaign page", recommend: "start", target: "PLAN-78", targetName: "We want the product sold in one deck" },
  ],
  closesGoal: false,
  openInGoal: [],
  from: {
    name: "Gap finder",
    url: "/milestones/ms_1?tab=personas",
    line: "It reads your last ten days of voice notes and lists what you asked for twice and still lack.",
    runs: "It works at the root, across agent team, EpicSpine and SocialApp, daily at 12:00 UTC.",
    page: "/gap-finder",
    file: "https://github.com/Acme/team/blob/main/state/personas/gap-finder.md",
    stores: "Its findings are saved in the home_repo repo, one page a day.",
    readers: "You, the Gap finder on its next run, and the Delivery manager read them.",
  },
};
const ITEM: ReviewItem = {
  id: "rv_g",
  title: "Gap finder run 8 Nov",
  liveUrl: FACE.evidence.url,
  ref: "T79-G20261108",
  repo: "home_repo",
  path: "docs/spines/gap-finder-a-daily-persona-for-what-got.md",
  milestoneId: "ms_1",
  state: "review",
  status: "review",
  liveStatus: 200,
  checkedAt: "2026-11-08T12:00:00Z",
  createdAt: "2026-11-08",
  verdict: { kind: "card" },
  face: FACE,
};

describe("T79-S1 r2 a persona's card with switches", () => {
  it("names the persona, where it runs and links its settings", async () => {
    vi.spyOn(api, "listReviewItems").mockImplementation(async (q?: { state?: string }) => (q?.state ? [] : [ITEM]));
    render(<MemoryRouter><WaitingForReview fold="review" /></MemoryRouter>);
    const c = await screen.findByTestId("review-card");
    // the From band sits under More, opened by the heading; what it says to him is the heading and the body
    expect(within(c).queryByTestId("review-from")).toBeNull();
    expect(within(c).getByTestId("review-title").textContent).toBe("Gap finder found 2 things you asked for more than once that are not…");
    fireEvent.click(within(c).getByTestId("review-title"));
    const from = within(c).getByTestId("review-from");
    expect(from.textContent).toContain("From the Gap finder");
    expect(from.textContent).toContain("It works at the root, across agent team, EpicSpine and SocialApp");
    expect(within(from).getByTestId("review-from-settings").getAttribute("href")).toBe("/milestones/ms_1?tab=personas");
    // its own page, its instructions, where its findings are stored and who reads them
    expect(within(from).getByTestId("review-from-page").getAttribute("href")).toBe("/gap-finder");
    expect(within(from).getByTestId("review-from-file").getAttribute("href")).toContain("state/personas/gap-finder.md");
    expect(within(from).getByTestId("review-from-stores").textContent).toContain("home_repo repo");
    expect(within(from).getByTestId("review-from-readers").textContent).toContain("Delivery manager");
    expect(within(c).getByTestId("review-body").textContent).toBe(FACE.title);
    expect(c.textContent).not.toMatch(/approv/i);
  });

  it("each follow-up is an On / Off switch; Off asks why; one button sends every choice with the reasons", async () => {
    vi.spyOn(api, "listReviewItems").mockImplementation(async (q?: { state?: string }) => (q?.state ? [] : [ITEM]));
    const complete = vi.spyOn(api, "completeReviewItem").mockResolvedValue({ ...ITEM, state: "approved" });
    render(<MemoryRouter><WaitingForReview fold="review" /></MemoryRouter>);
    const c = await screen.findByTestId("review-card");
    const items = within(c).getAllByTestId("review-switch-item");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('You said "I have been asking for this URL" 8 Nov');
    expect(items[0].textContent).toContain("Becomes a task in: We want you to see how your words reach the next round");
    // one short "Send my choices"; what it does (the on and off counts) is its title
    const send = within(c).getByTestId("review-complete");
    expect(send.textContent).toBe("Send my choices");
    expect(send.getAttribute("title")).toBe("The 2 you switched on become tasks in their goals, and the team starts them.");
    fireEvent.click(within(items[1]).getByTestId("review-switch"));
    expect(within(items[1]).getByTestId("review-switch").getAttribute("aria-checked")).toBe("false");
    fireEvent.change(within(items[1]).getByTestId("review-switch-why"), { target: { value: "We count them on the Pipeline already" } });
    expect(within(c).getByTestId("review-complete").getAttribute("title")).toBe(
      "The one you switched on becomes a task in its goal, and the team starts it. The one switched off is dropped with your reason and not suggested again.",
    );
    fireEvent.click(within(c).getByTestId("review-complete"));
    await waitFor(() => expect(complete).toHaveBeenCalledWith("rv_g", { start: [0], park: [1], why: ["", "We count them on the Pipeline already"] }));
  });
});
