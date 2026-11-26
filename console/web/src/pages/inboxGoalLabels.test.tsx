// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type PendingItem, type ReviewItem, type StatusBatch } from "@/api";
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

/**
 * (the owner 26 Nov 00:02Z, vn_b5b6f567): above the Inbox one label per goal of the cards the red and green
 * pills count, only goals that have such cards; all on at first, the first tap shows one goal alone, then each tap
 * toggles a goal, Show all resets (his chat of 26 Nov); every section and pill follows.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  forgetOtherWorlds();
  resetSent();
  resetReviewGone();
});

const home = { n: 5, id: "find-home", name: "Home: Find a home" };
const acme = { n: 6, id: "acme-testers", name: "Acme: Get 5 testers" };
const op = (objective?: typeof home) => (objective ? { level: "normal", why: "", ref: "x", objective } : undefined);
const base = sampleReview().face!;
const done = (n: number, objective?: typeof home) =>
  sampleReview({ id: `rv_done_${n}`, ref: `E900-S${n}`, milestoneId: "ms_x", ownerPriority: op(objective), face: { ...base, title: `Finished work number ${n}.` } } as Partial<ReviewItem>);
const decision = sampleReview({ id: "rv_decision", ref: "E900-S9", milestoneId: "ms_x", ownerPriority: op(acme), face: { ...base, title: "Two ways to go were found.", decision: "Which first? We recommend the first.", options: ["First: plan it", "Second: plan it"] } } as Partial<ReviewItem>);
const ask = (n: number, objective?: typeof home): PendingItem => ({ id: `ms_x:${n}`, kind: "ask", state: "open", milestoneId: "ms_x", title: `Ask number ${n}`, ownerPriority: op(objective) }) as PendingItem;
const batch = (items: PendingItem[]): StatusBatch => ({ milestones: [], items, needsYou: items.length, at: new Date().toISOString() });

beforeEach(() => {
  localStorage.clear();
  forgetWorld();
  forgetOtherWorlds();
  const reviews = [done(1, home), done(2, home), done(3, acme), decision];
  vi.spyOn(api, "listReviewItems").mockImplementation(((q?: { state?: string }) => Promise.resolve(q?.state ? [] : reviews)) as never);
  vi.spyOn(api, "listStatus").mockResolvedValue(batch([ask(1, home), ask(2)]));
  vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
  vi.spyOn(api, "listCompanyWorlds").mockResolvedValue({ worlds: [] });
  // an objective with no card in the inbox gets no label
  vi.spyOn(api, "listScorecards").mockResolvedValue({ nodes: [{ id: "widgets", kind: "pursuit", name: "Widgets: Ship the widget", rank: 9, greens: 0, total: 1, spines: [], children: [], rows: [] }], spineInfo: {} } as never);
  vi.spyOn(api, "listTeamCards").mockResolvedValue({
    open: [],
    answered: [],
    counts: { digest: 0, idea: 0, goal: 0, advisor: 0, support: 0 },
    limits: { digestPerScorecardPerDay: 1, ideasPerDay: 3, openGoalsPerScorecard: 1 },
    today: "2026-11-26",
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
/** every pill equals its section's open cards, the top bar too */
const allMatch = () => expect(inboxCountCheck().mismatches).toEqual([]);


const labels = () => [...document.querySelectorAll('[data-testid="inbox-goal"]')].map((b) => `${b.getAttribute("data-goal")}:${b.getAttribute("aria-pressed")}`);
const label = (name: string) => document.querySelector(`[data-testid="inbox-goal"][data-goal="${name}"]`)!;

describe("the Inbox's goal labels", () => {
  it("lists only the goals of the counted cards, in his order; the first tap shows that goal alone, then taps toggle, Show all resets", async () => {
    inbox();
    await waitFor(() => expect(labels()).toEqual(["Home: Find a home:true", "Acme: Get 5 testers:true", "Other:true"]));
    expect(label("Home: Find a home").textContent).toContain("3");
    await waitFor(() => expect(top("topbar-review")).toBe("3"));
    expect(top("topbar-needs-you")).toBe("3"); // 2 asks + 1 decision
    openAll();
    await waitFor(() => allMatch());

    // his chat of 26 Nov: the first tap shows that goal alone
    fireEvent.click(label("Home: Find a home"));
    await waitFor(() => expect(top("topbar-review")).toBe("2"));
    expect(top("topbar-needs-you")).toBe("1");
    expect(labels()).toEqual(["Home: Find a home:true", "Acme: Get 5 testers:false", "Other:false"]);
    await waitFor(() => expect(document.querySelectorAll('[data-testid="waiting-for-review"] [data-testid="review-feed-item"]').length).toBe(2));
    expect(pill("waiting-for-review")).toBe("2");
    expect(pill("waiting-on-you")).toBe("1");
    allMatch();

    // each further tap turns one goal on or off
    fireEvent.click(label("Acme: Get 5 testers"));
    await waitFor(() => expect(top("topbar-review")).toBe("3"));
    expect(top("topbar-needs-you")).toBe("2");
    fireEvent.click(label("Home: Find a home"));
    await waitFor(() => expect(top("topbar-review")).toBe("1"));
    expect(top("topbar-needs-you")).toBe("1");
    expect(labels()).toEqual(["Home: Find a home:false", "Acme: Get 5 testers:true", "Other:false"]);
    allMatch();

    // Show all puts every goal back
    fireEvent.click(screen.getByTestId("inbox-goals-all"));
    await waitFor(() => expect(top("topbar-review")).toBe("3"));
    expect(top("topbar-needs-you")).toBe("3");
    expect(labels().every((l) => l.endsWith(":true"))).toBe(true);
    expect(screen.queryByTestId("inbox-goals-all")).toBeNull();
  });

  it("turning the last goal off puts every goal back on", async () => {
    inbox();
    await waitFor(() => expect(labels()).toContain("Other:true"));
    fireEvent.click(label("Other"));
    await waitFor(() => expect(top("topbar-needs-you")).toBe("1"));
    fireEvent.click(label("Other"));
    await waitFor(() => expect(top("topbar-needs-you")).toBe("3"));
    expect(labels().every((l) => l.endsWith(":true"))).toBe(true);
  });

  it("changes with the inbox: a goal whose last card is answered leaves the labels", async () => {
    inbox();
    await waitFor(() => expect(labels()).toContain("Other:true"));
    act(() => void markSent("ask:ms_x:2", { said: "Answered", title: "Ask number 2" }));
    await waitFor(() => expect(labels()).toEqual(["Home: Find a home:true", "Acme: Get 5 testers:true"]));
  });
});
