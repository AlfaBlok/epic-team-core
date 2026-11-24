// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type PendingItem } from "@/api";
import { sampleAsk } from "@/components/cardInventory";
import { StatusItemRow, WaitingCard } from "@/components/waiting";
import { isYesNo, yesNoQuestion } from "@/lib/yesNo";

/**
 * E948-S200 (the owner closed E948-S109 24 Nov and started this follow-up): a yes-or-no card's buttons say Yes and No, not
 * Answer. The E907-S32 card asked "Do you approve one private test notes repo …?" and offered only Answer.
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
});

// the card on his phone: ask E907-A43, held, drawn from the status batch
const heldAsk: PendingItem = {
  id: "ask:acme:E907-A43",
  kind: "ask",
  state: "open",
  milestoneId: "ms_1",
  ask: "approve",
  code: "E907-A43",
  repo: "acme",
  title: "E907-S32 Acme testers can import an existing Obsidian brain. Core: changes app",
  question: "You approve: one private test notes repo and a token for it, used only by our staging copy of Acme. Why: today staging has no storage.",
};

const labels = (root: ParentNode) => [...root.querySelectorAll("button, a")].map((b) => (b.textContent ?? "").trim()).filter(Boolean);

describe("a yes-or-no card says Yes and No, never only Answer (E948-S200)", () => {
  it("tells a yes or no question from a pick question", () => {
    expect(yesNoQuestion("You check: does the page read clearly now? Why: you asked.")).toBe("does the page read clearly now?");
    expect(isYesNo("Do you approve one private test notes repo and a token for it?")).toBe(true);
    expect(isYesNo("http://x.example/#pick : You decide: how do the two desks get their own WhatsApp numbers?")).toBe(false);
    expect(isYesNo("Offer both ways, or AI included only?")).toBe(false);
    expect(isYesNo("You give: the most you would spend. Why: the trip.")).toBe(false);
  });

  it("the E907-S32 status card answers its question with Yes and No, and keeps the whole card and a note", async () => {
    render(
      <MemoryRouter>
        <StatusItemRow item={heldAsk} />
      </MemoryRouter>,
    );
    const card = screen.getByTestId("status-item");
    expect(screen.getByTestId("status-item-question").textContent).toMatch(/^Do you approve one private test notes repo/);
    expect(screen.getByTestId("yes").textContent).toContain("Yes: go ahead");
    expect(screen.getByTestId("no").textContent).toContain("No: drop it");
    expect(screen.getByTestId("status-open-card").textContent).toBe("Open the whole card");
    expect(labels(card)).not.toContain("Answer");
    // a free note stays: the card's words box (Voice · Text)
    expect(card.textContent).toMatch(/Voice|Text|note/i);
    const spy = vi.spyOn(api, "respondToWaiting").mockResolvedValue({ id: "jr_1" } as Awaited<ReturnType<typeof api.respondToWaiting>>);
    fireEvent.click(screen.getByTestId("yes"));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0]![0]).toBe("ask:acme:E907-A43");
    expect(spy.mock.calls[0]![1]).toMatchObject({ kind: "approve", milestoneId: "ms_1" });
  });

  it("a status card whose ask is a pick question keeps its one link", () => {
    render(
      <MemoryRouter>
        <StatusItemRow item={{ ...heldAsk, ask: "decide", question: "You decide: how do the two desks get their own WhatsApp numbers? Why: one each." }} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("yes")).toBeNull();
    expect(labels(screen.getByTestId("status-item"))).toContain("Answer");
  });

  it("a full card whose long question is cut in its heading still shows Yes and No", () => {
    const long = "You check: does the new import page read clearly for a tester who has never used Obsidian before and only has a folder of notes? Why: testers start next week.";
    const { container } = render(
      <MemoryRouter>
        <WaitingCard item={sampleAsk({ id: "w_long", ask: "unknown", question: long, options: undefined, recommendation: undefined })} />
      </MemoryRouter>,
    );
    const buttons = labels(container);
    expect(buttons).toContain("Yes: go ahead");
    expect(buttons).toContain("No: drop it");
  });
});
