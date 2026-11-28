// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAnswerVoiceState } from "@/voice/AnswerVoice";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import type { SocialData, SocialMetrics, SocialPost, SocialWriteAction } from "@/api/types";
import { mockCampaignCard } from "@/api/mockCampaigns";
import { AppRoutes } from "@/App";
import { SidebarNav } from "@/components/Layout";
import { boardLanes, emptySocialExport, ideaUsedOn, ledgerNumbers, toPost } from "@/lib/social";
import { SKINS, SkinProvider } from "@/lib/skin";
import { landsAt } from "@/test/landsAt";
import { resetEgressCache } from "@/pages/social/parts";

// the Pipeline is the main screen. The left menu reads Team, Chat, Pipeline; Pipeline gathers
// every campaign's posts on one board (each card names its campaign); a campaign's board has Ideas, Drafts, Scheduled,
// Posted; a draft spins in Drafts while the Writer works and offers Schedule when it is done (was Mark ready, then the owner asked for Schedule); Posted shows the numbers.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
// these tests drive the cards' own buttons: every card starts open (the board's Open all, remembered in the browser).
// these boards are the all-projects view (the project switcher's All projects)
beforeEach(() => (localStorage.clear(), localStorage.setItem("e74:open-all:v1", "1"), localStorage.setItem("console.project", "all")));
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

let line = 4;
const row = (p: Partial<SocialPost>): SocialPost => ({
  id: null, date: null, persona: "Writer", kind: "post", platform: null, community: null, slot: null, title: null, text: null, format: null, assets: [], topic: null,
  highlight: null, messages: [], idea: null, checks: null, link: null, replies: null, metrics: null, result: null, feedback: null, status: null,
  _line: ++line,
  ...p,
});

const memo = () => {
  const d = emptySocialExport("/repos/social");
  d.posts = [
    row({ id: "P-0001", date: "2026-11-01", platform: "X", title: "Memo held one", text: "held text", status: "held" }),
    row({ id: "P-0002", date: "2026-11-01", platform: "X", title: "Memo live on X", link: "https://x.com/MemoAgent/status/2116938581004464264", status: "posted" }),
    row({ id: "P-0003", date: "2026-10-26", platform: "Reddit", title: "Memo measured on Reddit", link: "https://www.reddit.com/r/x/comments/1/", replies: 13, metrics: "score 6, 50 comments (45 read, 1 removed) at 2026-10-28 20:05 UTC", status: "measured" }),
  ];
  return d;
};
const epic = () => {
  const d = emptySocialExport("/repos/brand-campaign");
  d.posts = [
    row({ id: "P-0001", date: "2026-11-02", platform: "Reddit", slot: "2026-11-03 10:00", title: "Epic scheduled one", text: "s", status: "scheduled" }),
    row({ id: "P-0002", date: "2026-11-02", platform: "X", title: "Epic being drafted", status: "draft" }),
  ];
  d.ideas = [{ id: "I-1", date: "2026-11-02", idea: "Epic idea", format: null, platform: "X", from: "Sam", link: null, state: "new", why: null, became: [], _line: 5 }];
  return d;
};
const DATA: Record<string, () => SocialData> = {
  "social": () => ({ tenantId: "social", repo: "social", data: memo() }),
  "brand-campaign": () => ({ tenantId: "social", repo: "brand-campaign", data: epic() }),
};
const CARDS = [
  { ...mockCampaignCard(), repo: "social", title: "social · EPIC-912: Make Memo heard", milestoneId: "ms-z" },
  { ...mockCampaignCard(), repo: "brand-campaign", title: "Epic campaign", milestoneId: "ms-e" },
];

