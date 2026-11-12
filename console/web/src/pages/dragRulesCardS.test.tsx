// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import type { SocialData, SocialPost, SocialWriteAction } from "@/api/types";
import { approvesEveryPost, boardMove, emptySocialExport, postedRecently, toPost, type BoardItem } from "@/lib/social";
import { describeWrite } from "@/lib/useSocialWrite";
import { resetEgressCache } from "@/pages/social/parts";
import { ForceReviewSwitch, OPEN_ALL_KEY, PipelineBoard, type BoardSource } from "@/pages/social/Pipeline";

// the Pipeline as a Kanban. Folded cards all the same height, a click opens one in
// place, a drag makes the card's own move or snaps back with the reason; Posted keeps the last 7 days, older ones
// fold away, Give feedback on a live post goes to the Writer; one Force review: yes / no switch.

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
  render(
    <MemoryRouter>
      <PipelineBoard sources={[src]} now={NOW} addIdea={false} />
    </MemoryRouter>,
  );
  return { write: (over.write as typeof write | undefined) ?? write };
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

describe("T74-S1 drag rules: only the card's own moves", () => {
  const post = (p: Partial<SocialPost>, working?: string): BoardItem => ({ kind: "post", post: toPost(row(p)), ...(working ? { working } : {}) });
  const idea = (working?: string): BoardItem => ({ kind: "idea", idea: social().data.ideas[0], ...(working ? { working } : {}) });
  const online = { writer: true, egress: [{ name: "laptop", state: "online" }] };

  it("idea → Drafts is Draft it; a ready draft → Scheduled is Schedule; a scheduled post → Posted is Post now (it asks first)", () => {
    expect(boardMove(idea(), "idea", "draft", online)).toEqual({ move: "draft" });
    expect(boardMove(post({ status: "held" }), "draft", "scheduled", online)).toEqual({ move: "schedule" });
    expect(boardMove(post({ status: "scheduled" }), "scheduled", "posted", online)).toEqual({ move: "post-now" });
    expect(boardMove(post({ status: "held" }), "draft", "draft", online)).toBeUndefined();
  });

  it("every other drop snaps back with a one-line reason", () => {
    const why = (m: ReturnType<typeof boardMove>) => (m && "reason" in m ? m.reason : m);
    expect(why(boardMove(post({ status: "held" }), "draft", "idea", online))).toBe("A post can't go back to Ideas.");
    expect(why(boardMove(post({ status: "held" }), "draft", "posted", online))).toBe("Schedule it first: posts go out from Scheduled.");
    expect(why(boardMove(post({ status: "draft" }, "The Writer is still on it."), "draft", "scheduled", online))).toBe("The Writer is still drafting it.");
    expect(why(boardMove(post({ status: "held", feedback: "Revise requested 2026-11-07 10:00 UTC: shorter" }), "draft", "scheduled", online))).toMatch(/The Writer is on it/);
    expect(why(boardMove(post({ status: "scheduled" }), "scheduled", "draft", online))).toBe("A scheduled post can't go back to Drafts. Open it to pull it.");
    expect(why(boardMove(post({ status: "scheduled" }), "scheduled", "posted", { writer: true, egress: [{ name: "laptop", state: "offline" }] }))).toMatch(/Mac is not online/);
    expect(why(boardMove(post({ status: "scheduled", feedback: "Post now 2026-11-07 10:00 UTC" }), "scheduled", "posted", online))).toBe("It is already on its way out.");
    expect(why(boardMove(post({ status: "posted" }), "posted", "scheduled", online))).toBe("It is live. Open it to give feedback or to pull it.");
    expect(why(boardMove(idea(), "idea", "scheduled", online))).toBe("Drop it on Drafts first: the Writer writes the post.");
    expect(why(boardMove(idea(), "idea", "draft", { writer: false }))).toBe("No Writer works on this campaign, so nobody can draft it.");
    expect(why(boardMove(idea("The Writer is drafting it."), "idea", "draft", online))).toBe("The Writer is already drafting it.");
  });
});

