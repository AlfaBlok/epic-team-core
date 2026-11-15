// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { CARD_TYPES } from "@/components/cardInventory";
import { forgetWorld } from "@/lib/useSocial";
import { clearAnswerVoiceState } from "@/voice/AnswerVoice";
import { forgetDeskVoiceWorld } from "@/voice/deskBase";

// The owner 2026-11-14 23:43Z: on every inbox card the link to check sits ABOVE the decision
// buttons, phone and computer, so he sees the thing before he decides. Every card kind of Every card type renders here;
// no link of the card may come after its first answer button (the feedback block at its end and folded details aside).

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

beforeEach(() => {
  forgetWorld();
  forgetDeskVoiceWorld();
  clearAnswerVoiceState();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const json = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
      if (String(url).endsWith("/voice/state")) return json({ enabled: true, monthUsd: 0.2, limits: { monthCapUsd: 25 } });
      return json({ error: { message: "not faked" } }, 404);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const after = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("the link to check comes before the buttons on every card kind", () => {
  for (const c of CARD_TYPES)
    it(`${c.name}: no card link below its answer buttons`, () => {
      const { container } = render(<MemoryRouter>{c.render()}</MemoryRouter>);
      const root = container.firstElementChild as HTMLElement;
      const aside = (e: Element) => !!e.closest("[data-card-feedback], [data-testid='review-more'], details, [data-testid='card-foot']");
      // the card's answer: its follow-up switches or its buttons row, else its first card button outside the meta line
      const first =
        root.querySelector("[data-testid='review-next'], [data-testid='review-buttons'], [data-testid='answer-buttons']") ??
        [...root.querySelectorAll("[data-card-button]")].find((b) => !aside(b) && !b.closest("[data-card-meta]"));
      if (!first) return;
      const below = [...root.querySelectorAll("a[href]")].filter((a) => !aside(a) && after(first, a));
      expect(below.map((a) => a.textContent?.trim()), "a link sits under the card's buttons").toEqual([]);
    });

  it("the review card's green link is its own line above the decision and the buttons", () => {
    for (const id of ["review", "review-decision", "review-next-steps", "review-switches"]) {
      const c = CARD_TYPES.find((t) => t.id === id);
      if (!c) continue;
      const { container, unmount } = render(<MemoryRouter>{c.render()}</MemoryRouter>);
      const go = container.querySelector("[data-testid='review-go']")!;
      const buttons = container.querySelector("[data-testid='review-buttons']")!;
      expect(go, id).toBeTruthy();
      expect(buttons.contains(go), `${id}: the link is inside the buttons row`).toBe(false);
      expect(after(go, buttons), `${id}: the link is not above the buttons`).toBe(true);
      const decision = container.querySelector("[data-testid='review-decision']");
      if (decision) expect(after(go, decision), `${id}: the link is not above the decision`).toBe(true);
      unmount();
    }
  });

  it("an ask card's green link is its own line above its answer buttons", () => {
    const c = CARD_TYPES.find((t) => t.id === "do")!;
    const { container } = render(<MemoryRouter>{c.render()}</MemoryRouter>);
    const buttons = container.querySelector("[data-testid='answer-buttons']")!;
    const go = container.querySelector("[data-testid='card-go']")!;
    expect(go?.textContent).toContain("Open the steps");
    expect(buttons.contains(go)).toBe(false);
    expect(after(go, buttons)).toBe(true);
  });

  // The owner 2026-11-15 00:0xZ: "Why are the buttons so separated from the feedback? Isn't the feedback one of the options of
  // the buttons? Why is there something in between?": the buttons and the feedback box are one group, nothing with words between.
  for (const c of CARD_TYPES)
    it(`${c.name}: nothing with words between its buttons and its feedback box`, () => {
      const { container } = render(<MemoryRouter>{c.render()}</MemoryRouter>);
      const root = container.firstElementChild as HTMLElement;
      const blocks = [...root.querySelectorAll<HTMLElement>("[data-card-feedback]")];
      const block = blocks[blocks.length - 1];
      if (!block) return;
      const btns = [...root.querySelectorAll("[data-card-button]")].filter((b) => !block.contains(b) && !b.closest("[data-card-meta]") && after(b, block));
      const last = btns[btns.length - 1];
      if (!last) return;
      const between = [...root.querySelectorAll<HTMLElement>("*")].filter(
        (e) => e.children.length === 0 && (e.textContent ?? "").trim() && !last.contains(e) && !block.contains(e) && after(last, e) && after(e, block) && !e.closest("[data-card-button]"),
      );
      expect(between.map((e) => e.textContent?.trim()), "words sit between the buttons and the feedback box").toEqual([]);
    });
});
