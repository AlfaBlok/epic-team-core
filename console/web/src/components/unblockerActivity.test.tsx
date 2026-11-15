// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ASK_VERB, type Assignment, type Persona, type Run, type WaitingItem } from "@/api";
import { RunNote, unblockerCodes } from "@/components/common";
import { RunChecks, RunOutcomeChip, spineLineHref } from "@/components/runChecks";
import { RunTimeline } from "@/components/timeline";
import { WaitingCard } from "@/components/waiting";
import { timelineGroups } from "@/lib/derive";

/** the Unblocker's work visible in Activity; asks in human format on the card. */
afterEach(() => cleanup());

const run = (id: string, extra: Partial<Run> = {}): Run => ({
  id,
  assignmentId: "as_u",
  milestoneId: "ms_1",
  startedAt: "2026-10-24T01:00:00Z",
  endedAt: "2026-10-24T01:05:00Z",
  outcome: "progressed",
  summary: `summary ${id}`,
  ...extra,
});
const checks: Run["checks"] = [
  { code: "E900-A6", decision: "answered", answer: "yes, add the line", confidence: 85, source: "E900-G3 grant", spine: "docs/EPIC-900-ROOT.md:42" },
  { code: "E900-A8", decision: "split", answer: "keys now; QR later", confidence: 80, source: "L-13" },
  { code: "E900-A7", decision: "left", why: "publishing: in the floor", spine: "docs/EPIC-900-ROOT.md:43" },
];

