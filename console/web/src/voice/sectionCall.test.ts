// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { showOnScreen } from "./SectionCall";

describe("the card the voice is on shows on his screen", () => {
  it("marks that card (any kind of slot), unmarks the last one, and says when it is not on the page", () => {
    document.body.innerHTML = '<ul><li data-inbox-card="team:tc_1">goal 1</li><li data-inbox-card="review:ri_2">review</li></ul>';
    expect(showOnScreen("tc_1")).toBe(true);
    expect(document.querySelector('[data-inbox-card="team:tc_1"]')!.hasAttribute("data-on-call")).toBe(true);
    expect(showOnScreen("ri_2")).toBe(true);
    expect(document.querySelector('[data-inbox-card="team:tc_1"]')!.hasAttribute("data-on-call")).toBe(false);
    expect(document.querySelector('[data-inbox-card="review:ri_2"]')!.className).toMatch(/ring-2/);
    expect(showOnScreen("nope")).toBe(false);
  });
});
