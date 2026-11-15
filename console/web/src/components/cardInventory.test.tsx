// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import fs from "node:fs";
import path from "node:path";
import { CARD_TYPES, CardInventoryPage, NOT_INBOX_CARDS, NO_PARK } from "@/components/cardInventory";
import { FEEDBACK_HINT, FEEDBACK_SEND } from "@/components/cardFeedback";
import { forgetWorld } from "@/lib/useSocial";
import { clearAnswerVoiceState } from "@/voice/AnswerVoice";
import { forgetDeskVoiceWorld } from "@/voice/deskBase";

// E948-S60 (the owner 2026-11-12 18:27Z: "Never again I want to see a card with I don't have a simple button to give
// feedback that allows me to add text, screenshots, voice"; 18:36Z on E946-A29: "Send my pick where there is only one
// choice … What does Not now do? That is a bad button"): every card type in the inventory renders with the one
// feedback block (text box, screenshot, big microphone, Send) as its END, says no "Not now", and the inventory
// cannot miss a card component the source has.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

beforeEach(() => {
  forgetWorld();
  forgetDeskVoiceWorld();
  clearAnswerVoiceState();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const json = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
      if (String(url).endsWith("/voice/state")) return json({ enabled: true, monthUsd: 0.2, limits: { monthCapUsd: 25 } });
      return json({ error: { message: "not faked" } }, 404);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const SRC = path.resolve(__dirname, "..");
const sources = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name) ? [p] : [];
  });

/** page panels and boards that are not cards he answers (their names end in Card but they ask nothing of him). */
const PANELS = new Set([
  "CreditsCard", "CurrentStateCard", "DeckCards", "DodCard", "MilestoneTopCard", "OutcomeCard", "SkeletonCards", "CampaignCardView", "ConnectionCard",
  "DeckCardLine", "FiledCard", "MemberCard", "PersonasCard", "RockCard", "SlideCard",
  // holds inbox cards (WaitingCard, ReviewCard, PostReviewCard) and renders nothing of its own to answer
  "RedLineCards",
  // the social board's cards: listed in NOT_INBOX_CARDS with their follow-up
  "FoldedCard", "PostCard", "IdeaCard",
  // holds the inbox's ConnectCard (listed) and renders nothing of its own
  "ConnectCards",
  // page panels named in NOT_INBOX_CARDS: the Credits page's plan spot and a pinned page on the Pages list
  "PlanCard", "PinnedCard",
]);

