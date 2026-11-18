// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { CARD_TYPES } from "@/components/cardInventory";

// E948-S151 (the owner on E940-A10, vn_b2c9395c: "If you don't give me a link, how the fuck do you expect me to choose?"):
// a choice whose options' link sits only in its context prose shows that link on its face, above the option buttons.
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

describe("a choice shows its options on its face (E948-S151)", () => {
  it("See the options sits above the A, B and C buttons, with the card folded", () => {
    const c = CARD_TYPES.find((t) => t.id === "decide-choice-link")!;
    const { container } = render(<MemoryRouter>{c.render()}</MemoryRouter>);
    expect(container.querySelector("[data-testid='ask-more']")).toBeNull();
    const go = container.querySelector("a[data-testid='card-go']") as HTMLAnchorElement;
    expect(go?.textContent).toMatch(/See the options/);
    expect(go.href).toBe("https://example.com/");
    const first = container.querySelector("[data-testid='ask-option']")!;
    expect(go.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelectorAll("[data-testid='ask-option']").length).toBe(3);
  });
});
