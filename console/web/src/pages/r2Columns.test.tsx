// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import type { SocialData, SocialPost, SocialWriteAction } from "@/api/types";
import { emptySocialExport } from "@/lib/social";
import { resetEgressCache } from "@/pages/social/parts";
import { FOCUS_KEY, PipelineBoard, VIEW_KEY, type BoardSource } from "@/pages/social/Pipeline";
import { widePage } from "@/components/Layout";

// the Pipeline's columns read as columns (a header with the count, the
// same height, a cue when more columns are to the right), a Rows view (every post one row, each opens in place), Full
// screen for one post (a dialog with its text, image and buttons) and Full width (the Pipeline over the whole screen).

const NOW = new Date("2026-11-07T12:00:00Z");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.querySelectorAll("[data-testid=drag-ghost]").forEach((g) => g.remove());
});
beforeEach(() => {
  localStorage.clear();
  resetEgressCache();
  vi.spyOn(api, "listEgress").mockResolvedValue([{ name: "laptop", state: "online" }]);
  vi.spyOn(api, "getSocialMetrics").mockRejectedValue(new Error("no metrics in this test"));
});
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
// jsdom has no PointerEvent: a MouseEvent with a pointer id and type is enough for the board's drag.
if (!("PointerEvent" in globalThis)) {
  class PointerEventShim extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  Object.assign(globalThis, { PointerEvent: PointerEventShim });
}

let line = 4;
const row = (p: Partial<SocialPost>): SocialPost => ({
  id: null, date: "2026-11-06", persona: "Writer", kind: "post", platform: "X", community: null, slot: null, title: null, text: null, format: null, assets: [], topic: null,
  highlight: null, messages: [], idea: null, checks: null, link: null, replies: null, metrics: null, result: null, feedback: null, status: null,
  _line: ++line,
  ...p,
});
const social = (): SocialData => {
  const d = emptySocialExport("/repos/test-campaign");
  d.posts = [
    { ...row({ id: "P-0001", title: "A ready draft", text: "ready text", status: "held", slot: "2026-11-09 09:00" }), nextSlot: "2026-11-09 09:00" } as SocialPost,
    row({ id: "P-0002", title: "A scheduled post with a much longer title that would wrap over several lines on a narrow column", text: "s", status: "scheduled", slot: "2026-11-08 10:00" }),
    row({ id: "P-0003", title: "Went out this week", status: "posted", slot: "2026-11-05 09:00", link: "https://example.com/p3", metrics: "41 impressions, 3 likes at 2026-11-06 10:00 UTC" }),
    row({ id: "P-0004", date: "2026-10-20", title: "Went out weeks ago", status: "measured", slot: "2026-10-20 09:00", link: "https://example.com/p4" }),
  ];
  d.ideas = [{ id: "I-1", date: "2026-11-06", idea: "An idea for later", format: null, platform: "X", from: "Sam", link: null, state: "new", why: null, became: [], _line: 3 }];
  return { tenantId: "acme", repo: "test-campaign", data: d };
};

function board(over: Partial<BoardSource> = {}) {
  const write = vi.fn(async (_w: SocialWriteAction) => undefined);
  const src: BoardSource = { repo: "test-campaign", social: social(), write, ...over };
  const view = render(
    <MemoryRouter>
      <PipelineBoard sources={[src]} now={NOW} addIdea={false} />
    </MemoryRouter>,
  );
  return { write: (over.write as typeof write | undefined) ?? write, view, src };
}
const lane = (id: string) => screen.getByTestId(`lane-${id}`);
const cardOf = (text: string) => screen.getAllByTestId("lane-item").find((c) => c.textContent?.includes(text))!;
/** A mouse drag of `card` to the column `to` (jsdom has no layout: the point under the pointer is that column). */
function dragTo(card: HTMLElement, to: HTMLElement) {
  const was = document.elementFromPoint;
  document.elementFromPoint = () => to;
  try {
    fireEvent.pointerDown(card, { button: 0, pointerId: 7, pointerType: "mouse", clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 7, pointerType: "mouse", clientX: 80, clientY: 12 });
    expect(document.querySelector("[data-testid=drag-ghost]")).toBeTruthy();
    fireEvent.pointerUp(window, { pointerId: 7, pointerType: "mouse", clientX: 80, clientY: 12 });
  } finally {
    document.elementFromPoint = was;
  }
}


