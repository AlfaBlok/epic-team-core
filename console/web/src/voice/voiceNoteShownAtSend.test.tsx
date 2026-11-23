// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { DeskChat } from "@/api";
import { ChatView } from "@/pages/Chat";
import { KEPT_FAILED_TEXT, type NoteClock, type NoteMedia, type NotesApi, type RecorderLike } from "./noteEngine";
import { postingFor } from "./VoiceNote";

// a short voice note waited 2 to 5 s after Send, because its words are written inside the
// last part's upload. Its audio is already safe on the phone, so the chat now shows the note the moment he taps Send
// ("writing out your words…"), fills in his words once written, and lets the bubble go when the transcript holds it.

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
  const recorders: (RecorderLike & { started: boolean; stopped: boolean })[] = [];
  const track: any = { stop: vi.fn(), readyState: "live", muted: false, listeners: {} as Record<string, () => void>, addEventListener: (e: string, f: () => void) => (track.listeners[e] = f) };
  const stream: any = { getAudioTracks: () => [track], getTracks: () => [track] };
  const media: NoteMedia = {
    microphone: vi.fn(async () => stream),
    recorder: () => {
      const r: any = {
        mimeType: "audio/webm;codecs=opus",
        started: false,
        stopped: false,
        ondataavailable: null,
        onstop: null,
        start: () => (r.started = true),
        stop: () => {
          r.stopped = true;
          queueMicrotask(() => {
            r.ondataavailable?.({ data: new Blob([`part${recorders.indexOf(r)}`], { type: "audio/webm" }) });
            r.onstop?.();
          });
        },
      };
      recorders.push(r);
      return r;
    },
    level: () => ({ read: () => 0.5, close: () => undefined }),
  };
  const api = {
    start: vi.fn(async () => ({ note: { id: "vn_1" }, segmentS: 120, maxMin: 30, usdPerMin: 0.003, monthUsd: 0.2, monthCapUsd: 25 })),
    segment: vi.fn(async (_id: string, n: number, _audio?: Blob, _seconds?: number) => ({ segment: { n, text: `t${n}`, costUsd: 0.006 }, note: { costUsd: 0.006 * (n + 1) } })),
    finish: vi.fn(async (_id: string, segments: number) => ({ note: { id: "vn_1", state: "posted", seconds: 150, costUsd: 0.0075, segments } })),
    discard: vi.fn(async () => ({})),
  } satisfies NotesApi;
  const advance = async (s: number) => {
    for (let i = 0; i < s * 4; i++) {
      clock.t += 250;
      for (const f of [...clock.ticks]) f();
    }
    await act(async () => await new Promise((r) => setTimeout(r, 0)));
  };
  return { clock: c, media, api, recorders, track, advance };
}


const chat = (messages: DeskChat["messages"]): DeskChat => ({ available: true, threadId: "th", session: 1, status: "idle", working: false, sending: 0, hasEarlier: false, messages }) as DeskChat;
const voiceOn = async () => ({ enabled: true, monthUsd: 0.2, limits: { monthCapUsd: 25 } });

