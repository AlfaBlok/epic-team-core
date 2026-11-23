// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import { XStatsFreshness, XStatsPage } from "@/components/xStats";
import type { XStatsBody } from "@/api/pages-types";

/** The team's X accounts: the answer first, a box per account with the change since the day before, each post's counts. */
const T = (likes: number, views: number) => ({ likes, replies: 1, reposts: 0, quotes: 0, views });
const BODY: XStatsBody = {
  dates: ["2026-11-12", "2026-11-13"],
  day: {
    date: "2026-11-13", readAt: "2026-11-13T00:15:00Z", windowDays: 7, since: "2026-11-06T00:15:00Z",
    accounts: [
      { handle: "@Alpha", product: "Alpha", state: "read", listedBy: "fxtwitter timeline", followers: 5, postsAllTime: 9, count: 1, totals: T(3, 40), notes: [], readAt: "",
        posts: [{ id: "1", url: "https://x.com/Alpha/status/1", at: "2026-11-12T20:00:00Z", kind: "post", text: "hello world", likes: 3, replies: 1, reposts: 0, views: 40, source: "fxtwitter" }] },
      { handle: "@Beta", product: "Beta", state: "not read", listedBy: null, followers: null, postsAllTime: null, count: 0, totals: { likes: 0, replies: 0, reposts: 0, quotes: 0, views: 0 }, notes: ["laptop offline"], readAt: "", posts: [] },
    ],
  },
  history: [
    { date: "2026-11-12", accounts: { "@Alpha": { ...T(1, 30), count: 1, followers: 5, state: "read" } } },
    { date: "2026-11-13", accounts: { "@Alpha": { ...T(3, 40), count: 1, followers: 5, state: "read" } } },
  ],
};

describe("x stats page", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("leads with the summed answer, a box per account with its change and state, then each post", async () => {
    vi.spyOn(api, "getXStats").mockResolvedValue(BODY);
    render(<MemoryRouter><XStatsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("x-stats-answer")).toBeTruthy());
    expect(screen.getByTestId("x-stats-answer").textContent).toContain("1 posts, 3 likes, 1 replies, 0 reposts and 40 views across 2 accounts");
    expect(screen.getByTestId("x-stats-answer").textContent).toContain("1 of 2 accounts read");
    const boxes = screen.getAllByTestId("x-stats-account");
    expect(boxes.map((b) => b.getAttribute("data-state"))).toEqual(["read", "not read"]);
    expect(boxes[0].textContent).toContain("+2");
    expect(boxes[0].textContent).toContain("+10");
    expect(screen.getAllByTestId("x-stats-post")).toHaveLength(1);
    expect(screen.getByText("laptop offline")).toBeTruthy();
  });

  it("says when nothing is stored yet", async () => {
    vi.spyOn(api, "getXStats").mockResolvedValue({ dates: [], day: null, history: [] });
    render(<MemoryRouter><XStatsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("No X stats stored yet.")).toBeTruthy());
  });
});

describe("Post stats says how fresh it is", () => {
  it("last refresh, cadence, settings and how to add an account; a read over a day old is late", () => {
    const now = Date.parse("2026-11-22T19:00:00Z");
    render(
      <MemoryRouter>
        <XStatsFreshness readAt="2026-11-22T16:35:20Z" now={now} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("x-stats-last-refresh").textContent).not.toMatch(/late/);
    expect(screen.getByTestId("x-stats-cadence").textContent).toMatch(/Once a day at 17:35 Berlin time/);
    expect(screen.getByTestId("x-stats-settings").textContent).toMatch(/Connections/);
    expect(screen.getByTestId("x-stats-add-account").textContent).toMatch(/Add @handle to Post stats/);
    cleanup();
    render(
      <MemoryRouter>
        <XStatsFreshness readAt="2026-11-20T16:35:20Z" now={now} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("x-stats-last-refresh").textContent).toMatch(/late, the daily read missed/);
  });
});
