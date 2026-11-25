// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { goalsSplit, InboxShowFilter, showKeeps, TeamCardsSections } from "@/components/teamCards";
import { sampleDigest, sampleGoal, sampleIdea } from "@/components/cardInventory";
import type { TeamCard } from "@/api/teamcard-types";
import { api } from "@/api";
import { forgetWorld } from "@/lib/useSocial";
import { clearAnswerVoiceState } from "@/voice/AnswerVoice";
import { forgetDeskVoiceWorld } from "@/voice/deskBase";
import { openText } from "@/test/openText";

// E948-S66 (the owner, vn_fe52ef4a 2026-11-12 22:19Z): the inbox carries, after what is blocked on him, a digest per
// scorecard, then ideas, then goals to set; each kind can be shown alone; a scorecard's own inbox shows only its cards.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

let posted: { id: string; body: Record<string, unknown> }[] = [];
let listed: (string | undefined)[] = [];
const cards = (): TeamCard[] => [sampleGoal(), sampleIdea(), sampleDigest()];
const ORDER = ["digest", "idea", "goal"];

beforeEach(() => {
  forgetWorld();
  forgetDeskVoiceWorld();
  clearAnswerVoiceState();
  posted = [];
  listed = [];
  vi.spyOn(api, "listTeamCards").mockImplementation(async (q = {}) => {
    listed.push(q.scorecard);
    const open = cards()
      .filter((c) => !q.scorecard || c.scorecard === q.scorecard)
      .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
    return { open, answered: [], counts: { digest: 1, idea: 1, goal: 1, advisor: 0, support: 0 }, limits: { digestPerScorecardPerDay: 1, ideasPerDay: 3, openGoalsPerScorecard: 1 }, today: "2026-11-13" };
  });
  vi.spyOn(api, "answerTeamCard").mockImplementation(async (id, body) => {
    posted.push({ id, body: body as Record<string, unknown> });
    const c = cards().find((x) => x.id === id)!;
    return { ok: true as const, card: { ...c, answer: { at: "2026-11-13T16:00:00Z", text: body.text ?? "", via: body.via ?? "text", ...(body.pick !== undefined ? { pick: body.pick } : {}) } } };
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("E948-S66 the team's cards in the inbox", () => {
  it("shows ideas, then goals to set, then digests (the owner's 22:19Z order), each card on the one shell", async () => {
    render(
      <MemoryRouter>
        <TeamCardsSections />
      </MemoryRouter>,
    );
    await screen.findByTestId("team-cards-digest");
    const sections = [...document.querySelectorAll("[data-fold-section]")].map((s) => s.getAttribute("data-testid"));
    expect(sections).toEqual(["team-cards-idea", "team-cards-goal", "team-cards-digest"]);
    for (const c of document.querySelectorAll("[data-testid=team-card]")) expect(c.matches("[data-card-shell]")).toBe(true);
    expect(screen.getByTestId("digest-trend").textContent).toBe("Greener");
    expect(screen.getByTestId("digest-numbers").textContent).toContain("3 of 7 green");
    expect(screen.getByTestId("digest-numbers").textContent).toContain("was 2 of 7");
    expect(within(screen.getByTestId("digest-reasons")).getAllByRole("listitem")).toHaveLength(2);
  });

  it("one kind alone, and one scorecard's cards only", async () => {
    render(
      <MemoryRouter>
        <TeamCardsSections kinds={["idea"]} scorecard="sample-testers" />
      </MemoryRouter>,
    );
    await screen.findByTestId("team-cards-idea");
    expect(screen.queryByTestId("team-cards-digest")).toBeNull();
    expect(screen.queryByTestId("team-cards-goal")).toBeNull();
    expect(listed).toContain("sample-testers");
  });

  it("Go ahead answers an idea; picking a goal answers with its number", async () => {
    render(
      <MemoryRouter>
        <TeamCardsSections />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByTestId("idea-go"));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ body: { text: "Go ahead", via: "button" } });
    fireEvent.click(screen.getAllByTestId("goal-option")[1]);
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1].body).toMatchObject({ pick: 1, via: "button" });
    expect(posted[1].id).toBe("tc_sample_goal");
  });

  it("the Show filter keeps one part of the inbox", () => {
    // the filter names the Inbox's few sections; an old one-kind address (?show=idea) still keeps that kind.
    expect(showKeeps("all")).toEqual({ blocked: true, review: true, rest: true, goals: true, kinds: ["support", "advisor", "idea", "digest"] });
    expect(showKeeps("advisor").kinds).toEqual(["advisor"]);
    expect(showKeeps("blocked")).toEqual({ blocked: true, review: false, rest: false, goals: false, kinds: [] });
    expect(showKeeps("goal")).toMatchObject({ goals: true, kinds: [] });
    expect(showKeeps("team").kinds).toEqual(["support", "advisor", "idea", "digest"]);
    const on = vi.fn();
    render(<InboxShowFilter show="all" onChange={on} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["All", "Blocked", "Goals to set", "Review", "Ideas and digests"]);
    fireEvent.click(screen.getByTestId("inbox-show-team"));
    expect(on).toHaveBeenCalledWith("team");
  });

  it("every card points at its goal set and key result: the meta line, each digest reason, Open the set", async () => {
    const idea = { ...sampleIdea(), scorecard: "launch", scorecardName: "Launch", keyResult: "Tester applications" };
    const digest = { ...sampleDigest(), scorecard: "launch", scorecardName: "Launch", digest: { ...sampleDigest().digest!, reasons: [{ text: "Still red: Tester applications, 0", keyResult: "Tester applications" }, { text: "plain reason" }] } };
    vi.spyOn(api, "listTeamCards").mockResolvedValue({ open: [digest, idea], answered: [], counts: { digest: 1, idea: 1, goal: 0, advisor: 0, support: 0 }, limits: { digestPerScorecardPerDay: 1, ideasPerDay: 3, openGoalsPerScorecard: 1 }, today: "2026-11-13" });
    render(
      <MemoryRouter>
        <TeamCardsSections />
      </MemoryRouter>,
    );
    const metas = await screen.findAllByTestId("team-card-scorecard");
    const ideaMeta = metas.find((m) => m.textContent?.includes("›"))!;
    expect(ideaMeta.textContent).toBe("Launch › Tester applications");
    expect(ideaMeta.getAttribute("href")).toBe("/sets/launch?kr=Tester%20applications");
    expect(screen.getByTestId("digest-reason-kr").getAttribute("href")).toBe("/sets/launch?kr=Tester%20applications");
    expect(screen.getByTestId("digest-open").getAttribute("href")).toBe("/sets/launch");
  });
});

