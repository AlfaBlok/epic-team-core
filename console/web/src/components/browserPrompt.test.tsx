// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserPrompt } from "@/components/waiting";

// (his vn_e166481b on TAX-A20, the GoDaddy receipt: "can this type of task, which can be done via Claude with the
// extension, come with a prompt that I can paste?"): a step in his own signed-in browser shows its one prompt for Claude in
// Chrome on the card, with a Copy button.

afterEach(cleanup);

const PROMPT = "Open https://account.godaddy.com/receipts/view/4176093069 in this browser, where I am signed in. Save the receipt as a PDF and email it to me.";

describe("the browser prompt on a do card", () => {
  it("says it is for Claude in Chrome, shows the prompt whole and copies it", async () => {
    const copied: string[] = [];
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t: string) => void copied.push(t) }, configurable: true });
    render(<BrowserPrompt prompt={PROMPT} />);
    expect(screen.getByTestId("ask-browser").textContent).toMatch(/Claude in Chrome/);
    expect(screen.getByTestId("ask-browser-prompt").textContent).toBe(PROMPT);
    fireEvent.click(screen.getByTestId("ask-browser-copy"));
    await waitFor(() => expect(screen.getByTestId("ask-browser-copy").textContent).toMatch(/Copied/));
    expect(copied).toEqual([PROMPT]);
  });
});
