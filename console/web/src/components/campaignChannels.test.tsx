// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { CampaignChannels } from "@/components/CampaignChannels";
import type { CampaignCard, CampaignChannel } from "@/api/campaign-types";

// the campaign card shows per channel the account, whether its sign-in is
// green, cadence, objective and metric, and the summed views, likes and replies of its posts with the trend.
const ch = (p: Partial<CampaignChannel>): CampaignChannel => ({
  key: "x", name: "X", account: "@ExampleHQ", signIn: { state: "green", line: "Signed in, as @ExampleHQ" }, cadence: "2 posts a day", what: "one proof a post",
  posts: 6, replyRows: 2, totals: { views: 185, likes: 3, replies: 4 }, readLine: "6 of 6 posts read 14:00Z", readAt: "2026-11-13T14:00:00Z",
  trend: { since: "2026-11-12", views: 12, likes: 0, replies: -1 }, history: [{ date: "2026-11-12", posts: 5, views: 173, likes: 3, replies: 5 }, { date: "2026-11-13", posts: 6, views: 185, likes: 3, replies: 4 }], ...p,
});
const card = {
  repo: "example-social", title: "Example testers", milestoneId: "ms_1", postsThisWeek: 2, live: 10, held: 0, nextPost: null, warnings: 0,
  goal: { sentence: "Get 10 people signed up to test Example.", metric: { label: "testers signed up", target: 10, now: 1, by: "2026-11-22", proposed: false, source: null }, line: "1 of 10" },
  channels: [ch({}), ch({ key: "reddit", name: "Reddit", account: "u/sam", signIn: { state: "amber", line: "Not checked: Mac offline" }, totals: { views: null, likes: 7, replies: 2 }, trend: null, cadence: null, what: null })],
} as CampaignCard;

describe("the campaign's channels", () => {
  it("shows account, sign-in, cadence, objective, metric and the summed counts with the change", () => {
    render(<CampaignChannels card={card} />);
    const x = screen.getByTestId("channel-x");
    expect(x.textContent).toContain("@ExampleHQ");
    expect(within(x).getByTestId("channel-signin").dataset.state).toBe("green");
    expect(x.textContent).toContain("Sign-in green");
    expect(x.textContent).toContain("2 posts a day");
    expect(x.textContent).toContain("one proof a post");
    expect(x.textContent).toContain("10 testers signed up by 22 Nov");
    const t = within(x).getByTestId("channel-totals").textContent!;
    expect(t).toContain("185");
    expect(t).toContain("▲ 12");
    expect(t).toContain("▼ 1");
    expect(within(x).getByTestId("channel-spark")).toBeTruthy();
    const r = screen.getByTestId("channel-reddit");
    expect(within(r).getByTestId("channel-signin").dataset.state).toBe("amber");
    expect(r.textContent).toContain("Reddit shows none");
    // no plan line: the campaign's goal stands in as the objective, and it says what is missing.
    expect(r.textContent).toContain("Get 10 people signed up");
    expect(r.textContent).toContain("not in the plan yet");
    expect(r.textContent).toContain("no earlier day yet");
  });

  it("says no post yet, never not read yet, on a channel with nothing live", () => {
    const yt = ch({ key: "youtube", name: "YouTube", posts: 0, replyRows: 0, totals: { views: null, likes: null, replies: null }, trend: null, history: [] });
    render(<CampaignChannels card={{ ...card, channels: [yt] }} />);
    const t = screen.getByTestId("channel-youtube").textContent!;
    expect(t).toContain("no post yet");
    expect(t).not.toContain("not read yet");
  });

  it("is one line per channel on the Team home card", () => {
    render(<CampaignChannels card={card} compact />);
    const c = screen.getByTestId("campaign-channels-compact").textContent!;
    expect(c).toContain("X @ExampleHQ · 6 posts · 185 views · 3 likes · 4 replies");
    expect(c).toContain("Reddit u/sam");
  });
});
