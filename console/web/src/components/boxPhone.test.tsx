// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "fs";
import path from "path";
import { useState } from "react";
import { api } from "@/api";
import { useChatAttach } from "@/components/ChatAttach";
import { PASTE_TOAST_MS, WordsBox } from "@/components/WordsBox";
import { PUSH_NOTE_MS, usePushToggle } from "@/components/PushToggle";

/**
 * (1) the words take the
 * whole width, the buttons sit in a short row under them and Paste is in the paperclip's menu; (3) "Notifications are on."
 * shows once, then goes; (5) the paste note is a toast that goes by itself and never pushes the box up. (2) the history
 * without its frame and (4) the small pill are in chat.test.tsx.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function phone(read: () => Promise<unknown>) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(pointer: coarse)" || q === "(max-width: 639.98px)", media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  Object.defineProperty(navigator, "clipboard", { value: { read: vi.fn(read) }, configurable: true });
}

function Box() {
  const [v, setV] = useState("");
  const files = useChatAttach({ enabled: true });
  return <WordsBox value={v} onChange={setV} files={files} voice={{ button: <button type="button">Mic</button> }} label="Message" placeholder="Tell the desk an idea" send={<button type="button">Send</button>} />;
}

describe("T18-S18 the one box on a phone", () => {
  it("the words take the whole width; paperclip, mic and send are one short row under them, inside the frame", () => {
    phone(async () => []);
    render(<Box />);
    const area = screen.getByRole("textbox", { name: "Message" });
    const frame = area.parentElement as HTMLElement;
    expect(frame.dataset.testid).toBe("words-field");
    expect(frame.className).toMatch(/\bflex-col\b/);
    expect(area.className).toMatch(/\bw-full\b/);
    expect(area.className).not.toMatch(/\bflex-1\b|basis-0/);
    const row = within(frame).getByTestId("words-tools");
    expect(area.nextElementSibling).toBe(row);
    expect(within(row).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Attach a screenshot or file", "Mic", "Send"]);
    expect(screen.queryByTestId("words-paste")).toBeNull(); // no Paste of its own in the row
  });

  it("Paste is in the paperclip's menu with Choose photos and Choose files; the menu closes after a choice", async () => {
    phone(async () => []);
    const opened: HTMLInputElement[] = [];
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      opened.push(this);
    });
    render(<Box />);
    const clip = screen.getByRole("button", { name: "Attach a screenshot or file" });
    expect(clip.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(clip);
    const menu = screen.getByTestId("chat-attach-menu");
    expect(within(menu).getAllByRole("menuitem").map((b) => b.textContent?.trim())).toEqual(["Paste a screenshot", "Choose photos", "Choose files"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Choose photos" }));
    expect(screen.queryByTestId("chat-attach-menu")).toBeNull();
    fireEvent.click(clip);
    fireEvent.click(screen.getByRole("menuitem", { name: "Choose files" }));
    // photos open the photo picker (pictures and videos only, several at once), files the chooser with documents
    expect(opened.map((i) => [i.dataset.testid, i.multiple, i.accept])).toEqual([
      ["chat-attach-photos", true, "image/*,video/*"],
      ["chat-attach-input", true, expect.stringContaining(".pdf")],
    ]);
  });

  it("a phone that cannot paste still gets the menu, and three photos picked in one go are three files of one message", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(pointer: coarse)", media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
    Object.defineProperty(navigator, "clipboard", { value: {}, configurable: true });
    let n = 0;
    const upload = vi.spyOn(api, "uploadChatAttachment").mockImplementation(async (f, name) => ({
      attachment: { id: `att_${++n}`, name, mime: f.type, bytes: f.size, createdAt: "", path: `/x/${n}` },
    }));
    render(<Box />);
    fireEvent.click(screen.getByRole("button", { name: "Attach a screenshot or file" }));
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent?.trim())).toEqual(["Choose photos", "Choose files"]);
    const shot = (name: string) => new File([new Uint8Array([0xff, 0xd8, 0xff])], name, { type: "image/jpeg" });
    fireEvent.change(screen.getByTestId("chat-attach-photos"), { target: { files: [shot("a.jpg"), shot("b.jpg"), shot("c.jpg")] } });
    await waitFor(() => expect(screen.getAllByTestId("chat-attach-item").map((e) => e.getAttribute("data-state"))).toEqual(["ready", "ready", "ready"]));
    expect(upload).toHaveBeenCalledTimes(3);
    expect(screen.getAllByTestId("chat-attach-remove")).toHaveLength(3);
  });

  it("Nothing to paste is a toast over the page that goes by itself", async () => {
    phone(async () => []);
    render(<Box />);
    fireEvent.click(screen.getByRole("button", { name: "Attach a screenshot or file" }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(screen.getByRole("menuitem", { name: "Paste a screenshot" }));
    const toast = await screen.findByTestId("words-paste-note");
    expect(toast.textContent).toMatch(/Nothing to paste/);
    expect(toast.className).toMatch(/\bfixed\b/);
    expect(toast.className).toMatch(/pointer-events-none/);
    await act(async () => void (await vi.advanceTimersByTimeAsync(PASTE_TOAST_MS + 50)));
    expect(screen.queryByTestId("words-paste-note")).toBeNull();
  });
});

describe("T18-S18 Notifications are on.", () => {
  it("shows once after turning them on, then goes", async () => {
    let sub: { endpoint: string; toJSON: () => unknown } | null = null;
    const reg = { pushManager: { getSubscription: async () => sub, subscribe: async () => (sub = { endpoint: "https://push.example/1", toJSON: () => ({ endpoint: "https://push.example/1" }) }) } };
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register: async () => reg, getRegistration: async () => reg, ready: Promise.resolve(reg) } });
    vi.stubGlobal("PushManager", function () {});
    vi.stubGlobal("Notification", { permission: "default", requestPermission: async () => "granted" });
    vi.spyOn(api, "getPush").mockResolvedValue({ configured: true, publicKey: "BAEC", devices: 0, endpoints: [], notifies: true });
    vi.spyOn(api, "subscribePush").mockResolvedValue({ ok: true });
    function Host() {
      const p = usePushToggle();
      return <div>{p.bell}{p.banner}</div>;
    }
    render(<Host />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn on notifications" }));
    expect((await screen.findByTestId("push-note")).textContent).toBe("Notifications are on.");
    await waitFor(() => expect(screen.getByTestId("push-bell")).toBeTruthy());
    await act(async () => void (await new Promise((r) => setTimeout(r, PUSH_NOTE_MS + 100))));
    expect(screen.queryByTestId("push-note")).toBeNull();
    expect(screen.queryByTestId("push-banner")).toBeNull(); // nothing left above the chat
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;
  }, PUSH_NOTE_MS + 5000);
});

describe("T18-S18 the chat box's 44 px rule", () => {
  it("only the box's own row of buttons is 44 px tall in Chat (never the pill or a file's remove cross)", () => {
    const css = readFileSync(path.resolve(__dirname, "../polish.css"), "utf8");
    expect(css).not.toMatch(/\[data-testid="chat-dock"\] button \{/);
    expect(css).toMatch(/\[data-testid="chat-dock"\] \[data-testid="words-tools"\] button \{ height: 44px/);
  });
});
