// @vitest-environment jsdom
import { resetSent } from "@/lib/sentRows";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type ReviewItem } from "@/api";
import { ApiError } from "@/api/real";
import type { CardFace, ClosedGoal } from "@/api/review-types";
import { cardButtons, milestoneLabel, postButtons, WaitingForReview } from "@/components/review";
import { resetReviewGone } from "@/lib/inbox";
import { invalidate } from "@/lib/data";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetReviewGone(); // a pressed card leaves every list (module state); each test starts with none pressed
});

/**
 * the Team home's review list is
 * one flat list of cards, each the mockup's face. These tests fail the build on any "approve" in the section and on any
 * URL, row code or path that is not a working link.
 */
const FACE: CardFace = {
  project: { name: "Memo, the memory app", url: "https://memo.example.com/" },
  goal: { text: "Get Memo into every AI tool directory", code: "PLAN-10" },
  tasks: { done: 1, total: 9 },
  title: "The Memo logo and a how to connect page were created for MCP and AI directory listings.",
  taskGoal: "Every directory gets a page and a logo to point at, so people can add Memo in one click.",
  delivered: [
    { ok: true, text: "[memo.example.com/connect](https://memo.example.com/connect) is live, with steps for Claude, ChatGPT, Cursor, VS Code and Gemini." },
    { ok: true, text: "The page lists the 7 tools and 5 example prompts." },
    { ok: false, text: "Not listed in any directory yet. That comes next." },
  ],
  evidence: { url: "https://memo.example.com/connect", label: "Open memo.example.com/connect" },
  screenshot: "docs/status/e10-r2/connect.jpg",
  tree: [
    { mark: "done", text: "The plan was made: 15 directories were checked." },
    { mark: "progress", text: "Customers see only the memory tools", sub: "waiting on a test" },
    { mark: "this", text: "This task: the logo and the connect page" },
    { mark: "next", text: "Next: the official MCP registry, then 6 more" },
  ],
  after: "Next the team lists Memo in the official MCP registry, once you say yes to publishing.",
  next: [],
  closesGoal: false,
  openInGoal: [],
};
const ITEM: ReviewItem = {
  id: "rv_1",
  title: "Listing kit: 512×512 PNG icon (docs/status/e10-r2.md, E910-R2)",
  liveUrl: "https://memo.example.com/connect",
  ref: "E910-R2",
  repo: "memo",
  path: "docs/PLAN-10.md",
  github: "acme-ai/memo",
  cardPath: "docs/cards/E910-R2.md",
  milestoneId: "ms_1",
  state: "review",
  status: "review",
  liveStatus: 200,
  checkedAt: "2026-11-03T01:00:00Z",
  createdAt: "2026-11-03",
  verdict: { kind: "card" },
  face: FACE,
};
const card = (o: Partial<ReviewItem> = {}, f: Partial<CardFace> = {}): ReviewItem => ({ ...ITEM, ...o, face: { ...FACE, ...f } });
const list = (items: ReviewItem[], snoozed: ReviewItem[] = []) =>
  vi.spyOn(api, "listReviewItems").mockImplementation(async (q?: { state?: string }) => (q?.state === "snoozed" ? snoozed : q?.state ? [] : items));
const mount = () => render(<MemoryRouter><WaitingForReview fold="review" /></MemoryRouter>);

/** Every visible string of a subtree, plus button labels, titles, aria-labels, alt and placeholder text. */
function allText(root: HTMLElement): string[] {
  const out: string[] = [root.textContent ?? ""];
  for (const el of Array.from(root.querySelectorAll("*"))) for (const a of ["title", "aria-label", "alt", "placeholder"]) if (el.getAttribute(a)) out.push(el.getAttribute(a)!);
  return out;
}

const LINKISH = /https?:\/\/\S+|\b[A-Z][A-Z0-9]*-[A-Z]{0,3}\d+[a-z]?\b|(?:[\w.-]+\/)+[\w.-]+\.(?:md|ts|tsx|json|png|jpe?g|html)\b/;
/** Text nodes that look like a URL, a row code or a path, and are not inside a link with an href. */
function unlinked(root: HTMLElement): string[] {
  const bad: string[] = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const t = n.textContent ?? "";
    if (!LINKISH.test(t)) continue;
    const a = (n.parentElement as HTMLElement | null)?.closest("a");
    if (!a || !a.getAttribute("href")) bad.push(t);
  }
  return bad;
}

