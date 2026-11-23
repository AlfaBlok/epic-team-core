// @vitest-environment jsdom
// E948-S187: a review card that came after an older ask on the same work shows on the ask's card: one card, both rows.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { WaitingItem } from "@/api";
import { WaitingCard } from "@/components/waiting";

afterEach(() => cleanup());

const item: WaitingItem = {
  id: "wj_1",
  source: "ask",
  state: "open",
  code: "E907-A16",
  milestoneId: "ms_1",
  milestoneTitle: "E907",
  path: "docs/E907.md",
  title: "The kernel plan",
  ask: "approve",
  question: "You approve the kernel plan?",
  contextLinks: [],
  owner: { kind: "delivery-manager", label: "Delivery Manager" },
  since: new Date(Date.now() - 86400_000).toISOString(),
  decidable: true,
  joined: [
    {
      id: "rv_s221",
      ref: "E907-S221",
      title: "One diagram of the whole kernel was made.",
      evidence: { url: "http://pages.example.com:18997/#kernel", label: "The kernel page", look: "Every tab and who writes it." },
      delivered: [{ ok: true, text: "✓ Real runs show each tab." }],
      decision: "Does the kernel read right? We recommend yes.",
    },
  ],
} as WaitingItem;

describe("the ask's card carries the review that joined it (E948-S187)", () => {
  it("shows the review's evidence, delivered lines and decision under the question, and says one answer settles both", () => {
    render(
      <MemoryRouter>
        <WaitingCard item={item} />
      </MemoryRouter>,
    );
    const j = screen.getByTestId("ask-joined");
    expect(screen.getByTestId("ask-joined-evidence").getAttribute("href")).toBe("http://pages.example.com:18997/#kernel");
    expect(j.textContent).toContain("Every tab and who writes it.");
    expect(screen.getByTestId("ask-joined-delivered").textContent).toContain("✓ Real runs show each tab.");
    expect(screen.getByTestId("ask-joined-decision").textContent).toContain("Does the kernel read right?");
    expect(screen.getByTestId("ask-joined-both").textContent).toMatch(/settles both/);
    expect(screen.getAllByTestId("ask-joined-card")).toHaveLength(1);
  });
});
