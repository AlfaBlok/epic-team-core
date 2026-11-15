// @vitest-environment jsdom
import { forgetWorld } from "@/lib/useSocial";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type Assignment, type Milestone, type Run, type WaitingItem } from "@/api";
import { SendToDialog, WaitingCard } from "@/components/waiting";
import { RunNowDialog, SteerDialog } from "@/components/dialogs";
import { readClipboard } from "@/components/ChatAttach";
import { SlideNoteBox } from "@/pages/social/Totems";
import { LiveFeedback, type BoardSource } from "@/pages/social/Pipeline";
import { FeedbackBox } from "@/pages/social/parts";
import { clearAnswerVoiceState } from "@/voice/AnswerVoice";
import { forgetChats } from "@/pages/Chat";

/**
 * (1) a `do` step that asks him for a
 * screenshot has its own Answer box; (2) on a phone the box has a Paste button that reads the clipboard itself (iOS offers no
 * Paste for a picture alone in a text box); (3) every other box that takes his words is the same box, its files going after
 * his words as a line of links.
 */
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const LINE = "📎 Sam attached a file, open it with your console headers: https://team.example/api/chat/attachments/att_1/image.png";

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
const lines = () => vi.spyOn(api, "attachmentLine").mockResolvedValue({ line: LINE });
/** A phone's long-press Paste: the image only as a clipboard item. */
const pasteItem = (box: HTMLElement, f = png()) => fireEvent.paste(box, { clipboardData: { files: [], items: [{ kind: "file", getAsFile: () => f }], getData: () => "" } });
/** The pasted file is uploaded and shows as a thumbnail in this box. */
const attached = (root: HTMLElement) => waitFor(() => expect(within(root).getAllByTestId("chat-attach-item").map((e) => e.getAttribute("data-state"))).toEqual(["ready"]));

/** A phone (a finger is the pointer) whose clipboard holds `items`, or refuses to be read. */
function phone(items: { types: string[]; getType: (t: string) => Promise<Blob> }[] | "refused") {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(pointer: coarse)", media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  const read = vi.fn(async () => {
    if (items === "refused") throw new DOMException("not allowed", "NotAllowedError");
    return items;
  });
  Object.defineProperty(navigator, "clipboard", { value: { read }, configurable: true });
  return read;
}
const screenshotItem = () => ({ types: ["image/png"], getType: async () => png() as Blob });
const textItem = (t: string) => ({ types: ["text/plain"], getType: async () => new Blob([t], { type: "text/plain" }) });

const ask = (over: Partial<WaitingItem> = {}): WaitingItem => ({
  id: "wj_1",
  code: "T18-A1",
  source: "ask",
  state: "open",
  who: "Sam",
  row: "T18-S12",
  milestoneId: "ms_1",
  milestoneTitle: "PLAN-18",
  nodeKey: "ms_1/T18-S12",
  path: "docs/spines/epic-18-team-chat.md",
  title: "T18-S12 Mobile Chat alignment",
  ask: "do",
  question: "Paste a screenshot of the mobile Chat boxes that are not lined up, right here in this card's answer box",
  options: [],
  contextLinks: [],
  owner: { kind: "delivery-manager", assignmentId: "as_1", personaName: "Delivery Manager", label: "Delivery Manager", threadId: "th_1" },
  since: "2026-11-08T10:00:00.000Z",
  decidable: false,
  ...over,
});
const answered = (itemId: string) => ({ id: "jr_1", itemId, kind: "answer" as const, text: "x", delivery: "sent" as const, createdAt: "" });

describe("T18-S12: a do step's Answer box (the T18-A1 card)", () => {
  it("Stuck opens the one note box; a pasted screenshot goes with it as the answer, not as Changes wanted", async () => {
    uploads();
    const respond = vi.spyOn(api, "respondToWaiting").mockResolvedValue(answered("wj_1"));
    const { container } = render(
      <MemoryRouter>
        <WaitingCard item={ask()} />
      </MemoryRouter>,
    );
    // a do step has Done and Stuck (was Done, Answer, Changes wanted, Decline); E948-S60: the note box is always open
    expect(within(container).getByTestId("card-feedback-box")).toBeTruthy();
    fireEvent.click(await within(container).findByTestId("stuck"));
    const box = await within(container).findByTestId("card-feedback-box");
    const area = within(box).getByLabelText("Feedback");
    pasteItem(area);
    await attached(box);
    fireEvent.change(area, { target: { value: "the send button sits lower" } });
    // its next press sends the words and the screenshot as the answer
    fireEvent.click(within(container).getByTestId("stuck"));
    await waitFor(() => expect(respond).toHaveBeenCalledWith("wj_1", expect.objectContaining({ kind: "answer", text: "Stuck. the send button sits lower", attachments: ["att_1"] })));
  });
});