describe("T46-S13 r2 columns", () => {
  it("each column has a title with its count as a pill and its own scrolling body, all four side by side", () => {
    board();
    expect(screen.getByTestId("lane-count-idea").textContent).toBe("1");
    expect(screen.getByTestId("lane-count-draft").textContent).toBe("1");
    expect(screen.getByTestId("lane-count-scheduled").textContent).toBe("1");
    expect(screen.getByTestId("lane-count-posted").textContent).toBe("1");
    for (const id of ["idea", "draft", "scheduled", "posted"]) {
      expect(lane(id).className).toContain("bg-muted/50"); // a tinted column, not loose cards
      expect(lane(id).className).not.toContain("hidden"); // the phone shows every column, the next one peeks in
      expect(screen.getByTestId(`lane-body-${id}`).className).toContain("overflow-y-auto");
    }
    expect(screen.getByTestId("board-scroll").className).toContain("overflow-x-auto");
    expect(screen.getByTestId("view-board").getAttribute("aria-pressed")).toBe("true");
  });

  it("when the board is wider than the screen it says so: an edge fade and a line under it", () => {
    const sw = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(1600);
    const cw = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390);
    board();
    expect(screen.getByTestId("edge-right")).toBeTruthy();
    expect(screen.getByTestId("scroll-cue").textContent).toContain("More columns to the right");
    expect(screen.queryByTestId("edge-left")).toBeNull();
    sw.mockRestore();
    cw.mockRestore();
  });

  it("on the phone the chip that is lit is the column the board shows, and follows a sideways scroll", () => {
    const sw = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(1600);
    const cw = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390);
    const lefts: Record<string, number> = { idea: 0, draft: 320, scheduled: 640, posted: 960 };
    const ol = vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
      return lefts[this.dataset.dropLane ?? ""] ?? 0;
    });
    board();
    const lit = () => within(screen.getByTestId("lane-switch")).getAllByRole("button").find((b) => b.getAttribute("aria-current") === "true")?.textContent;
    expect(lit()).toContain("Ideas");
    const box = screen.getByTestId("board-scroll");
    box.scrollLeft = 650;
    fireEvent.scroll(box);
    expect(lit()).toContain("Scheduled");
    sw.mockRestore();
    cw.mockRestore();
    ol.mockRestore();
  });

  it("a board that fits shows no cue", () => {
    board();
    expect(screen.queryByTestId("scroll-cue")).toBeNull();
  });
});

describe("T46-S13 r2 Rows view", () => {
  it("every post is one row, grouped by column; a click opens it in place, Fold folds it; the view is remembered", () => {
    board();
    fireEvent.click(screen.getByTestId("view-rows"));
    expect(screen.getByTestId("rows-view")).toBeTruthy();
    expect(localStorage.getItem(VIEW_KEY)).toBe("rows");
    const rows = screen.getAllByTestId("lane-item");
    expect(rows.length).toBe(4);
    for (const r of rows) expect(r.hasAttribute("data-row")).toBe(true);
    expect(within(lane("draft")).getByText("A ready draft")).toBeTruthy();
    fireEvent.click(cardOf("A ready draft"));
    const open = cardOf("A ready draft");
    expect(open.hasAttribute("data-folded")).toBe(false);
    expect(within(open).getByRole("button", { name: /Schedule for/ })).toBeTruthy();
    fireEvent.click(within(open).getByTestId("card-fold"));
    expect(cardOf("A ready draft").hasAttribute("data-row")).toBe(true);
    cleanup();
    board();
    expect(screen.getByTestId("rows-view")).toBeTruthy(); // remembered
    fireEvent.click(screen.getByTestId("view-board"));
    expect(screen.getByTestId("board-scroll")).toBeTruthy();
  });

  it("a row dragged to Scheduled is the draft's own Schedule, as on the columns", async () => {
    localStorage.setItem(VIEW_KEY, "rows");
    const { write } = board({ busy: "posts/P-0001/approve" });
    dragTo(cardOf("A ready draft"), lane("scheduled"));
    await waitFor(() => expect(write).toHaveBeenCalledWith({ action: "posts/P-0001/approve", body: { slot: "2026-11-09 09:00" } }));
  });

  it("Open all opens every row", () => {
    localStorage.setItem(VIEW_KEY, "rows");
    board();
    fireEvent.click(screen.getByTestId("open-all"));
    expect(screen.getAllByTestId("lane-item").every((c) => !c.hasAttribute("data-folded"))).toBe(true);
  });
});

