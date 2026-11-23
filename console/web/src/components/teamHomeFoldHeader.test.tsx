// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type Assignment, type Run, type Ticket, type WaitingItem } from "@/api";
import type { ReviewItem } from "@/api/review-types";
import { WaitingOnYou } from "@/components/waiting";
import { WaitingForReview } from "@/components/review";
import { AskedNoRow } from "@/components/askedNoRow";
import { MovingNow } from "@/components/movingNow";
import { PILL_SHAPE, PILL_TONES } from "@/components/homeSection";
import { RunsPage } from "@/pages/Runs";
import { TicketsPage } from "@/pages/Lists";

/**
 * every Team home section and every ListPane list is the one fold
 * section (same box, header, chevron, title case) with the one count pill (same shape; colour only by meaning), and no
 * count is written in brackets.
 */

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const base = (over: Partial<WaitingItem> = {}): WaitingItem => ({
  id: "wj_1",
  source: "ask",
  state: "open",
  who: "Sam",
  row: "T4",
  milestoneId: "ms_1",
  milestoneTitle: "E904",
  nodeKey: "ms_1/T4",
  path: "docs/E904.md",
  title: "T4 Pick the logger layout",
  ask: "decide",
  question: "Ship with one logger or two?",
  options: ["one", "two"],
  recommendation: "one",
  contextLinks: [],
  owner: { kind: "delivery-manager", assignmentId: "as_1", personaName: "Delivery Manager", label: "Delivery Manager", threadId: "th_1" },
  since: new Date(Date.now() - 2 * 86400_000).toISOString(),
  decidable: false,
  ...over,
});
const later = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
const waiting: WaitingItem[] = [
  base(),
  base({ id: "wj_z", code: "T4-A9", snoozedUntil: later }),
  base({ id: "wj_f", state: "answered", decidedBy: "Unblocker", question: "Decided?", answer: "one" }),
  base({ id: "wj_c", source: "heuristic", ask: undefined, options: undefined, question: "Later gate", gate: "future", gateReason: "after E4-2" }),
  base({ id: "wj_a", state: "answered", question: "Answered?", answer: "yes" }),
  base({ id: "wj_s", state: "superseded", supersededBy: "T4-A2", question: "Old ask?" }),
];
const review: ReviewItem = { id: "rv_1", title: "Result", liveUrl: "https://team.example.com/r/1", ref: "T40-S1", state: "review", liveStatus: 200, createdAt: new Date().toISOString() };

function teamHome() {
  vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue(waiting);
  vi.spyOn(api, "listStatus").mockResolvedValue(undefined as never);
  vi.spyOn(api, "listReviewItems").mockImplementation(async (q) => (q?.state === "backlog" ? [] : [review, { ...review, id: "rv_2", ref: "T40-S2" }]));
  vi.spyOn(api, "listAskedNoRow").mockResolvedValue({ items: [{ milestoneId: "ms_1", milestoneTitle: "a", path: "docs/e.md", spineTitle: "PLAN-40", id: "E40-1", text: "x" }], total: 1 });
  vi.spyOn(api, "movingNow").mockResolvedValue({ at: "x", epics: [], total: 0 });
  return render(
    <MemoryRouter>
      <WaitingOnYou title="Blocked, waiting on you" fold="blocked" />
      <WaitingForReview fold="review" />
      <AskedNoRow />
      <MovingNow />
    </MemoryRouter>,
  );
}

const sections = () => [...document.querySelectorAll<HTMLElement>("[data-fold-section]")];
const header = (s: HTMLElement) => s.querySelector<HTMLElement>("[data-fold-header]")!;
const toggle = (s: HTMLElement) => header(s).querySelector<HTMLButtonElement>("button[aria-expanded]")!;
const pill = (s: HTMLElement) => header(s).querySelector<HTMLElement>("[data-count-pill]")!;
const titleOf = (s: HTMLElement) => toggle(s).textContent!.replace(pill(s).textContent!, "").trim();

/** One look: same section box, header line, button, chevron and pill shape; the count only in the pill. */
function expectOneDesign(list: HTMLElement[]) {
  expect(list.length).toBeGreaterThan(0);
  const first = list[0];
  for (const s of list) {
    expect(s.className, titleOf(s)).toBe(first.className);
    expect(header(s).className, titleOf(s)).toBe(header(first).className);
    expect(toggle(s).className, titleOf(s)).toBe(toggle(first).className);
    // the one shared fold chevron (its open state aside)
    const chevron = (x: HTMLElement) => toggle(x).querySelector(".fold-chevron")!.getAttribute("class");
    expect(chevron(s), titleOf(s)).toBe(chevron(first));
    expect(pill(s).className.startsWith(PILL_SHAPE), titleOf(s)).toBe(true);
    expect(header(s).textContent, titleOf(s)).not.toMatch(/\(\d+\)/);
    expect(titleOf(s), "title case, not upper case").not.toBe(titleOf(s).toUpperCase());
    expect(toggle(s).className).not.toMatch(/uppercase/);
  }
}

