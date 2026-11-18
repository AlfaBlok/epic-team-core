// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { api } from "@/api";
import { inboxHands, showOnScreen } from "./SectionCall";

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

// the Team desk's whole-inbox call presses through the same card builders, each card read fresh.

describe("the whole-inbox call's hands", () => {
  it("a review card is read fresh and pressed through its own route; a button no longer on it is refused", async () => {
    const item = { id: "ri_9", ref: "E907-S1", title: "A card", face: { title: "A card" } } as never;
    vi.spyOn(api, "listReviewItems").mockResolvedValue([item]);
    const complete = vi.spyOn(api, "completeReviewItem").mockResolvedValue({} as never);
    const h = inboxHands();
    expect(await h.press!({ id: "ri_9", kind: "review", button: "Mark complete" })).toBe("done: marked complete");
    expect(complete).toHaveBeenCalledWith("ri_9", expect.objectContaining({ start: [], park: [] }));
    expect(await h.press!({ id: "ri_9", kind: "review", button: "Yes: plan it" })).toMatch(/^not pressed: Yes: plan it is not one of his buttons/);
    expect(await h.press!({ id: "ri_gone", kind: "review", button: "Mark complete" })).toBe("not pressed: the card is no longer in his inbox");
  });

  it("a question is answered through its own respond route: yes, no, or his words", async () => {
    const respond = vi.spyOn(api, "respondToWaiting").mockResolvedValue({} as never);
    const h = inboxHands();
    expect(await h.press!({ id: "w1", kind: "ask", button: "Yes: go ahead", milestoneId: "ms_1" })).toBe("done: said yes");
    expect(respond).toHaveBeenLastCalledWith("w1", { kind: "approve", text: "", milestoneId: "ms_1", wake: true });
    expect(await h.press!({ id: "w1", kind: "ask", button: "Answer in words…", words: "use example.shop", milestoneId: "ms_1" })).toBe("done: his answer was sent");
    expect(respond).toHaveBeenLastCalledWith("w1", { kind: "answer", text: "use example.shop", milestoneId: "ms_1", wake: true });
    expect(await h.press!({ id: "w1", kind: "ask", button: "Answer in words…" })).toBe("not pressed: his answer needs his words");
  });

  it("his words on an objective go through the briefing's own route", async () => {
    const answer = vi.spyOn(api, "briefingAnswer").mockResolvedValue({ ok: true, filed: ["docs/his-words.json", "team:docs/spines/x.md"] });
    expect(await inboxHands().file!({ id: "notes-testers", name: "Notes: 5 testers", words: "push it" })).toBe("filed: docs/his-words.json and team:docs/spines/x.md");
    expect(answer).toHaveBeenCalledWith({ kind: "objective", id: "notes-testers", name: "Notes: 5 testers", words: "push it" });
  });
});