describe("E908-S7 Unblocker in Activity", () => {
  const assignments: Assignment[] = [
    { id: "as_u", milestoneId: "ms_1", personaId: "pe_u", cadence: { type: "interval", everyMinutes: 60 }, enabled: true },
    { id: "as_dm", milestoneId: "ms_1", personaId: "pe_dm", cadence: { type: "interval", everyMinutes: 60 }, enabled: true },
  ];
  const personas = [
    { id: "pe_u", name: "Unblocker" },
    { id: "pe_dm", name: "Delivery Manager" },
  ] as Persona[];

  it("an Unblocker wake reads 'answered N · left M' with one line per ask (ANSWERED with answer, confidence, source, spine link / LEFT why); never 'idle'", () => {
    const runs = [
      run("u2", { checks }),
      run("u1", { startedAt: "2026-10-24T00:49:00Z", outcome: "idle", summary: "nothing answerable" }),
      run("d1", { assignmentId: "as_dm", instructions: "Unblocker answered E900-A6, E900-A8: act on them", instructionsBy: "Unblocker" }),
    ];
    render(<RunTimeline groups={timelineGroups(runs, assignments)} personas={personas} remote="Acme/whatgpt_v3" />);
    const u = screen.getByRole("region", { name: "runs of Unblocker" });
    expect(within(u).queryByText(/^idle$/)).toBeNull();
    const chips = within(u).getAllByTestId("unblocker-chip").map((c) => c.textContent);
    expect(chips).toEqual(["Unblocker · answered 2 · left 1 · split 1", "Unblocker · answered none"]);
    const lines = within(u).getAllByTestId("run-check");
    expect(lines.map((l) => l.textContent)).toEqual([
      "E900-A6answeredyes, add the line · 85% confident · source: E900-G3 grant",
      "E900-A8splitkeys now; QR later · 80% confident · source: L-13",
      "E900-A7leftpublishing: in the floor",
    ]);
    expect(within(lines[0]).getByText("E900-A6").getAttribute("href")).toBe("https://github.com/Acme/whatgpt_v3/blob/HEAD/docs/EPIC-900-ROOT.md#L42");
    expect(within(lines[1]).getByText("E900-A8").getAttribute("href")).toBeNull();
    // The Delivery Manager wake the Unblocker triggered says so, not "the owner's note".
    const dm = screen.getByRole("region", { name: "runs of Delivery Manager" });
    expect(within(dm).getByTestId("run-note").textContent).toContain("Woken by Unblocker: answered E900-A6, E900-A8");
    expect(within(dm).queryByText(/Sam's note/)).toBeNull();
    expect(within(dm).queryByTestId("unblocker-chip")).toBeNull();
  });

  it("other personas keep their outcome badge; running / failed Unblocker runs keep theirs too", () => {
    render(<RunOutcomeChip run={run("x", { outcome: "idle" })} personaName="steward" />);
    expect(screen.getByText("Idle")).toBeTruthy();
    cleanup();
    render(<RunOutcomeChip run={run("x", { outcome: "failed", checks })} personaName="Unblocker" />);
    expect(screen.getByText("Failed")).toBeTruthy();
  });

  it("RunNote: Sam by default; codes parsed from the Unblocker note", () => {
    render(<RunNote text="Focus on E904" />);
    expect(screen.getByTestId("run-note").textContent).toContain("Sam's note: Focus on E904");
    expect(unblockerCodes("Unblocker answered E900-A6: act on them")).toBe("E900-A6");
    expect(unblockerCodes("Focus")).toBeUndefined();
    expect(spineLineHref("docs/a.md", "o/r")).toBe("https://github.com/o/r/blob/HEAD/docs/a.md");
    expect(spineLineHref("docs/a.md:3")).toBeUndefined();
    render(<RunChecks checks={[]} />);
    expect(screen.queryByTestId("run-checks")).toBeNull();
  });
});

const item = (over: Partial<WaitingItem> = {}): WaitingItem => ({
  id: "wj_1",
  source: "ask",
  state: "open",
  who: "Sam",
  code: "E900-A6",
  milestoneId: "ms_1",
  milestoneTitle: "whatgpt",
  path: "docs/EPIC-900-ROOT.md",
  title: "S2 deploy",
  ask: "approve",
  question: "Let the app reach its own database?",
  recommendation: "Yes: same as the staging precedent",
  unblocks: "S2",
  proposedAction: "add one pg_hba.conf line above the final reject and reload",
  contextLinks: [],
  owner: { kind: "delivery-manager", label: "Delivery Manager" },
  decidable: false,
  ...over,
} as WaitingItem);
const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);
/** the sections, the technical bits and the details live under More, opened by the heading. */
const more = () => fireEvent.click(screen.getByTestId("ask-lead"));

describe("E908-S8 ask card in human format", () => {
  it("shows the question then Context / Impact / Risk / Recommendation / Why you; technical bits folded under More", () => {
    wrap(
      <WaitingCard
        item={item({ contextText: "The app cannot log in to its own db.", impact: "Unblocks the deploy.", risk: "Low; rollback: remove the line.", whyYou: "It touches a shared server." })}
      />,
    );
    // folded until the heading opens More (was a closed <details>)
    expect(screen.queryByTestId("ask-human")).toBeNull();
    expect(screen.queryByText(/pg_hba.conf/)).toBeNull();
    more();
    const human = screen.getByTestId("ask-human");
    expect(within(human).getAllByRole("term").map((t) => t.textContent)).toEqual(["Context", "Impact", "Risk", "Recommendation", "Why you"]);
    expect(within(human).getByText("It touches a shared server.")).toBeTruthy();
    const folded = screen.getByTestId("ask-more");
    expect(within(folded).getByText(/pg_hba.conf/)).toBeTruthy();
    expect(within(folded).getByText("S2")).toBeTruthy();
    expect(screen.queryByText("Recommended:")).toBeNull();
  });

  it("an old ask without the fields renders as before (no sections; Recommended and the technical bits under More)", () => {
    wrap(<WaitingCard item={item()} />);
    more();
    expect(screen.queryByTestId("ask-human")).toBeNull();
    expect(screen.queryByTestId("ask-details")).toBeNull();
    expect(screen.getByText("Recommended:")).toBeTruthy();
    expect(screen.getByText(/pg_hba.conf/)).toBeTruthy();
  });

  it("E908-S33, E948-S52: the card opens with the kind word, then the heading and the sections; the code sits in the foot", () => {
    wrap(<WaitingCard item={item({ code: "E942-A2", contextText: "Why.", impact: "I.", risk: "R.", recommendation: "yes" })} />);
    more();
    const html = screen.getByTestId("waiting-card").innerHTML;
    // the owner asked for nothing between the buttons and the feedback box, so the foot with
    // the code sits under the heading, above the folded sections, so the answer block stays whole
    expect(screen.getByTestId("card-foot").contains(screen.getByTestId("ask-code"))).toBe(true);
    const order = ["card-kind", "ask-lead", "ask-code", "ask-context", "ask-impact", "ask-risk", "ask-recommendation"].map((id) => html.indexOf(`data-testid="${id}"`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // the kind word is the first element of the card's meta line; no kind pill
    expect(screen.getByTestId("card-kind").parentElement!.firstElementChild).toBe(screen.getByTestId("card-kind"));
    expect(screen.getByTestId("card-kind").parentElement!.getAttribute("data-testid")).toBe("card-meta");
    expect(screen.queryByTestId("ask-kind")).toBeNull();
    expect(within(screen.getByTestId("card-foot")).getByTestId("ask-code").textContent).toContain("E942-A2");
  });

  it("E908-S33, E948-S52: the do kind reads Do; unknown reads Answer", () => {
    wrap(<WaitingCard item={item({ ask: "do" })} />);
    expect(screen.getByTestId("card-kind").textContent).toBe("Do");
    cleanup();
    wrap(<WaitingCard item={item({ ask: "unknown" })} />);
    expect(screen.getByTestId("card-kind").textContent).toBe("Answer");
    expect(Object.values(ASK_VERB)).toEqual(["Decide", "Approve", "Provide", "Action", "Respond"]);
  });

  it("E908-S33: Context links to the milestone's Epic Book section, with or without context text, on human and older asks", () => {
    wrap(<WaitingCard item={item({ milestoneId: "ms_9", contextText: "Why this comes up.", impact: "I." })} />);
    more();
    const link = within(screen.getByTestId("ask-context")).getByTestId("ask-book-link") as HTMLAnchorElement;
    expect(link.textContent).toContain("Epic deck: Where we are");
    expect(link.getAttribute("href")).toBe("/book/ms_9#where");
    expect(within(screen.getByTestId("ask-context")).getByText("Why this comes up.")).toBeTruthy();
    cleanup();
    // no context text, other sections present: the Context row still carries the link
    wrap(<WaitingCard item={item({ milestoneId: "ms_9", impact: "I." })} />);
    more();
    expect(within(screen.getByTestId("ask-context")).getByTestId("ask-book-link").getAttribute("href")).toBe("/book/ms_9#where");
    cleanup();
    // an older-format ask: just a Context row with the link
    wrap(<WaitingCard item={item({ milestoneId: "ms_9" })} />);
    more();
    expect(within(screen.getByTestId("ask-context-link")).getByTestId("ask-book-link").getAttribute("href")).toBe("/book/ms_9#where");
    cleanup();
    // no milestone: no link
    wrap(<WaitingCard item={item({ milestoneId: "", contextText: "Why." })} />);
    more();
    expect(screen.queryByTestId("ask-book-link")).toBeNull();
  });
});