describe("a voice note shows in the chat the moment he taps Send", () => {
  it("the bubble is there before the words are written, then fills in, then leaves once the transcript holds the note", async () => {
    const f = fakes();
    // the last part's upload is where the console writes his words: held open here until the test lets it go
    let release!: () => void;
    const written = new Promise<void>((ok) => (release = ok));
    f.api.segment.mockImplementation(async (_id: string, n: number) => {
      await written;
      return { segment: { n, text: "hello desk", costUsd: 0.0004 }, note: { costUsd: 0.0004 } };
    });
    f.api.finish.mockImplementation(async (_id: string, segments: number) => ({ note: { id: "vn_1", state: "posted", seconds: 7, costUsd: 0.0004, segments, transcript: "hello desk" } }) as never);
    let messages: DeskChat["messages"] = [];
    const load = vi.fn(async () => chat(messages));
    render(
      <MemoryRouter>
        <ChatView who="Team desk" load={load} sendMessage={async () => ({ threadId: "th", pending: false })} placeholder="…" panel voiceNote={{ api: f.api, media: f.media, clock: f.clock, state: voiceOn }} />
      </MemoryRouter>,
    );
    const mic = await screen.findByTestId("note-button");
    await act(async () => void fireEvent.click(mic));
    await waitFor(() => expect(screen.getByTestId("note-strip").dataset.phase).toBe("recording"));
    await f.advance(7);
    expect(screen.queryByTestId("chat-voice-posting")).toBeNull();
    await act(async () => void fireEvent.click(screen.getByTestId("note-button")));
    // shown at once, while the words are still being written
    const b = await screen.findByTestId("chat-voice-posting");
    expect(b.dataset.state).toBe("writing");
    expect(b.textContent).toContain("Voice note · 0:07");
    expect(screen.getByTestId("chat-voice-posting-state").textContent).toBe("Sending…");
    expect(f.api.finish).not.toHaveBeenCalled();
    // the words come: they fill in on the same bubble
    await act(async () => release());
    await waitFor(() => expect(screen.getByTestId("chat-voice-posting").dataset.state).toBe("sent"));
    expect(screen.getByTestId("chat-voice-posting-words").textContent).toBe("hello desk");
    // the transcript holds the note (its head line names vn_1): the bubble goes, the real message stays
    messages = [{ id: "m1", role: "user", text: "🎙 Voice note (Chat), 2026-11-15 02:00Z · 0:07 · $0.0004 (gpt-4o-mini-transcribe) · vn_1\nAudio: /api/voice/notes/vn_1/audio\n\nhello desk", at: new Date().toISOString(), status: "completed" }] as DeskChat["messages"];
    await act(async () => void (await load()));
    await waitFor(() => expect(screen.queryByTestId("chat-voice-posting")).toBeNull(), { timeout: 4000 });
    expect(screen.getByTestId("chat-voice-note").textContent).toContain("hello desk");
  });

  it("a note with nothing heard leaves no bubble", async () => {
    const f = fakes();
    f.api.finish.mockImplementation(async (_id: string, segments: number) => ({ note: { id: "vn_1", state: "empty", seconds: 3, costUsd: 0, segments } }));
    render(
      <MemoryRouter>
        <ChatView who="Team desk" load={async () => chat([])} sendMessage={async () => ({ threadId: "th", pending: false })} placeholder="…" panel voiceNote={{ api: f.api, media: f.media, clock: f.clock, state: voiceOn }} />
      </MemoryRouter>,
    );
    const mic = await screen.findByTestId("note-button");
    await act(async () => void fireEvent.click(mic));
    await waitFor(() => expect(screen.getByTestId("note-strip").dataset.phase).toBe("recording"));
    await f.advance(3);
    await act(async () => void fireEvent.click(screen.getByTestId("note-button")));
    await waitFor(() => expect(screen.getByTestId("note-strip").dataset.phase).toBe("sent"));
    expect(screen.queryByTestId("chat-voice-posting")).toBeNull();
  });
});

describe("the bubble's state for each phase", () => {
  const view = (phase: string, more: object = {}) => ({ phase, elapsedS: 7, ...more }) as never;
  it("sending shows it, kept says it sends by itself, a sent note keeps its Send time and gets its words", () => {
    const w = postingFor(undefined, view("sending"), 100);
    expect(w).toEqual({ at: 100, seconds: 7, state: "writing" });
    expect(postingFor(w, view("failed", { info: KEPT_FAILED_TEXT }), 200)?.state).toBe("kept");
    expect(postingFor(w, view("failed", { error: "Not sent: x" }), 200)?.state).toBe("failed");
    const s = postingFor(w, view("sent", { note: { id: "vn_9", state: "posted", seconds: 8, costUsd: 0, segments: 1, transcript: " hi " } }), 300);
    expect(s).toEqual({ at: 100, seconds: 8, state: "sent", id: "vn_9", words: "hi" });
    // a new note started (or the strip closed): a sent bubble stays until the chat shows it, a failed one goes
    expect(postingFor(s, view("idle"), 400)).toBe(s);
    expect(postingFor({ ...w!, state: "kept" }, view("idle"), 400)).toBeUndefined();
  });
});
