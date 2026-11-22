// @vitest-environment jsdom
import { forgetWorld } from "@/lib/useSocial";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api, type DeskChat, type ReviewItem, type WaitingItem } from "@/api";
import { WaitingCard } from "@/components/waiting";
import { WaitingForReview } from "@/components/review";
import { ChatPage, forgetChats } from "@/pages/Chat";
import { clearAnswerVoiceState } from "@/voice/AnswerVoice";
import { openText } from "@/test/openText";

/**
 * one box (WordsBox) everywhere: the same text area, paperclip, paste, drop, thumbnails and voice note in
 * Chat and in every card box; the files go with the card's own press.
 */
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

beforeEach(() => {
  forgetChats();
  forgetWorld();
  clearAnswerVoiceState();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const json = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
      if (url === "/api/voice/state") return json({ enabled: true, monthUsd: 0.2, limits: { monthCapUsd: 25 } });
      return json({ error: { message: "not faked" } }, 404);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const png = (name = "image.png") => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });
const uploads = () => {
  let n = 0;
  return vi.spyOn(api, "uploadChatAttachment").mockImplementation(async (f, name) => ({
    attachment: { id: `att_${++n}`, name, mime: f.type, bytes: f.size, createdAt: "", path: `/api/chat/attachments/att_${n}/${name}` },
  }));
};
/** Ctrl/Cmd+V of a screenshot on a computer: the image is in `files`. */
const pasteFile = (box: HTMLElement, f = png()) => fireEvent.paste(box, { clipboardData: { files: [f], items: [], getData: () => "" } });
/** A phone's long-press Paste: the image only as a clipboard item. */
const pasteItem = (box: HTMLElement, f = png()) => fireEvent.paste(box, { clipboardData: { files: [], items: [{ kind: "file", getAsFile: () => f }], getData: () => "" } });

const ask = (over: Partial<WaitingItem> = {}): WaitingItem => ({
  id: "wj_1",
  code: "T4-A2",
  source: "ask",
  state: "open",
  who: "Sam",
  row: "T4",
  milestoneId: "ms_1",
  milestoneTitle: "E904",
  nodeKey: "ms_1/T4",
  path: "docs/E904.md",
  title: "T4 Pick the logger layout",
  ask: "provide",
  question: "Which screen looks wrong?",
  options: [],
  contextLinks: [],
  owner: { kind: "delivery-manager", assignmentId: "as_1", personaName: "Delivery Manager", label: "Delivery Manager", threadId: "th_1" },
  since: "2026-11-06T10:00:00.000Z",
  decidable: false,
  ...over,
});
const answered = (itemId: string) => ({ id: "jr_1", itemId, kind: "answer" as const, text: "x", delivery: "sent" as const, createdAt: "" });

/** The one box: text area, paperclip and the voice note's microphone in one row. */
async function oneBox(root: HTMLElement, label: string) {
  // E948-S60: a card's box is the feedback block; a panel's (Decline) and Chat's are the WordsBox. E948-S131: a card's box
  // opens on Text, and its microphone is Voice in the card's row beside Text
  openText(root);
  const box = await waitFor(() => (root.querySelector("[data-testid='card-feedback-box']") ?? within(root).getByTestId("words-box")) as HTMLElement);
  const area = within(box).getByLabelText(label);
  expect(area.tagName).toBe("TEXTAREA");
  const row = area.parentElement!;
  expect(within(row).getByRole("button", { name: "Attach a screenshot or file" }).className).toMatch(/max-sm:size-11/);
  await waitFor(() => expect(within(root.querySelector("[data-feedback-row]") ?? row).getByTestId(/(answer-voice|note)-button/).className).toMatch(/max-sm:size-11|\bh-11\b|max-sm:min-h-11/));
  return { box, area };
}

describe("T18-S11 round 2: the inbox card's boxes take screenshots like Chat", () => {
  it("Answer: a pasted screenshot shows as a thumbnail and goes with the answer, even with no words", async () => {
    const up = uploads();
    const respond = vi.spyOn(api, "respondToWaiting").mockResolvedValue(answered("wj_1"));
    const { container } = render(
      <MemoryRouter>
        <WaitingCard item={ask()} />
      </MemoryRouter>,
    );
    openText();
    const { box, area } = await oneBox(container, "Your answer");
    const press = within(container).getByTestId("answer") as HTMLButtonElement;
    expect(press.disabled).toBe(true);
    pasteFile(area);
    await waitFor(() => expect(within(box).getAllByTestId("chat-attach-item").map((e) => e.getAttribute("data-state"))).toEqual(["ready"]));
    expect(up).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(press.disabled).toBe(false));
    fireEvent.click(press);
    await waitFor(() => expect(respond).toHaveBeenCalledWith("wj_1", expect.objectContaining({ kind: "answer", text: "", attachments: ["att_1"] })));
    await waitFor(() => expect(within(container).queryByTestId("chat-attach-tray")).toBeNull());
  });

  it("No on an approve card (was Changes wanted): a phone's long-press paste and a drop both attach; the words and files go together", async () => {
    uploads();
    const respond = vi.spyOn(api, "respondToWaiting").mockResolvedValue(answered("wj_2"));
    const { container } = render(
      <MemoryRouter>
        <WaitingCard item={ask({ id: "wj_2", ask: "approve", decidable: true, question: "Ship the logger?" })} />
      </MemoryRouter>,
    );
    // the first press of No opens the note; the next sends it with the note and the files
    fireEvent.click(await within(container).findByTestId("decline"));
    expect(respond).not.toHaveBeenCalled();
    openText();
    const { box, area } = await oneBox(container, "Feedback");
    pasteItem(area, png("phone.png"));
    fireEvent.drop(box, { dataTransfer: { files: [png("dropped.png")], types: ["Files"] } });
    await waitFor(() => expect(within(box).getAllByTestId("chat-attach-item").map((e) => e.getAttribute("data-state"))).toEqual(["ready", "ready"]));
    fireEvent.change(area, { target: { value: "the logo is cut off" } });
    fireEvent.click(within(container).getByTestId("decline"));
    await waitFor(() => expect(respond).toHaveBeenCalledWith("wj_2", expect.objectContaining({ kind: "deny", text: "the logo is cut off", attachments: ["att_1", "att_2"] })));
  });

  // the note box has no Cancel any more (the note goes with the button pressed), so only the no-files half stays
  it("with no files, the answer carries no attachments", async () => {
    uploads();
    const respond = vi.spyOn(api, "respondToWaiting").mockResolvedValue(answered("wj_3"));
    const { container } = render(
      <MemoryRouter>
        <WaitingCard item={ask({ id: "wj_3", ask: "approve", decidable: true })} />
      </MemoryRouter>,
    );
    fireEvent.click(await within(container).findByTestId("decline"));
    openText();
    await oneBox(container, "Feedback");
    fireEvent.click(within(container).getByTestId("decline"));
    await waitFor(() => expect(respond).toHaveBeenCalled());
    expect(respond.mock.calls[0][1]).toMatchObject({ kind: "deny", text: "" });
    expect(respond.mock.calls[0][1]).not.toHaveProperty("attachments");
  });
});

