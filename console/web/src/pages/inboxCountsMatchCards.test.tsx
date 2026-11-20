// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type PendingItem, type ReviewItem, type StatusBatch } from "@/api";
import type { TeamCard } from "@/api/teamcard-types";
import { TeamPage } from "@/pages/Team";
import { TopBarPills } from "@/components/Layout";
import { forgetOtherWorlds } from "@/components/otherWorlds";
import { sampleGoal, sampleIdea, sampleReview } from "@/components/cardInventory";
import { forgetWorld } from "@/lib/useSocial";
import { ProjectProvider } from "@/lib/project";
import { SKINS, SkinProvider } from "@/lib/skin";
import { COUNTED_SECTIONS, inboxCountCheck } from "@/lib/countCheck";
import { markSent, resetSent } from "@/lib/sentRows";
import { resetReviewGone } from "@/lib/inbox";

/**
 * E948-S141, said more than 20 times (vn_a2fb3058; his phone 18 Nov 04:30Z: "Done, waiting for your review 4" and the top
 * bar 4 over one Sent row and no open card, "Must have given this feedback more than 20 times"). Every inbox count is the
 * number of open cards its section draws, the top bar's too: a card he answered (a Sent mark, its green row shown or not)
 * is out of every count the moment he answers. Before, only Blocked on you left answered items out (E948-S117): Done,
 * Decisions, Goals to set and Ideas counted the answered cards that E948-S140 had already taken off the page.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  forgetOtherWorlds();
  resetSent();
  resetReviewGone();
});

const base = sampleReview().face!;
const done = (n: number) => sampleReview({ id: `rv_done_${n}`, ref: `E900-S${n}`, milestoneId: "ms_x", face: { ...base, title: `Finished work number ${n}.` } } as Partial<ReviewItem>);
const decision = sampleReview({ id: "rv_decision", ref: "E900-S9", milestoneId: "ms_x", face: { ...base, title: "Two ways to go were found.", decision: "Which first? We recommend the first.", options: ["First: plan it", "Second: plan it"] } } as Partial<ReviewItem>);
const ask = (n: number): PendingItem => ({ id: `ms_x:${n}`, kind: "ask", state: "open", milestoneId: "ms_x", title: `Ask number ${n}` }) as PendingItem;
const batch = (items: PendingItem[]): StatusBatch => ({ milestones: [], items, needsYou: items.length, at: new Date().toISOString() });

let reviews: ReviewItem[] = [];
beforeEach(() => {
  localStorage.clear();
  forgetWorld();
  forgetOtherWorlds();
  reviews = [done(1), done(2), done(3), done(4), decision];
  // the server still lists every card he answered (its write and rescan lag his press), as on his phone
  vi.spyOn(api, "listReviewItems").mockImplementation(((q?: { state?: string }) => Promise.resolve(q?.state ? [] : reviews)) as never);
  vi.spyOn(api, "listStatus").mockResolvedValue(batch([ask(1), ask(2)]));
  vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
  vi.spyOn(api, "listCompanyWorlds").mockResolvedValue({ worlds: [] });
  vi.spyOn(api, "listTeamCards").mockResolvedValue({
    open: [sampleGoal(), { ...sampleGoal(), id: "tc_goal_2" } as TeamCard, sampleIdea()],
    answered: [],
    counts: { digest: 0, idea: 1, goal: 2, advisor: 0 },
    limits: { digestPerScorecardPerDay: 1, ideasPerDay: 3, openGoalsPerScorecard: 1 },
    today: "2026-11-18",
  });
});
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const inbox = () =>
  render(
    <SkinProvider skin={SKINS.console}>
      <MemoryRouter initialEntries={["/inbox"]}>
        <ProjectProvider>
          <TopBarPills counts={undefined} />
          <TeamPage />
        </ProjectProvider>
      </MemoryRouter>
    </SkinProvider>,
  );
const openAll = () => {
  for (const id of COUNTED_SECTIONS) {
    const t = document.querySelector(`[data-testid="${id}-toggle"]`);
    if (t?.getAttribute("aria-expanded") === "false") fireEvent.click(t);
  }
};
const pill = (id: string) => document.querySelector(`[data-testid="${id}-count"]`)?.textContent;
const top = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.textContent ?? "0";
/** every pill equals its section's open cards, the top bar too, and every counted section was compared */
const allMatch = () => {
  const r = inboxCountCheck();
  expect(r.mismatches).toEqual([]);
  // E948-S132: Urgent is not drawn while no card is urgent or pressing
  const drawnHere = COUNTED_SECTIONS.filter((id) => id !== "inbox-urgent" || document.querySelector('[data-fold-section][data-testid="inbox-urgent"]'));
  expect(r.sections.filter((s) => !s.folded).map((s) => s.section).sort()).toEqual([...drawnHere].sort());
  return r;
};

