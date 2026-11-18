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
import { answeredSlot, markSent, resetSent, withServerAnswers, type SentEntry } from "@/lib/sentRows";
import { resetReviewGone } from "@/lib/inbox";

/**
 * E948-S141 iteration 2 (the owner 18 Nov 18:30Z, his phone and his laptop side by side: "See counters on phone vs desktop.
 * It's broken nasty."): his laptop read "Decisions waiting on you 0" with no red pill, his phone "2" with a red 2. An
 * answer was known only to the browser that pressed it (localStorage), while the server kept listing the card (a review
 * card he sent words on stays listed until relaunched). Now every device reads his answers from the server's press log
 * (GET /api/presses/answered), so the same inbox draws the same counts on his phone and his laptop.
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
let answers: { target: string; at: string; action: string; state: string }[] = [];
beforeEach(() => {
  localStorage.clear();
  forgetWorld();
  forgetOtherWorlds();
  reviews = [done(1), done(2), done(3), done(4), decision];
  // the server still lists every card he answered (its write and rescan lag his press), as on his phone
  vi.spyOn(api, "listReviewItems").mockImplementation(((q?: { state?: string }) => Promise.resolve(q?.state ? [] : reviews)) as never);
  vi.spyOn(api, "listStatus").mockResolvedValue(batch([ask(1), ask(2)]));
  vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
  answers = [];
  api.listAnsweredPresses = () => Promise.resolve({ since: new Date(Date.now() - 7_200_000).toISOString(), answers });
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
/** every pill equals its section's open cards, the top bar too, and every counted section was compared */
const allMatch = () => {
  const r = inboxCountCheck();
  expect(r.mismatches).toEqual([]);
  expect(r.sections.filter((s) => !s.folded).map((s) => s.section).sort()).toEqual([...COUNTED_SECTIONS].sort());
  return r;
};


const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
/** every counter the page draws, by name */
const counters = () => {
  const r = inboxCountCheck();
  return { ...Object.fromEntries(r.sections.map((s) => [s.section, s.pill])), red: r.topbar?.red, green: r.topbar?.green };
};

describe("his phone and his laptop show the same counts", () => {
  it("the cards he answered on his phone leave his laptop's counts too, while the server still lists them", async () => {
    // his phone pressed three cards 10 to 30 min ago; the server still lists all of them, its press log has the presses
    answers = [
      { target: "rv_decision", at: ago(30), action: "review feedback", state: "landed" },
      { target: "rv_done_1", at: ago(20), action: "review complete", state: "landing" },
      { target: "ms_x:1", at: ago(10), action: "ask answer", state: "landed" },
    ];
    // the laptop: no Sent mark of its own
    inbox();
    openAll();
    await waitFor(() => expect(pill("waiting-for-review")).toBe("3"));
    await waitFor(() => expect(pill("inbox-decisions")).toBe("0"));
    await waitFor(() => expect(pill("waiting-on-you")).toBe("1"));
    openAll();
    await waitFor(() => allMatch());
    const laptop = counters();
    expect(laptop).toMatchObject({ red: 1, green: 3 });
    // no green row on the laptop: it did not press them
    expect(document.querySelectorAll('[data-testid="sent-row"]').length).toBe(0);
    cleanup();
    resetSent();
    resetReviewGone();

    // the phone: the same inbox, its own Sent marks for the same three cards
    act(() => {
      markSent("review:rv_decision", { said: "Changes wanted", title: "Two ways to go were found." });
      markSent("review:rv_done_1", { said: "Closed", title: "Finished work number 1." });
      markSent("ask:ms_x:1", { said: "Answered", title: "Ask number 1" });
    });
    inbox();
    openAll();
    await waitFor(() => expect(pill("waiting-for-review")).toBe("3"));
    openAll();
    await waitFor(() => allMatch());
    expect(counters()).toEqual(laptop);
  });

  it("an answer whose press failed is open again on every device, this browser's mark included", async () => {
    act(() => void markSent("review:rv_done_2", { said: "Closed", title: "Finished work number 2." }));
    answers = [{ target: "rv_done_2", at: new Date().toISOString(), action: "review complete", state: "failed" }];
    inbox();
    openAll();
    await waitFor(() => expect(pill("waiting-for-review")).toBe("4"));
    expect(answeredSlot("review:rv_done_2")).toBe(false);
    openAll();
    await waitFor(() => allMatch());
  });

  it("the rule: landing or landed counts as answered, failed or brought back does not, older than two hours is forgotten", () => {
    const now = Date.now();
    const mine: SentEntry = { id: 1, said: "Closed", title: "x", at: now - 5 * 60_000 };
    const m = withServerAnswers(new Map([["review:rv_a", mine], ["review:rv_b", mine]]), [
      { target: "rv_a", at: new Date(now - 4 * 60_000).toISOString(), action: "review complete", state: "failed" },
      { target: "rv_c", at: new Date(now - 60_000).toISOString(), action: "review feedback", state: "landed" },
      { target: "rv_old", at: new Date(now - 3 * 3_600_000).toISOString(), action: "review complete", state: "landed" },
    ], now);
    expect(m.has("review:rv_a")).toBe(false); // its press failed after this mark
    expect(m.get("review:rv_b")).toBe(mine); // pressed here, not reported yet: kept
    expect(m.get("review:rv_c")).toMatchObject({ gone: true, server: true }); // answered elsewhere: out, no green row
    expect(m.has("review:rv_old")).toBe(false);
    // the next read no longer lists rv_c (brought back): it is open again
    expect(withServerAnswers(m, [], now).has("review:rv_c")).toBe(false);
  });

  it("the check fails a menu Inbox pill that differs from the top bar", () => {
    document.body.innerHTML = `<div data-testid="topbar-team"><span data-testid="topbar-needs-you">2</span><span data-testid="topbar-review">19</span></div><a data-testid="nav-inbox"><span data-testid="team-review-count">19</span></a>`;
    expect(inboxCountCheck().mismatches).toEqual(["menu Inbox red: 0, top bar red 2"]);
  });
});