const ITEM = {
  id: "rv_1",
  title: "TEST card",
  liveUrl: "https://team.example.com",
  ref: "T972-D4",
  repo: "e67-feedback-test",
  path: "docs/spines/press-test.md",
  cardPath: "docs/cards/T972-D4.md",
  milestoneId: "ms_1",
  state: "review",
  status: "review",
  liveStatus: 200,
  checkedAt: "2026-11-08T17:00:00Z",
  createdAt: "2026-11-08",
  verdict: { kind: "card" },
  face: {
    project: { name: "The TEST project", url: "https://team.example.com/" },
    goal: { text: "Try every button on a TEST card", code: "PLAN-972" },
    tasks: { done: 1, total: 2 },
    title: "A TEST card was put up to try a pasted screenshot.",
    taskGoal: "Sam can paste a screenshot into any card box.",
    delivered: [{ ok: true, text: "The paperclip is on every card box." }],
    evidence: { url: "https://team.example.com", label: "Open the Team home" },
    screenshot: "docs/status/test.png",
    tree: [],
    after: "",
    next: [],
    closesGoal: false,
    openInGoal: [],
  },
} as unknown as ReviewItem;

describe("T18-S11 round 2: a review card's Give feedback and Decline", () => {
  const mount = () => {
    vi.spyOn(api, "listReviewItems").mockImplementation(async (q?: { state?: string }) => (q?.state ? [] : [ITEM]));
    return render(
      <MemoryRouter>
        <WaitingForReview fold="review" />
      </MemoryRouter>,
    );
  };

  it("Give feedback (was Not yet): the pasted screenshot goes with his words to the new round", async () => {
    uploads();
    const relaunch = vi.spyOn(api, "relaunchReviewItem").mockResolvedValue({ ...ITEM, state: "relaunched" });
    mount();
    const c = await screen.findByTestId("review-card");
    fireEvent.click(within(c).getByTestId("card-feedback-text"));
    const { box, area } = await oneBox(c, "Feedback");
    pasteFile(area);
    await waitFor(() => expect(within(box).getByTestId("chat-attach-item").getAttribute("data-state")).toBe("ready"));
    fireEvent.change(area, { target: { value: "this was only in the main chat" } });
    fireEvent.click(within(c).getByTestId("card-feedback-send"));
    await waitFor(() => expect(relaunch).toHaveBeenCalledWith("rv_1", "this was only in the main chat", ["att_1"]));
  });

  it("Decline: a screenshot alone can go with it; without files the call is as before", async () => {
    uploads();
    const deny = vi.spyOn(api, "denyReviewItem").mockResolvedValue({ ...ITEM, state: "denied" });
    mount();
    const c = await screen.findByTestId("review-card");
    // Decline sits under More, opened by the heading
    fireEvent.click(within(c).getByTestId("review-title"));
    fireEvent.click(within(c).getByTestId("review-deny"));
    const panel = within(c).getByTestId("review-deny-panel");
    const { area } = await oneBox(panel, "Why you decline it");
    pasteItem(area);
    await within(panel).findByTestId("chat-attach-item");
    await waitFor(() => expect((within(panel).getByTestId("review-deny-confirm") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(panel).getByTestId("review-deny-confirm"));
    await waitFor(() => expect(deny).toHaveBeenCalledWith("rv_1", "", ["att_1"]));
  });
});

describe("T18-S11 round 2: Chat is the same box", () => {
  it("the Chat page's composer is the WordsBox with the paperclip and the voice note in the same row", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue({ available: true, threadId: "th", environmentId: "env", session: 1, status: "idle", working: false, sending: 0, hasEarlier: false, messages: [] } as DeskChat);
    const up = uploads();
    const { container } = render(
      <MemoryRouter initialEntries={["/chat"]}>
        <Routes>
          <Route path="/chat" element={<ChatPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const { area } = await oneBox(container, "Message to the Team desk");
    pasteItem(area);
    await waitFor(() => expect(up).toHaveBeenCalledTimes(1));
  });
});
