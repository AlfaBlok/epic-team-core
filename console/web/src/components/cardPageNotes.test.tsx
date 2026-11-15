// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PageNotes } from "./review";

// a note left inside a page's own feedback box shows on the item's card: his words, when, a link to the page.

describe("PageNotes on a card", () => {
  it("shows the newest note first with its time and the page link", () => {
    render(
      <PageNotes
        notes={[
          { date: "2026-11-11", words: "first", url: "http://h:9319/" },
          { date: "2026-11-12", time: "23:49", words: "good for now", url: "http://h:9319/", step: "Your feedback on this page" },
        ]}
      />,
    );
    const lines = screen.getAllByTestId("review-page-note");
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toContain("Your note on the page");
    expect(lines[0].textContent).toContain("good for now");
    expect(lines[0].textContent).toMatch(/\d{2}:\d{2}/);
    expect(lines[1].textContent).toContain("first");
    expect(screen.getAllByRole("link", { name: "open the page" })[0].getAttribute("href")).toBe("http://h:9319/");
  });
});