describe("T48-S17 Team home: one fold header and one count pill", () => {
  it("every section folds with the same header and pill, the count never in brackets", async () => {
    teamHome();
    await screen.findByTestId("answered-section");
    await screen.findByTestId("asked-no-row");
    await waitFor(() => expect(screen.getByTestId("moving-now-count").textContent).toBe("0"));
    const titles = sections().map(titleOf);
    expect(titles).toEqual(["Blocked, waiting on you", "Snoozed", "Decided for you", "Coming up", "Answered", "Superseded", "Done, waiting for your review", "Asked, no row yet", "Moving now"]);
    expectOneDesign(sections());
    // Folded: every section is its header line only, the same for each.
    for (const s of sections()) if (toggle(s).getAttribute("aria-expanded") === "true") fireEvent.click(toggle(s));
    for (const s of sections()) {
      expect(s.children).toHaveLength(1);
      expect(toggle(s).getAttribute("aria-expanded")).toBe("false");
    }
    expectOneDesign(sections());
  });

  // review is its own green tone now (the owner: red = waiting on you to unblock, green = waiting for your review).
  it("the pill's colour is only its meaning: needs-you for Blocked, review for review, info for the rest and for 0", async () => {
    teamHome();
    await screen.findByTestId("answered-section");
    await screen.findByTestId("asked-no-row");
    await waitFor(() => expect(screen.getByTestId("waiting-for-review-count").textContent).toBe("2"));
    const tone = Object.fromEntries(sections().map((s) => [titleOf(s), pill(s).dataset.tone]));
    expect(tone).toMatchObject({
      "Blocked, waiting on you": "needs-you",
      "Done, waiting for your review": "review",
      Snoozed: "info",
      "Decided for you": "info",
      "Coming up": "info",
      Answered: "info",
      Superseded: "info",
      "Asked, no row yet": "info",
      "Moving now": "info",
    });
    for (const s of sections()) expect(pill(s).className).toBe(`${PILL_SHAPE} ${PILL_TONES[pill(s).dataset.tone as keyof typeof PILL_TONES]}`);
  });

  it("the sub-lists fold on their own: Blocked folded leaves Snoozed, Answered and the rest one line each", async () => {
    teamHome();
    const blocked = await screen.findByTestId("waiting-on-you");
    fireEvent.click(within(blocked).getByTestId("waiting-on-you-toggle"));
    expect(blocked.children).toHaveLength(1);
    const answered = screen.getByTestId("answered-section");
    fireEvent.click(within(answered).getByTestId("answered-section-toggle"));
    expect(within(answered).getAllByTestId("answered-row")).toHaveLength(1);
  });
});

describe("T48-S17 the other ListPane lists: Runs and Tickets", () => {
  const run = (id: string, over: Partial<Run> = {}): Run => ({ id, assignmentId: "as_1", milestoneId: "ms_1", startedAt: "2026-10-21T20:00:00Z", outcome: "progressed", summary: "", ...over });
  const assignments: Assignment[] = [{ id: "as_1", milestoneId: "ms_1", personaId: "pe_1", cadence: { type: "interval", everyMinutes: 240 }, enabled: true }];

  it("Wakes and Open tickets use the same fold section and pill as Team home", async () => {
    vi.spyOn(api, "listMilestones").mockResolvedValue([]);
    vi.spyOn(api, "listPersonas").mockResolvedValue([]);
    vi.spyOn(api, "listAssignments").mockResolvedValue(assignments);
    vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
    vi.spyOn(api, "listRuns").mockResolvedValue([run("run_1")]);
    vi.spyOn(api, "listRunsTop").mockResolvedValue({ runs: [run("run_1")], total: 1 });
    const tickets: Ticket[] = [{ id: "T1", title: "Ticket", repo: "r", status: "ready", source: "ledger" }];
    vi.spyOn(api, "listTicketsTop").mockResolvedValue({ tickets, total: 1 });
    render(
      <MemoryRouter>
        <RunsPage />
        <TicketsPage />
      </MemoryRouter>,
    );
    await screen.findByTestId("runs-pane");
    await screen.findByTestId("tickets-pane");
    await screen.findByTestId("active-agents-chart"); // the Active agents chart folds the same way
    await screen.findByTestId("run-hosts-chart"); // so does Live runs by host
    expect(sections().map(titleOf)).toEqual(["Active agents", "Live runs by host", "Wakes", "Open tickets"]);
    expectOneDesign(sections());
    expect(screen.getByTestId("runs-count").textContent).toBe("1");
    expect(screen.getByTestId("tickets-count").dataset.tone).toBe("info");
  });
});

describe("T48-S17 edge-to-edge panes (Runs, Tickets): the foot is padded, no second border inside the box", () => {
  it("Tickets: the table's own border is off inside the fold box; '20 of 30 shown' sits padded under a rule", async () => {
    vi.spyOn(api, "listMilestones").mockResolvedValue([]);
    const all: Ticket[] = Array.from({ length: 30 }, (_, i) => ({ id: `T${i + 1}`, title: `Ticket ${i + 1}`, repo: "r", status: "ready", source: "ledger" }));
    vi.spyOn(api, "listTicketsTop").mockImplementation(async (limit) => ({ tickets: limit ? all.slice(0, limit) : all, total: 30 }));
    render(
      <MemoryRouter>
        <TicketsPage />
      </MemoryRouter>,
    );
    const pane = await screen.findByTestId("tickets-pane");
    expect(pane.className).toMatch(/\[&>div\]:border-0/);
    expect(screen.getByTestId("tickets-more").className).toMatch(/px-4/);
    expect(screen.getByTestId("tickets-more").className).toMatch(/border-t/);
  });
});
