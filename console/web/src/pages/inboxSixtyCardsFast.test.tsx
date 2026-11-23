// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type PendingItem, type ReviewItem, type StatusBatch, type WaitingItem } from "@/api";
import { TeamPage } from "@/pages/Team";
import { forgetOtherWorlds } from "@/components/otherWorlds";
import { sampleAsk, sampleReview } from "@/components/cardInventory";
import { forgetWorld } from "@/lib/useSocial";
import { resetSnoozes } from "@/lib/snooze";
import { ProjectProvider } from "@/lib/project";
import { SKINS, SkinProvider } from "@/lib/skin";

/**
 * E948-S192, his words 23 Nov 12:04Z: "It actually did load just slowly? Can you check yourself and time for inbox when 50
 * items plus?" Timed on a phone profile with his 74 cards: the first card showed 7 s after the address opened, 1.8 s of
 * it the one-card-per-topic check run again by every section, the top bar and the sidebar, each pair of cards parsing
 * every link again. A 60-card inbox (decision asks with links and About lines, review cards with evidence) draws every
 * section with its cards inside the budget.
 */
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

// every card its own topic (nothing folds, all 60 draw); the check still compares every pair
const topics = ["kernel", "acme", "vault", "inbox", "browser", "disk"];
const word = (n: number) => `w${n.toString(36)}x${(n * 7919).toString(36)}`;
const ask = (n: number): WaitingItem =>
  sampleAsk({
    id: `wj_${n}`,
    code: `E9${n % 7}0-A${n}`,
    row: `E9${n % 7}0-S${n}`,
    ask: "decide",
    about: `${topics[n % topics.length]} ${word(n)} ${word(n + 500)}`,
    question: `Do we ship step ${n}? See http://host1.example.com:${9000 + n}/ and https://console.example.com/inbox?focus=${n}`,
    contextLinks: [{ url: `http://host1.example.com:${9300 + n}/`, label: "page" }],
    since: new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString(),
  } as Partial<WaitingItem>);
const review = (n: number): ReviewItem => {
  const r = sampleReview();
  return sampleReview({
    id: `rv_${n}`,
    ref: `E8${n % 5}0-S${n}`,
    liveUrl: `http://host1.example.com:${9400 + n}/`,
    face: { ...r.face!, title: `Finished work number ${n} was made.`, about: `${topics[(n + 2) % topics.length]} ${word(n + 1000)} ${word(n + 1500)}`, evidence: { url: `http://host1.example.com:${9600 + n}/#a`, label: "Open it" } },
  } as Partial<ReviewItem>);
};
const ASKS = Array.from({ length: 20 }, (_, n) => ask(n));
const REVIEWS = Array.from({ length: 40 }, (_, n) => review(n));
const pending = (id: string): PendingItem => ({ id, kind: "ask", state: "open", milestoneId: "ms_sample", title: `row of ${id}` });
const batch = (items: PendingItem[]): StatusBatch => ({ milestones: [], items, needsYou: items.length, at: "2026-11-23T12:00:00Z" });

beforeEach(() => {
  localStorage.clear();
  forgetWorld();
  forgetOtherWorlds();
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(api, "listWaitingOnOwner").mockResolvedValue(ASKS);
  vi.spyOn(api, "listStatus").mockResolvedValue(batch(ASKS.map((a) => pending(a.id))));
  vi.spyOn(api, "listReviewItems").mockImplementation(((q?: { state?: string }) => Promise.resolve(q?.state ? [] : REVIEWS)) as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  forgetOtherWorlds();
  resetSnoozes();
});

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

/** jsdom is several times slower than a browser; the whole draw, data already in (old fold code: 4.3 s here, new: 1.6 s) */
const BUDGET_MS = 3000;
const CARDS = `[data-review-id], [data-testid="waiting-card"]`;

describe("E948-S192 an inbox of 60 cards draws inside the budget", () => {
  it("draws every section with its cards", async () => {
    inbox(); // warm the modules and the JIT, as a browser has parsed the app before it draws
    await waitFor(() => expect(document.querySelector('[data-testid="inbox-stack"]')?.getAttribute("data-ready")).toBe("yes"), { timeout: 20000 });
    cleanup();
    const t0 = performance.now();
    inbox();
    await waitFor(() => expect(document.querySelector('[data-testid="inbox-stack"]')?.getAttribute("data-ready")).toBe("yes"), { timeout: 20000 });
    // every section opened, as he reads it
    for (let k = 0; k < 2; k++)
      for (const t of document.querySelectorAll('[data-fold-section] [aria-expanded="false"]')) fireEvent.click(t);
    await waitFor(() => expect(document.querySelectorAll(CARDS).length).toBeGreaterThanOrEqual(60), { timeout: 20000 });
    const ms = performance.now() - t0;
    expect(document.querySelectorAll(CARDS).length).toBeGreaterThanOrEqual(60);
    expect(ms).toBeLessThan(BUDGET_MS);
  }, 60000);
});