let writes: [SocialWriteAction, string | undefined][] = [];
let metrics: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writes = [];
  vi.spyOn(api, "listCampaigns").mockResolvedValue({ tenantId: "social", campaigns: CARDS });
  vi.spyOn(api, "getSocial").mockImplementation(async (_t: string, repo?: string) => DATA[repo!]());
  metrics = vi.spyOn(api, "getSocialMetrics").mockImplementation(async (tenantId: string, repo?: string): Promise<SocialMetrics> => ({
    tenantId,
    repo: repo ?? null,
    readAt: "2026-11-02T09:30:00Z",
    posts: repo === "social" ? { "P-0002": { impressions: 41, likes: 3, reposts: 1, replies: 2 } } : {},
    missing: [],
  })) as unknown as ReturnType<typeof vi.fn>;
  vi.spyOn(api, "socialWrite").mockImplementation(async (_t: string, w: SocialWriteAction, repo?: string) => {
    writes.push([w, repo]);
    const s = DATA[repo!]();
    if (w.action === "posts/P-0001/approve") s.data.posts.find((p) => p.id === "P-0001")!.status = "scheduled";
    return { ...s, action: w.action.replace(/^posts\/[^/]+\//, ""), id: "P-0001", commit: "abc1234", push: { state: "pushed" }, files: [] } as never;
  });
});

const app = (path: string) =>
  render(
    <SkinProvider skin={SKINS.social}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </SkinProvider>,
  );
/** Posted keeps the last 7 days; these fixtures may be older than that by now: unfold them. */
const showOlder = async () => {
  const t = within(await screen.findByTestId("lane-posted")).queryByTestId("posted-older");
  if (t && /folded away/.test(t.textContent ?? "")) fireEvent.click(t);
};
const cardIn = async (lane: string, text: string) => (await within(await screen.findByTestId(`lane-${lane}`)).findAllByTestId("lane-item")).find((c) => c.textContent?.includes(text));