describe("every inbox count is the open cards its section draws", () => {
  it("his phone of 18 Nov: three cards answered earlier still listed by the server count nothing; Done reads 1 over one card", async () => {
    // three answers stored in his browser (an earlier visit), the server still lists those cards
    localStorage.setItem(
      "inbox.sent.v1",
      JSON.stringify([1, 2, 3].map((n) => [`review:rv_done_${n}`, { id: n, said: "Closed", title: `Finished work number ${n}.`, at: Date.now() - (40 - n * 10) * 60_000 }])),
    );
    vi.resetModules();
    const sent = await import("@/lib/sentRows");
    expect(sent.answeredSlot("review:rv_done_1")).toBe(true);
    // the page reads the store the module loaded with: mark the same three here
    act(() => [1, 2, 3].forEach((n) => markSent(`review:rv_done_${n}`, { said: "Closed", title: `Finished work number ${n}.` })));
    inbox();
    await waitFor(() => expect(pill("waiting-for-review")).toBe("1"));
    openAll();
    await waitFor(() => expect(document.querySelectorAll('[data-testid="waiting-for-review"] [data-testid="review-feed-item"]').length).toBe(1));
    expect(top("topbar-review")).toBe("1");
    allMatch();
  });

  it("answering one card drops its section's pill and the top bar at once, every other pill still equals its cards", async () => {
    inbox();
    await waitFor(() => expect(pill("waiting-for-review")).toBe("4"));
    await waitFor(() => expect(pill("waiting-on-you")).toBe("2"));
    await waitFor(() => expect(pill("inbox-goals-to-set")).toBe("2"));
    openAll();
    await waitFor(() => expect(document.querySelectorAll('[data-testid="waiting-for-review"] [data-testid="review-feed-item"]').length).toBe(4));
    await waitFor(() => allMatch());
    expect(top("topbar-review")).toBe("4");
    expect(top("topbar-needs-you")).toBe("3"); // 2 blocked + 1 decision

    // he answers a Done card, a decision, a blocked ask and a goal card; the server lists them all still
    act(() => void markSent("review:rv_done_2", { said: "Closed", title: "Finished work number 2." }));
    await waitFor(() => expect(pill("waiting-for-review")).toBe("3"));
    expect(top("topbar-review")).toBe("3");
    allMatch();
    act(() => void markSent("review:rv_decision", { said: "First: plan it", title: "Two ways to go were found." }));
    await waitFor(() => expect(pill("inbox-decisions")).toBe("0"));
    act(() => void markSent("ask:ms_x:1", { said: "Answered", title: "Ask number 1" }));
    await waitFor(() => expect(pill("waiting-on-you")).toBe("1"));
    act(() => void markSent(`team:${sampleGoal().id}`, { said: "Goal set", title: "A goal" }));
    await waitFor(() => expect(pill("inbox-goals-to-set")).toBe("1"));
    await waitFor(() => expect(top("topbar-needs-you")).toBe("1"));
    allMatch();
    // only the last answer keeps its green row (E948-S140), and it counts nowhere
    expect(document.querySelectorAll('[data-testid="sent-row"]').length).toBe(1);
  });

  it("the check fails a pill that differs from its drawn cards", () => {
    document.body.innerHTML = `<section data-fold-section data-testid="waiting-for-review"><button data-testid="waiting-for-review-toggle" aria-expanded="true"><span data-testid="waiting-for-review-count">4</span></button><ul><li data-testid="review-feed-sent"><div data-testid="sent-row"></div></li></ul></section>`;
    expect(inboxCountCheck().mismatches).toEqual(["waiting-for-review: pill 4, 0 open cards drawn"]);
  });
});
