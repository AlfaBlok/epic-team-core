// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { api, type Milestone } from "@/api";
import type { CampaignBriefings } from "@/api/campaign-types";
import { DailyBriefingPanel, dayLabel } from "./DailyBriefing";

// the owner's morning briefing, kept on its campaign: the latest first, older ones one tap away.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.spyOn(api as unknown as { getMe: () => Promise<unknown> }, "getMe").mockResolvedValue({ tenant: { id: "social" } });
});
const M = { id: "ms-memo" } as Milestone;
const B: CampaignBriefings = {
  latest: {
    day: "2026-11-18",
    code: "E907-A3",
    yesterday: "4 things went out for Notes testers: a forum reply https://example.com/r/x/1.",
    today: "9 things planned for Notes testers.",
    questions: ["What do you think would make a reader try Notes?"],
    text: "the product's morning talk, Wed 18 Nov.",
    answers: [],
  },
  older: [
    { day: "2026-11-17", code: "E907-A2", yesterday: "the product sent 3 things.", today: null, questions: ["Videos or forum?"], text: "", answers: [{ when: "2026-11-17", text: "We need to elevate this." }] },
  ],
};

describe("a campaign's morning briefing", () => {
  it("shows the latest in its three parts, with its links", async () => {
    vi.spyOn(api, "getCampaignBriefings").mockResolvedValue(B);
    render(<DailyBriefingPanel m={M} />);
    const box = await screen.findByTestId("daily-briefing");
    expect(within(box).getByText("Wed 18 Nov")).toBeTruthy();
    expect(within(box).getAllByTestId("briefing-part").map((p) => p.textContent)).toEqual([
      "Yesterday4 things went out for Notes testers: a forum reply https://example.com/r/x/1.",
      "Today9 things planned for Notes testers.",
      "Open questionWhat do you think would make a reader try Notes?",
    ]);
    expect(within(box).getByRole("link").getAttribute("href")).toBe("https://example.com/r/x/1");
    expect(screen.queryByTestId("briefing-older")).toBeNull();
  });

  it("opens the older ones in one tap, each with the answer", async () => {
    vi.spyOn(api, "getCampaignBriefings").mockResolvedValue(B);
    render(<DailyBriefingPanel m={M} />);
    fireEvent.click(await screen.findByTestId("briefing-older-toggle"));
    const older = screen.getByTestId("briefing-older");
    expect(within(older).getByText("Tue 17 Nov")).toBeTruthy();
    expect(within(older).getByTestId("briefing-answer").textContent).toContain("We need to elevate this.");
  });

  it("says so in one quiet line when the campaign has no briefing yet", async () => {
    vi.spyOn(api, "getCampaignBriefings").mockResolvedValue({ latest: null, older: [] });
    render(<DailyBriefingPanel m={M} />);
    expect((await screen.findByTestId("briefing-none")).textContent).toBe("No morning briefing for this campaign yet.");
  });

  it("names the day without a time zone shift", () => {
    expect(dayLabel("2026-11-16")).toBe("Mon 16 Nov");
  });
});
