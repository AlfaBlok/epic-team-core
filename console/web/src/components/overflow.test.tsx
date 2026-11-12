// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Milestone, Run, WaitingItem } from "@/api";
import { ClampText, Linkified } from "@/components/unblock";
import { CurrentStateCard } from "@/components/outcome";
import { WaitingStrip } from "@/pages/Milestone";
import { WaitingCard } from "@/components/waiting";

// long summaries, asks and Current State lines wrap inside the page instead of widening it past the viewport.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

// The live Personas tab, 2026-10-22: a run summary and an unbroken scheduled-task id.
const LONG =
  "S11 reconciled (panel not built, back to ready); read-only workers launched for S5 limits table (seat1) and S6 retire list (seat2); Needs Sam raised for S4 go and S9 decision nj_f480d480-1111-2222-3333-444455556666; " +
  "scheduled-task:command:mcp:dc219c4f-5746-41a0-bac5-7f3ab8ac83be:schedule-task:console-as_8bec0cbd-5c05-4ff8-8b0d-a0fa1f1e563a-984591ec-a905-4339-8103-2d8198a018e2";

describe("ClampText (M2-19 overflow, ported by M2-26)", () => {
  it("wraps long tokens and clamps; 'show more' only when clamped, toggles without following a surrounding link", () => {
    const sh = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(120);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(40);
    const outer = vi.fn();
    wrap(
      <a href="/x" onClick={outer}>
        <ClampText text={LONG} milestoneId="ms_1" links={false} />
      </a>,
    );
    const body = screen.getByTitle(LONG);
    expect(body.className).toContain("line-clamp-2");
    expect(body.className).toContain("break-words");
    expect(body.className).toContain("[overflow-wrap:anywhere]");
    fireEvent.click(screen.getByRole("button", { name: "show more" }));
    expect(outer).not.toHaveBeenCalled();
    expect(screen.getByTitle(LONG).className).not.toContain("line-clamp-2");
    fireEvent.click(screen.getByRole("button", { name: "show less" }));
    expect(screen.getByTitle(LONG).className).toContain("line-clamp-2");
    sh.mockReturnValue(40);
    cleanup();
    wrap(<ClampText text="short" />);
    expect(screen.queryByRole("button", { name: "show more" })).toBeNull();
  });

  it("turns bare nj_ ids into links only when links are on", () => {
    wrap(<Linkified text={LONG} milestoneId="ms_1" />);
    expect(screen.getByRole("link").getAttribute("href")).toBe("/milestones/ms_1?tab=waiting&item=nj_f480d480-1111-2222-3333-444455556666");
    cleanup();
    wrap(<Linkified text={LONG} milestoneId="ms_1" links={false} />);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });
});

const ask = (id: string, question: string): WaitingItem => ({
  id,
  source: "ask",
  state: "open",
  milestoneId: "ms_1",
  milestoneTitle: "PLAN-2",
  title: "S9",
  ask: "approve",
  question,
  contextLinks: [],
  owner: { kind: "none", label: "none" },
  decidable: false,
});

describe("Summary tab wraps instead of overflowing (M2-26)", () => {
  it("waiting-on-you banner: each ask wraps in full (no truncate)", () => {
    const q = "S9 agent load rule for HOST1: accept max 6 concurrent agent sessions, no native builds (npm ci with gcc) on HOST1, and mandatory workers " + LONG;
    wrap(<WaitingStrip open={[ask("a1", q), ask("a2", "S4 go?")]} href="?tab=waiting" />);
    const strip = screen.getByTestId("waiting-strip");
    expect(strip.querySelector(".truncate")).toBeNull();
    const line = screen.getByTitle(q);
    expect(line.className).toContain("[overflow-wrap:anywhere]");
  });

  it("Current State rows: label column + a value column that may shrink; long values and the stale chip break", () => {
    const m = {
      id: "ms_1",
      title: "PLAN-2",
      repo: "ops",
      path: "docs/PLAN-2.md",
      owner: "Sam",
      paused: false,
      createdAt: "2026-10-16T00:00:00Z",
      spineCommitAt: "2026-10-16T00:00:00Z",
      state: { status: "active", lastAttempted: null, result: null, evidence: null, waitingOn: `Sam: ${LONG}`, nextAction: null, verifiedAt: null, source: "spines" },
    } as Milestone;
    const runs = [{ id: "r1", assignmentId: "as_1", milestoneId: "ms_1", startedAt: "2026-10-22T00:00:00Z", endedAt: "2026-10-22T00:10:00Z", outcome: "progressed", summary: "x" }] as Run[];
    wrap(<CurrentStateCard m={m} runs={runs} />);
    const card = screen.getByTestId("state-card");
    const row = screen.getByText("Waiting on").parentElement!;
    expect(row.className).toContain("sm:grid-cols-[9rem_minmax(0,1fr)]");
    expect(row.className).toContain("min-w-0");
    expect(card.querySelector(".line-clamp-2, [class*='overflow-wrap']")?.className).toContain("[overflow-wrap:anywhere]");
    expect(screen.getByText(/^stale:/).className).toContain("break-words");
  });
});

describe("Waiting cards stay inside the viewport at 390 px (M2-30)", () => {
  it("WaitingCard: single shrinkable grid column, wrapping options and heading, anchor kept", () => {
    const item = { ...ask("a1", LONG), ask: "decide" as const, options: [LONG, "b"], missing: [LONG], advisory: [LONG] };
    wrap(<WaitingCard item={item} />);
    const card = screen.getByTestId("waiting-card");
    expect(card.id).toBeTruthy();
    expect(card.className).toContain("min-w-0");
    expect(card.querySelector(":scope > div")!.className).toContain("grid-cols-1");
    // options are a radio list; each option's label wraps (no nowrap, no truncate) inside the card
    const option = screen.getAllByTestId("ask-option")[0].closest("label")!;
    expect(option.textContent).toContain("S11");
    expect(option.className).not.toMatch(/whitespace-nowrap|truncate/);
    expect(option.className).toContain("flex");
    expect(screen.getByTestId("ask-lead").className).not.toMatch(/whitespace-nowrap|truncate/);
    // the missing/advisory chips (ask-advisories) are no longer on the card, so their max-w-full check is gone
  });

});
