// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type PendingItem, type ReviewItem, type StatusBatch } from "@/api";
import { TeamPage } from "@/pages/Team";
import { TopBarPills } from "@/components/Layout";
import { forgetOtherWorlds } from "@/components/otherWorlds";
import { sampleReview } from "@/components/cardInventory";
import { forgetWorld } from "@/lib/useSocial";
import { ProjectProvider } from "@/lib/project";
import { SKINS, SkinProvider } from "@/lib/skin";
import { COUNTED_SECTIONS } from "@/lib/countCheck";
import { markSent, resetSent, SENT_KEEP_MS } from "@/lib/sentRows";
import { resetReviewGone } from "@/lib/inbox";
import { landed, onPress, PRESS_LATE_MS, type PressNote } from "@/lib/press";

/**
 * (the owner 28 Nov, vn_8768081d: "Some of the cards that I gave an answer seem to be left inside the inbox, but
 * now I can see the answer I gave. That's weird ... If I've answered, I want it gone from the inbox until it comes back."):
 * a card he answered by voice, by text or with a button leaves his inbox at once and stays gone, past the two hours a Sent
 * mark used to live, while the server still lists it; it is his card again only when its owner sends it back (the server
 * dates it after his answer). And (his chat 28 Nov, "300s in why these still showing at bottom?") a press still not
 * written after 30 s says so plainly while the console tries again.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  forgetOtherWorlds();
  resetSent();
  resetReviewGone();
});

const base = sampleReview().face!;
const H = 3_600_000;
const card = (n: string, inboxSince: string) =>
  sampleReview({ id: `rv_${n}`, ref: `E900-S${n.length}`, milestoneId: "ms_x", inboxSince, face: { ...base, title: `Finished work ${n}.` } } as Partial<ReviewItem>);
const ask = (n: number, since: string): PendingItem => ({ id: `ms_x:${n}`, kind: "ask", state: "open", milestoneId: "ms_x", title: `Ask number ${n}`, since }) as PendingItem;
const batch = (items: PendingItem[]): StatusBatch => ({ milestones: [], items, needsYou: items.length, at: new Date().toISOString() });
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

let reviews: ReviewItem[] = [];
let asks: PendingItem[] = [];
let answers: { target: string; at: string; action: string; state: string }[] = [];
beforeEach(() => {
  localStorage.clear();
  forgetWorld();
  forgetOtherWorlds();
  // three cards that reached him a day ago, and one ask; the server keeps listing all of them (their next round is not back)
  reviews = [card("button", ago(24 * H)), card("text", ago(24 * H)), card("other", ago(24 * H))];
  asks = [ask(1, ago(24 * H)), ask(2, ago(24 * H))];
  vi.spyOn(api, "listReviewItems").mockImplementation(((q?: { state?: string }) => Promise.resolve(q?.state ? [] : reviews)) as never);
  vi.spyOn(api, "listStatus").mockImplementation(() => Promise.resolve(batch(asks)));
  vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue([]);
  answers = [];
  api.listAnsweredPresses = () => Promise.resolve({ since: ago(14 * 24 * H), answers });
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
const drawn = (slot: string) => !!document.querySelector(`[data-inbox-card="${slot}"]`);
/** the asks Blocked on you lists (a status row or its card): the red section's own count, checked against its rows */
const asksOpen = () => pill("waiting-on-you");
const pill = (id: string) => document.querySelector(`[data-testid="${id}-count"]`)?.textContent;
/** his three answers, made `ms` ago in this browser: a button, his typed words, a voice note (its spinning row, then Sent) */
const answerAll = (ms: number) => {
  const real = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(real - ms);
  act(() => {
    markSent("review:rv_button", { said: "Closed", title: "Finished work button." });
    markSent("review:rv_text", { said: "Changes sent to the team", title: "Finished work text." });
    markSent("ask:ms_x:1", { said: "Voice note", title: "Ask number 1", voice: "note_1" });
    markSent("ask:ms_x:1", { said: "Voice note sent", title: "Ask number 1" });
  });
  clock.mockRestore();
};

