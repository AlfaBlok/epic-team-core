// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { CampaignGoals } from "@/components/campaignGoals";

// the owner's Inbox on a phone: every link in the goals and numbers is a finger-sized target (44 px, Tailwind min-h-11).
// The quality pass measured "Open the plan" 87x18 at 390 and 768 px (production, 13 Nov).
describe("Your goals and their numbers on a touch screen", () => {
  it("opens with the experiment, its plan link and source links each at least 44 px tall", async () => {
    render(
      <MemoryRouter>
        <CampaignGoals />
      </MemoryRouter>,
    );
    const plan = await screen.findByTestId("experiment-plan");
    expect(plan.textContent).toBe("Open the plan");
    expect(plan.className).toMatch(/\bmin-h-11\b/);
    expect(plan.className).toMatch(/\binline-flex\b/);
    expect(screen.getAllByTestId("experiment-kr").length).toBeGreaterThan(0);
    const sources = screen.getAllByTestId("experiment-source");
    expect(sources.length).toBeGreaterThan(0);
    for (const a of sources) expect(a.className).toMatch(/\bmin-h-11\b/);
  });
});
