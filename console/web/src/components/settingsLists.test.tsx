// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type RedLine } from "@/api";
import type { BuildingList } from "@/api/building-types";
import type { Onboarding } from "@/api";
import { BuildingLists } from "@/components/buildingLists";
import { ScorecardView } from "@/components/OnboardingScorecard";
import { RedLineBand } from "@/components/ownerPriority";
import { resetReviewGone } from "@/lib/inbox";

// the round 2 mockup's Settings: Setup, Red lines and What you build are
// each a heading and one quiet list, no ring, no flag, no pencil or bin icons, no product cards (one quiet family).

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetReviewGone();
});

const line: RedLine = {
  name: "Flywheel",
  target: "2026-11-30",
  sentence: "By 30 November, two or three data products run on their own.",
  state: "agreed",
  at: "2026-11-10T17:55:00Z",
  items: [{ repo: "funnels", ref: "E907-S3" }],
};

describe("Settings lists", () => {
  it("red lines: a heading, one row per line, Edit and Delete as words", async () => {
    vi.spyOn(api, "redLine").mockResolvedValue({
      redLine: line,
      redLines: [line],
    });
    render(
      <MemoryRouter>
        <RedLineBand list />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("red-line-name").textContent).toBe("Flywheel"));
    expect(screen.getByRole("heading", { name: "Red lines" })).toBeTruthy();
    expect(screen.getByTestId("red-line-row").textContent).toContain("by 30 Nov");
    expect(screen.getByTestId("red-line-edit").textContent).toBe("Edit");
    expect(screen.getByTestId("red-line-delete").textContent).toBe("Delete");
    expect(screen.getByTestId("red-lines").querySelector("svg")).toBeNull();
    fireEvent.click(screen.getByTestId("red-line-delete"));
    expect(screen.getByTestId("red-line-delete-confirm")).toBeTruthy();
  });

  it("what you build: one row per product with its red and green counts, or nothing waits", async () => {
    const lists: BuildingList[] = [
      {
        id: "z",
        name: "Memo",
        line: "Open-source memory.",
        repos: ["memo"],
        open: { label: "cloud.example.com", url: "https://cloud.example.com/" },
        waits: { asks: 2, review: 4 },
        repoWaits: {},
        campaigns: [],
      },
      {
        id: "s",
        name: "Social",
        repos: ["social"],
        waits: { asks: 0, review: 0 },
        repoWaits: {},
        campaigns: [],
      },
    ];
    vi.spyOn(api, "listBuilding").mockResolvedValue({ lists });
    render(
      <MemoryRouter>
        <BuildingLists
          list
          milestones={[
            {
              id: "ms_z",
              repo: "Acme/memo",
              path: "docs/spines/root.md",
            } as never,
          ]}
        />
      </MemoryRouter>,
    );
    const rows = await screen.findAllByTestId("building-list");
    expect(rows[0].textContent).toContain("Memo · Open-source memory · cloud.example.com");
    expect(within(rows[0]).getByTestId("building-repo").getAttribute("href")).toBe("/milestones/ms_z");
    expect([...within(rows[0]).getByTestId("building-waits").querySelectorAll("[data-count-pill]")].map((p) => p.getAttribute("data-tone"))).toEqual(["needs-you", "review"]);
    expect(within(rows[1]).getByTestId("building-waits").textContent).toBe("nothing waits");
  });

  it("setup: a heading with the count, one row per step, no ring", () => {
    const s = {
      product: "team",
      done: 0,
      of: 2,
      site: "cloud.example.com",
      readAt: "2026-11-12T07:00:00Z",
      accounts: [],
      ticks: [
        {
          id: "world",
          title: "Your own team",
          line: "a team of your own",
          state: "todo",
          today: "Not yet.",
          how: "We read it.",
        },
        {
          id: "signin",
          title: "Sign in",
          line: "with Google or GitHub",
          state: "done",
          today: "Done.",
          how: "We read it.",
        },
      ],
    } as unknown as Onboarding;
    render(
      <MemoryRouter>
        <ScorecardView s={s} list />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "Setup" })).toBeTruthy();
    expect(screen.getByTestId("onboarding-count").textContent).toBe("0 of 2 proven by a live check on cloud.example.com");
    expect(screen.queryByTestId("onboarding-ring")).toBeNull();
    expect(screen.getByTestId("onboarding-world").textContent).toContain("not yet");
    expect(screen.getByTestId("onboarding-signin").textContent).toContain("proven");
    fireEvent.click(within(screen.getByTestId("onboarding-world")).getByRole("button"));
    expect(screen.getByTestId("onboarding-world-detail")).toBeTruthy();
  });
});