describe("a card he answered leaves his inbox and stays gone until it comes back", () => {
  it("voice, text and button: gone at once, and still gone three hours later while the server lists them", async () => {
    answerAll(0);
    inbox();
    openAll();
    await waitFor(() => expect(drawn("review:rv_other")).toBe(true));
    expect(drawn("review:rv_button")).toBe(false);
    expect(drawn("review:rv_text")).toBe(false);
    await waitFor(() => expect(asksOpen()).toBe("1"));
    cleanup();
    resetSent();
    resetReviewGone();

    // the same three answers, made three hours ago (past the two hours a Sent mark used to live): still gone
    answerAll(3 * H);
    expect(3 * H).toBeGreaterThan(SENT_KEEP_MS);
    inbox();
    openAll();
    await waitFor(() => expect(drawn("review:rv_other")).toBe(true));
    await waitFor(() => expect(pill("waiting-for-review")).toBe("1"));
    expect(drawn("review:rv_button")).toBe(false);
    expect(drawn("review:rv_text")).toBe(false);
    await waitFor(() => expect(asksOpen()).toBe("1"));
    // no green Sent row for an answer that old either: nothing of it is in his inbox
    expect(document.querySelectorAll('[data-testid="sent-row"]').length).toBe(0);
  });

  it("answered on another device three hours ago (the server's press log): gone here too", async () => {
    answers = [
      { target: "rv_button", at: ago(3 * H), action: "review complete", state: "landed" },
      { target: "rv_text", at: ago(3 * H), action: "review feedback", state: "landed" },
      { target: "ms_x:1", at: ago(3 * H), action: "ask answer", state: "landing" },
    ];
    inbox();
    openAll();
    await waitFor(() => expect(pill("waiting-for-review")).toBe("1"));
    expect(drawn("review:rv_button")).toBe(false);
    expect(drawn("review:rv_text")).toBe(false);
    await waitFor(() => expect(asksOpen()).toBe("1"));
  });

  it("it comes back only when its owner sends it back: the server dates it after his answer", async () => {
    answerAll(3 * H);
    // the owner sent the text card's next round an hour ago, and asked ask 1 again: both are his again; the button card is not
    reviews = [card("button", ago(24 * H)), card("text", ago(H)), card("other", ago(24 * H))];
    asks = [ask(1, ago(H)), ask(2, ago(24 * H))];
    inbox();
    openAll();
    await waitFor(() => expect(drawn("review:rv_text")).toBe(true));
    await waitFor(() => expect(asksOpen()).toBe("2"));
    expect(drawn("review:rv_button")).toBe(false);
    await waitFor(() => expect(pill("waiting-for-review")).toBe("2"));
  });
});

describe("a press never spins on", () => {
  afterEach(() => vi.useRealTimers());
  it("still not written 30 s after it was saved: one plain 'late' note with the reason, then Done when it lands", async () => {
    vi.useFakeTimers();
    const notes: PressNote[] = [];
    const off = onPress((n) => notes.push(n));
    let landedNow = false;
    const get = vi.fn(async () =>
      landedNow ? { id: "pr_1", state: "landed" as const, response: { ok: true } } : { id: "pr_1", state: "landing" as const, reason: "not written: the checkout has uncommitted changes" },
    );
    const p = landed<{ ok: boolean }>({ press: { id: "pr_1", state: "landing" } }, "/review-items/rv_x/complete", get, (m) => new Error(m));
    await vi.advanceTimersByTimeAsync(PRESS_LATE_MS - 1_000);
    expect(notes.map((n) => n.state)).toEqual(["landing"]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(notes.map((n) => n.state)).toEqual(["landing", "late"]);
    expect(notes[1].reason).toMatch(/uncommitted/);
    // asked again and again (the console retries): said once, not every poll
    await vi.advanceTimersByTimeAsync(20_000);
    expect(notes.filter((n) => n.state === "late")).toHaveLength(1);
    landedNow = true;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await p).toEqual({ ok: true });
    expect(notes.map((n) => n.state)).toEqual(["landing", "late", "landed"]);
    off();
  });
});