describe("E948-S59 the Senior advisor's weekly set", () => {
  const set = (): TeamCard => ({
    id: "tc_20261113_advisor_2026-w46",
    kind: "advisor",
    by: "Senior advisor",
    at: "2026-11-13T02:00:00Z",
    day: "2026-11-12",
    title: "Three moves this week toward commercially live",
    advisor: {
      week: "2026-W46",
      weekLabel: "9 to 15 November",
      page: "https://example.com/advisor",
      items: [
        { id: "a1", title: "Open the door", why: "zero outside users", spine: "docs/spines/a.md" },
        { id: "a2", title: "Post every day without you", spine: "docs/spines/a.md" },
      ],
    },
  });
  it("one marked set: the header names the Senior advisor and the week, each suggestion a card with Accept, Decline and its answer box; Accept all", async () => {
    vi.spyOn(api, "listTeamCards").mockResolvedValue({ open: [set(), sampleIdea()], answered: [], counts: { digest: 0, idea: 1, goal: 0, advisor: 1, support: 0 }, limits: { digestPerScorecardPerDay: 1, ideasPerDay: 3, openGoalsPerScorecard: 1 }, today: "2026-11-13" });
    const calls: unknown[] = [];
    vi.spyOn(api, "advisorVerdict").mockImplementation(async (id, v) => {
      calls.push({ id, ...v });
      const c = set();
      c.advisor!.items = c.advisor!.items.map((i, n) => ({ ...i, verdict: { state: "accepted" as const, at: "2026-11-13T03:00:00Z", via: "button" as const, row: `E946-S${n + 9}` } }));
      return { ok: true as const, card: c, rows: { a1: "E946-S9", a2: "E946-S10" } };
    });
    render(
      <MemoryRouter>
        <TeamCardsSections />
      </MemoryRouter>,
    );
    const head = await screen.findByTestId("advisor-header");
    expect(head.textContent).toContain("Senior advisor");
    expect(screen.getByTestId("advisor-week").textContent).toBe("week of 9 to 15 November");
    const sections = [...document.querySelectorAll("[data-fold-section]")].map((s) => s.getAttribute("data-testid"));
    expect(sections[0]).toBe("team-cards-advisor");
    const items = screen.getAllByTestId("advisor-item");
    expect(items).toHaveLength(2);
    for (const i of items) {
      expect(i.getAttribute("data-card-shell")).toBe("advisor-item");
      expect(i.querySelector("[data-testid=advisor-accept]")).not.toBeNull();
      expect(i.querySelector("[data-testid=advisor-decline]")).not.toBeNull();
      openText(i);
      expect(i.querySelector("textarea")).not.toBeNull();
      expect(i.textContent).toContain("Senior advisor, week of 9 to 15 November");
    }
    fireEvent.click(screen.getByTestId("advisor-accept-all"));
    // E948-S130: the whole set answered collapses to its green Sent row, naming the tasks it made
    await waitFor(() => expect(screen.getByTestId("sent-row-said").textContent).toBe("Accepted"));
    expect(calls).toEqual([{ id: "tc_20261113_advisor_2026-w46", verdict: "accept", via: "button" }]);
    expect(screen.getByTestId("sent-row-detail").textContent).toContain("E946-S9");
  });
});

// The owner on a call ("is there a relation between these 15 numbers?"): Goals to set says what its count is made of.
describe("Goals to set's split line", () => {
  it("names his objectives needing a goal apart from the campaigns", () => {
    expect(goalsSplit(7, 8, { active: 13, needGoal: 7 })).toBe("7 of your 13 objectives still need a goal, and 8 campaigns need a number.");
    expect(goalsSplit(1, 0, { active: 13, needGoal: 1 })).toBe("1 of your 13 objectives still needs a goal.");
    expect(goalsSplit(0, 2)).toBe("2 campaigns need a number.");
    expect(goalsSplit(2, 1)).toBe("2 objectives need a goal, and 1 campaign needs a number.");
  });
});
