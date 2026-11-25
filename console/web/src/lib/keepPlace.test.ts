// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GAP, holdAfterAnswer, installKeepPlace, keepPlace, keptPlace, landFoldedSection, landingTop, resetKeepPlace, scrollDelta, SETTLE_MS, stopHold } from "./keepPlace";

/**
 * after a card leaves the Team inbox, the next card's top lands where the old card's top was (or just under the
 * top bar when the old card started above the screen), smoothly; the last card lands on the next section's header.
 * jsdom has no layout: each element's page position is `data-y`, its height `data-h`; the page scroll is `scrolled`.
 */
let scrolled = 0;
const scrollBy = vi.fn((o: ScrollToOptions) => {
  scrolled += o.top ?? 0;
});

/** Lay the page out top to bottom: each child of a list takes its height plus an 18 px gap (the review feed's). */
function layout() {
  let y = 0;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-h]"))) {
    el.dataset.y = String(y);
    y += Number(el.dataset.h) + 18;
  }
}

function page(cards: { id: string; h: number }[], after = true) {
  document.body.innerHTML = `
    <header data-testid="topbar" data-fixed="52"></header>
    <section data-fold-section data-testid="blocked"><ul>${cards.map((c) => `<li data-inbox-card="ask:${c.id}" data-h="${c.h}"><button>Approve</button></li>`).join("")}</ul></section>
    ${after ? `<section data-fold-section data-testid="waiting-for-review" data-h="40"></section>` : ""}`;
  layout();
}

const leave = async (id: string) => {
  document.querySelector(`[data-inbox-card="ask:${id}"]`)!.remove();
  layout();
  await new Promise((r) => setTimeout(r, SETTLE_MS + 60));
};
const press = (id: string) => document.querySelector(`[data-inbox-card="ask:${id}"] button`)!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
const topOf = (id: string) => Number(document.querySelector<HTMLElement>(`[data-inbox-card="ask:${id}"]`)!.dataset.y) - scrolled;