describe("T18-S12: the phone's Paste button", () => {
  it("reads a screenshot from the clipboard into the files above the box", async () => {
    const read = phone([screenshotItem()]);
    const up = uploads();
    const respond = vi.spyOn(api, "respondToWaiting").mockResolvedValue(answered("wj_2"));
    const { container } = render(
      <MemoryRouter>
        <WaitingCard item={ask({ id: "wj_2", ask: "provide", question: "Which screen looks wrong?" })} />
      </MemoryRouter>,
    );
    const box = await within(container).findByTestId("card-feedback-box");
    // Paste is folded into the paperclip's menu (the box's row keeps the paperclip, the mic and the press)
    const clip = within(box).getByRole("button", { name: "Attach a screenshot or file" });
    expect(clip.className).toMatch(/max-sm:size-11/);
    fireEvent.click(clip);
    fireEvent.click(within(box).getByRole("menuitem", { name: "Paste a screenshot" }));
    await attached(box);
    expect(read).toHaveBeenCalledTimes(1);
    expect(up.mock.calls[0][0].type).toBe("image/png");
    expect(up.mock.calls[0][1]).toMatch(/^pasted-\d{14}\.png$/);
    const press = within(container).getByTestId("answer") as HTMLButtonElement;
    await waitFor(() => expect(press.disabled).toBe(false));
    fireEvent.click(press);
    await waitFor(() => expect(respond).toHaveBeenCalledWith("wj_2", expect.objectContaining({ kind: "answer", attachments: ["att_1"] })));
  });

  it("puts copied words into the box, and says why when the phone refuses", async () => {
    phone([textItem("copied words")]);
    const { container } = render(
      <MemoryRouter>
        <WaitingCard item={ask({ id: "wj_3", ask: "provide" })} />
      </MemoryRouter>,
    );
    const box = await within(container).findByTestId("card-feedback-box");
    fireEvent.click(within(box).getByRole("button", { name: "Attach a screenshot or file" }));
    fireEvent.click(within(box).getByRole("menuitem", { name: "Paste a screenshot" }));
    await waitFor(() => expect((within(box).getByLabelText("Feedback") as HTMLTextAreaElement).value).toBe("copied words"));
    cleanup();
    phone("refused");
    const again = render(
      <MemoryRouter>
        <WaitingCard item={ask({ id: "wj_4", ask: "provide" })} />
      </MemoryRouter>,
    );
    const box2 = await within(again.container).findByTestId("card-feedback-box");
    fireEvent.click(within(box2).getByRole("button", { name: "Attach a screenshot or file" }));
    fireEvent.click(within(box2).getByRole("menuitem", { name: "Paste a screenshot" }));
    expect((await within(again.container).findByTestId("words-paste-note")).textContent).toMatch(/paperclip/);
  });

  it("is not shown with a mouse, where Ctrl or Cmd V pastes", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
    Object.defineProperty(navigator, "clipboard", { value: { read: vi.fn() }, configurable: true });
    const { container } = render(
      <MemoryRouter>
        <WaitingCard item={ask({ id: "wj_5", ask: "provide" })} />
      </MemoryRouter>,
    );
    const box = await within(container).findByTestId("card-feedback-box");
    expect(within(box).queryByRole("button", { name: "Paste a screenshot" })).toBeNull();
    // with a mouse the paperclip opens the file dialog at once, no menu
    expect(within(box).getByRole("button", { name: "Attach a screenshot or file" }).getAttribute("aria-haspopup")).toBeNull();
  });

  it("readClipboard: an image item becomes a file, a text item words; no read is a clear error", async () => {
    const got = await readClipboard({ read: async () => [screenshotItem(), textItem("hi")] as unknown as ClipboardItems });
    expect(got.files.map((f) => f.type)).toEqual(["image/png"]);
    expect(got.text).toBe("hi");
    await expect(readClipboard({} as Clipboard)).rejects.toThrow(/clipboard/);
  });
});

