// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { DeskChat } from "@/api";
import { ChatView } from "@/pages/Chat";
import { fetchNotesApi, type NoteClock, type NoteMedia, type NotesApi, type RecorderLike } from "./noteEngine";
import { postingFor } from "./VoiceNote";

// (the owner: "why is it so slow to send a message? I am always afraid, will it be sent?"):
// a chat note is Sent the moment its audio is safe on the console (the finish answers `accepted`, before any words
// are written); the chat says "✓ Sent" at once, his words fill in when the console posts them, and the page tells
// the console how long tap stop to Sent took, for its 3-second check.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function fakes() {
  const clock = { t: 1_000_000, ticks: [] as (() => void)[] };
  const c: NoteClock = {
    now: () => clock.t,
    every: (_ms, fn) => {
      clock.ticks.push(fn);
      return () => (clock.ticks = clock.ticks.filter((f) => f !== fn));
    },
  };
  const track: any = { stop: vi.fn(), readyState: "live", muted: false, addEventListener: () => undefined };
  const stream: any = { getAudioTracks: () => [track], getTracks: () => [track] };
  const media: NoteMedia = {
    microphone: vi.fn(async () => stream),
    recorder: () => {
      const r: any = {
        mimeType: "audio/webm;codecs=opus",
        ondataavailable: null,
        onstop: null,
        start: () => undefined,
        stop: () =>
          queueMicrotask(() => {
            r.ondataavailable?.({ data: new Blob(["part"], { type: "audio/webm" }) });
            r.onstop?.();
          }),
      };
      return r as RecorderLike;
    },
    level: () => ({ read: () => 0.5, close: () => undefined }),
  };
  const api = {
    start: vi.fn(async () => ({ note: { id: "vn_1" }, segmentS: 120, maxMin: 30, usdPerMin: 0.003, monthUsd: 0.2, monthCapUsd: 25 })),
    // the part is stored and answered before its words exist (x-quick)
    segment: vi.fn(async (_id: string, n: number) => ({ segment: { n, text: "", costUsd: 0 }, note: { costUsd: 0 } })),
    finish: vi.fn(async (_id: string, segments: number) => ({ note: { id: "vn_1", state: "recording", seconds: 7, costUsd: 0, segments, acceptedAt: "2026-11-18T18:00:00.000Z" }, accepted: true })),
    discard: vi.fn(async () => ({})),
    timing: vi.fn(async () => ({})),
  } satisfies NotesApi;
  const advance = async (s: number) => {
    for (let i = 0; i < s * 4; i++) {
      clock.t += 250;
      for (const f of [...clock.ticks]) f();
    }
    await act(async () => await new Promise((r) => setTimeout(r, 0)));
  };
  return { clock: c, media, api, advance };
}

const chat = (messages: DeskChat["messages"]): DeskChat => ({ available: true, threadId: "th", session: 1, status: "idle", working: false, sending: 0, hasEarlier: false, messages }) as DeskChat;
const voiceOn = async () => ({ enabled: true, monthUsd: 0.2, limits: { monthCapUsd: 25 } });

describe("a voice note is Sent in seconds", () => {
  it("shows ✓ Sent as soon as the console has the audio, before the words, and reports tap stop to Sent", async () => {
    const f = fakes();
    let messages: DeskChat["messages"] = [];
    const load = vi.fn(async () => chat(messages));
    render(
      <MemoryRouter>
        <ChatView who="Team desk" load={load} sendMessage={async () => ({ threadId: "th", pending: false })} placeholder="…" panel voiceNote={{ api: f.api, media: f.media, clock: f.clock, state: voiceOn }} />
      </MemoryRouter>,
    );
    const mic = await screen.findByTestId("note-button", {}, { timeout: 5000 });
    await act(async () => void fireEvent.click(mic));
    await waitFor(() => expect(screen.getByTestId("note-strip").dataset.phase).toBe("recording"));
    await f.advance(7);
    await act(async () => void fireEvent.click(screen.getByTestId("note-button")));
    await waitFor(() => expect(screen.getByTestId("chat-voice-posting").dataset.state).toBe("safe"));
    expect(screen.getByTestId("chat-voice-posting-state").textContent).toContain("✓ Sent");
    expect(screen.queryByTestId("chat-voice-posting-words")).toBeNull();
    expect(screen.getByTestId("note-sent").textContent).toContain("✓ Voice note sent");
    expect(f.api.timing).toHaveBeenCalledWith("vn_1", expect.any(Number));
    // the console posts his words: the transcript holds the note and the bubble goes
    messages = [{ id: "m1", role: "user", text: "🎙 Voice note (Chat), 2026-11-18 18:00Z · 0 min 07 s · $0.0004 (gpt-4o-mini-transcribe) · vn_1\nAudio: /api/voice/notes/vn_1/audio\n\nhello desk", at: new Date().toISOString(), status: "completed" }] as DeskChat["messages"];
    await act(async () => void (await load()));
    await waitFor(() => expect(screen.queryByTestId("chat-voice-posting")).toBeNull(), { timeout: 4000 });
  });

  it("an accepted note without words is the safe bubble; one with words is sent", () => {
    const v = (note: object) => ({ phase: "sent", elapsedS: 7, note }) as never;
    expect(postingFor(undefined, v({ id: "vn_2", state: "recording", seconds: 7, costUsd: 0, segments: 1, acceptedAt: "x" }), 5)).toEqual({ at: 5, seconds: 7, state: "safe", id: "vn_2" });
    expect(postingFor(undefined, v({ id: "vn_2", state: "posted", seconds: 7, costUsd: 0, segments: 1, acceptedAt: "x", transcript: "hi" }), 5)?.state).toBe("sent");
  });

  it("the page asks for quick parts and a quick finish on a chat note, never on a card's answer", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response(JSON.stringify({ note: { id: "vn_3" } }), { status: 200 }))) as unknown as typeof fetch;
    const chatApi = fetchNotesApi("/api/voice", f);
    await chatApi.segment("vn_3", 0, new Blob(["a"], { type: "audio/webm" }), 3);
    await chatApi.finish("vn_3", 1);
    await chatApi.timing!("vn_3", 812.4);
    expect((calls[0].init.headers as Record<string, string>)["x-quick"]).toBe("1");
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ segments: 1, quick: true });
    expect(calls[2].url).toBe("/api/voice/notes/vn_3/timing");
    expect(JSON.parse(String(calls[2].init.body))).toEqual({ sentMs: 812 });
    const cardApi = fetchNotesApi("/api/voice", f, { fill: true });
    await cardApi.finish("vn_3", 1);
    expect(JSON.parse(String(calls[3].init.body))).toEqual({ segments: 1, fill: true });
  });
});
