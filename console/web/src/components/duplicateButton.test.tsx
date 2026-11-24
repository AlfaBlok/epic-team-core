// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type PendingItem, type ReviewItem } from "@/api";
import type { CardFace } from "@/api/review-types";
import { ACTION } from "@/components/cardActions";
import { sampleAsk } from "@/components/cardInventory";
import { WaitingForReview } from "@/components/review";
import { StatusItemRow, WaitingCard } from "@/components/waiting";
import { resetReviewGone } from "@/lib/inbox";

/**
 * E948-S139 (the owner's voice note, 24 Nov 20:37Z): "Give me a button. That's it Duplicate or already answered". Every card
 * in his inbox (an ask, a status card of an ask, a review card) has it; one tap closes it as answered.
 */
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), { status: 404, headers: { "content-type": "application/json" } })));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetReviewGone();
});

const LABEL = "Duplicate or already answered";
const answered = { id: "jr_1" } as Awaited<ReturnType<typeof api.respondToWaiting>>;

describe("Duplicate or already answered on every inbox card (E948-S139)", () => {
  it("the label is his words", () => {
    expect(ACTION.duplicate.label).toBe(LABEL);
    expect(ACTION.duplicate.words).toBe("duplicate or already answered");
  });

  it("an ask card closes in one tap, as an answer with those words", async () => {
    render(
      <MemoryRouter>
        <WaitingCard item={sampleAsk({ id: "w_dup", ask: "approve", question: "Do you approve a second WhatsApp number for the desk?" })} />
      </MemoryRouter>,
    );
    const spy = vi.spyOn(api, "respondToWaiting").mockResolvedValue(answered);
    const b = screen.getByTestId("card-duplicate");
    expect(b.textContent).toContain(LABEL);
    fireEvent.click(b);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0]![0]).toBe("w_dup");
    expect(spy.mock.calls[0]![1]).toMatchObject({ kind: "answer", text: "duplicate or already answered", wake: true });
  });

  it("a status card of an ask has it too", async () => {
    const held: PendingItem = { id: "ask:acme:E907-A3", kind: "ask", state: "open", milestoneId: "ms_1", ask: "decide", code: "E907-A3", repo: "acme", title: "E907-S2 numbers", question: "You decide: how do the two desks get their own WhatsApp numbers? Why: one each." };
    render(
      <MemoryRouter>
        <StatusItemRow item={held} />
      </MemoryRouter>,
    );
    const spy = vi.spyOn(api, "respondToWaiting").mockResolvedValue(answered);
    fireEvent.click(screen.getByTestId("card-duplicate"));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0]![1]).toMatchObject({ kind: "answer", text: "duplicate or already answered", milestoneId: "ms_1" });
  });

  it("a review card closes in one tap through the duplicate route", async () => {
    const face: CardFace = {
      project: { name: "TEST Epic Team", url: "https://team.example.com/" },
      goal: { text: "We want one card per question.", code: "PLAN-990" },
      tasks: { done: 0, total: 1 },
      title: "The sidebar now shows every project and its unread count.",
      taskGoal: "We want one card per question.",
      delivered: [{ ok: true, text: "The sidebar is live." }],
      evidence: { url: "https://team.example.com/", label: "Open the sidebar" },
      screenshot: "docs/status/test.png",
      tree: [],
      after: "",
      next: [],
      closesGoal: false,
      openInGoal: [],
    };
    const item: ReviewItem = { id: "rv_dup", title: "TEST card", liveUrl: "https://team.example.com/", ref: "T990-B3", repo: "e67-feedback-test", path: "docs/spines/dup.md", milestoneId: "ms_t", state: "review", status: "review", liveStatus: 200, checkedAt: "2026-11-24T17:00:00Z", createdAt: "2026-11-24", verdict: { kind: "card" }, face };
    vi.spyOn(api, "listReviewItems").mockImplementation(async (q?: { state?: string }) => (q?.state ? [] : [item]));
    const spy = vi.spyOn(api, "duplicateReviewItem").mockResolvedValue({ ...item, state: "denied" });
    render(
      <MemoryRouter>
        <WaitingForReview fold="review" />
      </MemoryRouter>,
    );
    const card = await screen.findByTestId("review-card");
    const b = within(card).getByTestId("card-duplicate");
    expect(b.textContent).toContain(LABEL);
    fireEvent.click(b);
    await waitFor(() => expect(spy).toHaveBeenCalledWith("rv_dup", ""));
  });
});