describe("the menu's Pipeline: every campaign on one board", () => {
  it("the left menu reads Team, Chat, Pipeline in the social skin (not in the console skin)", async () => {
    // one menu for both skins (the console skin's); the social pages sit in the Tools fold.
    render(
      <SkinProvider skin={SKINS.social}>
        <MemoryRouter>
          <SidebarNav />
        </MemoryRouter>
      </SkinProvider>,
    );
    const main = await screen.findByTestId("nav-main");
    // Messages (DMs) sits under Pipeline in a world with a social repo (the mock world has one).
    await screen.findByTestId("nav-messages");
    const names = (el: Element) => [...el.querySelectorAll("a")].map((a) => a.textContent?.replace(/\d+/g, "").trim());
    // Inbox and Chat on top, Messages in the main list as in the console skin; Performance and Product are tools.
    // The Pipeline is each campaign's tab.
    expect(names(main).slice(0, 2)).toEqual(["Inbox", "Chat"]);
    expect(names(main)).toContain("Messages");
    expect(screen.queryByTestId("nav-social-pages")).toBeNull();
    fireEvent.click(screen.getByTestId("nav-pages-toggle"));
    expect(names(screen.getByTestId("nav-pages-list")).slice(0, 2)).toEqual(["Performance", "Product"]);
    expect(screen.queryByTestId("nav-pipeline")).toBeNull();
    cleanup();
    render(
      <SkinProvider skin={SKINS.console}>
        <MemoryRouter>
          <SidebarNav />
        </MemoryRouter>
      </SkinProvider>,
    );
    await screen.findByTestId("nav-main");
    expect(screen.queryByTestId("nav-pipeline")).toBeNull();
  });

  it("/social/pipeline without a campaign is the all-campaigns board; with ?repo= it is that campaign", async () => {
    expect(await landsAt("/social/pipeline")).toBe("/pipeline");
    expect(await landsAt("/social/pipeline?repo=brand-campaign")).toBe("/milestones/ms-e");
  });

  it("each card names its campaign; the four columns gather both campaigns; post ids that repeat stay apart", async () => {
    app("/pipeline");
    const held = (await cardIn("draft", "Memo held one"))!;
    expect(within(held).getByTestId("card-campaign").textContent).toContain("Make Memo heard");
    expect(within(held).getByTestId("card-campaign").querySelector("a")!.getAttribute("href")).toBe("/milestones/ms-z");
    const drafting = (await cardIn("draft", "Epic being drafted"))!;
    expect(within(drafting).getByTestId("card-campaign").textContent).toContain("Epic campaign");
    expect((await cardIn("scheduled", "Epic scheduled one"))!).toBeTruthy();
    expect((await cardIn("idea", "Epic idea"))!).toBeTruthy();
    await showOlder();
    expect(within(screen.getByTestId("lane-posted")).getAllByTestId("lane-item")).toHaveLength(2);
    // Ready first, the spinning one after it.
    const drafts = within(screen.getByTestId("lane-draft")).getAllByTestId("lane-item");
    expect(drafts.map((c) => c.getAttribute("aria-busy"))).toEqual([null, "true"]);
    // The same platform filters across campaigns.
    fireEvent.click(within(screen.getByRole("group", { name: "Platform" })).getByRole("button", { name: "Reddit" }));
    expect(within(screen.getByTestId("lane-posted")).getAllByTestId("lane-item")).toHaveLength(1);
    expect(within(screen.getByTestId("lane-draft")).queryAllByTestId("lane-item")).toHaveLength(0);
  });

  it("named campaigns: a tagged post is its campaign's card, the rest the repo's; a retired campaign's posts stay off", async () => {
    const named = (code: string, name: string, retired = false) => ({ ...mockCampaignCard(), repo: "social", title: name, milestoneId: `ms-${code}`, campaign: { code, name, path: `docs/spines/${code}.md`, platform: null, period: null }, retired });
    vi.mocked(api.listCampaigns).mockResolvedValue({ tenantId: "social", campaigns: [...CARDS, named("EPIC-907", "Launch week"), named("EPIC-908", "Old push", true)] });
    const read = vi.mocked(api.getSocial);
    read.mockImplementation(async (_t: string, repo?: string) => {
      const s = DATA[repo!]();
      if (repo === "social")
        s.data.posts.push(
          row({ id: "P-0010", date: "2026-11-02", platform: "X", title: "Launch week draft", status: "held", campaign: "epic-907" }),
          row({ id: "P-0011", date: "2026-11-02", platform: "X", title: "Old push draft", status: "held", campaign: "EPIC-908" }),
        );
      return s;
    });
    app("/pipeline");
    const launch = (await cardIn("draft", "Launch week draft"))!;
    expect(within(launch).getByTestId("card-campaign").textContent).toContain("Launch week");
    expect(within(launch).getByTestId("card-campaign").querySelector("a")!.getAttribute("href")).toBe("/milestones/ms-EPIC-907");
    expect(within((await cardIn("draft", "Memo held one"))!).getByTestId("card-campaign").textContent).toContain("Make Memo heard");
    expect(screen.queryByText("Old push draft")).toBeNull();
    // One read per repo, whatever the number of campaigns in it.
    expect(read.mock.calls.map((c) => c[1]).sort()).toEqual(["brand-campaign", "social"]);
  });

  it("a campaign that cannot be read is named on the page, the others still show", async () => {
    vi.mocked(api.getSocial).mockImplementation(async (_t: string, repo?: string) => {
      if (repo === "brand-campaign") throw new Error("timeout after 30 s");
      return DATA[repo!]();
    });
    app("/pipeline");
    expect((await screen.findByTestId("campaign-unread")).textContent).toBe("Not on the board: Epic campaign could not be read (timeout after 30 s). It comes back on the next refresh.");
    expect((await cardIn("draft", "Memo held one"))!).toBeTruthy();
  });

  it("Schedule writes to that card's campaign and the card lands in Scheduled, its result on the card", async () => {
    app("/pipeline");
    const held = (await cardIn("draft", "Memo held one"))!;
    fireEvent.click(within(held).getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(writes).toEqual([[{ action: "posts/P-0001/approve", body: {} }, "social"]]));
    const landed = (await waitFor(() => cardIn("scheduled", "Memo held one").then((c) => c ?? Promise.reject(new Error("not yet")))))!;
    expect(within(landed).getByTestId("write-note").textContent).toContain("P-0001 is scheduled: it goes out at its slot");
    // The other campaign's P-0001 is untouched.
    expect((await cardIn("scheduled", "Epic scheduled one"))!).toBeTruthy();
  });

  it("Week view lists every campaign's posts, each naming its campaign", async () => {
    app("/pipeline");
    await screen.findByTestId("lane-draft");
    fireEvent.click(within(screen.getByTestId("pipeline-view")).getByRole("button", { name: "Week" }));
    expect(await screen.findByTestId("week-label")).toBeTruthy();
  });
});

