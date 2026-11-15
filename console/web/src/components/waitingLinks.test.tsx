// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { WaitingItem } from "@/api";
import { WaitingCard } from "@/components/waiting";

afterEach(() => cleanup());

const item = (over: Partial<WaitingItem> = {}): WaitingItem =>
  ({
    id: "wj_1",
    source: "ask",
    state: "open",
    code: "T28-A3",
    milestoneId: "ms_1",
    milestoneTitle: "video",
    title: "Pick a voice",
    ask: "decide",
    question: "Pick a voice, see http://10.86.141.63:8828/voices/ first",
    contextLinks: [],
    owner: { kind: "delivery-manager", label: "Delivery Manager" },
    decidable: false,
    ...over,
  }) as WaitingItem;

describe("links on ask cards are clickable", () => {
  it("bare URLs and Markdown links in the question and every plain-words section are <a> that open in a new tab", () => {
    render(
      <MemoryRouter>
        <WaitingCard
          item={item({
            contextText: "see https://example.com/ctx.",
            whyYou: "taste call — details: http://10.86.141.63:8828/voices/ ([notes](https://example.com/notes.md))",
          })}
        />
      </MemoryRouter>,
    );
    // the heading is a button (it opens More); the question's own link must still be a link on the card
    // a server's own address is labelled Open the page, never its host and port
    const q = within(screen.getByTestId("waiting-card")).getByRole("link", { name: /Open the page/ });
    expect(q.getAttribute("href")).toBe("http://10.86.141.63:8828/voices/");
    expect(q.getAttribute("target")).toBe("_blank");
    fireEvent.click(screen.getByTestId("ask-lead")); // Context and Why you live under More
    // Context also carries the Epic Book link, so take the text's own link
    expect(within(screen.getByTestId("ask-context")).getByRole("link", { name: /example\.com/ }).getAttribute("href")).toBe("https://example.com/ctx");
    const why = within(screen.getByTestId("ask-why-you")).getAllByRole("link");
    expect(why.map((a) => a.getAttribute("href"))).toEqual(["http://10.86.141.63:8828/voices/", "https://example.com/notes.md"]);
    expect(why[1].textContent).toBe("notes");
  });
});
