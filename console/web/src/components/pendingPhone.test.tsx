// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type PendingItem, type StatusBatch, type WaitingItem } from "@/api";
import { PendingSelector } from "@/components/pending";
import { WaitingCard } from "@/components/waiting";
import { AnswerTextarea } from "@/components/common";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);
const phone = (matches: boolean) => vi.stubGlobal("matchMedia", (q: string) => ({ matches, media: q }) as MediaQueryList);

const LONG = "Heads-up for ops (outside E904): a Deployer deploy tonight started xtreme_logger with NO env, because Deployer could not read it";
const ITEMS: PendingItem[] = [
  { id: "a1", kind: "ask", state: "open", milestoneId: "ms_p", code: "T13-A1", title: LONG, repo: "ops" },
  { id: "f1", kind: "free_text_ask", state: "open", milestoneId: "ms_z", title: "T0-S2 Which accounts do we post from?", repo: "social", path: "docs/spines/root.md" },
];
const batch: StatusBatch = { milestones: [], items: ITEMS, needsYou: 2, at: "2026-10-25T10:00:00Z" };

const item: WaitingItem = {
  id: "wj_1",
  source: "ask",
  state: "open",
  who: "Sam",
  row: "T4",
  milestoneId: "ms_1",
  milestoneTitle: "E904",
  nodeKey: "ms_1/T4",
  path: "docs/E904.md",
  title: "T4 Pick the logger layout",
  ask: "decide",
  question: "Ship with one logger or two?",
  options: ["one", "two"],
  recommendation: "one",
  contextLinks: [],
  owner: { kind: "delivery-manager", assignmentId: "as_1", personaName: "Delivery Manager", label: "Delivery Manager", threadId: "th_1" },
  since: new Date(Date.now() - 86400_000).toISOString(),
  decidable: false,
};

describe("T17-S1 Pending on a phone", () => {
  it("each row stacks below sm (text full width, action under it, 44 px tap target); the desktop classes stay as they were", async () => {
    vi.spyOn(api, "listStatus").mockResolvedValue(batch);
    wrap(<PendingSelector />);
    const rows = within(await screen.findByTestId("pending-group-needs_you")).getAllByTestId("pending-item");
    for (const r of rows) {
      expect(r.className).toContain("flex min-w-0 flex-wrap items-center"); // desktop: text beside the action
      expect(r.className).toMatch(/max-sm:flex-col max-sm:items-stretch/);
      expect((r.firstElementChild as HTMLElement).className).toContain("max-sm:flex-none");
    }
    const answer = within(rows[0]).getByRole("link", { name: "Answer" });
    expect(answer.className).toMatch(/\bshrink-0\b/);
    expect(answer.className).toMatch(/max-sm:min-h-11 max-sm:self-end/);
    expect(within(rows[1]).getByRole("button", { name: /Rewrite as a coded ask/ }).className).toContain("max-sm:min-h-11");
  });
});

describe("T17-S1 answer box on a phone", () => {
  // the card's box is Chat's box (WordsBox):
  // on a phone it takes the row's width beside 44 px icons, 16 px text, and grows with the text to 40% of the screen.
  it("WaitingCard's answer box is Chat's box: 16 px, grows below sm; its buttons are 44 px tap targets", () => {
    // a question that needs words shows its "Your answer" box at once (an options card shows it under More)
    wrap(<WaitingCard item={{ ...item, ask: "provide" }} />);
    const box = screen.getByRole("textbox", { name: "Feedback" });
    // the words take the frame's whole width; the buttons sit in a short row under them, inside the same frame
    expect(box.className).toContain("w-full min-w-0 resize-none border-0 bg-transparent px-3 py-2 text-sm");
    for (const c of ["max-sm:text-base", "max-sm:min-h-11", "max-sm:max-h-[40dvh]", "max-sm:[field-sizing:content]"]) expect(box.className).toContain(c);
    const row = box.parentElement as HTMLElement;
    expect(row.dataset.testid).toBe("words-field");
    for (const b of within(row).getAllByRole("button")) expect(b.className).toContain("max-sm:min-h-11");
    // E948-S60: a words question's Answer is the feedback block's Send, in the box's own row
    const buttons = [...within(screen.getByTestId("answer-buttons")).queryAllByRole("button"), within(row).getByTestId("answer")];
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b.className).toContain("max-sm:min-h-11");
  });

  it("grows with its text on a phone without CSS field-sizing; desktop keeps its fixed height", () => {
    vi.stubGlobal("CSS", { supports: () => false });
    phone(true);
    const onChange = vi.fn();
    const { unmount } = render(<AnswerTextarea aria-label="A" value="" onChange={onChange} />);
    const box = screen.getByRole("textbox", { name: "A" }) as HTMLTextAreaElement;
    Object.defineProperty(box, "scrollHeight", { value: 140 });
    fireEvent.input(box, { target: { value: "a\nb\nc\nd\ne" } });
    expect(box.style.height).toBe("142px");
    unmount();
    phone(false);
    render(<AnswerTextarea aria-label="B" />);
    const desk = screen.getByRole("textbox", { name: "B" }) as HTMLTextAreaElement;
    fireEvent.input(desk, { target: { value: "x" } });
    expect(desk.style.height).toBe("");
  });

  it("on focus a phone scrolls the row (box + send buttons) above the keyboard; desktop does not scroll", () => {
    vi.useFakeTimers();
    try {
      phone(true);
      const { container } = render(
        <div>
          <AnswerTextarea aria-label="A" />
          <button>Send</button>
        </div>,
      );
      const row = container.firstElementChild as HTMLElement;
      const scroll = vi.fn();
      row.scrollIntoView = scroll;
      fireEvent.focus(screen.getByRole("textbox", { name: "A" }));
      vi.runAllTimers();
      expect(scroll).toHaveBeenCalledWith({ block: "end", behavior: "smooth" });
      cleanup();
      phone(false);
      const r2 = render(
        <div>
          <AnswerTextarea aria-label="B" />
        </div>,
      );
      const scroll2 = vi.fn();
      (r2.container.firstElementChild as HTMLElement).scrollIntoView = scroll2;
      fireEvent.focus(screen.getByRole("textbox", { name: "B" }));
      vi.runAllTimers();
      expect(scroll2).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
