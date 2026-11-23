// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { cardKey, duplicateCards, inboxCountCheck } from "@/lib/countCheck";

// E948-S182 (the owner 22 Nov 23:5xZ, his Urgent: the kernel plan ask E906-A16 twice, 2 and 13 min old, Urgent counted 2):
// the pill matched the cards drawn, so the count check passed. One ask is one card: the same repo and code twice fails.
const page = (urgent: string[], blocked: string[] = []) => {
  const root = document.createElement("div");
  const card = (k: string) => `<div data-inbox-open="" data-inbox-tone="red" data-card-key="${k}">card</div>`;
  root.innerHTML = `
    <section data-fold-section data-testid="inbox-urgent"><button data-testid="inbox-urgent-toggle" aria-expanded="true"></button>
      <span data-testid="inbox-urgent-count">${urgent.length}</span>${urgent.map(card).join("")}</section>
    <section data-fold-section data-testid="waiting-on-you"><button data-testid="waiting-on-you-toggle" aria-expanded="true"></button>
      ${blocked.length ? `<span data-testid="waiting-on-you-count">${blocked.length}</span>` : ""}${blocked.map(card).join("")}</section>`;
  return root;
};

describe("E948-S182 one ask is one card in the count check", () => {
  it("E906-A16 drawn twice in Urgent: a mismatch naming it, though the pill says 2 over 2 cards", () => {
    const k = cardKey("ask", "home_repo", "E906-A16")!;
    const c = inboxCountCheck(page([k, k]));
    expect(c.mismatches).toEqual(["home_repo/E906-A16 shows 2 cards (inbox-urgent, inbox-urgent): one ask is one card"]);
  });
  it("one card in Urgent and the same ask in Blocked on you is a double too", () => {
    const k = cardKey("ask", "home_repo", "e906-a16")!;
    expect(duplicateCards(page([k], [k]))).toHaveLength(1);
  });
  it("two different asks, or one code in two repos, pass", () => {
    expect(inboxCountCheck(page([cardKey("ask", "home_repo", "E906-A16")!, cardKey("ask", "home_repo", "E948-A29")!])).mismatches).toEqual([]);
    expect(duplicateCards(page([cardKey("ask", "other_repo", "E907-A1")!, cardKey("ask", "third_repo", "E907-A1")!]))).toEqual([]);
  });
  it("an ask with no code has no key", () => {
    expect(cardKey("ask", "home_repo", undefined)).toBeUndefined();
  });
});