let off: () => void;
let reduce = false;
beforeEach(() => {
  scrolled = 0;
  scrollBy.mockClear();
  reduce = false;
  window.scrollBy = scrollBy as unknown as typeof window.scrollBy;
  window.matchMedia = ((q: string) => ({ matches: reduce && q.includes("reduce") })) as unknown as typeof window.matchMedia;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const el = this as HTMLElement;
    if (el.dataset.fixed) return { top: 0, bottom: Number(el.dataset.fixed) } as DOMRect;
    const top = Number(el.dataset.y ?? 0) - scrolled;
    return { top, bottom: top + Number(el.dataset.h ?? 0) } as DOMRect;
  });
  off = installKeepPlace();
});
afterEach(() => {
  stopHold();
  off();
  resetKeepPlace();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("T72-S17 keep his place when a card leaves", () => {
  it("lands where the old card's top was, or just under the top bar when it started above the screen", () => {
    expect(landingTop(300, 52)).toBe(300);
    expect(landingTop(-400, 52)).toBe(52 + GAP);
    expect(scrollDelta(310, 300)).toBe(10);
    expect(scrollDelta(301, 300)).toBe(0);
  });

  it("a long card he answered at its buttons: the next card's top lands under the top bar, smoothly", async () => {
    page([
      { id: "a", h: 1200 },
      { id: "b", h: 600 },
      { id: "c", h: 600 },
    ]);
    scrolled = 900; // he reads card a's buttons, its top is far above the screen
    press("a");
    expect(keptPlace()?.id).toBe("ask:a");
    await leave("a");
    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollBy.mock.calls[0][0].behavior).toBe("smooth");
    expect(topOf("b")).toBe(52 + GAP);
  });

  it("a card whose top was on the screen: the next card's top lands at that same spot", async () => {
    page([
      { id: "a", h: 200 },
      { id: "b", h: 300 },
      { id: "c", h: 300 },
    ]);
    scrolled = 100;
    press("b");
    const was = topOf("b");
    await leave("b");
    expect(topOf("c")).toBe(was);
  });

  it("the last card of a list lands on the next section's header", async () => {
    page([
      { id: "a", h: 300 },
      { id: "b", h: 900 },
    ]);
    scrolled = 700;
    press("b");
    await leave("b");
    const header = document.querySelector<HTMLElement>('[data-testid="waiting-for-review"]')!;
    expect(Number(header.dataset.y) - scrolled).toBe(52 + GAP);
  });

  it("the last card on the page: nothing moves", async () => {
    page([{ id: "a", h: 900 }], false);
    scrolled = 500;
    press("a");
    await leave("a");
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("prefers-reduced-motion: jumps without the animation", async () => {
    reduce = true;
    page([
      { id: "a", h: 1200 },
      { id: "b", h: 600 },
    ]);
    scrolled = 900;
    press("a");
    await leave("a");
    expect(scrollBy.mock.calls[0][0].behavior).toBe("auto");
  });

  it("waits for the list to settle (T90-S2: one answer closes more asks), then lands on the first card still there", async () => {
    page([
      { id: "a", h: 1000 },
      { id: "b", h: 400 },
      { id: "c", h: 400 },
    ]);
    scrolled = 800;
    press("a");
    document.querySelector('[data-inbox-card="ask:a"]')!.remove();
    await new Promise((r) => setTimeout(r, 20));
    document.querySelector('[data-inbox-card="ask:b"]')!.remove(); // also closed by the same answer
    layout();
    await new Promise((r) => setTimeout(r, SETTLE_MS + 60));
    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(topOf("c")).toBe(52 + GAP);
  });

  it("a press arms the card even without a tap on it (a voice note's Send, a key press)", async () => {
    page([
      { id: "a", h: 1200 },
      { id: "b", h: 600 },
    ]);
    scrolled = 900;
    keepPlace("ask:a");
    await leave("a");
    expect(topOf("b")).toBe(52 + GAP);
  });

  it("a card that re-renders in place (same id back at once) or a folded section moves nothing", async () => {
    page([
      { id: "a", h: 1200 },
      { id: "b", h: 600 },
    ]);
    scrolled = 900;
    press("a");
    const a = document.querySelector('[data-inbox-card="ask:a"]')!;
    const parent = a.parentElement!;
    a.remove();
    parent.prepend(a);
    await new Promise((r) => setTimeout(r, SETTLE_MS + 60));
    expect(scrollBy).not.toHaveBeenCalled();
    // he folds the section on its header: its cards go, the next section's header stays put
    const header = document.createElement("div");
    header.setAttribute("data-fold-header", "");
    document.querySelector('[data-testid="blocked"]')!.prepend(header);
    header.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    document.querySelector('[data-testid="blocked"] ul')!.remove();
    layout();
    await new Promise((r) => setTimeout(r, SETTLE_MS + 60));
    expect(scrollBy).not.toHaveBeenCalled();
  });
});

/** E948-S208 (the owner 25 Nov, vn_7a378324): the screen never jumps to a card he already sent. */
describe("E948-S208 no jump to a card he already sent", () => {
  const frames = () => new Promise((r) => setTimeout(r, 80));
  const sentRow = (id: string) => document.querySelector(`[data-inbox-card="ask:${id}"]`)!.setAttribute("data-testid", "sent-row");
  const collapse = (id: string, h: number) => {
    document.querySelector<HTMLElement>(`[data-inbox-card="ask:${id}"]`)!.dataset.h = String(h);
    layout();
  };

  it("a card whose top is on the screen: its spot holds while it and an older Sent row above it collapse", async () => {
    page([
      { id: "a", h: 70 },
      { id: "b", h: 400 },
      { id: "c", h: 300 },
    ]);
    sentRow("a"); // an earlier answer's green row, above
    scrolled = 0;
    const was = topOf("b");
    holdAfterAnswer(["ask:b"]);
    collapse("b", 60); // the card becomes its Sent row
    collapse("a", 0); // the older row leaves (only the newest shows)
    await frames();
    expect(topOf("b")).toBe(was);
    expect(scrollBy.mock.calls.every(([o]) => o.behavior === "auto")).toBe(true);
  });

  it("a long card answered at its buttons: the next card still waiting lands under the top bar, never the Sent row before it", async () => {
    page([
      { id: "a", h: 1200 },
      { id: "s", h: 60 },
      { id: "c", h: 600 },
    ]);
    sentRow("s");
    scrolled = 900;
    holdAfterAnswer(["ask:a"]);
    collapse("a", 60);
    await frames();
    expect(topOf("c")).toBe(52 + GAP);
  });

  it("the last card of its section answered low in it: nothing moves now, never down to the next section (the fold moves once)", async () => {
    page([
      { id: "a", h: 300 },
      { id: "b", h: 1200 },
    ]);
    scrolled = 900;
    holdAfterAnswer(["ask:b"]);
    collapse("b", 60);
    await frames();
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("his own scroll ends the hold", async () => {
    page([
      { id: "a", h: 200 },
      { id: "b", h: 400 },
    ]);
    scrolled = 50;
    holdAfterAnswer(["ask:b"]);
    window.dispatchEvent(new Event("touchmove"));
    collapse("a", 20);
    await frames();
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("a card that leaves lands on the next card still waiting, skipping a Sent row", async () => {
    page([
      { id: "z", h: 100 },
      { id: "a", h: 300 },
      { id: "s", h: 60 },
      { id: "c", h: 300 },
    ]);
    sentRow("s");
    scrolled = 0;
    press("a");
    expect(keptPlace()?.next[0]).toBe("card:ask:c");
    const was = topOf("a");
    await leave("a");
    expect(topOf("c")).toBe(was);
  });

  it("a section that folded by itself: a heading above the screen lands under the top bar, one on the screen stays", () => {
    page([{ id: "a", h: 100 }]);
    const sec = document.querySelector<HTMLElement>('[data-testid="waiting-for-review"]')!;
    scrolled = Number(sec.dataset.y) + 300;
    landFoldedSection(sec);
    expect(sec.getBoundingClientRect().top).toBe(52 + GAP);
    scrollBy.mockClear();
    scrolled = 0;
    landFoldedSection(sec);
    expect(scrollBy).not.toHaveBeenCalled();
  });
});