describe("E948-S60 every card type ends with the feedback block", () => {
  it("the inventory names every card component the source has (a new card cannot slip in without the block)", () => {
    const found = new Set<string>();
    for (const f of sources(SRC)) for (const m of fs.readFileSync(f, "utf8").matchAll(/^(?:export )?function ([A-Z]\w*Cards?)\b/gm)) found.add(m[1]);
    const listed = new Set(CARD_TYPES.map((c) => c.component));
    const missing = [...found].filter((n) => !listed.has(n as never) && !PANELS.has(n));
    expect(missing, "a card component is in the code but not in CARD_TYPES (cardInventory.tsx): add it with a sample and the feedback block").toEqual([]);
    const all = sources(SRC).map((f) => fs.readFileSync(f, "utf8")).join("\n");
    for (const c of listed) expect(new RegExp(`^(?:export )?function ${c}\\b`, "m").test(all), `${c} is listed but not in the code`).toBe(true);
    expect(NOT_INBOX_CARDS.length).toBeGreaterThan(0);
  });

  for (const c of CARD_TYPES)
    it(`${c.name}: a text box, a screenshot, a big microphone and Send, at the card's end, and no Not now`, async () => {
      const { container } = render(<MemoryRouter>{c.render()}</MemoryRouter>);
      const root = container.firstElementChild as HTMLElement;
      // the card's own block (an alert's ask cards carry theirs; the card's is its last)
      const blocks = [...root.querySelectorAll<HTMLElement>("[data-card-feedback]")];
      expect(blocks.length, "no feedback block").toBeGreaterThan(0);
      const block = blocks[blocks.length - 1];
      expect(within(block).getByRole("textbox")).toBeTruthy();
      expect(within(block).getByTestId("chat-attach"), "no screenshot button").toBeTruthy();
      const mic = await within(block).findByTestId("answer-voice-button");
      expect(mic.closest("[data-feedback-mic]")).toBeTruthy();
      expect(mic.className, "the microphone is big (44 px)").toMatch(/\bh-11\b/);
      expect(mic.textContent).toContain("Speak");
      const send = block.querySelector("[data-feedback-send]");
      expect(send, "no Send").toBeTruthy();
      // the end: no button of the card comes after its feedback block
      const after = [...root.querySelectorAll("button, a[href]")].filter((b) => !block.contains(b) && !!(block.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
      expect(after.map((b) => b.textContent?.trim()), "a button comes after the feedback block").toEqual([]);
      expect(root.textContent ?? "").not.toMatch(/Not now/);
      // E948-S60 iteration 3 (the owner 2026-11-12 21:46Z: "don't say not yet, because sometimes it's like the not yet is not what I want to say")
      const words = [...root.querySelectorAll("button, a[href]")].map((b) => b.textContent ?? "");
      expect(words.filter((w) => /not yet/i.test(w)), "a card offers Not yet").toEqual([]);
      expect(root.textContent ?? "").not.toMatch(/Not yet/);
    });

  // The owner 2026-11-15 (a voice note on a card: "Why are the buttons so separated from the feedback? Isn't the feedback one
  // of the options of the buttons? Why is there something in between? ... you're supposed to click the link before you press the
  // buttons, then more fluff ... about what the buttons mean, and then feedback. I hate this."): one order on every card, the
  // context, the link to check, then one answer block (the buttons, Park, the feedback box) with nothing in between.
  for (const c of CARD_TYPES)
    it(`${c.name}: the link before the buttons, then the buttons and the feedback box with no words in between`, () => {
      const { container } = render(<MemoryRouter>{c.render()}</MemoryRouter>);
      const root = container.firstElementChild as HTMLElement;
      const blocks = [...root.querySelectorAll<HTMLElement>("[data-card-feedback]")];
      const block = blocks[blocks.length - 1];
      const follows = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      const shell = block.closest<HTMLElement>("[data-card-shell]") ?? root;
      const buttons = [...shell.querySelectorAll<HTMLElement>("button")].filter((b) => !b.closest("[data-card-feedback]") && !b.closest("details") && !b.closest("[data-card-meta], [data-testid=review-title], [data-testid=ask-lead]") && follows(b, block));
      const lastButton = buttons[buttons.length - 1];
      const from = lastButton ?? null;
      // no words between the card's last answer button and its feedback box (a press's own status line shows only after a press)
      const between = [...shell.querySelectorAll<HTMLElement>("*")].filter(
        (e) => e.children.length === 0 && (e.textContent ?? "").trim() && !block.contains(e) && follows(e, block) && (!from || (follows(from, e) && !from.contains(e))) && !e.closest("button"),
      );
      if (from) expect(between.map((e) => e.textContent?.trim()), "words sit between the buttons and the feedback box").toEqual([]);
      // the links to check come before the first answer button, never after it
      const first = buttons[0];
      if (first) {
        const late = [...shell.querySelectorAll<HTMLAnchorElement>("a[href]")].filter((a) => !block.contains(a) && !a.closest("details") && follows(first, a));
        expect(late.map((a) => `${a.textContent?.trim()} in ${a.parentElement?.closest("[data-testid]")?.getAttribute("data-testid")} after ${first.textContent?.trim()}`), "a link sits after the buttons").toEqual([]);
      }
    });

  // E948-S60 iteration 2 (the owner 2026-11-12 19:39Z: "Why are the cards so different every time?"): one shell for every card.
  for (const c of CARD_TYPES)
    it(`${c.name}: the one card shell (frame, a meta line with its kind word first, the same feedback box and Send)`, async () => {
      const { container } = render(<MemoryRouter>{c.render()}</MemoryRouter>);
      const root = container.firstElementChild as HTMLElement;
      const shell = root.matches("[data-card-shell]") ? root : root.querySelector<HTMLElement>("[data-card-shell]");
      expect(shell, "the card does not render through the card shell (cardShell.tsx)").toBeTruthy();
      for (const k of ["rounded-xl", "border", "bg-card"]) expect(shell!.className, `the frame lacks ${k}`).toMatch(new RegExp(`(^|\\s)${k}(\\s|$)`));
      const padded = /(^|\s)p-4(\s|$)/.test(shell!.className) || /(^|\s)p-4(\s|$)/.test((shell!.firstElementChild as HTMLElement | null)?.className ?? "");
      expect(padded, "the frame is not p-4").toBe(true);
      const meta = shell!.querySelector<HTMLElement>("[data-card-meta]");
      expect(meta, "no meta line").toBeTruthy();
      const kind = meta!.firstElementChild as HTMLElement;
      expect(kind.matches("[data-card-kind-word]"), "the meta line does not open with the kind word").toBe(true);
      expect(kind.textContent?.trim()).toMatch(/^[A-Z][a-z]+$/);
      // nothing with words comes before the meta line
      const before = [...shell!.querySelectorAll<HTMLElement>("*")].filter((e) => !!(e.compareDocumentPosition(meta!) & Node.DOCUMENT_POSITION_FOLLOWING) && !e.contains(meta!) && e.children.length === 0 && (e.textContent ?? "").trim());
      expect(before.map((e) => e.textContent), "words come before the meta line").toEqual([]);
      const blocks = [...shell!.querySelectorAll<HTMLElement>("[data-card-feedback]")];
      const block = blocks[blocks.length - 1];
      expect(within(block).getByRole("textbox").getAttribute("placeholder")).toBe(FEEDBACK_HINT);
      expect(block.querySelector("[data-feedback-send]")?.textContent?.trim()).toBe(FEEDBACK_SEND);
    });

  // E948-S53 (the owner, vn_ebf81fab): the last open part of a goal reads "Mark complete, close the goal"; an ordinary review card does not.
  it("the last-part sample reads Mark complete, close the goal; the ordinary review card reads Mark complete", () => {
    const last = CARD_TYPES.find((c) => c.id === "review-last-part")!;
    const a = render(<MemoryRouter>{last.render()}</MemoryRouter>);
    expect(within(a.container).getByTestId("review-complete").textContent).toBe("Mark complete, close the goal");
    a.unmount();
    const plain = CARD_TYPES.find((c) => c.id === "review")!;
    const b = render(<MemoryRouter>{plain.render()}</MemoryRouter>);
    expect(within(b.container).getByTestId("review-complete").textContent).toBe("Mark complete");
  });

  // E948-S60 iteration 3 (the owner 2026-11-12 21:46Z): a review card offers only two actions, "Mark complete" (accept it as is) or "Give feedback".
  it("a review card has exactly Mark complete and Give feedback, then the feedback block", () => {
    const review = CARD_TYPES.find((c) => c.id === "review")!;
    const { container } = render(<MemoryRouter>{review.render()}</MemoryRouter>);
    const buttons = within(container).getByTestId("review-buttons");
    expect(within(buttons).getAllByRole("button").map((b) => b.textContent?.trim())).toEqual(["Mark complete", "Park", "Give feedback"]);
    expect(container.querySelector("[data-card-feedback] [data-feedback-send]")).toBeTruthy();
  });

  it("E946-A29 and E948-S69: each option is its own button, the own-number one opens its box; never Send my pick", async () => {
    const a29 = CARD_TYPES.find((c) => c.id === "decide-options")!;
    const { container, unmount } = render(<MemoryRouter>{a29.render()}</MemoryRouter>);
    const options = within(container).getAllByTestId("ask-option");
    expect(options).toHaveLength(3);
    expect(options.every((o) => o.tagName === "BUTTON")).toBe(true);
    options[2].click();
    expect(await within(container).findByTestId("ask-option-own")).toBeTruthy();
    expect(within(container).queryByTestId("send-pick")).toBeNull();
    expect(container.textContent).not.toMatch(/Send my pick/);
    unmount();
    const { sampleAsk } = await import("@/components/cardInventory");
    const { WaitingCard } = await import("@/components/waiting");
    const one = render(<MemoryRouter><WaitingCard item={sampleAsk({ ask: "decide", options: ["only this one"], question: "Pick one" })} /></MemoryRouter>);
    expect(one.queryByTestId("send-pick")).toBeNull();
    expect(one.queryAllByTestId("ask-option")).toHaveLength(0);
  });
});

// E948-S69 (the owner 2026-11-13, vn_9e6f5fa4, on the used-car lookup card: "when we have decisions, then the buttons need to
// be the decisions, or I can leave feedback ... what I'm clicking is what's the next step ... we cannot have a button that
// says Mark complete when the card is about a decision"): one table of card types and their buttons, held here.
/** the buttons that answer a decision with yes or no: each says what happens next, `Yes: plan it`. */
const ANSWER_IDS = ["review-choice", "yes", "no", "approve", "decline", "ask-set-accept", "ask-set-no", "accept-all", "advisor-accept", "advisor-decline", "advisor-accept-all"];
/** an ask's own options: its own words, never one bare word. */
const OPTION_IDS = ["ask-option", "goal-option"];
const BARE = /^(?:yes|no|ok|okay|approve|accept|decline|send|send my pick|pick|confirm|submit)$/i;
const NAMES_NEXT = /^[^:]{1,30}:\s*\S/;

describe("E948-S69 a decision card's buttons are its options, each naming its next step", () => {
  it("every card type is in the one table: what it asks of him and its buttons", () => {
    for (const c of CARD_TYPES) {
      expect(["decision", "review", "do", "answer", "key", "news"], `${c.id} has no kind`).toContain(c.kind);
      expect(c.buttons.trim().length, `${c.id} names no buttons`).toBeGreaterThan(3);
    }
    expect(CARD_TYPES.filter((c) => c.kind === "decision").length).toBeGreaterThanOrEqual(8);
  });

  for (const c of CARD_TYPES.filter((x) => x.kind === "decision"))
    it(`${c.name}: never Mark complete or Send my pick, every option names its next step, Give feedback stays`, () => {
      const { container } = render(<MemoryRouter>{c.render()}</MemoryRouter>);
      const buttons = [...container.querySelectorAll<HTMLElement>("button")].filter((b) => !b.closest("[data-card-feedback]"));
      const words = buttons.map((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim());
      expect(words.filter((w) => /mark complete|send my pick/i.test(w)), "a decision card offers Mark complete or Send my pick").toEqual([]);
      expect(container.querySelector("[data-testid=review-complete], [data-testid=review-complete-park], [data-testid=send-pick]")).toBeNull();
      const answers = buttons.filter((b) => ANSWER_IDS.includes(b.dataset.testid ?? ""));
      const options = buttons.filter((b) => OPTION_IDS.includes(b.dataset.testid ?? ""));
      expect(answers.length + options.length + (c.id === "team-idea" ? 1 : 0), "a decision card shows its options as buttons").toBeGreaterThan(0);
      for (const b of answers) expect(b.textContent?.trim(), "a yes or no button does not say what happens next").toMatch(NAMES_NEXT);
      for (const b of options) expect(BARE.test((b.textContent ?? "").replace(/·.*$/, "").trim()), `option "${b.textContent}" is one bare word`).toBe(false);
      for (const w of words) expect(BARE.test(w), `"${w}" is a bare button`).toBe(false);
      // and his own words always: the feedback block (Give feedback on a review-shaped card)
      expect(container.querySelector("[data-card-feedback] [data-feedback-send]")).toBeTruthy();
    });

  // E948-S69 iteration 2 (the owner on E946-A31, 2026-11-13, vn_11f06422: "It's still happening that I'm getting decide cards with
  // no decide options. Just now, only ask feedback."): every Decide card shows two choices or more as buttons.
  it("every Decide card shows two option buttons or more, never only the feedback box", async () => {
    const { sampleAsk } = await import("@/components/cardInventory");
    const { WaitingCard } = await import("@/components/waiting");
    const decides = CARD_TYPES.filter((c) => c.id.startsWith("decide-"));
    expect(decides.map((c) => c.id)).toEqual(expect.arrayContaining(["decide-listed-semicolons", "decide-no-options"]));
    const count = (el: HTMLElement) => el.querySelectorAll("[data-testid=ask-option], [data-testid=yes], [data-testid=no]").length;
    for (const c of decides) {
      const { container, unmount } = render(<MemoryRouter>{c.render()}</MemoryRouter>);
      expect(count(container), `${c.id} shows no option buttons`).toBeGreaterThanOrEqual(2);
      unmount();
    }
    const a31 = render(<MemoryRouter>{CARD_TYPES.find((c) => c.id === "decide-no-options")!.render()}</MemoryRouter>);
    expect(a31.getAllByTestId("ask-option").map((b) => b.textContent?.trim())).toEqual(["Yes, agree this plan for the testers", "No: drop it"]);
    a31.unmount();
    // an older server sends a decide ask with no options: a question still gets Yes and No
    const old = render(<MemoryRouter><WaitingCard item={sampleAsk({ ask: "decide", question: "Agree this plan? The team recommends yes." })} /></MemoryRouter>);
    expect(count(old.container)).toBe(2);
  });

  it("the used-car lookup card: Yes: plan it (the team's pick, filled), No: park it, Give feedback; never Mark complete", () => {
    const car = CARD_TYPES.find((c) => c.id === "review-decision")!;
    const { container } = render(<MemoryRouter>{car.render()}</MemoryRouter>);
    const row = within(container).getByTestId("review-buttons");
    expect(row.getAttribute("data-card-buttons")).toBe("decision");
    expect(within(row).getAllByRole("button").map((b) => b.textContent?.trim())).toEqual(["Yes: plan it", "No: park it", "Park", "Give feedback"]);
    const [yes, no] = within(row).getAllByTestId("review-choice");
    expect(yes.dataset.start).toBe("yes");
    expect(no.dataset.start).toBe("no");
    expect(yes.className).not.toMatch(/\bborder-input\b|variant-outline/);
    // what each does stays on the button (its title), never as text between the buttons and the feedback (the owner 2026-11-15)
    expect(yes.getAttribute("title")).toMatch(/The team writes a detailed plan for used-car price lookups for Spain/);
    expect(no.getAttribute("title")).toMatch(/used-car price lookups for Spain stays parked on the goal/);
    expect(within(container).queryByTestId("review-choice-subs")).toBeNull();
    // the Start now and Park switches are gone: the decision itself starts or parks
    expect(within(container).queryByTestId("review-next")).toBeNull();
    expect(container.textContent).not.toMatch(/Mark complete/);
  });

  it("a card's own options are its buttons, the recommended one first", () => {
    const own = CARD_TYPES.find((c) => c.id === "review-decision-options")!;
    const { container } = render(<MemoryRouter>{own.render()}</MemoryRouter>);
    expect(within(container).getAllByTestId("review-choice").map((b) => b.textContent)).toEqual(["Replies: keep answering threads", "Posts: keep the daily post", "Neither: stop and rethink"]);
    expect(within(container).getAllByTestId("review-choice").map((b) => b.dataset.start)).toEqual(["yes", "yes", "no"]);
  });

  it("a review card that is not a decision keeps Mark complete or Give feedback", () => {
    for (const id of ["review", "review-last-part"]) {
      const c = CARD_TYPES.find((x) => x.id === id)!;
      expect(c.kind).toBe("review");
      const { container, unmount } = render(<MemoryRouter>{c.render()}</MemoryRouter>);
      expect(within(container).getByTestId("review-buttons").getAttribute("data-card-buttons")).toBe("review");
      expect(within(container).queryAllByTestId("review-choice")).toHaveLength(0);
      unmount();
    }
  });
  // E948-S83 (the owner, third time, ^e-f43544: "We're still not getting the button names that make sense for the tasks";
  // on the Gap finder card 2026-11-14: "start the 6. And if I switch one off, start 5. Mark complete is ambiguous"):
  // every card kind is rendered; one that shows follow-ups (switches or Start now / Park) or asks a decision never says
  // Mark complete, and its main button counts what starts.
  it("no card kind with follow-ups or a decision shows Mark complete; the main button reads Start N", () => {
    let withFollowUps = 0;
    for (const c of CARD_TYPES) {
      const { container, unmount } = render(<MemoryRouter>{c.render()}</MemoryRouter>);
      const followUps = container.querySelectorAll("[data-testid=review-switch-item], [data-testid=review-suggestion]").length;
      const decision = c.kind === "decision" || container.querySelector("[data-card-buttons=decision]");
      const labels = [...container.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");
      if (followUps || decision) expect(labels.filter((l) => /mark (?:this task )?complete/i.test(l)), `${c.id} shows Mark complete`).toEqual([]);
      if (followUps) {
        withFollowUps++;
        expect(within(container).getByTestId("review-complete").textContent, c.id).toBe(`Start ${followUps}`);
      }
      unmount();
    }
    expect(withFollowUps).toBeGreaterThanOrEqual(2);
  });

  it("the next-steps card reads Start 6, Start 5 after one is parked, Close, start nothing when all are", async () => {
    const c = CARD_TYPES.find((x) => x.id === "review-next-steps")!;
    const { container } = render(<MemoryRouter>{c.render()}</MemoryRouter>);
    const main = () => container.querySelector("[data-testid=review-complete], [data-testid=review-complete-park]")?.textContent;
    expect(main()).toBe("Start 6");
    const parks = within(container).getAllByTestId("review-switch-park");
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(parks[1]);
    expect(main()).toBe("Start 5");
    for (const p of within(container).getAllByTestId("review-switch-park")) fireEvent.click(p);
    expect(main()).toBe("Close, start nothing");
  });
  it("on the inventory page the follow-up switches work (local only): Start 6 reads Start 5, the main button stays inert", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const { CardInventoryPage } = await import("@/components/cardInventory");
    window.history.replaceState(null, "", "/cards/inventory?frame=1280");
    const { container } = render(<MemoryRouter><CardInventoryPage /></MemoryRouter>);
    window.history.replaceState(null, "", "/");
    const card = container.querySelector("#review-next-steps")!;
    const main = () => card.querySelector("[data-testid=review-complete], [data-testid=review-complete-park]")?.textContent;
    expect(main()).toBe("Start 6");
    fireEvent.click(card.querySelectorAll("[data-testid=review-switch-park]")[1]);
    expect(main()).toBe("Start 5");
    const sw = container.querySelector("#review-switches")!;
    fireEvent.click(sw.querySelector("[data-testid=review-switch]")!);
    expect(sw.querySelector("[data-testid=review-complete]")?.textContent).toBe("Start 2");
  });

  it("on a phone the card-type table stacks each type as a block, a table from sm up", () => {
    window.history.replaceState(null, "", "/cards/inventory");
    const { getByTestId } = render(<MemoryRouter><CardInventoryPage /></MemoryRouter>);
    const t = getByTestId("card-button-table");
    expect(t.className).toMatch(/\bblock\b.*\bsm:table\b/);
    expect(t.querySelector("thead")!.className).toMatch(/\bhidden\b.*\bsm:table-header-group\b/);
    const row = t.querySelector("tbody tr")!;
    expect(row.className).toMatch(/\bgrid\b.*\bsm:table-row\b/);
    for (const td of row.querySelectorAll("td")) expect(td.className).toMatch(/\bblock\b.*\bbreak-words\b.*\bsm:table-cell\b/);
    expect(row.textContent).toContain("It asks you to:");
    expect(getByTestId("inventory-390").className).toContain("max-w-full");
  });

  it("a link to one card passes its anchor to both frames, so the page opens on that card", () => {
    window.history.replaceState(null, "", "/cards/inventory#review-switches");
    const { getByTestId } = render(<MemoryRouter><CardInventoryPage /></MemoryRouter>);
    expect(getByTestId("inventory-390").getAttribute("src")).toBe("?frame=390#review-switches");
    expect(getByTestId("inventory-1280").getAttribute("src")).toBe("?frame=1280#review-switches");
    window.history.replaceState(null, "", "/cards/inventory#nothing-here");
    cleanup();
    const other = render(<MemoryRouter><CardInventoryPage /></MemoryRouter>);
    expect(other.getByTestId("inventory-390").getAttribute("src")).toBe("?frame=390");
  });
});

// E948-S83 iteration 2 (the owner 2026-11-14 23:38Z on a decision card, vn_fc018786: "There should always be one button which is
// to park ... if there had been an option for park, I think maybe that's the one I would have taken"): every card kind that waits
// on him shows one Park beside its own buttons, before Give feedback and the answer box; the few without are named with why.
describe("E948-S83 iteration 2 every card that waits on him has Park", () => {
  it("every card kind but For your information and the named few shows exactly one Park, in its button row", () => {
    const parked: string[] = [];
    for (const c of CARD_TYPES) {
      const { container, unmount } = render(<MemoryRouter>{c.render()}</MemoryRouter>);
      const parks = container.querySelectorAll("[data-testid=card-park]");
      if (c.kind === "news" || NO_PARK[c.id]) expect(parks.length, `${c.id} should not show Park`).toBe(0);
      else {
        expect(parks.length, `${c.id} has no Park`).toBe(1);
        expect(parks[0].textContent?.trim(), c.id).toBe("Park");
        // beside the card's own buttons, never alone in the meta line, and before the feedback block
        const row = parks[0].parentElement!;
        expect(row.closest("[data-card-meta]"), c.id).toBeNull();
        const block = container.querySelector("[data-card-feedback], [data-testid=review-note], [data-testid^=answer-][data-testid$=-box]");
        if (block) expect(parks[0].compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING, `${c.id}: Park comes before the answer box`).toBeTruthy();
        expect(c.buttons, `${c.id}: the table names Park`).toMatch(/\bPark\b/);
        parked.push(c.id);
      }
      unmount();
    }
    // the decision cards he met it on, and every review and ask kind
    for (const id of ["review-decision", "review-decision-options", "decide-options", "decide-yes-no", "approve", "do", "answer", "review", "review-next-steps", "ask-set", "team-idea", "team-goal"]) expect(parked).toContain(id);
  });

  it("every card without Park is named with its reason and exists", () => {
    for (const [id, why] of Object.entries(NO_PARK)) {
      expect(CARD_TYPES.some((c) => c.id === id), id).toBe(true);
      expect(why.length).toBeGreaterThan(20);
    }
  });

  it("pressing Park on a review card writes a month's park to its row, and Bring it back unparks it", async () => {
    const { fireEvent, waitFor } = await import("@testing-library/react");
    const { api } = await import("@/api");
    const { closedNote } = await import("@/lib/afterClose");
    const spy = vi.spyOn(api, "snoozeReviewItem").mockImplementation(async (id, input) => ({ id, snoozedUntil: input.until === null ? null : "2026-12-14T23:00Z" }) as never);
    const c = CARD_TYPES.find((x) => x.id === "review-decision")!;
    const { container } = render(<MemoryRouter>{c.render()}</MemoryRouter>);
    fireEvent.click(within(container).getByTestId("card-park"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("sample_decision", { days: 30, park: true }));
    const note = closedNote();
    expect(note?.said).toBe("Parked for a month");
    await note!.back!();
    expect(spy).toHaveBeenLastCalledWith("sample_decision", { until: null });
  });

  it("pressing Park on an ask writes a month's park on its spine line", async () => {
    const { fireEvent, waitFor } = await import("@testing-library/react");
    const { api } = await import("@/api");
    const spy = vi.spyOn(api, "snoozeWaiting").mockResolvedValue({ id: "sample_a29", snoozedUntil: "2026-12-14" });
    const c = CARD_TYPES.find((x) => x.id === "decide-options")!;
    const { container } = render(<MemoryRouter>{c.render()}</MemoryRouter>);
    fireEvent.click(within(container).getByTestId("card-park"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("sample_a29", expect.objectContaining({ days: 30, park: true })));
  });
});
