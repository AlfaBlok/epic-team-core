// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import { TeamPage } from "@/pages/Team";
import { forgetOtherWorlds } from "@/components/otherWorlds";
import { sampleDigest, sampleGoal, sampleIdea } from "@/components/cardInventory";
import { forgetWorld } from "@/lib/useSocial";
import { ProjectProvider } from "@/lib/project";
import { SKINS, SkinProvider } from "@/lib/skin";

/**
 * the owner (2026-11-15): "Can we simplify this? Like the inbox is the inbox ... either I'm
 * reviewing something or I am unblocking something ... Goals to set, can you mark it as waiting on me? ... I want it to be
 * either red or green, not gray. And also, why do we have two sets of goals to be set? ... I want to maybe land with
 * everything collapsed, and then I expand where I want to look at."
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  forgetOtherWorlds();
});
beforeEach(() => {
  localStorage.clear();
  forgetWorld();
  forgetOtherWorlds();
  vi.spyOn(api, "listCompanyWorlds").mockResolvedValue({
    worlds: [
      {
        tenantId: "social-world",
        tenantName: "Sam",
        app: "SocialApp",
        appUrl: "https://cloud.example.com",
        items: [],
        campaigns: [{ name: "Launch week", milestoneId: "ms_launch", openUrl: "https://cloud.example.com/c/launch" }],
      },
    ],
  });
  vi.spyOn(api, "listTeamCards").mockResolvedValue({
    open: [sampleGoal(), sampleIdea(), sampleDigest()],
    answered: [],
    counts: { digest: 1, idea: 1, goal: 1, advisor: 0 },
    limits: { digestPerScorecardPerDay: 1, ideasPerDay: 3, openGoalsPerScorecard: 1 },
    today: "2026-11-15",
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
          <TeamPage />
        </ProjectProvider>
      </MemoryRouter>
    </SkinProvider>,
  );
const sections = () => [...document.querySelectorAll("[data-fold-section]")].filter((s) => !s.parentElement?.closest("[data-fold-section]")).map((s) => s.getAttribute("data-testid"));

describe("the Inbox has a few clear sections, all folded when it opens", () => {
  it("shows Blocked, Goals to set, Done waiting for your review, the team's ideas and digests, then one Everything else line", async () => {
    inbox();
    await screen.findByTestId("inbox-goals-to-set");
    await screen.findByTestId("inbox-team-cards");
    await screen.findByTestId("inbox-everything-else");
    await waitFor(() => expect(sections().filter((t) => t !== "inbox-decisions")).toEqual(["waiting-on-you", "inbox-goals-to-set", "waiting-for-review", "inbox-team-cards", "inbox-everything-else"]));
    // the sections that merged or went
    for (const gone of ["campaign-goals", "team-cards-goal", "team-cards-idea", "team-cards-digest", "goal-talk-section", "since-yesterday"]) expect(screen.queryByTestId(gone)).toBeNull();
  });

  it("lands with every section folded, even one left open on the last visit", async () => {
    localStorage.setItem("teamHome.section.review", "open");
    localStorage.setItem("teamHome.section.blocked", "open");
    inbox();
    await screen.findByTestId("inbox-everything-else");
    await waitFor(() => expect(screen.queryAllByRole("button", { expanded: true })).toHaveLength(0));
    for (const t of ["waiting-on-you", "inbox-goals-to-set", "waiting-for-review", "inbox-team-cards", "inbox-everything-else"]) expect(screen.getByTestId(`${t}-toggle`).getAttribute("aria-expanded")).toBe("false");
    // a tap opens one for this visit; the next visit lands folded again
    fireEvent.click(screen.getByTestId("waiting-for-review-toggle"));
    expect(screen.getByTestId("waiting-for-review-toggle").getAttribute("aria-expanded")).toBe("true");
    cleanup();
    forgetOtherWorlds();
    inbox();
    await screen.findByTestId("waiting-for-review-toggle");
    expect(screen.getByTestId("waiting-for-review-toggle").getAttribute("aria-expanded")).toBe("false");
  });

  it("Goals to set is one list, the campaign's question and the team's goal card together, counted red as waiting on him", async () => {
    inbox();
    const goals = await screen.findByTestId("inbox-goals-to-set");
    await waitFor(() => expect(screen.getByTestId("inbox-goals-to-set-count").textContent).toBe("2"));
    expect(screen.getByTestId("inbox-goals-to-set-count").getAttribute("data-tone")).toBe("needs-you");
    fireEvent.click(screen.getByTestId("inbox-goals-to-set-toggle"));
    expect(within(goals).getAllByTestId("goal-talk-line")).toHaveLength(1);
    expect(within(goals).getAllByTestId("team-card")).toHaveLength(1);
  });

  // E948-S110 (the owner 2026-11-15, vn_43d1c51e: "Goals to set should just be cards like everybody else. I don't understand
  // why there is like an entry or like an entry list"): every goal to set is one card, the same shape as a decision card.
  it("every goal to set is a card: card frame, Your decision, a row of answer buttons, Give feedback and the feedback box", async () => {
    inbox();
    const goals = await screen.findByTestId("inbox-goals-to-set");
    fireEvent.click(screen.getByTestId("inbox-goals-to-set-toggle"));
    await waitFor(() => expect(within(goals).getAllByTestId("team-card")).toHaveLength(1));
    const cards = [...goals.querySelectorAll("li > [data-card-shell]")];
    expect(cards).toHaveLength(2);
    for (const c of cards) {
      expect(c.querySelector("[data-testid=goal-decision]")?.textContent).toMatch(/^Your decision/);
      expect(c.querySelector("[data-card-answer] [data-card-feedback] [data-feedback-send]")).toBeTruthy();
    }
    // the team's goal card: its options are buttons in one row, the team's pick filled, never a stacked list
    const card = within(goals).getByTestId("team-card");
    const row = within(card).getByTestId("goal-options");
    expect(row.getAttribute("data-card-buttons")).toBe("decision");
    expect(row.className).toContain("flex-wrap");
    expect(row.className).not.toContain("grid");
    expect(within(row).getAllByTestId("goal-option").length).toBeGreaterThanOrEqual(2);
    expect(within(row).getByText("Give feedback")).toBeTruthy();
    expect(within(card).getByTestId("goal-source").textContent).toMatch(/^Came from: /);
    expect(goals.querySelector("[data-testid=goal-talk]")).toBeNull();
  });

  it("the team's ideas and digests are one list, counted green for his review; no count on the Inbox is grey", async () => {
    inbox();
    const team = await screen.findByTestId("inbox-team-cards");
    expect(screen.getByTestId("inbox-team-cards-count").getAttribute("data-tone")).toBe("review");
    expect(screen.getByTestId("inbox-team-cards-count").textContent).toBe("2");
    fireEvent.click(screen.getByTestId("inbox-team-cards-toggle"));
    expect([...team.querySelectorAll("li[data-team-kind]")].map((li) => li.getAttribute("data-team-kind"))).toEqual(["idea", "digest"]);
    // the top-level sections' counts: red or green, never grey (a list with nothing in it hides, Everything else has none)
    await waitFor(() => expect(screen.getByTestId("waiting-for-review-count")).toBeTruthy());
    const tops = [...document.querySelectorAll("[data-fold-section]")].filter((s) => !s.parentElement?.closest("[data-fold-section]"));
    const tones = tops.flatMap((s) => {
      const pill = s.querySelector(":scope > [data-fold-header] [data-count-pill]");
      return pill && pill.textContent !== "0" ? [pill.getAttribute("data-tone")] : [];
    });
    expect(tones.every((t) => t === "needs-you" || t === "review")).toBe(true);
  });

  it("Everything else holds the inbox's history lists, each still folding on its own", async () => {
    vi.spyOn(api, "listClosedGoals").mockResolvedValue([{ key: "k1", code: "E907-G1", title: "Old goal", repo: "sample-repo", path: "docs/spines/x.md", status: "done", hidden: ["E907-S2"] }]);
    inbox();
    const rest = await screen.findByTestId("inbox-everything-else");
    expect(screen.queryByTestId("inbox-everything-else-count")).toBeNull();
    // folded, nothing of it shows
    expect(screen.queryByTestId("review-closed-goals")).toBeNull();
    fireEvent.click(screen.getByTestId("inbox-everything-else-toggle"));
    const closed = await within(rest).findByTestId("review-closed-goals");
    expect(within(closed).getByTestId("review-closed-goals-toggle").getAttribute("aria-expanded")).toBe("false");
  });
});