describe("T48-S26 the card, as the approved mockup", () => {
  it("meta line, a short heading, the body, Why, the checklist; the screenshot, tree and Details under More; two buttons", async () => {
    list([ITEM]);
    mount();
    const c = await screen.findByTestId("review-card");
    const crumb = within(c).getByTestId("review-crumb");
    // the meta line is the kind word, the project (a link) and the age; Snooze is a button beside Park
    expect(crumb.textContent).toMatch(/^Review\d+ \w+ oldMemo, the memory app/);
    expect(within(crumb).getByText("Memo, the memory app").getAttribute("href")).toBe("https://memo.example.com/");
    expect(within(crumb).queryByTestId("snooze")).toBeNull();
    expect(within(within(c).getByTestId("review-buttons")).getByTestId("snooze")).toBeTruthy();
    // no foot repeating the project, the goal and the count (half the words)
    expect(within(c).queryByTestId("review-foot")).toBeNull();
    // the heading is short; the body holds the full title, the Why line the task's goal
    const title = within(c).getByTestId("review-title");
    expect(title.tagName).toBe("BUTTON");
    const computer = title.querySelector('[data-heading="computer"]')!;
    expect(computer.textContent!.length).toBeLessThanOrEqual(73);
    expect(FACE.title.startsWith(computer.textContent!.replace(/…$/, ""))).toBe(true);
    expect(within(c).getByTestId("review-body").textContent).toBe(FACE.title);
    // a phone shows the whole title as the heading and leaves out the body that only repeats it
    expect(title.querySelector('[data-heading="phone"]')!.textContent).toBe(FACE.title);
    expect(computer.className).toContain("max-sm:hidden");
    expect(within(c).getByTestId("review-body").className).toContain("max-sm:hidden");
    expect(within(c).getByTestId("review-task-goal").textContent).toBe(`Why: ${FACE.taskGoal}`);
    const lines = within(c).getByTestId("review-delivered").querySelectorAll("li");
    // drawn marks (a tick, a cross) instead of the ✓ / ✗ glyphs
    expect(Array.from(lines).map((l) => [l.getAttribute("data-ok"), l.querySelector("[data-mark]")?.getAttribute("data-mark")])).toEqual([
      ["true", "done"],
      ["true", "done"],
      ["false", "not-done"],
    ]);
    expect(within(lines[0] as HTMLElement).getByText("memo.example.com/connect").getAttribute("href")).toBe("https://memo.example.com/connect");
    // two buttons, the main one's sub-line is its title; the green evidence link its own line above them
    const buttons = within(c).getByTestId("review-buttons");
    expect(within(buttons).getAllByRole("button").map((b) => b.textContent)).toEqual(["Mark complete", "Duplicate or already answered", "Park", "Snooze"]); // E948-S139 Duplicate or already answered; E948-S83 iteration 2: Park on every card; E948-S131: Voice and Text close the same row
    expect(within(buttons).getByTestId("review-complete").getAttribute("title")).toBe("The goal stays open. Next the team lists Memo in the official MCP registry, once you say yes to publishing.");
    const go = within(c).getByTestId("review-go");
    expect(buttons.contains(go)).toBe(false);
    expect(go.compareDocumentPosition(buttons) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(go.getAttribute("href")).toBe("https://memo.example.com/connect");
    expect(go.textContent).toBe("Open memo.example.com/connect ↗");
    // folded: the evidence, the tree and the Details only open from the heading
    expect(within(c).queryByTestId("review-more")).toBeNull();
    expect(within(c).queryByTestId("review-evidence")).toBeNull();
    fireEvent.click(title);
    expect(title.getAttribute("aria-expanded")).toBe("true");
    const ev = within(c).getByTestId("review-evidence");
    expect(ev.getAttribute("href")).toBe("https://memo.example.com/connect");
    expect(ev.querySelector("img")!.getAttribute("src")).toBe("/api/review-items/rv_1/screenshot");
    const tree = within(c).getByTestId("review-tree");
    expect(tree.textContent).toContain("Get Memo into every AI tool directory · goal open, 1 of 9 tasks done");
    expect(Array.from(tree.querySelectorAll("[data-mark]")).map((x) => x.getAttribute("data-mark"))).toEqual(["done", "progress", "this", "next"]);
    expect(within(c).getByTestId("review-details")).toBeTruthy();
    expect(within(c).getByTestId("review-deny")).toBeTruthy();
    // the long row title never shows on the face
    expect(c.textContent).not.toContain("Listing kit");
  });

  it("never says approve: no 'approv' in any card text, button, title or label (Sam: I HATE THE WORD APPROVE)", async () => {
    list([
      ITEM,
      card({ id: "rv_2" }, { closesGoal: true, openInGoal: [{ ref: "E910-R5", name: "the registry listing" }] }),
      card({ id: "rv_3" }, { next: [{ title: "Build the health page", recommend: "start" }, { title: "Add a phone alert", recommend: "park" }] }),
    ]);
    mount();
    await waitFor(() => expect(screen.getAllByTestId("review-card")).toHaveLength(3));
    const section = screen.getByTestId("waiting-for-review");
    for (const t of allText(section)) expect(t).not.toMatch(/approv/i);
    // the confirm and the feedback box too
    // the confirm, the note box (Give feedback) and everything under More too
    expect(within(screen.getAllByTestId("review-card")[1]).getByTestId("review-parked-left")).toBeTruthy();
    fireEvent.click(within(screen.getAllByTestId("review-card")[0]).getByTestId("card-feedback-text"));
    expect(within(screen.getAllByTestId("review-card")[0]).getByTestId("review-note")).toBeTruthy();
    for (const c of screen.getAllByTestId("review-card")) fireEvent.click(within(c).getByTestId("review-title"));
    fireEvent.click(within(screen.getAllByTestId("review-card")[2]).getByTestId("review-deny"));
    expect(within(screen.getAllByTestId("review-card")[2]).getByTestId("review-deny-panel")).toBeTruthy();
    for (const t of allText(section)) expect(t).not.toMatch(/approv/i);
  });

  it("every URL, row code and path on the card and in its Details is a working link", async () => {
    list([card({}, { taskGoal: "See https://memo.example.com/connect and E910-R2 in docs/status/e10-r2.md for the details." })]);
    mount();
    const c = await screen.findByTestId("review-card");
    expect(unlinked(c)).toEqual([]);
    // the Details sit under More, opened by the heading
    fireEvent.click(within(c).getByTestId("review-title"));
    expect(unlinked(c)).toEqual([]);
    const d = within(c).getByTestId("review-details");
    expect(within(d).getByText("E910-R2").getAttribute("href")).toBe("https://github.com/acme-ai/memo/blob/main/docs/PLAN-10.md");
    expect(within(d).getByText("docs/cards/E910-R2.md").getAttribute("href")).toBe("https://github.com/acme-ai/memo/blob/main/docs/cards/E910-R2.md");
    // the evidence is never GitHub
    expect(within(c).getByTestId("review-evidence").getAttribute("href")).not.toMatch(/github\.com/);
  });
});

describe("T48-S26 the buttons", () => {
  it("Mark this task complete writes, the card collapses in place to its green Sent row and the count drops at once", async () => {
    list([ITEM, card({ id: "rv_2" })]);
    const complete = vi.spyOn(api, "completeReviewItem").mockResolvedValue({ ...ITEM, state: "approved" });
    mount();
    await waitFor(() => expect(screen.getAllByTestId("review-card")).toHaveLength(2));
    expect(screen.getByTestId("waiting-for-review-count").textContent).toBe("2");
    fireEvent.click(within(screen.getAllByTestId("review-card")[0]).getByTestId("review-complete"));
    await waitFor(() => expect(complete).toHaveBeenCalledWith("rv_1", { start: [], park: [] }));
    // the first place of the list is now one Sent row, the other card still under it (nothing moved up into its place)
    await waitFor(() => expect(screen.getByTestId("review-feed").firstElementChild?.getAttribute("data-testid")).toBe("review-feed-sent"));
    expect(screen.getByTestId("sent-row-said").textContent).toBe("Closed");
    expect(screen.getAllByTestId("review-card")).toHaveLength(1);
    await waitFor(() => expect(screen.getByTestId("waiting-for-review-count").textContent).toBe("1"));
    // the refetch that drops it keeps the Sent row where the card was
    expect(screen.getByTestId("review-feed").firstElementChild?.getAttribute("data-testid")).toBe("review-feed-sent");
  });

  it("a pressed card listed again later shows as its Sent row, never as an invisible card-sized gap (Sam 2026-11-12, and the Sent row)", async () => {
    let rows: ReviewItem[] = [ITEM, card({ id: "rv_2" })];
    vi.spyOn(api, "listReviewItems").mockImplementation(async (q?: { state?: string }) => (q?.state ? [] : rows));
    vi.spyOn(api, "completeReviewItem").mockResolvedValue({ ...ITEM, state: "approved" });
    mount();
    await waitFor(() => expect(screen.getAllByTestId("review-card")).toHaveLength(2));
    fireEvent.click(within(screen.getAllByTestId("review-card")[0]).getByTestId("review-complete"));
    await waitFor(() => expect(screen.getByTestId("waiting-for-review-count").textContent).toBe("1"));
    // a fetch no longer lists it, then a lagging one lists it again
    rows = [card({ id: "rv_2" })];
    invalidate("inbox");
    await new Promise((r) => setTimeout(r, 300));
    rows = [ITEM, card({ id: "rv_2" })];
    invalidate("inbox");
    await waitFor(() => expect(screen.getAllByTestId("review-feed-item")).toHaveLength(1));
    expect(screen.getAllByTestId("review-feed-sent")).toHaveLength(1);
    for (const li of screen.getAllByTestId("review-feed-item")) expect(li.getAttribute("style") ?? "").not.toContain("opacity: 0");
  });

  it("the last open piece: Mark this task complete and close the goal closes it at once, parked parts named before the press (E948-S53)", async () => {
    list([card({}, { closesGoal: true, openInGoal: [{ ref: "E910-R5", name: "the registry listing" }, { ref: "E910-R6" }] })]);
    const complete = vi.spyOn(api, "completeReviewItem").mockResolvedValue({ ...ITEM, state: "approved" });
    mount();
    const c = await screen.findByTestId("review-card");
    expect(within(c).getByTestId("review-complete").getAttribute("title")).toBe("This is the last open part of the goal, so the goal closes.");
    expect(within(c).getByTestId("review-complete").textContent).toBe("Mark complete, close the goal");
    const parked = within(c).getByTestId("review-parked-left");
    expect(parked.textContent).toBe("Parked for later, kept with the goal: the registry listing, E910-R6.");
    expect(within(parked).getByText("E910-R6").closest("a")).toBeTruthy();
    fireEvent.click(within(c).getByTestId("review-complete"));
    // no confirm that warns against the close it just offered
    expect(within(c).queryByTestId("review-close-confirm")).toBeNull();
    await waitFor(() => expect(complete).toHaveBeenCalledWith("rv_1", { start: [], park: [] }));
  });

  it("a step card never says it closes the goal and never asks to confirm a close (E948-S53)", async () => {
    list([card({}, { closesGoal: false, openInGoal: [{ ref: "E910-R5", name: "the registry listing" }] })]);
    const complete = vi.spyOn(api, "completeReviewItem").mockResolvedValue({ ...ITEM, state: "approved" });
    mount();
    const c = await screen.findByTestId("review-card");
    expect(within(c).getByTestId("review-complete").textContent).toBe("Mark complete");
    expect(within(c).queryByTestId("review-parked-left")).toBeNull();
    fireEvent.click(within(c).getByTestId("review-complete"));
    expect(within(c).queryByTestId("review-close-confirm")).toBeNull();
    await waitFor(() => expect(complete).toHaveBeenCalledWith("rv_1", { start: [], park: [] }));
  });

  it("next steps: each a Start now / Park switch preset to the team's advice; start N or don't start anything", async () => {
    list([card({}, { next: [{ title: "Build the health page", recommend: "start" }, { title: "Add a phone alert when a part goes red", recommend: "park" }] })]);
    const complete = vi.spyOn(api, "completeReviewItem").mockResolvedValue({ ...ITEM, state: "approved" });
    mount();
    const c = await screen.findByTestId("review-card");
    const sw = within(c).getAllByTestId("review-switch-start");
    expect(sw.map((b) => b.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    // one main button that counts what starts; its sub-line is its title
    const main = within(c).getByTestId("review-complete");
    expect(main.textContent).toBe("Start 1");
    expect(main.getAttribute("title")).toBe("The team starts: Build the health page. The other next step is parked on the goal.");
    fireEvent.click(sw[1]);
    expect(within(c).getByTestId("review-complete").textContent).toBe("Start 2");
    fireEvent.click(within(c).getByTestId("review-complete"));
    await waitFor(() => expect(complete).toHaveBeenCalledWith("rv_1", { start: [0, 1], park: [] }));
  });

  it("don't start anything parks every next step", async () => {
    list([card({}, { next: [{ title: "Build the health page", recommend: "start" }] })]);
    const complete = vi.spyOn(api, "completeReviewItem").mockResolvedValue({ ...ITEM, state: "approved" });
    mount();
    const c = await screen.findByTestId("review-card");
    // Park every step and the main button is the park one ("Mark complete, start nothing")
    fireEvent.click(within(c).getByTestId("review-switch-park"));
    const park = within(c).getByTestId("review-complete-park");
    expect(park.textContent).toBe("Close, start nothing");
    expect(park.getAttribute("title")).toBe("The next step is parked on the goal. Nothing new starts.");
    fireEvent.click(park);
    await waitFor(() => expect(complete).toHaveBeenCalledWith("rv_1", { start: [], park: [0] }));
  });

  it("Give feedback (was Not yet, Changes wanted): the first press opens the note, a press with no words asks for them, then his words go back with the task", async () => {
    list([ITEM]);
    const relaunch = vi.spyOn(api, "relaunchReviewItem").mockResolvedValue({ ...ITEM, state: "relaunched" });
    mount();
    const c = await screen.findByTestId("review-card");
    // E948-S131: no box until Text opens it; Send waits for words
    expect(within(c).getByTestId("review-note")).toBeTruthy();
    expect(within(c).queryByLabelText("Feedback")).toBeNull();
    fireEvent.click(within(c).getByTestId("card-feedback-text"));
    expect((within(c).getByTestId("card-feedback-send") as HTMLButtonElement).disabled).toBe(true);
    expect(relaunch).not.toHaveBeenCalled();
    fireEvent.change(within(c).getByLabelText("Feedback"), { target: { value: "show the Cursor steps first" } });
    fireEvent.click(within(c).getByTestId("card-feedback-send"));
    await waitFor(() => expect(relaunch).toHaveBeenCalledWith("rv_1", "show the Cursor steps first"));
  });

  it("T67-S1, T72-S7 Decline: the third outcome, an optional reason, then one press closes it as a no", async () => {
    list([ITEM]);
    const deny = vi.spyOn(api, "denyReviewItem").mockResolvedValue({ ...ITEM, state: "denied" });
    mount();
    const c = await screen.findByTestId("review-card");
    // Decline sits under More (the heading opens it)
    expect(within(c).queryByTestId("review-deny")).toBeNull();
    fireEvent.click(within(c).getByTestId("review-title"));
    fireEvent.click(within(c).getByTestId("review-deny"));
    fireEvent.change(within(c).getByLabelText("Why you decline it"), { target: { value: "not needed any more" } });
    fireEvent.click(within(c).getByTestId("review-deny-confirm"));
    await waitFor(() => expect(deny).toHaveBeenCalledWith("rv_1", "not needed any more"));
  });

  it("a refused spine write changes nothing: the card stays, says why, and Retry runs it again", async () => {
    list([ITEM]);
    const complete = vi.spyOn(api, "completeReviewItem").mockRejectedValueOnce(new Error("spine write failed: push rejected")).mockResolvedValueOnce({ ...ITEM, state: "approved" });
    mount();
    const c = await screen.findByTestId("review-card");
    fireEvent.click(within(c).getByTestId("review-complete"));
    const err = await within(c).findByTestId("review-error");
    expect(err.textContent).toContain("Nothing was changed. spine write failed: push rejected");
    expect(screen.getAllByTestId("review-card")).toHaveLength(1);
    fireEvent.click(within(err).getByTestId("review-retry"));
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
  });

  it("cardButtons: the words by case", () => {
    expect(cardButtons({ closesGoal: false, next: [] }, []).map((b) => [b.label, b.sub])).toEqual([["✓ Mark this task complete", "The goal stays open. The team goes on with its next task."]]);
    expect(cardButtons({ closesGoal: true, next: [] }, [])[0].label).toBe("✓ Mark this task complete and close the goal");
    const two = [
      { title: "A", recommend: "start" as const },
      { title: "B", recommend: "park" as const },
    ];
    expect(cardButtons({ closesGoal: false, next: two }, [false, false]).map((b) => b.label)).toEqual(["✓ Mark this task complete, don't start anything"]);
    expect(cardButtons({ closesGoal: false, next: two }, [false, false])[0].sub).toBe("Both next steps are parked on the goal. Nothing new starts.");
  });
});

describe("T48-S26 the parked parts named on a goal-closing card", () => {
  it("never names a task just marked complete on this page", async () => {
    const a = card({ id: "rv_a", ref: "E910-R5" }, { title: "The registry listing was made for you to check." });
    const c = card({ id: "rv_c", ref: "E910-R9" }, { closesGoal: true, openInGoal: [{ ref: "E910-R5", name: "the registry listing" }, { ref: "E910-R6", name: "the ChatGPT directory" }] });
    list([a, c]);
    vi.spyOn(api, "completeReviewItem").mockResolvedValue({ ...ITEM, state: "approved" });
    mount();
    await waitFor(() => expect(screen.getAllByTestId("review-card")).toHaveLength(2));
    fireEvent.click(within(screen.getAllByTestId("review-card")[0]).getByTestId("review-complete"));
    await waitFor(() => expect(screen.getAllByTestId("review-card")).toHaveLength(1));
    const last = screen.getByTestId("review-card");
    expect(within(last).getByTestId("review-parked-left").textContent).toBe("Parked for later, kept with the goal: the ChatGPT directory.");
  });
});

describe("T61-S2 a held post is the same card, in its own words", () => {
  const POST = (o: Partial<NonNullable<ReviewItem["post"]>> = {}): ReviewItem => ({
    id: "post~social~P-0063", kind: "post", title: "How do you check a note is still true?", liveUrl: "/posts/social/P-0063", ref: "P-0063", state: "review", createdAt: "2026-11-03", milestoneId: "ms_c", verdict: { kind: "card" },
    post: { tenantId: "social", repo: "social", id: "P-0063", kind: "post", platform: "Reddit", community: "r/ClaudeCode", slot: "2099-11-04 09:00", title: "How do you check a note is still true?", text: "I build Memo, so I'm biased.\n\nSee https://memo.example.com/connect for how.", images: [], project: { name: "Memo on social media", url: "https://social.example.com/" }, campaign: "Reddit awareness week 37", pageUrl: "/posts/social/P-0063", ...o },
  });
  it("the post's words, where it goes, the title opening its page; Schedule and Changes wanted; no approve; every link a link", async () => {
    list([POST(), ITEM]);
    const schedule = vi.spyOn(api, "completeReviewItem").mockResolvedValue({ ...ITEM, state: "approved" });
    mount();
    await waitFor(() => expect(screen.getAllByTestId("review-card")).toHaveLength(2));
    expect(screen.getByTestId("waiting-for-review-count").textContent).toBe("2");
    const c = screen.getAllByTestId("review-card").find((x) => x.getAttribute("data-kind") === "post")!;
    // E948-S60: the one meta line: the kind word first, the project, the campaign
    const crumb = within(c).getByTestId("review-crumb");
    expect(crumb.querySelector("[data-card-kind-word]")?.textContent).toBe("Post");
    for (const w of ["Memo on social media", "Reddit awareness week 37", "waiting for you"]) expect(crumb.textContent).toContain(w);
    expect(within(c).getByTestId("review-title").querySelector("a")!.getAttribute("href")).toBe("/posts/social/P-0063");
    expect(within(c).getByTestId("review-post-text").textContent).toContain("I build Memo, so I'm biased.");
    expect(within(c).getByTestId("review-post-where").textContent).toMatch(/^Reddit, r\/ClaudeCode, /);
    expect(within(c).getAllByRole("button").map((b) => b.textContent)).toEqual(expect.arrayContaining(["✓ Schedule", "↻ Changes wanted"]));
    expect(within(c).queryByTestId("review-post-now")).toBeNull();
    (within(c).getByTestId("review-details") as HTMLDetailsElement).open = true;
    expect(unlinked(c)).toEqual([]);
    for (const t of allText(screen.getByTestId("waiting-for-review"))) expect(t).not.toMatch(/approv/i);
    fireEvent.click(within(c).getByTestId("review-schedule"));
    await waitFor(() => expect(schedule).toHaveBeenCalledWith("post~social~P-0063", {}));
  });
  it("his words on a new version are shown, and any path or code in them is a link", async () => {
    list([POST({ revisedFor: "the pack refuses this change: data/posts-ledger.md P-0062: link_rule" })]);
    mount();
    const c = await screen.findByTestId("review-card");
    expect(within(c).getByTestId("review-post-revised").textContent).toContain("A new version after your words");
    expect(unlinked(c)).toEqual([]);
  });
  it("T61-S3: a held post never has Post now; a passed slot gets Schedule for the next free slot, with Pick a new time beside it", () => {
    expect(postButtons({ kind: "post", slot: "2099-11-04 09:00" }).map((b) => b.label)).toEqual(["✓ Schedule"]);
    expect(postButtons({ kind: "outreach" })[0]).toMatchObject({ label: "✓ Schedule this reply", sub: "The team sends this reply in the thread, inside today's limits." });
    const late = postButtons({ kind: "post", slot: "2020-01-01 09:00", nextSlot: "2026-11-03T14:00Z" });
    expect(late.map((b) => b.label)).toEqual(["✓ Schedule for Tue 3 Nov 14:00 UTC", "Pick a new time"]);
    expect(late[0]).toMatchObject({ slot: "2026-11-03T14:00Z", sub: "Its own time has passed. This is the next free time within the objective's limits." });
    for (const b of [...late, ...postButtons({ kind: "post", slot: "2099-11-04 09:00" })]) expect(b.label).not.toMatch(/post now/i);
    // its time has passed and nothing is free in the next 3 days: only Pick a new time, never a Schedule that sends now
    expect(postButtons({ kind: "post", slot: "2020-01-01 09:00" })).toEqual([expect.objectContaining({ label: "Pick a new time", how: "pick", go: false, sub: expect.stringMatching(/nothing is free in the next 3 days/) })]);
  });
  it("T61-S3: Schedule sends the named slot; Pick a new time schedules at the time he gives", async () => {
    list([POST({ slot: "2026-11-02 14:00", nextSlot: "2026-11-05T14:00Z" })]);
    const schedule = vi.spyOn(api, "completeReviewItem").mockResolvedValue({ ...ITEM, state: "approved" });
    mount();
    const c = await screen.findByTestId("review-card");
    expect(within(c).getByTestId("review-schedule").textContent).toBe("✓ Schedule for Thu 5 Nov 14:00 UTC");
    expect(within(c).queryByText(/post now/i)).toBeNull();
    fireEvent.click(within(c).getByTestId("review-schedule"));
    await waitFor(() => expect(schedule).toHaveBeenCalledWith("post~social~P-0063", { slot: "2026-11-05T14:00Z" }));
    // E948-S130: a held post he scheduled collapses to its green Sent row, like every card
    expect((await screen.findByTestId("sent-row-said")).textContent).toBe("Scheduled");
    cleanup();
    resetSent();
    list([POST({ slot: "2026-11-02 14:00", nextSlot: "2026-11-05T14:00Z" })]);
    mount();
    const d = await screen.findByTestId("review-card");
    fireEvent.click(within(d).getByTestId("review-pick"));
    fireEvent.change(within(d).getByLabelText("New time (UTC)"), { target: { value: "2026-11-06T09:30" } });
    fireEvent.click(within(d).getByTestId("review-pick-schedule"));
    await waitFor(() => expect(schedule).toHaveBeenLastCalledWith("post~social~P-0063", { slot: "2026-11-06T09:30Z" }));
  });

});

describe("T48-S26 one flat list", () => {
  it("every card fully shown: no goal groups, no older-rows fold, no Show 20 / 50 / all; the count is the cards (its Sort is back)", async () => {
    list(Array.from({ length: 25 }, (_, i) => card({ id: `rv_${i}` })));
    mount();
    await waitFor(() => expect(screen.getAllByTestId("review-card")).toHaveLength(25));
    expect(screen.getByTestId("waiting-for-review-count").textContent).toBe("25");
    for (const id of ["review-goal", "review-backlog", "review-pending", "waiting-for-review-limit"]) expect(screen.queryByTestId(id)).toBeNull();
  });

  it("empty says so; a world refused the list (403) shows no section", async () => {
    list([]);
    mount();
    expect(await screen.findByText("Nothing finished waiting for your review.")).toBeTruthy();
    cleanup();
    vi.restoreAllMocks();
    vi.spyOn(api, "listReviewItems").mockRejectedValue(new ApiError(403, "world_scope", "world_scope"));
    const { container } = mount();
    await waitFor(() => expect(api.listReviewItems).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('[data-testid="waiting-for-review"]')).toBeNull();
  });

  it("T48-S27: nothing goes past the edge: zero-minimum grid columns, long words wrap anywhere", async () => {
    list([card({}, { title: `The page was built at https://memo.example.com/${"x".repeat(200)} for you.` })]);
    mount();
    const c = await screen.findByTestId("review-card");
    expect(screen.getByTestId("review-feed").className).toContain("grid-cols-1");
    expect(screen.getByTestId("review-feed").className).toContain("min-w-0");
    expect(c.className).toContain("min-w-0");
    expect(c.className).toContain("[overflow-wrap:anywhere]");
    expect(within(c).getByTestId("card-feedback-row").className).toContain("min-w-0");
    // the Snooze menu opens below its link: the card never clips it (only the screenshot frame clips its corners)
    expect(c.className).not.toContain("overflow-hidden");
    fireEvent.click(within(c).getByTestId("review-title"));
    expect(within(c).getByTestId("review-evidence").className).toContain("overflow-hidden");
  });

  it("closed goals can be reopened (E48-8 Q3)", async () => {
    list([]);
    const g: ClosedGoal = { key: "home_repo:docs/spines/epic-59.md", code: "PLAN-59", title: "Security review", repo: "home_repo", path: "docs/spines/epic-59.md", milestoneId: "ms_1", status: "done (closed by Sam 2026-11-02)", hidden: ["T59-S6"] };
    vi.spyOn(api, "listClosedGoals").mockResolvedValue([g]);
    const reopen = vi.spyOn(api, "reopenGoal").mockResolvedValue({ goal: g });
    mount();
    fireEvent.click(await screen.findByTestId("review-closed-goals-count"));
    fireEvent.click(await screen.findByTestId("review-reopen-goal"));
    await waitFor(() => expect(reopen).toHaveBeenCalledWith(g.key));
  });

  it("milestoneLabel reads a repeated name once", () => {
    expect(milestoneLabel("home_repo · home_repo")).toBe("home_repo");
    expect(milestoneLabel("ops · PLAN-15: Fleet stays green")).toBe("ops · PLAN-15: Fleet stays green");
  });
});

describe("Home on a phone: the first cards, then one button for the rest", () => {
  it("cards after the first five are hidden on a phone only, and Show N more to review brings them back", async () => {
    list(Array.from({ length: 7 }, (_, n) => ({ ...ITEM, id: `rv_${n}` })));
    mount();
    const items = await screen.findAllByTestId("review-feed-item");
    expect(items).toHaveLength(7);
    expect(items.map((li) => li.className.includes("max-sm:hidden"))).toEqual([false, false, false, false, false, true, true]);
    const more = screen.getByTestId("review-phone-more");
    expect(more.textContent).toBe("Show 2 more to review");
    expect(more.className).toContain("sm:hidden");
    fireEvent.click(more);
    expect(screen.getAllByTestId("review-feed-item").some((li) => li.className.includes("max-sm:hidden"))).toBe(false);
    expect(screen.queryByTestId("review-phone-more")).toBeNull();
  });
});

// (vn_7c5aa36e: "how old is the card in minutes, hours, days, weeks"): the age counts from when the card
// reached his inbox, never from the row's restamped Last verified day.
describe("a review card shows how long it has waited", () => {
  it("reads the inbox time to the minute, the restamp day only when git has not answered", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
    try {
      list([card({ id: "a", createdAt: "2026-11-16", inboxSince: "2026-11-16T09:00:00Z" }), card({ id: "b", ref: "T1-S2", createdAt: "2026-11-16", inboxSince: "2026-11-02T12:00:00Z" }), card({ id: "c", ref: "T1-S3", createdAt: "2026-11-15" })]);
      mount();
      const ages = (await screen.findAllByTestId("review-crumb")).map((c) => within(c).getByTestId("issued-age"));
      expect(ages.map((a) => a.textContent)).toEqual(["3 h old", "2 wk old", "1 d old"]);
      expect(ages[0].getAttribute("title")).toMatch(/^reached your inbox /);
    } finally {
      vi.useRealTimers();
    }
  });
  it("a held post shows it too, beside waiting for you", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
    try {
      const post = (id: string, o: Partial<ReviewItem>): ReviewItem => ({
        id, kind: "post", title: "A post", liveUrl: "/posts/social/P-1", ref: id, state: "review", createdAt: "2026-11-15T00:00:00Z", milestoneId: "ms_c", verdict: { kind: "card" },
        post: { tenantId: "social", repo: "social", id, kind: "post", platform: "Reddit", community: "r/x", slot: "2099-11-04 09:00", title: "A post", text: "Words.", images: [], project: { name: "Memo on social media", url: "https://social.example.com/" }, campaign: "Week 1", pageUrl: "/posts/social/P-1" },
        ...o,
      });
      list([post("post~social~P-1", { inboxSince: "2026-11-16T11:48:00Z" }), post("post~social~P-2", {})]);
      mount();
      const ages = (await screen.findAllByTestId("review-crumb")).map((c) => within(c).getByTestId("issued-age").textContent);
      expect(ages).toEqual(["12 min old", "1 d old"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
