// @vitest-environment jsdom
import { forgetWorld } from "@/lib/useSocial";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api, type DeskChat, type DeskMessage } from "@/api";
import { ChatPage, forgetChats } from "@/pages/Chat";
import { splitAttachments, takesFile } from "@/components/ChatAttach";

/**
 * screenshots and files in Chat. The paperclip by the voice note uploads each file at once and shows its thumbnail;
 * Send carries the ids with the text; the sent message shows the files again (tap an image to open it full size).
 */
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => {
  forgetChats();
  forgetWorld();
  Element.prototype.scrollIntoView = vi.fn();
});

const msg = (over: Partial<DeskMessage> & Pick<DeskMessage, "id" | "role" | "text">): DeskMessage => ({ kind: "message", status: "completed", at: new Date().toISOString(), ...over });
const chat = (messages: DeskMessage[] = []): DeskChat => ({ available: true, threadId: "th", environmentId: "env", session: 1, status: "idle", working: false, sending: 0, hasEarlier: false, messages });
const renderChat = () =>
  render(
    <MemoryRouter initialEntries={["/chat"]}>
      <Routes>
        <Route path="/chat" element={<ChatPage />} />
      </Routes>
    </MemoryRouter>,
  );
const png = (name = "shot.png") => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });
const BLOCK = [
  "look at the button",
  "",
  "📎 Attachments (2): Sam attached these files to his message. Open each one before you answer: download it …",
  "- IMG_0042.png · image/png · 240 KB · https://console.example.com/api/chat/attachments/att_1/IMG_0042.png",
  "- notes.pdf · application/pdf · 1.2 MB · https://console.example.com/api/chat/attachments/att_2/notes.pdf",
].join("\n");

describe("T18-S11 files in Chat", () => {
  it("reads the console's block back into his words and the files (same-origin paths)", () => {
    const s = splitAttachments(BLOCK);
    expect(s.text).toBe("look at the button");
    expect(s.files).toEqual([
      { name: "IMG_0042.png", mime: "image/png", size: "240 KB", href: "/api/chat/attachments/att_1/IMG_0042.png" },
      { name: "notes.pdf", mime: "application/pdf", size: "1.2 MB", href: "/api/chat/attachments/att_2/notes.pdf" },
    ]);
    expect(splitAttachments("plain text")).toEqual({ text: "plain text", files: [] });
    expect(takesFile({ type: "image/png", name: "a.png" })).toBe(true);
    expect(takesFile({ type: "", name: "Report.PDF" })).toBe(true);
    expect(takesFile({ type: "application/x-msdownload", name: "setup.exe" })).toBe(false);
    expect(takesFile({ type: "image/svg+xml", name: "x.svg" })).toBe(false);
  });

  it("attaches a screenshot: thumbnail, remove one, send with the text, the tray empties", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(chat());
    let n = 0;
    const upload = vi.spyOn(api, "uploadChatAttachment").mockImplementation(async (f, name) => ({
      attachment: { id: `att_${++n}`, name, mime: f.type, bytes: f.size, createdAt: "", path: `/api/chat/attachments/att_${n}/${name}` },
    }));
    const send = vi.spyOn(api, "sendDeskMessage").mockResolvedValue({ threadId: "th", pending: false });
    renderChat();
    const pick = (await screen.findByTestId("chat-attach-input")) as HTMLInputElement;
    expect(screen.getByRole("button", { name: "Attach a screenshot or file" })).toBeTruthy();
    expect(pick.accept).toContain("image/*");
    fireEvent.change(pick, { target: { files: [png("a.png"), png("b.png")] } });
    await waitFor(() => expect(screen.getAllByTestId("chat-attach-item").map((e) => e.getAttribute("data-state"))).toEqual(["ready", "ready"]));
    expect(upload).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Remove a.png" }));
    expect(screen.getAllByTestId("chat-attach-item")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Message to the Team desk"), { target: { value: "this one" } });
    fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
    await waitFor(() => expect(send).toHaveBeenCalledWith("this one", undefined, expect.stringMatching(/^chat-/), ["att_2"]));
    await waitFor(() => expect(screen.queryByTestId("chat-attach-tray")).toBeNull());
  });

  it("a screenshot alone can be sent (no text), and a refused file never uploads", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(chat());
    const upload = vi.spyOn(api, "uploadChatAttachment").mockResolvedValue({ attachment: { id: "att_9", name: "s.png", mime: "image/png", bytes: 4, createdAt: "", path: "/x" } });
    const send = vi.spyOn(api, "sendDeskMessage").mockResolvedValue({ threadId: "th", pending: false });
    renderChat();
    const pick = (await screen.findByTestId("chat-attach-input")) as HTMLInputElement;
    const sendBtn = screen.getByRole("button", { name: /^Send$/ }) as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
    fireEvent.change(pick, { target: { files: [new File(["MZ"], "setup.exe", { type: "application/x-msdownload" })] } });
    expect((await screen.findByTestId("chat-attach-error")).textContent).toContain("Chat takes");
    expect(upload).not.toHaveBeenCalled();
    expect(sendBtn.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove setup.exe" }));
    fireEvent.change(pick, { target: { files: [png("s.png")] } });
    await waitFor(() => expect(sendBtn.disabled).toBe(false));
    fireEvent.click(sendBtn);
    await waitFor(() => expect(send).toHaveBeenCalledWith("", undefined, expect.any(String), ["att_9"]));
  });

  it("a pasted screenshot is attached", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(chat());
    const upload = vi.spyOn(api, "uploadChatAttachment").mockResolvedValue({ attachment: { id: "att_p", name: "image.png", mime: "image/png", bytes: 4, createdAt: "", path: "/x" } });
    renderChat();
    const box = await screen.findByLabelText("Message to the Team desk");
    fireEvent.paste(box, { clipboardData: { files: [png("image.png")], getData: () => "" } });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
  });

  it("the history shows his files under his words; tapping an image opens it full size", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(chat([msg({ id: "u1", role: "user", text: BLOCK })]));
    renderChat();
    const bubble = await screen.findByTestId("chat-user");
    expect(bubble.textContent).toContain("look at the button");
    expect(bubble.textContent).not.toContain("📎");
    const img = within(bubble).getByRole("img", { name: "IMG_0042.png" }) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/api/chat/attachments/att_1/IMG_0042.png");
    expect((within(bubble).getByTestId("chat-file") as HTMLAnchorElement).getAttribute("href")).toBe("/api/chat/attachments/att_2/notes.pdf");
    fireEvent.click(within(bubble).getByRole("button", { name: "Open IMG_0042.png" }));
    const viewer = screen.getByTestId("chat-file-viewer");
    expect(within(viewer).getByRole("img", { name: "IMG_0042.png" })).toBeTruthy();
    fireEvent.click(viewer);
    expect(screen.queryByTestId("chat-file-viewer")).toBeNull();
  });
});
