// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "@/App";
import { SidebarNav } from "@/components/Layout";
import { SKINS, SkinProvider, type Skin } from "@/lib/skin";
import { CalendarPage } from "@/pages/Calendar";
import { api } from "@/api";
import type { SocialData, SocialPost } from "@/api/types";
import { emptySocialExport, initialWeek, LEGACY_DECISIONS_KEY, placeByDay, postsOf, sampleSocialExport, toPost, weekStart } from "@/lib/social";
import { landsAt } from "@/test/landsAt";

// the calendar reads the pack export (GET /api/tenants/:id/social). Rows in the export's shape: two from a ledger
// from before the pack (no id, draft inside Title, a status off the lifecycle), one with the pack's own columns.
let line = 6;
const row = (p: Partial<SocialPost>): SocialPost => ({
  id: null, date: null, persona: null, kind: null, platform: null, community: null, slot: null, title: null, text: null, format: null, assets: [], topic: null,
  highlight: null, messages: [], idea: null, checks: null, link: null, replies: null, metrics: null, result: null, feedback: null, status: null, _line: line++, ...p,
});
const EXPORT = (() => {
  const d = emptySocialExport("/repos/social", [{ file: "data/posts-ledger.md", line: 5, message: "missing column(s): Id" }]);
  d.posts = [
    row({ id: "P-0001", date: "2026-10-19", persona: "Author", kind: "post", platform: "X (thread, 3 posts, @MemoAgent)", link: "https://x.com/a/1", title: "Memory as files you own", replies: 0, status: "posted" }),
    row({ date: "2026-10-21", persona: "Engager", platform: "X (outreach reply, @MemoAgent)", link: "https://x.com/b/1", title: 'Reply to @bob on agent memory. Draft: "Every memory a commit | open source."', replies: 0, status: "draft" }),
    row({ date: "2026-10-25", persona: "Responder", platform: "Reddit (DM, u/carol)", link: "https://www.reddit.com/chat", title: "Chat request from u/carol. No draft yet", replies: 0, status: "draft" }),
    row({ date: "2026-10-25", persona: "Responder", platform: "Reddit (DMs, left for Sam)", title: "Chats not answered by rule", status: "left for sam" }),
    row({ date: null, title: "no date: not on the calendar" }),
  ];
  return d;
})();
const DATA: SocialData = { tenantId: "home", repo: "social", data: EXPORT };

let getSocial: { mock: { calls: unknown[][] } };
const serve = (d: SocialData = DATA) => {
  getSocial = vi.spyOn(api, "getSocial").mockResolvedValue(d);
};

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const page = (skin: Skin = SKINS.social) =>
  render(
    <SkinProvider skin={skin}>
      <MemoryRouter>
        <CalendarPage />
      </MemoryRouter>
    </SkinProvider>,
  );

describe("T34-S5 posts from the pack export", () => {
  it("types export rows for the screens: ids, legacy draft text, first link, status", () => {
    const posts = postsOf(EXPORT);
    expect(posts.map((p) => [p.id, p.date, p.status])).toEqual([
      ["P-0001", "2026-10-19", "posted"],
      ["L7", "2026-10-21", "draft"],
      ["L8", "2026-10-25", "draft"],
      ["L9", "2026-10-25", "other"],
    ]);
    expect(posts[0].link).toBe("https://x.com/a/1");
    expect(posts[1].title).toBe("Reply to @bob on agent memory");
    expect(posts[1].text).toBe("Every memory a commit | open source.");
    expect(posts[2].text).toBe("");
    expect(posts[3].statusText).toBe("left for sam");
    expect(toPost(row({ title: "T", text: "body", status: "held", slot: "2026-11-01 10:00" }))).toMatchObject({ title: "T", text: "body", status: "held", date: "2026-11-01" });
  });

  it("places posts by day in a Monday-first week", () => {
    expect(weekStart("2026-10-25")).toBe("2026-10-19"); // a Sunday belongs to the week of Monday the 19th
    expect(weekStart("2026-10-19")).toBe("2026-10-19");
    const posts = postsOf(EXPORT);
    expect(initialWeek(posts, "2026-12-01")).toBe("2026-10-19");
    expect(initialWeek([], "2026-10-28")).toBe("2026-10-26");
    const days = placeByDay(posts, "2026-10-19");
    expect(days.map((d) => d.date)).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
    expect(days.map((d) => d.posts.map((p) => p.id))).toEqual([["P-0001"], [], ["L7"], [], [], [], ["L8", "L9"]]);
    expect(placeByDay(posts, "2026-10-26").every((d) => d.posts.length === 0)).toBe(true);
  });

  it("the sample has the export's shape", () => {
    expect(postsOf(sampleSocialExport()).length).toBeGreaterThan(3);
  });
});