describe("T46-S13 r2 Full screen post", () => {
  it("Full screen on a folded card opens the whole post in a dialog with its buttons; the card itself stays folded", async () => {
    const { write } = board();
    const card = cardOf("A ready draft");
    fireEvent.click(within(card).getByTestId("card-full"));
    expect(cardOf("A ready draft").hasAttribute("data-folded")).toBe(true);
    const dlg = await screen.findByTestId("post-full");
    expect(within(dlg).getByText(/P-0001 · Drafts/)).toBeTruthy();
    const item = within(dlg).getByTestId("full-item");
    expect(within(item).getByTestId("post-text").className).not.toContain("line-clamp");
    expect(within(item).queryByTestId("card-fold")).toBeNull();
    fireEvent.click(within(item).getByRole("button", { name: /Schedule for/ }));
    await waitFor(() => expect(write).toHaveBeenCalledWith({ action: "posts/P-0001/approve", body: { slot: "2026-11-09 09:00" } }));
  });

  it("works from a row and from an open card, and closes", async () => {
    localStorage.setItem(VIEW_KEY, "rows");
    board();
    fireEvent.click(within(cardOf("A scheduled post")).getByTestId("card-full"));
    const dlg = await screen.findByTestId("post-full");
    expect(within(dlg).getByText(/P-0002 · Scheduled/)).toBeTruthy();
    fireEvent.click(within(dlg).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByTestId("post-full")).toBeNull());
    fireEvent.click(cardOf("An idea for later"));
    fireEvent.click(within(cardOf("An idea for later")).getByTestId("card-full"));
    expect(within(await screen.findByTestId("post-full")).getByText(/Idea I-1 · Ideas/)).toBeTruthy();
  });
});

describe("T46-S13 r2 Full width", () => {
  it("opens the Pipeline over the whole screen, is remembered, and Esc leaves it", () => {
    board();
    expect(screen.queryByTestId("pipeline-focus-layer")).toBeNull();
    fireEvent.click(screen.getByTestId("pipeline-focus"));
    const layer = screen.getByTestId("pipeline-focus-layer");
    expect(layer.className).toContain("fixed inset-0");
    expect(localStorage.getItem(FOCUS_KEY)).toBe("1");
    expect(document.body.style.overflow).toBe("hidden");
    expect(within(layer).getByTestId("lane-draft")).toBeTruthy();
    cleanup();
    board();
    expect(screen.getByTestId("pipeline-focus-layer")).toBeTruthy(); // remembered
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("pipeline-focus-layer")).toBeNull();
    expect(localStorage.getItem(FOCUS_KEY)).toBe("0");
    expect(document.body.style.overflow).toBe("");
  });

  it("Esc with a full-screen post open closes the post first, not Full width", async () => {
    localStorage.setItem(FOCUS_KEY, "1");
    board();
    fireEvent.click(within(cardOf("A ready draft")).getByTestId("card-full"));
    const dlg = await screen.findByTestId("post-full");
    fireEvent.keyDown(dlg, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("post-full")).toBeNull());
    expect(screen.getByTestId("pipeline-focus-layer")).toBeTruthy();
  });
});

describe("T46-S13 r2 the Pipeline pages use the screen's width", () => {
  it("widePage: the Pipeline routes and a campaign's Pipeline tab, nothing else", () => {
    expect(widePage("/pipeline")).toBe(true);
    expect(widePage("/social/pipeline", "?repo=x")).toBe(true);
    expect(widePage("/milestones/ms_1", "?tab=pipeline")).toBe(true);
    expect(widePage("/")).toBe(false);
    expect(widePage("/performance")).toBe(false);
    expect(widePage("/posts/brand-campaign/P-0006")).toBe(false);
  });
});

