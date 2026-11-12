// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { CampaignCard } from "@/api/campaign-types";
import { CampaignGoalBlock } from "@/components/CampaignGoal";

// a campaign is tracked by its name and its one goal: the goal, the number toward it with
// a bar, and what waits on him, as the server read them from its spine.
afterEach(cleanup);

const card = (over: Partial<CampaignCard> = {}): CampaignCard => ({
  repo: "social",
  title: "Memo testers",
  milestoneId: "ms_1",
  postsThisWeek: 1,
  live: 1,
  held: 1,
  nextPost: null,
  warnings: 0,
  goal: {
    sentence: "Get 10 people signed up to test Memo Memory by 22 November.",
    metric: { label: "testers signed up", target: 10, now: 3, by: "2026-11-22", proposed: false, source: "Memo's public counts" },
    line: "3 of 10 testers signed up, by 22 Nov",
  },
  waiting: { asks: [{ code: "T6-A1", question: "Post the call?" }], held: 1, line: "Waiting on you: 1 post to approve, 1 question" },
  ...over,
});

describe("the campaign's goal block", () => {
  it("shows the goal, the number with a bar at its share, and what waits on him", () => {
    render(<CampaignGoalBlock card={card()} />);
    expect(screen.getByTestId("campaign-goal-sentence").textContent).toBe("Goal: Get 10 people signed up to test Memo Memory by 22 November.");
    expect(screen.getByTestId("campaign-goal-progress").textContent).toBe("3 of 10 testers signed up, by 22 Nov");
    expect((screen.getByTestId("campaign-goal-progress").querySelector("span > span") as HTMLElement).style.width).toBe("30%");
    expect(screen.getByTestId("campaign-goal-waiting").textContent).toBe("Waiting on you: 1 post to approve, 1 question · Post the call?");
  });

  it("compact on the Team home card: no waiting line (the post line says it), no bar when the number is not read", () => {
    const c = card({ goal: { sentence: null, metric: { label: "x", target: 5, now: null, by: null, proposed: false, source: null }, line: "? of 5 x (not read yet)" } });
    render(<CampaignGoalBlock card={c} compact />);
    expect(screen.getByTestId("campaign-goal-sentence").textContent).toBe("Goal: not written yet");
    expect(screen.queryByTestId("campaign-goal-waiting")).toBeNull();
    expect(screen.getByTestId("campaign-goal-progress").querySelector("span > span")).toBeNull();
  });

  it("nothing without a goal from the server (an older console)", () => {
    const { container } = render(<CampaignGoalBlock card={card({ goal: undefined })} />);
    expect(container.innerHTML).toBe("");
  });
});
