// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type ReviewItem, type StatusBatch } from "@/api";
import { TeamPage } from "@/pages/Team";
import { TopBarPills } from "@/components/Layout";
import { forgetOtherWorlds } from "@/components/otherWorlds";
import { sampleReview } from "@/components/cardInventory";
import { forgetWorld } from "@/lib/useSocial";
import { ProjectProvider } from "@/lib/project";
import { SKINS, SkinProvider } from "@/lib/skin";
import { COUNTED_SECTIONS, inboxCountCheck } from "@/lib/countCheck";
import { markSent, resetSent } from "@/lib/sentRows";
import { resetReviewGone } from "@/lib/inbox";
import { isDecisionCard } from "@/lib/cardKind";
import { healOnce } from "@/lib/countHeal";

/**
 * E948-S231 (the owner 28 Nov, his phone: "counter off again :((": Decisions waiting on you 2, only a Sent row below; the
 * fourth time after E948-S19, E948-S141, E948-S197). The cause: two decision cards he had answered were sent back to him
 * by their owners within two hours. Every count let them back in (the server dates them after his answer), but each card
 * still drew his old green Sent row, and the second Sent row hides behind the newest. Now a card and its count read one
 * rule, and his inbox reads itself again when a pill and its list ever differ.
 * E948-S232 (his request 28 Nov 11:45Z, the traction card "Should we try these three next?" drawn under Done): a card
 * that asks him a real choice sits under Decisions, even when its one other button is Change it.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  forgetOtherWorlds();
  resetSent();
  resetReviewGone();
});

const base = sampleReview().face!;
const M = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const TRACTION = { decision: "Should we try these three next, starting with personal replies? We recommend yes.", options: ["Yes: start with personal replies", "Change it: say which try moves"] };
const decision = (n: string, inboxSince: string) =>
  sampleReview({ id: `rv_${n}`, ref: `E900-S${n}`, milestoneId: "ms_x", inboxSince, face: { ...base, title: `Decision ${n}.`, ...TRACTION, next: [] } } as Partial<ReviewItem>);
const done = (n: string, inboxSince: string) => sampleReview({ id: `rv_${n}`, ref: `E901-S${n}`, milestoneId: "ms_x", inboxSince, face: { ...base, title: `Finished ${n}.` } } as Partial<ReviewItem>);

let reviews: ReviewItem[] = [];
beforeEach(() => {
  localStorage.clear();
  forgetWorld();
  forgetOtherWorlds();
  vi.spyOn(api, "listReviewItems").mockImplementation(((q?: { state?: string }) => Promise.resolve(q?.state ? [] : reviews)) as never);
  vi.spyOn(api, "listStatus").mockImplementation(() => Promise.resolve({ milestones: [], items: [], needsYou: 0, at: new Date().toISOString() } as StatusBatch));
  vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
  api.listAnsweredPresses = () => Promise.resolve({ since: ago(14 * 24 * 60 * M), answers: [] });
  vi.spyOn(api, "listCompanyWorlds").mockResolvedValue({ worlds: [] });
  vi.spyOn(api, "listTeamCards").mockResolvedValue({ open: [], answered: [], counts: { digest: 0, idea: 0, goal: 0, advisor: 0, support: 0 }, limits: { digestPerScorecardPerDay: 1, ideasPerDay: 3, openGoalsPerScorecard: 1 }, today: "2026-11-28" });
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
const openIn = (id: string) => [...document.querySelectorAll(`[data-fold-section][data-testid="${id}"] [data-inbox-card]`)].filter((e) => !e.querySelector('[data-testid="sent-row"]')).map((e) => e.getAttribute("data-inbox-card"));
const answeredAgo = (slot: string, ms: number) => {
  const real = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(real - ms);
  act(() => void markSent(slot, { said: "Changes sent to the team", title: slot }));
  clock.mockRestore();
};

describe("E948-S231: a pill counts exactly the cards its list draws", () => {
  it("two decisions he answered 20 minutes ago, both sent back 5 minutes ago: pill 2 over 2 cards, never over a Sent row", async () => {
    reviews = [decision("one", ago(5 * M)), decision("two", ago(5 * M)), done("three", ago(60 * M))];
    answeredAgo("review:rv_one", 20 * M);
    answeredAgo("review:rv_two", 20 * M);
    inbox();
    openAll();
    await waitFor(() => expect(pill("inbox-decisions")).toBe("2"));
    await waitFor(() => expect(openIn("inbox-decisions")).toEqual(["review:rv_one", "review:rv_two"]));
    expect(document.querySelectorAll('[data-fold-section][data-testid="inbox-decisions"] [data-testid="sent-row"]').length).toBe(0);
    expect(inboxCountCheck(document).mismatches).toEqual([]);
  });

  it("answered 2 minutes ago and not sent back: no card, no count, his Sent row only", async () => {
    reviews = [decision("one", ago(60 * M)), done("three", ago(60 * M))];
    answeredAgo("review:rv_one", 2 * M);
    inbox();
    openAll();
    await waitFor(() => expect(pill("waiting-for-review")).toBe("1"));
    expect(openIn("inbox-decisions")).toEqual([]);
    expect(pill("inbox-decisions") ?? "0").toBe("0");
    expect(inboxCountCheck(document).mismatches).toEqual([]);
  });

  it("the inbox reads itself again when a pill and its list differ, and only then", async () => {
    document.body.innerHTML = `<section data-fold-section data-testid="inbox-decisions"><span data-testid="inbox-decisions-count">2</span><div data-inbox-open><div data-testid="sent-row"></div></div></section>`;
    const refresh = vi.fn();
    const h = await healOnce(document, 0, refresh);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(h?.mismatches[0]).toMatch(/inbox-decisions: pill 2, 0 open cards drawn/);
    document.body.innerHTML = `<section data-fold-section data-testid="inbox-decisions"><span data-testid="inbox-decisions-count">1</span><div data-inbox-open></div></section>`;
    expect(await healOnce(document, 0, refresh)).toBeUndefined();
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("E948-S232: a card that asks him a decision sits under Decisions", () => {
  it("the traction card (Should we …? with Yes and Change it) is a Decision", async () => {
    expect(isDecisionCard({ ...TRACTION, next: [] })).toBe(true);
    reviews = [decision("traction", ago(60 * M)), done("three", ago(60 * M))];
    inbox();
    openAll();
    await waitFor(() => expect(openIn("inbox-decisions")).toEqual(["review:rv_traction"]));
    expect(openIn("waiting-for-review")).toEqual(["review:rv_three"]);
  });
  it("finished work that only asks Keep it? with Yes and Change it stays in Done", () => {
    expect(isDecisionCard({ decision: "Keep it? We recommend yes.", options: ["Yes: keep it", "Change it: say what to change"], next: [] })).toBe(false);
    expect(isDecisionCard({ decision: "Is this right?", options: ["Yes: keep it", "No: tell us what to change"], next: [] })).toBe(false);
    expect(isDecisionCard({ decision: "Does the page say your pain point the way you meant? We recommend yes.", options: ["Yes: it says it", "Change it: tell us what"], next: [] })).toBe(false);
    expect(isDecisionCard({ decision: "Are these numbers what the house search needed? We recommend yes.", options: ["Yes: use them for bidding", "No: say what is missing"], next: [] })).toBe(false);
  });
  it("the four of his live cards that ask what happens next move to Decisions (28 Nov)", () => {
    for (const [decision, options] of [
      ["Should the next three episodes keep this style? We recommend yes.", ["Yes: make episodes 2 to 4", "Change it: say what to change first"]],
      ["Run each product's test at 10 euros on X only? We recommend yes.", ["Yes: plan the three tests on X", "Change it: more money or another platform"]],
      ["Do we run the Acme pitch for one week first? We recommend yes.", ["Yes: run Acme's week from Monday", "No: say what to change"]],
    ] as const)
      expect(isDecisionCard({ decision, options: [...options], next: [] }), decision).toBe(true);
  });
});
