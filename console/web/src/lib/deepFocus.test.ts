// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { findFocus, focusTarget } from "./deepFocus";

/** E948-S180 (the owner 22 Nov: "You lead my attention to what you want to show me"): a card's link lands on the one thing. */
describe("deep focus", () => {
  it("reads ?focus= first, else the # part, and leaves text fragments to the browser", () => {
    expect(focusTarget("https://team.example.com/sets/bitwarden?tab=kr&focus=loose%20tickets")).toEqual({ value: "loose tickets", words: true });
    expect(focusTarget("https://team.example.com/deck/all#top-journeys")).toEqual({ value: "top-journeys", words: false });
    expect(focusTarget("https://team.example.com/x#:~:text=three")).toBeUndefined();
    expect(focusTarget("https://team.example.com/inbox")).toBeUndefined();
  });

  it("finds the id, then data-focus, then the smallest row holding the words", () => {
    document.body.innerHTML = `<main><h2 id="krs">Key results</h2><div data-focus="loose"><p>Loose box</p></div>
      <table><tr><td>Three open tickets hang with no key result</td><td>3</td></tr><tr><td>Other</td></tr></table></main>`;
    expect(findFocus(document, { value: "krs", words: false })?.textContent).toBe("Key results");
    expect(findFocus(document, { value: "loose", words: false })?.getAttribute("data-focus")).toBe("loose");
    expect(findFocus(document, { value: "no-key-result", words: true })?.tagName).toBe("TR");
    expect(findFocus(document, { value: "no-key-result", words: false })).toBeNull();
    document.body.innerHTML = `<p data-testid="chat-ticket-line">old</p><p data-testid="chat-ticket-line">new</p>`;
    expect(findFocus(document, { value: "chat-ticket-line", words: true })?.textContent).toBe("old");
    expect(findFocus(document, { value: "chat-ticket-line:last", words: true })?.textContent).toBe("new");
  });
});
