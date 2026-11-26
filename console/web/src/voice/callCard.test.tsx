// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { CardCallButton, callPathOf } from "./callCard";

// a card that opens a call page carries the Call on its face; it opens that page in this console with ?call=1
// (never a new tab on another site, where the owner may not be signed in).

afterEach(cleanup);

describe("the Call on a card", () => {
  it("knows our call pages on either console, and nothing else", () => {
    expect(callPathOf("https://social.example.com/marketing?focus=x")).toBe("marketing");
    expect(callPathOf("https://team.example.com/marketing")).toBe("marketing");
    expect(callPathOf("/briefing")).toBe("briefing");
    expect(callPathOf("https://team.example.com/strategy/")).toBe("strategy");
    expect(callPathOf("http://host1:9864/?focus=x#x")).toBeUndefined();
    expect(callPathOf("https://other.test/marketing")).toBeUndefined();
    expect(callPathOf("https://team.example.com/milestones/x")).toBeUndefined();
    expect(callPathOf(undefined)).toBeUndefined();
  });

  it("shows one green Call that opens the call page here and starts it", () => {
    render(
      <MemoryRouter>
        <CardCallButton hrefs={["https://social.example.com/marketing?focus=x"]} />
      </MemoryRouter>,
    );
    const b = screen.getByTestId("card-call-now");
    expect(b.textContent).toMatch(/Call the .+ briefer/);
    expect(b.getAttribute("href")).toBe("/marketing?call=1");
    expect(b.getAttribute("target")).toBeNull();
  });

  it("shows nothing for a card that opens no call page", () => {
    const { container } = render(
      <MemoryRouter>
        <CardCallButton hrefs={["http://host1:9864/", undefined]} />
      </MemoryRouter>,
    );
    expect(container.innerHTML).toBe("");
  });
});