describe("T18-S12: every other box that takes his words is the one box", () => {
  it("Send to: the pasted screenshot goes as a line of links after his words", async () => {
    uploads();
    const line = lines();
    vi.spyOn(api, "listAssignments").mockResolvedValue([{ id: "as_1", milestoneId: "ms_1", personaId: "per_1", cadence: { type: "interval", everyMinutes: 60 }, enabled: true } as Assignment]);
    vi.spyOn(api, "listPersonas").mockResolvedValue([{ id: "per_1", name: "Delivery Manager", remit: "x", skills: [], model: "opus", mayWrite: false, createdAt: "" }]);
    const send = vi.spyOn(api, "sendMessage").mockResolvedValue({ id: "msg_1", delivery: "sent", threadId: "th_1" } as never);
    render(
      <MemoryRouter>
        <SendToDialog milestoneId="ms_1" open onOpenChange={() => undefined} />
      </MemoryRouter>,
    );
    const box = await screen.findByTestId("send-to-box");
    await screen.findByRole("option", { name: /Delivery Manager/ });
    pasteItem(within(box).getByLabelText("Message"));
    await attached(box);
    fireEvent.change(within(box).getByLabelText("Message"), { target: { value: "look" } });
    fireEvent.click(screen.getByRole("button", { name: /Send$/ }));
    await waitFor(() => expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: `look ${LINE}` })));
    expect(line).toHaveBeenCalledWith(["att_1"]);
  });

  it("Steer: a screenshot alone is a message", async () => {
    uploads();
    lines();
    const steer = vi.spyOn(api, "steerRun").mockResolvedValue({ run: {} as Run, threadId: "th", mode: "steer" });
    render(<SteerDialog open onOpenChange={() => undefined} run={{ id: "run_1", assignmentId: "as_1", startedAt: "", outcome: "running" } as Run} />);
    const box = await screen.findByTestId("steer-box");
    pasteItem(within(box).getByLabelText("Message"));
    await attached(box);
    const sendBtn = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    await waitFor(() => expect(sendBtn.disabled).toBe(false));
    fireEvent.click(sendBtn);
    await waitFor(() => expect(steer).toHaveBeenCalledWith("run_1", LINE, expect.any(String)));
  });

  it("Run now: the instructions carry the screenshot's link", async () => {
    uploads();
    lines();
    const runNow = vi.spyOn(api, "runAssignmentNow").mockResolvedValue({ id: "run_2" } as Run);
    render(<RunNowDialog open onOpenChange={() => undefined} assignment={{ id: "as_1", milestoneId: "ms_1", personaId: "per_1", cadence: { type: "interval", everyMinutes: 60 }, enabled: true } as Assignment} />);
    const box = await screen.findByTestId("run-now-box");
    pasteItem(within(box).getByLabelText("Instructions for this run"));
    await attached(box);
    fireEvent.change(within(box).getByLabelText("Instructions for this run"), { target: { value: "fix this first" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(runNow).toHaveBeenCalledWith("as_1", `fix this first ${LINE}`, expect.any(String)));
  });

  it("a slide's note: the screenshot goes to the campaign chat as a file", async () => {
    uploads();
    const chat = vi.spyOn(api, "sendMilestoneChatMessage").mockResolvedValue({ threadId: "th", pending: false });
    render(
      <MemoryRouter>
        <SlideNoteBox m={{ id: "ms_9" } as Milestone} sent={(t) => `slide 2: ${t}`} />
      </MemoryRouter>,
    );
    const box = await screen.findByTestId("slide-note-box");
    pasteItem(within(box).getByLabelText("What should change on this slide"));
    await attached(box);
    fireEvent.click(screen.getByTestId("slide-note-send"));
    await waitFor(() => expect(chat).toHaveBeenCalledWith("ms_9", "slide 2: ", undefined, undefined, ["att_1"]));
  });

  it("feedback on a live post and a post's note: the link follows his words", async () => {
    uploads();
    lines();
    const write = vi.fn(async () => ({ ok: true }) as never);
    const post = { id: "P7", status: "posted" } as never;
    render(
      <MemoryRouter>
        <LiveFeedback p={post} src={{ repo: "r", social: {} as never, write } as BoardSource} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Give feedback/ }));
    const box = await screen.findByTestId("live-feedback-box");
    pasteItem(within(box).getByLabelText("Feedback on P7"));
    await attached(box);
    fireEvent.change(within(box).getByLabelText("Feedback on P7"), { target: { value: "too long" } });
    fireEvent.click(screen.getByRole("button", { name: /Send to the Writer/ }));
    await waitFor(() => expect(write).toHaveBeenCalledWith({ action: "posts/P7/feedback", body: { feedback: `too long ${LINE}` } }));
    cleanup();
    write.mockClear();
    render(
      <MemoryRouter>
        <FeedbackBox p={post} write={write} />
      </MemoryRouter>,
    );
    const note = await screen.findByTestId("post-note-box");
    pasteItem(within(note).getByLabelText("Feedback on P7"));
    await attached(note);
    const sendBtn = within(note).getByRole("button", { name: /Send/ }) as HTMLButtonElement;
    await waitFor(() => expect(sendBtn.disabled).toBe(false));
    fireEvent.click(sendBtn);
    await waitFor(() => expect(write).toHaveBeenCalledWith({ action: "posts/P7/feedback", body: { feedback: LINE } }));
  });
});
