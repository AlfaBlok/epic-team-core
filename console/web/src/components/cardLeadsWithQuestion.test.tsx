// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { PendingItem } from "@/api";
import { CARD_TYPES } from "@/components/cardInventory";
import { StatusItemRow } from "@/components/waiting";
import { reviewQuestion, statusQuestion } from "@/lib/pending";

/**
 * E948-S198 (the owner 24 Nov 14:12Z, vn_c408c78f, with a phone screenshot of the E907-S32 card): "it's usually a question
 * ... there is no question, you really need to see the question mark". Every card leads with one plain question ending
 * in "?", never the row's internal line.
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
  vi.unstubAllGlobals();
});

const ROW_LINE =
  "E907-S32 Acme testers can import an existing Obsidian brain into their memory. Core: changes app: His voice note vn_aa7447c3 on E907-A42 (24 Nov): a tester may already have an Obsidian vault; today the UX does not help them import it. Add an import path and show it.";

// the card on his phone: ask E907-A43, held from the card list, drawn from the status batch with the row's line as title
const heldAsk: PendingItem = {
  id: "ask:acme:E907-A43",
  kind: "ask",
  state: "open",
  milestoneId: "ms_802bd66d-1002-4ba7-bf9f-f44aad4d7a56",
  ask: "approve",
  code: "E907-A43",
  repo: "acme",
  title: ROW_LINE,
  question:
    "You approve: one private test notes repo and a token for it, used only by our staging copy of Acme. Why: today staging has no storage, so we cannot try memory changes like the Obsidian import end to end before they reach testers. — context: the import was proven on a copy of the build on our server",
};

describe("every card leads with its question (E948-S198)", () => {
  it("the E907-S32 status card shows a plain question, never the raw row line", () => {
    render(
      <MemoryRouter>
        <StatusItemRow item={heldAsk} />
      </MemoryRouter>,
    );
    const q = screen.getByTestId("status-item-question").textContent ?? "";
    expect(q).toBe("Do you approve one private test notes repo and a token for it, used only by our staging copy of Acme?");
    const card = screen.getByTestId("status-item").textContent ?? "";
    expect(card).not.toContain("E907-S32");
    expect(card).not.toContain("Core: changes");
    expect(card).not.toContain("vn_aa7447c3");
    expect(screen.getByTestId("status-item-why").textContent).toMatch(/^Why: Today staging has no storage/);
  });

  it("a status card with no question of its own gets one built from its card, never its row line", () => {
    for (const kind of ["ask", "needs_jordi", "mark_ready", "failed_run", "free_text_ask", "stalled"] as const) {
      const { question } = statusQuestion({ kind, title: ROW_LINE });
      expect(question.endsWith("?"), `${kind}: ${question}`).toBe(true);
      expect(question, kind).not.toMatch(/E907-S32|Core:|vn_/);
    }
    // the stalled-team card asks his own words (E948-S204, replacing its old "… Switch on Delivery Manager?" line)
    expect(statusQuestion({ kind: "stalled", title: "3 open items to work, nobody on. Switch on Delivery Manager?" }).question).toBe("Should a team member work on it?");
    // a line that already asks in plain words keeps them
    expect(statusQuestion({ kind: "ready_to_mark", title: "Is Market entry signals finished?" }).question).toBe("Is Market entry signals finished?");
    // an ask that already asks keeps its own question
    expect(
      statusQuestion({ kind: "ask", ask: "decide", title: ROW_LINE, question: "http://x.example/#pick : You decide: how do the two desks get their own WhatsApp numbers? Why: one per desk." }).question,
    ).toBe("How do the two desks get their own WhatsApp numbers?");
  });

  it("a review card's first line is its decision's question; without one it is built from its title", () => {
    expect(reviewQuestion({ decision: "Is this the import you meant for testers? Recommend yes.", title: "An import was added." })).toBe("Is this the import you meant for testers?");
    const built = reviewQuestion({ decision: "Recommend yes.", title: "An Obsidian import was added so testers start with their whole vault." });
    expect(built).toBe("Is this what you asked for: an Obsidian import was added so testers start with their whole vault?");
    const c = CARD_TYPES.find((t) => t.id === "review")!;
    const { container } = render(<MemoryRouter>{c.render()}</MemoryRouter>);
    const card = container.querySelector("[data-testid='review-card']")!;
    const lead = card.querySelector("[data-testid='review-question']")!;
    expect(lead.textContent?.trim().endsWith("?")).toBe(true);
    // it comes before the title and every other line of the card's body
    const title = card.querySelector("[data-testid='review-title']")!;
    expect(lead.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
