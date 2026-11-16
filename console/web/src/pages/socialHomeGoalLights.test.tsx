// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import type { Goal } from "@/api/company-types";
import { pursuitTitle } from "@/api/pursuit-types";
import { forgetOtherWorlds } from "@/components/otherWorlds";
import { goalHeadline } from "@/components/goalLights";
import { TeamPage } from "@/pages/Team";
import { SKINS, SkinProvider } from "@/lib/skin";

// E907-S3. The owner: "I want to see a list of key results and traffic light for each". The social Home's first screen is
// the goal ("5 testers using SocialApp · 0 of 5"), its key results one line each with a light, and the rule; everything
// else folds under one line. The goal is worded once, read from its source file (docs/goals/<name>.json).

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  forgetOtherWorlds();
});
beforeEach(() => localStorage.clear());
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const RULE = "Green: on pace for its date. Amber: behind pace. Red: no movement in 3 days, or its date has passed short of the target.";
const GOAL: Goal = {
  id: "social-testers",
  name: "5 testers using SocialApp",
  label: "5 testers using SocialApp",
  now: 0,
  target: 5,
  by: "2026-12-08",
  light: "red",
  why: "no movement since 8 Nov",
  lightRule: RULE,
  keyResults: [
    { id: "applications", label: "People apply to be testers", now: 0, target: 10, by: "2026-11-17", light: "red", why: "no movement since 4 Nov" },
    { id: "visitors", label: "Visitors on example.com", now: 88, target: 500, by: "2026-11-22", light: "amber", why: "behind: pace says 179 by today" },
    { id: "followers", label: "@SocialHQ followers on X", now: 0, target: 100, by: "2026-12-08", light: "green", why: "on pace" },
  ],
};

const home = () => {
  vi.spyOn(api as Required<typeof api>, "getMe").mockResolvedValue({ tenant: { id: "home" } } as never);
  vi.spyOn(api, "getSocial").mockRejectedValue(new Error("not in this test"));
  vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "home", campaigns: [] });
  vi.spyOn(api as Required<typeof api>, "listCompanyWorlds").mockResolvedValue({ worlds: [] } as never);
  vi.spyOn(api as Required<typeof api>, "listGoals").mockResolvedValue({ goals: [GOAL] });
  return render(
    <SkinProvider skin={SKINS.social}>
      <MemoryRouter>
        <TeamPage only="goals" />
      </MemoryRouter>
    </SkinProvider>,
  );
};

describe("the SocialApp Home: key results with a traffic light each", () => {
  it("opens on the goal and its number, then each key result on one line with its light, then the rule", async () => {
    home();
    expect((await screen.findByTestId("goal-headline")).textContent).toBe("5 testers using SocialApp");
    expect(screen.getByTestId("goal-count").textContent).toBe("0 of 5");
    const krs = screen.getAllByTestId("goal-kr");
    expect(krs.map((k) => k.getAttribute("data-light"))).toEqual(["red", "amber", "green"]);
    expect(krs[1].querySelector('[data-testid="goal-kr-count"]')!.textContent).toBe("88 of 500by 22 Nov");
    expect(screen.getByTestId("goal-rule").textContent).toBe(RULE);
  });

  it("nothing else on top: no description paragraph, no buttons, the campaigns and widgets folded under one line", async () => {
    home();
    await screen.findByTestId("goal-lights");
    expect(screen.queryByText(/Your campaigns and how they are doing/)).toBeNull();
    expect(screen.queryByTestId("new-focus")).toBeNull();
    const toggle = screen.getByTestId("home-more-toggle");
    expect(toggle.textContent).toMatch(/More: all objectives, campaigns, your Inbox/);
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByTestId("home-more-body")).toBeTruthy());
    expect(screen.getByTestId("new-focus")).toBeTruthy();
  });

  it("never says paying tester", async () => {
    home();
    await screen.findByTestId("goal-lights");
    expect(document.body.textContent).not.toMatch(/paying tester/i);
  });
});

describe("one wording everywhere", () => {
  it("the goal headline and the pursuit title read the same", () => {
    expect(goalHeadline(GOAL)).toBe("5 testers using SocialApp");
    expect(pursuitTitle({ name: "5 testers using SocialApp", goal: { now: 0, target: 5 } })).toBe(goalHeadline(GOAL));
    expect(pursuitTitle({ name: "Memory app commercially live" })).toBe("Memory app commercially live");
  });
});
