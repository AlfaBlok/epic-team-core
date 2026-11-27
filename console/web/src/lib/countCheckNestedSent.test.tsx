// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { collapsedToSent, inboxCountCheck } from "@/lib/countCheck";

// E948-S229 (inbox-count check 27 Nov 16:06Z and 16:31Z, a phone at 390 px after answers: "waiting-on-you: pill 3,
// 2 open cards drawn"): the "No post sent" alert carries its blocking ask's own card; the phone answered that ask, so the
// inner card collapsed to a Sent row inside the alert. The alert stays open and the pill counts it: so must the check.
// The DOM below is the one production drew (Open > SentOr's card slot > the alert > the inner ask's Sent row).
const sent = (slot: string) => `<div data-testid="sent-row" data-sent-slot="${slot}" data-inbox-card="${slot}">Sent Closed</div>`;
const page = (cards: string[]) => {
  const root = document.createElement("div");
  root.innerHTML = `
    <section data-fold-section data-testid="waiting-on-you"><button data-testid="waiting-on-you-toggle" aria-expanded="true"></button>
      <span data-testid="waiting-on-you-count">3</span>${cards.join("")}</section>`;
  return root;
};
const decision = `<div class="contents" data-inbox-open=""><div data-inbox-card="ask:wj_a">Do you approve?</div></div>`;
const alertWithAnsweredAsk = `<div class="contents" data-inbox-open=""><div class="contents" data-card-slot="status:al_1">
  <div data-testid="monitor-alert">No post sent<ul data-testid="monitor-alert-asks"><li data-testid="monitor-alert-ask">
  <div data-testid="monitor-alert-ask-card">${sent("ask:wj_89fc")}</div></li></ul></div></div></div>`;
const towerwatch = `<div class="contents" data-inbox-open=""><div data-inbox-card="ask:wj_4d6b">Give the Writer seat read access</div></div>`;

describe("E948-S229 a Sent row inside an open card does not close that card", () => {
  it("the alert whose inner ask he answered still counts: pill 3 over 3 open cards", () => {
    const c = inboxCountCheck(page([decision, alertWithAnsweredAsk, towerwatch]));
    expect(c.sections).toEqual([{ section: "waiting-on-you", pill: 3, cards: 3, folded: false }]);
    expect(c.mismatches).toEqual([]);
  });
  it("a card that collapsed itself to its Sent row is still out of the count", () => {
    const own = `<div class="contents" data-inbox-open="">${sent("ask:wj_x")}</div>`;
    const c = inboxCountCheck(page([decision, alertWithAnsweredAsk, towerwatch, own]));
    expect(c.sections[0].cards).toBe(3);
    expect(collapsedToSent(page([own]).querySelector("[data-inbox-open]")!)).toBe(true);
  });
  it("the alert itself answered (its own card slot collapsed) is out too", () => {
    const el = page([`<div class="contents" data-inbox-open="">${sent("status:al_1")}</div>`]).querySelector("[data-inbox-open]")!;
    expect(collapsedToSent(el)).toBe(true);
    expect(collapsedToSent(page([alertWithAnsweredAsk]).querySelector("[data-inbox-open]")!)).toBe(false);
  });
});