describe("T74-S1 the board as a Kanban", () => {
  it("folded cards are all the same height; a click opens one in place and Fold folds it; Open all is remembered", async () => {
    board();
    const cards = screen.getAllByTestId("lane-item");
    expect(cards.length).toBe(4); // the idea, the draft, the scheduled post, this week's post (the old one is folded away)
    for (const c of cards) {
      expect(c.hasAttribute("data-folded"), c.textContent ?? "").toBe(true);
      expect(c.className).toContain("h-[7.5rem]");
    }
    expect(within(cardOf("A ready draft")).queryByRole("button", { name: /Schedule/ })).toBeNull();
    fireEvent.click(cardOf("A ready draft"));
    const open = cardOf("A ready draft");
    expect(open.hasAttribute("data-folded")).toBe(false);
    expect(within(open).getByRole("button", { name: /Schedule for/ })).toBeTruthy();
    expect(within(open).getByRole("button", { name: /Give feedback/ })).toBeTruthy();
    // the open card sits where it was, in Drafts
    expect(within(lane("draft")).getByText("A ready draft")).toBeTruthy();
    fireEvent.click(within(open).getByTestId("card-fold"));
    expect(cardOf("A ready draft").hasAttribute("data-folded")).toBe(true);
    // keyboard: Enter opens
    fireEvent.keyDown(cardOf("A scheduled post"), { key: "Enter" });
    expect(cardOf("A scheduled post").hasAttribute("data-folded")).toBe(false);
    fireEvent.click(screen.getByTestId("open-all"));
    expect(screen.getAllByTestId("lane-item").every((c) => !c.hasAttribute("data-folded"))).toBe(true);
    expect(localStorage.getItem(OPEN_ALL_KEY)).toBe("1");
    expect(screen.getByTestId("open-all").textContent).toBe("Fold all");
  });

  it("drag a ready draft to Scheduled: the card's Schedule (next free slot) is written, and it says Moving on the card", async () => {
    const { write } = board({ busy: "posts/P-0001/approve" });
    dragTo(cardOf("A ready draft"), lane("scheduled"));
    await waitFor(() => expect(write).toHaveBeenCalledWith({ action: "posts/P-0001/approve", body: { slot: "2026-11-09 09:00" } }));
    expect(write).toHaveBeenCalledTimes(1);
    expect(within(cardOf("A ready draft")).getByTestId("card-hint").textContent).toBe("Moving…");
    expect(document.querySelector("[data-testid=drag-ghost]")).toBeNull();
  });

  it("an illegal drop snaps back with the reason, on the card and above the board, and writes nothing", async () => {
    const { write } = board();
    dragTo(cardOf("A ready draft"), lane("posted"));
    expect(screen.getByTestId("drop-refused").textContent).toBe("P-0001 stays where it was: Schedule it first: posts go out from Scheduled.");
    expect(within(cardOf("A ready draft")).getByTestId("card-hint").textContent).toBe("Schedule it first: posts go out from Scheduled.");
    expect(within(lane("draft")).getByText("A ready draft")).toBeTruthy();
    dragTo(cardOf("Went out this week"), lane("draft"));
    expect(screen.getByTestId("drop-refused").textContent).toContain("It is live. Open it to give feedback or to pull it.");
    expect(write).not.toHaveBeenCalled();
  });

  it("drag a scheduled post to Posted opens it with Post now's question; nothing is sent until Sam says so", async () => {
    const { write } = board();
    await waitFor(() => expect(api.listEgress).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    dragTo(cardOf("A scheduled post"), lane("posted"));
    const card = cardOf("A scheduled post");
    expect(await within(card).findByRole("alertdialog", { name: "Post P-0002 now?" })).toBeTruthy();
    expect(write).not.toHaveBeenCalled();
    fireEvent.click(within(card).getByRole("button", { name: /Post it now/ }));
    await waitFor(() => expect(write).toHaveBeenCalledWith({ action: "posts/P-0002/post-now" }));
  });

  it("drag an idea to Drafts wakes the Writer with it (Draft it)", async () => {
    const run = vi.spyOn(api, "runAssignmentNow").mockResolvedValue({ id: "run_1" } as never);
    board({ writer: { assignmentId: "as-writer", name: "Writer" } });
    dragTo(cardOf("An idea for later"), lane("draft"));
    await waitFor(() => expect(run).toHaveBeenCalledWith("as-writer", expect.stringContaining("Draft idea I-1 now")));
  });
});

describe("T74-S2 Posted: the last 7 days, feedback after the fact", () => {
  it("only the last 7 days show; older ones fold away and come back on a click", () => {
    expect(postedRecently(toPost(row({ slot: "2026-11-01 09:00" })), NOW)).toBe(true);
    expect(postedRecently(toPost(row({ slot: "2026-10-30 09:00" })), NOW)).toBe(false);
    expect(postedRecently(toPost(row({ date: "2026-10-01" })), NOW)).toBe(false);
    board();
    expect(within(lane("posted")).getByRole("heading").textContent).toMatch(/Posted · last 7 days\s*1/);
    expect(within(lane("posted")).queryByText("Went out weeks ago")).toBeNull();
    fireEvent.click(screen.getByTestId("posted-older"));
    expect(within(lane("posted")).getByText("Went out weeks ago")).toBeTruthy();
    expect(screen.getByTestId("posted-older").textContent).toBe("Fold the 1 older than 7 days");
  });

  it("a folded posted card shows its numbers; open, Give feedback (typed) goes to the Writer as the post's feedback", async () => {
    const { write } = board();
    expect(within(cardOf("Went out this week")).getByTestId("card-hint").textContent).toBe("41 reads · 3 likes");
    fireEvent.click(cardOf("Went out this week"));
    const card = cardOf("Went out this week");
    fireEvent.click(within(card).getByRole("button", { name: /Give feedback/ }));
    fireEvent.change(within(card).getByLabelText("Feedback on P-0003"), { target: { value: "this landed, more like it" } });
    fireEvent.click(within(card).getByRole("button", { name: /Send to the Writer/ }));
    await waitFor(() => expect(write).toHaveBeenCalledWith({ action: "posts/P-0003/feedback", body: { feedback: "this landed, more like it" } }));
  });

  it("the result line says the Writer has it", () => {
    const r = { action: "feedback", id: "P-0003", commit: "abc1234def", push: { state: "skipped" }, wake: { assignmentId: "a", runId: "r", role: "Writer" } } as never;
    expect(describeWrite(r)).toBe("Your feedback on P-0003 is with the Writer for the next posts: saved as abc1234 · Writer woken");
  });
});

describe("T74-S3 / T74-S5 Auto-approve: one small toggle per campaign", () => {
  it("shows the campaign's state on one line, writes its own switch on a click; the result says which posts went back to Drafts", async () => {
    const write = vi.fn(async (_w: SocialWriteAction) => undefined);
    render(<ForceReviewSwitch on={true} src={{ write }} campaign="PLAN-7" name="Get testers" />);
    const toggle = screen.getByRole("switch", { name: "Auto-approve for Get testers" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("force-review").getAttribute("title")).toContain("Auto-approve is off for Get testers: every post waits in Drafts");
    fireEvent.click(toggle);
    expect(write).toHaveBeenCalledWith({ action: "approval", body: { on: false, campaign: "PLAN-7" } });
    const r = { action: "approval on", id: "hold_rules", commit: "abc1234def", push: { state: "skipped" }, info: { approval: true, held: ["P-0002"] } } as never;
    expect(describeWrite(r)).toBe("Auto-approve is off: every new post waits in Drafts for you. P-0002 moved back to Drafts: saved as abc1234");
  });

  it("the repo level is campaign null; a campaign's own rule or the repo-wide one turns its review on", () => {
    const d = (rules: string[]) => ({ brief: { hold_rules: rules.map((match, i) => ({ id: `R${i}`, match })) } }) as never;
    expect(approvesEveryPost(d(["Kind: post"]), "PLAN-7")).toBe(true);
    expect(approvesEveryPost(d(["Kind: post, Campaign: PLAN-7"]), "PLAN-7")).toBe(true);
    expect(approvesEveryPost(d(["Kind: post, Campaign: PLAN-7"]), null)).toBe(false);
    expect(approvesEveryPost(d(["Kind: post, Campaign: none"]), null)).toBe(true);
    expect(approvesEveryPost(d(["Kind: post, Campaign: none"]), "PLAN-7")).toBe(false);
  });
});
