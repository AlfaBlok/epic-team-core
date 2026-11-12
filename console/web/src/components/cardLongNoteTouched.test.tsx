// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type ReviewItem, type WaitingItem } from "@/api";
import type { NoteMark } from "@/api/review-types";
import { WaitingCard } from "@/components/waiting";
import { WaitingForReview } from "@/components/review";
import { NoteMarkBand, noteTime } from "@/components/noteMark";

// (the owner's WhatsApp voice note 2026-11-10 23:08Z: "so that if I go into my inbox, I'm just not going to find
// things that are stale"): a card his long note touched says so on its face, stale or updated, with his words, until its
// owner acts (the server drops the mark when the row moves or the ask is rewritten).

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const STALE: NoteMark = { kind: "stale", ref: "T972-D4", at: "2026-11-10 23:08Z", quote: "the clip should end on the app address", why: "new ending", note: "WhatsApp", key: "1a2b3c4d" };
const UPDATED: NoteMark = { ...STALE, kind: "updated", ref: "T4-A2", quote: "the flywheel is one of the big rocks" };

beforeEach(() => {
  vi.spyOn(api as Required<typeof api>, "getMe").mockResolvedValue({ mode: "on", identity: { kind: "session" }, tenant: { id: "acme", name: "Sam", skin: "console" } } as never);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "not faked" } }), { status: 404, headers: { "content-type": "application/json" } })));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ask = (over: Partial<WaitingItem> = {}): WaitingItem => ({
  id: "wj_1",
  code: "T4-A2",
  source: "ask",
  state: "open",
  who: "Sam",
  milestoneId: "ms_1",
  milestoneTitle: "E904",
  nodeKey: "ms_1/T4",
  path: "docs/E904.md",
  title: "T4 Pick the logger layout",
  ask: "decide",
  question: "Is the flywheel the second red line?",
  options: [],
  contextLinks: [],
  owner: { kind: "delivery-manager", assignmentId: "as_1", personaName: "Delivery Manager", label: "Delivery Manager", threadId: "th_1" },
  since: "2026-11-10T10:00:00Z",
  decidable: false,
  ...over,
});
const ITEM = {
  id: "rv_1",
  title: "TEST card",
  liveUrl: "https://team.example.com",
  ref: "T972-D4",
  repo: "home_repo",
  path: "docs/spines/epic-48.md",
  milestoneId: "ms_1",
  state: "review",
  status: "review",
  liveStatus: 200,
  checkedAt: "2026-11-10T17:00:00Z",
  createdAt: "2026-11-10",
  verdict: { kind: "card" },
  face: {
    project: { name: "EpicTeam", url: "https://team.example.com/" },
    goal: { text: "Finished work waits for your review", code: "PLAN-48" },
    tasks: { done: 1, total: 2 },
    title: "The red line clip was made so you can share it.",
    taskGoal: "A short clip shows the red line.",
    delivered: [{ ok: true, text: "The clip plays on the page." }],
    evidence: { url: "https://team.example.com", label: "Open the clip" },
    tree: [],
    next: [],
    closesGoal: false,
    openInGoal: [],
  },
} as unknown as ReviewItem;

const page = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("T48-S40 a card his long note touched", () => {
  it("a review card shows stale with his words, above what it delivered", async () => {
    vi.spyOn(api, "listReviewItems").mockImplementation(async (q?: { state?: string }) => (q?.state ? [] : [{ ...ITEM, noteMark: STALE }]));
    page(<WaitingForReview fold="review" />);
    const card = await screen.findByTestId("review-card");
    const band = within(card).getByTestId("note-mark");
    expect(band.getAttribute("data-kind")).toBe("stale");
    expect(band.textContent).toMatch(/^Stale: your note of .*23:08|^Stale: your note of /);
    expect(band.textContent).toContain("You said “the clip should end on the app address”");
    expect(band.textContent).toContain("No need to judge it yet");
    // it sits above the title, the first thing he reads
    expect(band.compareDocumentPosition(within(card).getByTestId("review-title")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a card with no mark has no band", async () => {
    vi.spyOn(api, "listReviewItems").mockImplementation(async (q?: { state?: string }) => (q?.state ? [] : [ITEM]));
    page(<WaitingForReview fold="review" />);
    const card = await screen.findByTestId("review-card");
    expect(within(card).queryByTestId("note-mark")).toBeNull();
  });

  it("an open ask shows updated with his words; an answered one does not", () => {
    page(<WaitingCard item={ask({ noteMark: UPDATED })} />);
    const band = screen.getByTestId("note-mark");
    expect(band.getAttribute("data-kind")).toBe("updated");
    expect(band.textContent).toContain("Updated by your note of");
    expect(band.textContent).toContain("the flywheel is one of the big rocks");
    cleanup();
    page(<WaitingCard item={ask({ noteMark: UPDATED, state: "answered", answer: "A" })} />);
    expect(screen.queryByTestId("note-mark")).toBeNull();
  });

  it("says the time in his clock, with the day when it was not today", () => {
    const at = Date.parse("2026-11-10T23:08:00Z");
    expect(noteTime("2026-11-10 23:08Z", at + 60_000)).toBe(new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    expect(noteTime("2026-11-10 23:08Z", at + 3 * 86_400_000)).toContain(new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    expect(noteTime("2026-11-10 23:08Z", at + 3 * 86_400_000).length).toBeGreaterThan(5);
    page(<NoteMarkBand mark={STALE} now={at} />);
    expect(screen.getByRole("status").textContent).toContain("Stale: your note of");
  });
});
