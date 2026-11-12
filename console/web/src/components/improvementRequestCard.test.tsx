// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { WaitingItem } from "@/api";
import { WaitingCard } from "@/components/waiting";

/**
 * the social product persona's improvement request
 * reads as one on his card, with its campaign, what done means, and where his yes sends it.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const item = (over: Partial<WaitingItem> = {}): WaitingItem =>
  ({
    id: "wj_imp",
    source: "ask",
    state: "open",
    who: "Sam",
    code: "T5-A9",
    milestoneId: "ms_s",
    milestoneTitle: "Launch campaign",
    nodeKey: "ms_s/E905",
    path: "docs/spines/root.md",
    title: "T5-S3 Site link",
    ask: "approve",
    question: "Improvement request: a link to the campaign page on epicspine.dev",
    recommendation: "yes, the posts point at a page that does not exist yet",
    unblocks: "T5-S3, the launch posts",
    contextLinks: [],
    owner: { kind: "delivery-manager", assignmentId: "as_1", personaName: "Delivery Manager", label: "Delivery Manager" },
    decidable: false,
    improvement: { to: "EpicTeam", campaign: "Launch campaign", doneMeans: "epicspine.dev links to the campaign page" },
    ...over,
  }) as unknown as WaitingItem;

const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("T101-S8 the improvement request card", () => {
  it("is tagged an improvement request and shows campaign, done means and where his yes sends it", () => {
    wrap(<WaitingCard item={item()} />);
    expect(screen.getByTestId("improvement-tag").textContent).toBe("improvement request");
    const facts = screen.getByTestId("improvement-facts").textContent ?? "";
    expect(facts).toContain("Campaign: Launch campaign");
    expect(facts).toContain("Done means: epicspine.dev links to the campaign page");
    expect(facts).toContain("On your yes it goes to the EpicTeam desk");
    // it stays an approve card: the Approve button is there
    expect(screen.getByRole("button", { name: /^Approve/ })).toBeTruthy();
  });

  it("names a world id as that world's desk; an ordinary ask has neither tag nor facts", () => {
    wrap(<WaitingCard item={item({ improvement: { to: "e77-test" } })} />);
    expect(screen.getByTestId("improvement-facts").textContent).toContain("the e77-test desk");
    cleanup();
    wrap(<WaitingCard item={item({ improvement: undefined })} />);
    expect(screen.queryByTestId("improvement-tag")).toBeNull();
    expect(screen.queryByTestId("improvement-facts")).toBeNull();
  });
});