describe("T24-S5 calendar screen", () => {
  it("reads the world's social data once and shows drafts by day", async () => {
    serve();
    page();
    expect(await screen.findByTestId("week-label")).toHaveProperty("textContent", "Week of Mon 19 Oct");
    expect(getSocial).toHaveBeenCalledTimes(1);
    expect(getSocial.mock.calls[0][0]).toBe("home");
    expect(within(screen.getByTestId("day-2026-10-21")).getByText("Reply to @bob on agent memory")).toBeTruthy();
    expect(within(screen.getByTestId("day-2026-10-25")).getAllByTestId("day-post")).toHaveLength(2);
    expect(within(screen.getByTestId("day-2026-10-20")).queryAllByTestId("day-post")).toHaveLength(0);
    expect(screen.getByText("social (social pack)", { exact: false })).toBeTruthy();
    expect(screen.getByTestId("social-warnings").textContent).toContain("data/posts-ledger.md:5: missing column(s): Id");

    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    expect(screen.getByTestId("week-label").textContent).toBe("Week of Mon 26 Oct");
    expect(screen.queryAllByTestId("day-post")).toHaveLength(0);
  });

  it("says when the data is the mock client's sample (local dev)", async () => {
    serve({ tenantId: "home", repo: "social", data: sampleSocialExport(), sample: true });
    page();
    expect(await screen.findByText(/sample data/)).toBeTruthy();
    expect(screen.getAllByTestId("day-post").length).toBeGreaterThan(0);
  });

  it("T34-S9: no approval gate: no approve / reject / inbox, and T24-S5's stored decisions are dropped", async () => {
    localStorage.setItem(LEGACY_DECISIONS_KEY, JSON.stringify({ L7: { status: "rejected" } }));
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    serve();
    page();
    await screen.findByTestId("week-label");
    expect(screen.queryByRole("button", { name: /Approve|Reject/ })).toBeNull();
    expect(screen.queryByTestId("inbox-item")).toBeNull();
    expect(screen.queryByText(/approved|rejected/)).toBeNull();
    expect(localStorage.getItem(LEGACY_DECISIONS_KEY)).toBeNull();
    expect(screen.getByRole("link", { name: "Pipeline" }).getAttribute("href")).toBe("/social/pipeline");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("T24-S5 screen set", () => {
  const routeAt = (path: string, skin: Skin) =>
    render(
      <SkinProvider skin={skin}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </SkinProvider>,
    );

  it("is absent from the console skin: no nav link and no route", () => {
    serve();
    const nav = render(
      <MemoryRouter>
        <SidebarNav />
      </MemoryRouter>,
    );
    expect(nav.container.querySelector('a[href="/calendar"]')).toBeNull();
    cleanup();
    routeAt("/calendar", SKINS.console);
    expect(screen.getByText(/Not found\./)).toBeTruthy();
    expect(getSocial).not.toHaveBeenCalled();
  });

  it("leads to the campaign's Pipeline in the social skin (T58-S3: Week view)", async () => {
    serve();
    expect(await landsAt("/calendar")).toBe("/pipeline"); // the all-campaigns Pipeline (Week view)
  });
});
