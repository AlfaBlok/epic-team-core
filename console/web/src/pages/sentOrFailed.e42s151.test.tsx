// @vitest-environment jsdom
// (his 22 Nov 03:22Z desk chat: "screenshots and imafges i paste but dont seem to be sent :((((why????"):
// every message of his the desk's chat holds shows Sent (pasted images too); a voice note it lacks sits where he sent
// it, never under his newer messages, and says why with Send again.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api, type DeskChat, type DeskMessage } from "@/api";
import { ChatPage, forgetChats, noteWhy, notesInTime, SENT_MARK } from "@/pages/Chat";

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
  Element.prototype.scrollIntoView = vi.fn();
});

const msg = (over: Partial<DeskMessage> & Pick<DeskMessage, "id" | "role" | "text">): DeskMessage => ({ kind: "message", status: "completed", at: new Date().toISOString(), ...over });
const IMAGE = "screenshots i paste\n\n📎 Attachments (1): Sam attached this file to his message.\n- image.png · image/png · 289 KB · https://team.example.com/api/chat/attachments/att_0758963e7a3f/image.png\n  read: https://team.example.com/api/chat/attachments/att_0758963e7a3f/agent/image.png";
const chat = (over: Partial<DeskChat> = {}): DeskChat => ({
  available: true,
  threadId: "th_desk",
  environmentId: "env_1",
  session: 1,
  status: "idle",
  working: false,
  sending: 0,
  hasEarlier: false,
  messages: [
    { id: "s1", role: "user", kind: "seed", text: "", status: "completed", session: 1 },
    msg({ id: "a1", role: "assistant", text: "Team desk ready.", at: "2026-11-22T03:00:00Z" }),
    msg({ id: "u1", role: "user", text: IMAGE, at: "2026-11-22T03:22:10Z" }),
    msg({ id: "a2", role: "assistant", text: "Got it.", at: "2026-11-22T03:22:40Z" }),
  ],
  ...over,
});
const renderChat = () =>
  render(
    <MemoryRouter initialEntries={["/chat"]}>
      <Routes>
        <Route path="/chat" element={<ChatPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe("every pasted image shows sent or failed", () => {
  it("his message with a pasted image, once in the desk's chat, shows ✓ Sent under it with the picture", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(chat());
    renderChat();
    const mine = await screen.findByTestId("chat-user");
    expect(within(mine).getByTestId("chat-file-image")).toBeTruthy();
    expect(within(mine).getByTestId("chat-sent-mark").textContent).toContain(SENT_MARK);
    // the desk's replies carry no Sent mark
    for (const a of screen.getAllByTestId("chat-assistant")) expect(within(a).queryByTestId("chat-sent-mark")).toBeNull();
  });

  it("a voice note the chat lacks sits where he sent it, not under his newer image message, and says why", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(
      chat({
        t3: "restarting",
        undeliveredNotes: [{ id: "vn_0000aaaa", at: "2026-11-22T03:07:18Z", text: "Can you dispatch Fable", state: "retrying" }],
      }),
    );
    renderChat();
    const note = await screen.findByTestId("chat-undelivered-note");
    const items = Array.from(screen.getByTestId("chat-transcript").children);
    const at = items.indexOf(note);
    const image = items.indexOf(screen.getByTestId("chat-user"));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(image); // the newest bubble at the bottom is his Sent image, not a red note
    expect(within(note).getByTestId("chat-undelivered-why").textContent).toContain("T3 is restarting");
    expect(within(note).getByTestId("chat-undelivered-retry")).toBeTruthy();
  });

  it("Send again re-sends the note now and says Sent when the desk's chat took it", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(chat({ undeliveredNotes: [{ id: "vn_0000aaaa", at: "2026-11-22T03:07:18Z", text: "Can you dispatch Fable", state: "retrying" }] }));
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ delivered: true, note: { id: "vn_0000aaaa" } }), { status: 200, headers: { "content-type": "application/json" } }));
    renderChat();
    fireEvent.click(await screen.findByTestId("chat-undelivered-retry"));
    await waitFor(() => expect(screen.getByTestId("chat-undelivered-said").textContent).toBe(SENT_MARK));
    const call = f.mock.calls.find((c) => String(c[0]).endsWith("/redeliver"));
    expect(String(call?.[0])).toBe("/api/voice/notes/vn_0000aaaa/redeliver");
    expect((call?.[1] as RequestInit).method).toBe("POST");
  });

  it("a failed Send again says why, never quietly", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(chat({ undeliveredNotes: [{ id: "vn_1", at: "2026-11-22T03:07:18Z", text: "x", state: "failed" }] }));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => (String(u).endsWith("/redeliver") ? new Response(JSON.stringify({ error: { message: "voice note vn_1 is transcribed" } }), { status: 409 }) : new Response("{}", { status: 200 })));
    renderChat();
    fireEvent.click(await screen.findByTestId("chat-undelivered-retry"));
    await waitFor(() => expect(screen.getByTestId("chat-undelivered-said").textContent).toBe("Could not send it again: voice note vn_1 is transcribed"));
  });

  it("noteWhy: the console's reason first, then T3's state, then a plain default", () => {
    expect(noteWhy("not delivered yet, retrying (T3 is down: the console holds it and sends it once T3 is back)")).toBe("T3 is down: the console holds it and sends it once T3 is back");
    expect(noteWhy("not delivered yet, retrying", "maintenance")).toBe("T3 is down for planned maintenance");
    expect(noteWhy(undefined)).toBe("The desk's chat has not taken it yet");
  });

  it("notesInTime: each note after the last message at or before it", () => {
    const m = [
      { id: "a", at: "2026-11-22T03:00:00Z" },
      { id: "b", at: "2026-11-22T03:10:00Z" },
    ];
    const r = notesInTime([{ at: "2026-11-22T02:59:00Z" }, { at: "2026-11-22T03:07:00Z" }, { at: "2026-11-22T03:30:00Z" }], m);
    expect(r.get("")?.length).toBe(1);
    expect(r.get("a")?.length).toBe(1);
    expect(r.get("b")?.length).toBe(1);
  });
});