// Full screen
// shows a post as labelled parts (hook, body, call to action, image, channel, slot, status) and an idea as what, why,
// audience, how to write it and source.
describe("T46-S13 r3 Full screen in labelled parts", () => {
  const labels = (root: HTMLElement) => within(root).getAllByRole("heading", { level: 3 }).map((h) => h.childNodes[0].textContent);

  it("a thread post: one part per post of the thread, its bullets as a list, then channel, slot and status", async () => {
    const thread = "[1/3] How do you keep up? · I built a team. · [2/3] Five personas: • Scout finds topics • Writer drafts • Reporter reads numbers · [3/3] Short application: https://epicspine.dev/testers/";
    const s = social();
    s.data.posts = [row({ id: "P-0009", title: "How do you keep up?", text: thread, status: "scheduled", slot: "2026-11-08 17:00" })];
    board({ social: s });
    fireEvent.click(within(cardOf("How do you keep up?")).getByTestId("card-full"));
    const detail = within(await screen.findByTestId("post-full")).getByTestId("post-detail");
    expect(labels(detail)).toEqual(["Hook", "Body", "Call to action", "Channel", "Slot", "Status", "More"]);
    expect(within(detail).getAllByTestId("post-part").map((p) => p.querySelector("h3 span")?.textContent)).toEqual(["Post 1 of 3", "Post 2 of 3", "Post 3 of 3"]);
    expect(within(detail).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Scout finds topics", "Writer drafts", "Reporter reads numbers"]);
    expect(within(detail).getAllByRole("paragraph").map((p) => p.textContent)).toContain("I built a team.");
    expect(within(detail).getByTestId("post-text").textContent).not.toContain("[2/3]");
    expect(detail.textContent).toContain("ChannelX");
    expect(detail.textContent).toContain("SlotSunday 8 Nov, 17:00 UTC");
  });

  it("a Reddit thread: its title is the hook, then body and call to action", async () => {
    const s = social();
    s.data.posts = [row({ id: "P-0010", platform: "Reddit", community: "r/mcp", title: "Do you keep your agent's memory in git?", text: "I build Memo. · Nothing gets deleted. · What do you do?", status: "held" })];
    board({ social: s });
    fireEvent.click(within(cardOf("memory in git")).getByTestId("card-full"));
    const detail = within(await screen.findByTestId("post-full")).getByTestId("post-detail");
    expect(labels(detail).slice(0, 3)).toEqual(["Hook", "Body", "Call to action"]);
    expect(detail.textContent).toContain("ChannelReddit · r/mcp");
  });

  it("an idea: what, why, audience, how to write it and source, each its own part", async () => {
    const s = social();
    s.data.ideas = [
      {
        id: "I-18", date: "2026-11-06", format: "text", platform: "Reddit", from: "Scout", link: "https://www.reddit.com/r/ClaudeCode/comments/1xodr56/x/", state: "open", why: null, became: [], _line: 3,
        idea: "You told your assistant no, and next week it proposes the same thing again. The human stake is that your decisions do not stick. State the purpose in one line before drafting. End on a question: how do you make a no stick? Live thread: r/ClaudeCode 1xodr56. No price, no competitor named (T-1106-2, messages 3 and 6)",
      },
    ];
    board({ social: s });
    fireEvent.click(cardOf("You told your assistant no"));
    fireEvent.click(within(cardOf("You told your assistant no")).getByTestId("card-full"));
    const detail = within(await screen.findByTestId("post-full")).getByTestId("idea-detail");
    expect(labels(detail)).toEqual(["What", "Why", "Audience", "How to write it", "Source", "So far"]);
    expect(within(detail).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["State the purpose in one line before drafting.", "End on a question: how do you make a no stick?", "No price, no competitor named"]);
    expect(within(detail).getByRole("link", { name: /The thread it came from/ }).getAttribute("href")).toContain("1xodr56");
    // the buttons stay under the parts
    expect(within(screen.getByTestId("post-full")).getByRole("button", { name: "Give feedback" })).toBeTruthy();
  });
});
