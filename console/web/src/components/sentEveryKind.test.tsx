// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { CARD_TYPES } from "@/components/cardInventory";
import { forgetWorld } from "@/lib/useSocial";
import { clearAnswerVoiceState } from "@/voice/AnswerVoice";
import { forgetDeskVoiceWorld } from "@/voice/deskBase";
import { markSent, resetSent } from "@/lib/sentRows";
import { api } from "@/api";

// E948-S130 (the owner 17 Nov 17:28Z, vn_4f13161d: "after a text is sent, it ... collapses and remains there for you to add
// things. Is this happening to all cards or only in the cards that are review? Because on decisions waiting on you, done,
// and blocked on you, basically all cards should have the same behavior"): every card type in the inventory, once his
// words are sent from its feedback box, is one green Sent row with Add comment, in the card's place.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

/** whatever route a card's Send takes, the console says it took his words (sent, written). */
const TOOK = { id: "jr_test", itemId: "x", kind: "feedback", text: "t", delivery: "sent", createdAt: "2026-11-17T18:00:00Z", spine: { status: "written", sha: "abc1234" }, reads: [], threadId: "t", pending: false, ok: true };

beforeEach(() => {
  forgetWorld();
  forgetDeskVoiceWorld();
  clearAnswerVoiceState();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const json = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
      if (String(url).endsWith("/voice/state")) return json({ enabled: true, monthUsd: 0.2, limits: { monthCapUsd: 25 } });
      if ((init?.method ?? "GET") !== "GET") {
        // a team card's answer comes back as the card
        if (/\/team-cards\//.test(String(url))) return json({ card: { id: "tc", kind: "idea", title: "t", at: "2026-11-17T18:00:00Z", answer: { text: "t", via: "text", at: "2026-11-17T18:00:00Z" } } });
        return json(TOOK, 201);
      }
      return json({ error: { message: "not faked" } }, 404);
    }),
  );
  // the tests' client is the mock: every route a card's Send takes answers that it took his words
  const a = api as unknown as Record<string, unknown>;
  for (const m of ["respondToWaiting", "commentClosedCard", "sendDeskMessage", "sendWorldDeskMessage", "relaunchReviewItem", "stepTick"]) vi.spyOn(a as never, m as never).mockResolvedValue(TOOK as never);
  vi.spyOn(api, "advisorVerdict").mockImplementation(async (id: string) => ({ card: { id, kind: "advisor", title: "t", at: "2026-11-17T18:00:00Z" } }) as never);
  vi.spyOn(api, "readSpokenAnswers").mockResolvedValue({ reads: [] } as never);
  vi.spyOn(api, "answerTeamCard").mockImplementation(async (id: string) => ({ card: { id, kind: "idea", title: "t", at: "2026-11-17T18:00:00Z", answer: { text: "t", via: "text", at: "2026-11-17T18:00:00Z" } } }) as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("E948-S130 every card kind collapses to its Sent row after his words", () => {
  for (const c of CARD_TYPES)
    it(`${c.name}: Send turns it into one green Sent row with Add comment`, async () => {
      const { container } = render(<MemoryRouter>{c.render()}</MemoryRouter>);
      const root = container.firstElementChild as HTMLElement;
      const blocks = [...root.querySelectorAll<HTMLElement>("[data-card-feedback]")];
      const block = blocks[blocks.length - 1];
      fireEvent.change(within(block).getByRole("textbox"), { target: { value: "Please also add the date on it." } });
      const send = block.querySelector<HTMLButtonElement>("[data-feedback-send]")!;
      await waitFor(() => expect(send.disabled).toBe(false));
      fireEvent.click(send);
      const row = await within(container).findByTestId("sent-row", {}, { timeout: 3000 });
      expect(within(row).getByTestId("sent-row-word").textContent).toContain("Sent");
      expect(within(row).getByTestId("sent-row-comment")).toBeTruthy();
      // the card he wrote on is gone (a set of suggestions keeps its other cards, each its own)
      expect(block.isConnected).toBe(false);
      expect(container.querySelectorAll("[data-card-feedback]").length).toBeLessThan(blocks.length);
    });
});

describe("E948-S130 a Sent row stays after a reload", () => {
  it("the store keeps every Sent row (without its Bring it back) and a fresh page reads it back", async () => {
    resetSent();
    markSent("review:rv_1", { said: "Closed", title: "The Notes logo was made.", card: { kind: "review", repo: "r", path: "p", ref: "E907-S3" }, back: async () => ({ back: true, line: "" }) });
    vi.resetModules();
    const fresh = await import("@/lib/sentRows");
    const e = fresh.sentOf("review:rv_1");
    expect(e?.said).toBe("Closed");
    expect(e?.card?.ref).toBe("E907-S3");
    expect(e?.back).toBeUndefined();
  });

  it("a list keeps a sent card's place across a reload: after the card that was before it", async () => {
    vi.resetModules();
    const { renderHook } = await import("@testing-library/react");
    const { useKeepSent, markSent, resetSent } = await import("@/lib/sentRows");
    resetSent();
    const slot = (x: string) => `ask:${x}`;
    const a = renderHook(({ items }) => useKeepSent(items, slot, "test-list"), { initialProps: { items: ["a", "b", "c"] } });
    markSent("ask:b", { said: "Approved", title: "B" });
    a.rerender({ items: ["a", "b", "c"] });
    a.unmount();
    vi.resetModules();
    const fresh = await import("@/lib/sentRows");
    // the reload: the list no longer has b (it was answered); its Sent row comes back between a and c
    const b = renderHook(({ items }) => fresh.useKeepSent(items, slot, "test-list"), { initialProps: { items: ["a", "c"] } });
    expect(b.result.current.map((r) => r.slot)).toEqual(["ask:a", "ask:b", "ask:c"]);
    expect(b.result.current[1].sent?.said).toBe("Approved");
  });
});

describe("E948-S130 a Decision's option press collapses like every other press", () => {
  it("a finished piece that asks a decision: its option button turns the card into a Sent row saying the option", async () => {
    vi.spyOn(api, "completeReviewItem").mockResolvedValue({ state: "approved" } as never);
    const decisions = CARD_TYPES.filter((c) => c.component === "ReviewCard");
    let pressed = 0;
    for (const c of decisions) {
      const { container, unmount } = render(<MemoryRouter>{c.render()}</MemoryRouter>);
      const choice = container.querySelector<HTMLButtonElement>("[data-testid=review-choice]");
      if (!choice) {
        unmount();
        continue;
      }
      const label = choice.textContent?.trim();
      fireEvent.click(choice);
      const row = await within(container).findByTestId("sent-row");
      expect(within(row).getByTestId("sent-row-said").textContent).toBe(label);
      pressed++;
      unmount();
      resetSent();
    }
    expect(pressed, "no decision card in the inventory").toBeGreaterThan(0);
  });
});

describe("E948-S130 the last card of a list, answered, keeps its Sent row after a reload", () => {
  it("the refetch empties the list before the press marks it: the place is still kept", async () => {
    vi.resetModules();
    const { renderHook } = await import("@testing-library/react");
    const { useKeepSent, markSent, resetSent } = await import("@/lib/sentRows");
    resetSent();
    const slot = (x: string) => `ask:${x}`;
    const a = renderHook(({ items }) => useKeepSent(items, slot, "only-one"), { initialProps: { items: ["t"] } });
    a.rerender({ items: [] as string[] }); // the refetch came first: the answered card left the list
    markSent("ask:t", { said: "Changes sent to the team", title: "T" });
    a.rerender({ items: [] as string[] });
    expect(a.result.current.map((r) => r.slot)).toEqual(["ask:t"]);
    a.unmount();
    vi.resetModules();
    const fresh = await import("@/lib/sentRows");
    const b = renderHook(() => fresh.useKeepSent([] as string[], slot, "only-one"));
    expect(b.result.current.map((r) => r.slot)).toEqual(["ask:t"]);
  });
});