describe("Give feedback, E61-5 Post now (Sam's voice note 2026-11-02)", () => {
  it("Give feedback on an idea (replaces Edit) sends it to the Scout; the card stays in Ideas with Draft it spinning until the new words are in", async () => {
    let reworded = false;
    vi.mocked(api.getSocial).mockImplementation(async (_t: string, repo?: string) => {
      const s = DATA[repo!]();
      if (reworded && repo === "brand-campaign") s.data.ideas[0].idea = "Epic idea, about replies";
      return s;
    });
    app("/pipeline");
    const card = (await cardIn("idea", "Epic idea"))!;
    expect(within(card).queryByRole("button", { name: "Edit" })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Give feedback" }));
    fireEvent.change(within(card).getByLabelText("Feedback on I-1"), { target: { value: "about replies" } });
    fireEvent.click(within(card).getByRole("button", { name: "Send to the Scout" }));
    await waitFor(() => expect(writes).toEqual([[{ action: "ideas/I-1/feedback", body: { feedback: "about replies" } }, "brand-campaign"]]));
    const waiting = (await waitFor(() => cardIn("idea", "Epic idea").then((c) => (c?.getAttribute("aria-busy") ? c : Promise.reject(new Error("not yet"))))))!;
    expect(within(waiting).getByTestId("card-working").textContent).toContain("The Scout is rewriting it with your feedback");
    expect(within(waiting).getAllByRole("button").filter((b) => !b.hasAttribute("data-fold-open")).map((b) => [b.textContent, (b as HTMLButtonElement).disabled])).toEqual([["Scout is rewriting…", true]]);
    // The Scout's new words arrive (next read): Draft it is back.
    reworded = true;
    cleanup();
    app("/pipeline");
    const back = (await cardIn("idea", "Epic idea, about replies"))!;
    expect(back.getAttribute("aria-busy")).toBeNull();
    expect(within(back).getByRole("button", { name: "Give feedback" })).toBeTruthy();
  });

  it("while the Mac is not online a Scheduled card has no Post now and says it goes out when the Mac is back", async () => {
    resetEgressCache();
    const egress = vi.spyOn(api, "listEgress").mockResolvedValue([{ name: "laptop", state: "offline" }]);
    app("/pipeline");
    const card = (await cardIn("scheduled", "Epic scheduled one"))!;
    expect(egress).toHaveBeenCalledWith(true); // the posting path: the world's own browser, then the one it borrows
    expect((await within(card).findByTestId("post-now-off")).textContent).toBe("The Mac is not online, so it can't go out right now. It goes out at its slot when the Mac is back online.");
    expect(within(card).queryByRole("button", { name: "Post now" })).toBeNull();
  });

  it("Post now on a Scheduled card asks once, writes post-now, and the card spins in Scheduled until it is live", async () => {
    resetEgressCache();
    vi.spyOn(api, "listEgress").mockResolvedValue([{ name: "laptop", state: "online" }]);
    vi.mocked(api.socialWrite).mockImplementation(async (_t: string, w: SocialWriteAction, repo?: string) => {
      writes.push([w, repo]);
      const s = DATA[repo!]();
      s.data.posts.find((p) => p.id === "P-0001")!.feedback = "Post now 2026-11-02 10:05 UTC";
      return { ...s, action: "post now", id: "P-0001", commit: "abc1234", push: { state: "pushed" }, files: [], wake: { assignmentId: "as_p", runId: "run_1", role: "Publisher" } } as never;
    });
    app("/pipeline");
    const card = (await cardIn("scheduled", "Epic scheduled one"))!;
    fireEvent.click(await within(card).findByRole("button", { name: "Post now" }));
    expect(within(card).getByRole("alertdialog").textContent).toContain("It goes out on Reddit now, not at Tue 3 Nov 10:00.");
    expect(writes).toEqual([]);
    fireEvent.click(within(card).getByRole("button", { name: "Post it now" }));
    await waitFor(() => expect(writes).toEqual([[{ action: "posts/P-0001/post-now" }, "brand-campaign"]]));
    const sending = (await waitFor(() => cardIn("scheduled", "Epic scheduled one").then((c) => (c?.getAttribute("aria-busy") ? c : Promise.reject(new Error("not yet"))))))!;
    expect(within(sending).getByTestId("card-working").textContent).toContain("Sending it now");
    expect(within(sending).getAllByRole("button").filter((b) => !b.hasAttribute("data-fold-open")).map((b) => [b.textContent, (b as HTMLButtonElement).disabled])).toEqual([["Sending…", true]]);
    expect(within(sending).getByTestId("write-note").textContent).toContain("P-0001 goes out now: the Publisher is posting it");
  });

  it("only finished drafts count as ready for Sam", async () => {
    app("/pipeline");
    expect((await screen.findByTestId("drafts-ready")).textContent).toBe("1 ready for you");
  });

  it("Give feedback on a draft can be spoken: the one voice note of every card, never the browser's dictation", async () => {
    clearAnswerVoiceState();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (String(url).endsWith("/state") ? new Response(JSON.stringify({ enabled: true, monthUsd: 0, limits: { monthCapUsd: 25 } }), { headers: { "content-type": "application/json" } }) : new Response("{}", { status: 404 }))),
    );
    try {
      app("/pipeline");
      const card = (await cardIn("draft", "Memo held one"))!;
      fireEvent.click(within(card).getByRole("button", { name: "Give feedback" }));
      expect(within(card).queryByTestId("dictate")).toBeNull();
      expect((await within(card).findByTestId("answer-voice-button")).getAttribute("aria-label")).toBe("Record a voice note");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Posted / monitoring", () => {
  it("Posted sorts by its numbers (reads, replies, ...), newest by default", async () => {
    app("/pipeline");
    await showOlder();
    await waitFor(async () => expect(within((await cardIn("posted", "Memo live on X"))!).getByTestId("post-numbers").textContent).toContain("41 impressions"));
    const titles = () => within(screen.getByTestId("lane-posted")).getAllByTestId("lane-item").map((c) => (c.textContent?.includes("Memo live on X") ? "X" : "Reddit"));
    expect(titles()).toEqual(["X", "Reddit"]);
    fireEvent.change(screen.getByTestId("posted-sort"), { target: { value: "comments" } });
    expect(titles()).toEqual(["Reddit", "X"]);
    fireEvent.change(screen.getByTestId("posted-sort"), { target: { value: "impressions" } });
    expect(titles()).toEqual(["X", "Reddit"]);
  });

  it("an X post shows its live numbers and when they were read; a Reddit post the Reporter's score and comments", async () => {
    app("/pipeline");
    await showOlder();
    const x = (await cardIn("posted", "Memo live on X"))!;
    await waitFor(() => expect(within(x).getByTestId("post-numbers").textContent).toContain("41 impressions"));
    expect(within(x).getByTestId("post-numbers").textContent).toMatch(/3 likes.*1 reposts.*2 replies/);
    expect(within(x).getByTestId("numbers-read").textContent).toBe("Read live from X at 2026-11-02 09:30 UTC");
    const r = (await cardIn("posted", "Memo measured on Reddit"))!;
    expect(within(r).getByTestId("post-numbers").textContent).toMatch(/6 score.*50 comments/);
    expect(within(r).getByTestId("numbers-read").textContent).toBe("Read by the Reporter at 2026-10-28 20:05 UTC · Reddit gives no impressions");
    expect(metrics.mock.calls.map((c) => c[1])).toEqual(["social"]);
  });
});

describe("lib", () => {
  it("boardLanes: four lanes; held is a ready draft, draft rows, revisions and picked-up ideas spin; Draft it now moves an idea to Drafts; an idea that became a post shows once", () => {
    const d = emptySocialExport("");
    d.posts = [
      row({ id: "P-1", date: "2026-11-01", platform: "X", status: "held" }),
      row({ id: "P-2", date: "2026-11-01", platform: "X", status: "held", feedback: "Revise requested 2026-11-02 10:05 UTC: shorter" }),
      row({ id: "P-3", date: "2026-11-01", platform: "X", status: "held", feedback: "Approved with feedback 2026-11-02 10:05 UTC: shorter" }),
      row({ id: "P-4", date: "2026-11-01", platform: "X", status: "draft", idea: "I-3" }),
      row({ id: "P-5", date: "2026-11-01", platform: "X", status: "measured" }),
      row({ id: "P-6", date: "2026-11-01", platform: "X", kind: "reply", status: "posted" }),
      row({ id: "P-7", date: "2026-11-01", platform: "X", status: "pulled" }),
    ];
    const idea = (id: string, state: string) => ({ id, date: "2026-11-01", idea: id, format: null, platform: null, from: "Sam", link: null, state, why: null, became: [], _line: 5 });
    d.ideas = [idea("I-1", "new"), idea("I-2", "picked up"), idea("I-3", "picked up"), idea("I-4", "new"), idea("I-5", "drafted")];
    const { lanes, replies } = boardLanes(d, new Set(["I-4"]));
    const ids = (l: keyof typeof lanes) => lanes[l].map((it) => (it.kind === "post" ? it.post.id : it.idea.id));
    expect(Object.keys(lanes)).toEqual(["idea", "draft", "scheduled", "posted"]);
    // ideas never expire: an idea that became a post (I-3, legacy I-5) stays in Ideas, open for other platforms
    expect(ids("idea")).toEqual(["I-5", "I-3", "I-1"]);
    expect(ids("draft")).toEqual(["P-1", "I-4", "I-2", "P-4", "P-3", "P-2"]);
    expect(lanes.draft.map((it) => !!it.working)).toEqual([false, true, true, true, true, true]);
    expect(ids("posted")).toEqual(["P-5"]);
    expect(replies).toBe(1);
  });

  it("ledgerNumbers reads the Reporter's Metrics cell (X and Reddit wording); empty cell = not read yet", () => {
    const n = (metrics: string | null) => ledgerNumbers(toPost(row({ metrics })));
    expect(n("3 posts: 3 impressions (2/1/0), 0 likes, 0 reposts, 0 external replies at 2026-10-28 20:05 UTC")).toEqual({ source: "ledger", impressions: 3, likes: 0, reposts: 0, replies: 0, readAt: "2026-10-28 20:05" });
    expect(n("score 1, 0 direct replies at 2026-10-28 20:05 UTC")).toEqual({ source: "ledger", score: 1, replies: 0, readAt: "2026-10-28 20:05" });
    expect(n("score 6, 50 comments (45 read, 1 removed) at 2026-10-28 20:05 UTC")).toEqual({ source: "ledger", score: 6, comments: 50, readAt: "2026-10-28 20:05" });
    expect(n("1,204 impressions")).toEqual({ source: "ledger", impressions: 1204 });
    expect(n(null)).toBeUndefined();
  });
});

describe("ideas never expire on the board", () => {
  it("an open idea stays after its first post with Used on per platform; parked and spent leave; Draft it ends when a new post comes from it", () => {
    const d = emptySocialExport("");
    d.posts = [row({ id: "P-1", date: "2026-11-01", platform: "Reddit", status: "held", idea: "I-1" }), row({ id: "P-2", date: "2026-11-01", platform: "X", status: "posted" })];
    const idea = (id: string, state: string) => ({ id, date: "2026-11-01", idea: id, format: null, platform: "Reddit, LinkedIn", from: "Scout", link: null, state, why: null, became: [], _line: 5 });
    d.ideas = [idea("I-1", "open"), idea("I-2", "parked"), idea("I-3", "spent"), idea("I-4", "new")];
    const ids = (m: ReadonlySet<string> | ReadonlyMap<string, string>) => {
      const { lanes } = boardLanes(d, m);
      return [lanes.idea.map((it) => (it.kind === "idea" ? it.idea.id : "")), lanes.draft.filter((it) => it.kind === "idea").map((it) => (it.kind === "idea" ? it.idea.id : ""))];
    };
    expect(ids(new Set())).toEqual([["I-4", "I-1"], []]);
    expect(ids(new Map([["I-1", "1"]]))).toEqual([["I-4"], ["I-1"]]); // pressed with 1 post: drafting until a 2nd comes
    expect(ids(new Map([["I-1", "0"]]))).toEqual([["I-4", "I-1"], []]); // pressed with none: P-1 came from it, done
    expect(ideaUsedOn(d.ideas[0], d)).toEqual([
      { platform: "Reddit", posts: [{ id: "P-1", status: "held" }] },
      { platform: "LinkedIn", posts: [] },
      { platform: "X", posts: [] },
    ]);
    expect(ideaUsedOn({ ...d.ideas[0], used_on: { X: ["P-2"] } }, d).find((u) => u.platform === "X")).toEqual({ platform: "X", posts: [{ id: "P-2", status: "posted" }] });
  });
});
