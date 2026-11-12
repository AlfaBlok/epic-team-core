// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { DeskChat } from "@/api";
import { ChatView } from "@/pages/Chat";
import { INTERRUPTED_TEXT, NoteEngine, type NoteClock, type NoteMedia, type NotesApi, type RecorderLike } from "./noteEngine";
import { parseVoiceNote } from "./VoiceNote";

// rework (the owner's review, 2026-11-02): voice notes in Chat. One button: tap to start, tap to finish; the timer and the
// level while recording; long notes go up in two-minute parts while he talks; the transcript lands in the chat as his message,
// labelled a voice note with its recording, the same way a WhatsApp voice note lands.

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

describe("T42-S12 the voice-note recorder", () => {
  it("tap to start, tap to finish: two-minute parts go up while he talks, then one note is posted", async () => {
    const f = fakes();
    const e = new NoteEngine(f.api, f.media, f.clock);
    await e.start("T42-S12");
    expect(e.view()).toMatchObject({ phase: "recording", elapsedS: 0 });
    await f.advance(30);
    expect(e.view()).toMatchObject({ elapsedS: 30, level: 0.5, estUsd: 0.0015 });
    await f.advance(95); // past the 120 s part: a new recorder starts before the old one stops (no gap), and part 0 uploads
    expect(f.recorders).toHaveLength(2);
    expect(f.recorders[1].started && f.recorders[0].stopped).toBe(true);
    expect(f.api.segment).toHaveBeenCalledTimes(1);
    expect(f.api.segment.mock.calls[0].slice(0, 2)).toEqual(["vn_1", 0]);
    expect(f.api.segment.mock.calls[0][3]).toBeCloseTo(120, 0);
    await f.advance(25);
    await act(async () => void (await e.finish()));
    expect(f.api.segment).toHaveBeenCalledTimes(2);
    expect(f.api.finish).toHaveBeenCalledWith("vn_1", 2, "T42-S12");
    expect(e.view()).toMatchObject({ phase: "sent", note: { seconds: 150, costUsd: 0.0075 } });
    expect(f.track.stop).toHaveBeenCalled();
  });

  it("the microphone stopping (a locked iPhone) keeps what was said and waits for Resume or Send", async () => {
    const f = fakes();
    const e = new NoteEngine(f.api, f.media, f.clock);
    await e.start();
    await f.advance(40);
    // iOS: the page hidden or the phone locked mutes the track.
    act(() => f.track.listeners.mute());
    expect(e.view()).toMatchObject({ phase: "paused", info: INTERRUPTED_TEXT, elapsedS: 40 });
    await act(async () => void (await e.resume()));
    expect(e.view().phase).toBe("recording");
    await f.advance(10);
    await act(async () => void (await e.finish()));
    expect(f.api.segment.mock.calls.map((c) => c[1])).toEqual([0, 1]);
    expect(f.api.finish).toHaveBeenCalledWith("vn_1", 2, undefined);
  });

  it("Discard throws the note away: the last part is never uploaded, so never transcribed or billed", async () => {
    const f = fakes();
    const e = new NoteEngine(f.api, f.media, f.clock);
    await e.start();
    await f.advance(6);
    await act(async () => void (await e.discard()));
    expect(f.api.discard).toHaveBeenCalledWith("vn_1");
    expect(f.api.segment).not.toHaveBeenCalled();
    expect(e.view().phase).toBe("idle");
  });

  it("sends itself at the cap; a refused microphone opens no note", async () => {
    const f = fakes();
    f.api.start.mockResolvedValueOnce({ note: { id: "vn_1" }, segmentS: 120, maxMin: 1, usdPerMin: 0.003, monthUsd: 0, monthCapUsd: 25 });
    const e = new NoteEngine(f.api, f.media, f.clock);
    await e.start();
    await waitFor(() => expect(e.view().maxMin).toBe(1));
    await f.advance(61);
    await waitFor(() => expect(f.api.finish).toHaveBeenCalled());
    const g = fakes();
    (g.media.microphone as any).mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    const e2 = new NoteEngine(g.api, g.media, g.clock);
    await e2.start();
    expect(e2.view().phase).toBe("failed");
    expect(e2.view().error).toMatch(/microphone is blocked/);
    // the note opens alongside the microphone; it is thrown away once open.
    await waitFor(() => expect(g.api.discard).toHaveBeenCalledWith("vn_1"));
  });
});

const chat = (messages: DeskChat["messages"]): DeskChat => ({ available: true, threadId: "th", session: 1, status: "idle", working: false, sending: 0, hasEarlier: false, messages }) as DeskChat;

describe("T42-S12 the button in Chat and the note in the chat", () => {
  it("one button by Send: tap to start shows the timer, level and cost; tap again sends and the chat reloads", async () => {
    const f = fakes();
    const load = vi.fn(async () => chat([]));
    render(
      <MemoryRouter>
        <ChatView who="Team desk" load={load} sendMessage={async () => ({ threadId: "th", pending: false })} placeholder="…" panel voiceNote={{ api: f.api, media: f.media, clock: f.clock, state: async () => ({ enabled: true, monthUsd: 0.2, limits: { monthCapUsd: 25 } }) }} />
      </MemoryRouter>,
    );
    const btn = await screen.findByTestId("note-button");
    expect(btn.getAttribute("aria-label")).toBe("Record a voice note");
    await act(async () => void fireEvent.click(btn));
    await waitFor(() => expect(screen.getByTestId("note-strip").dataset.phase).toBe("recording"));
    await f.advance(31);
    expect(screen.getByTestId("note-timer").textContent).toBe("0:31");
    expect(screen.getByTestId("note-level").getAttribute("aria-label")).toBe("input level 50%");
    expect(screen.getByTestId("note-cost").textContent).toContain("max 30 min");
    const loads = load.mock.calls.length;
    await act(async () => void fireEvent.click(screen.getByTestId("note-button")));
    await waitFor(() => expect(screen.getByTestId("note-sent").textContent).toMatch(/Voice note sent · 2:30 · \$0\.0075/));
    expect(f.api.finish).toHaveBeenCalledWith("vn_1", 1, undefined);
    expect(load.mock.calls.length).toBeGreaterThan(loads);
  });

  it("no voice in this chat (switched off, another world): no button", async () => {
    const f = fakes();
    render(
      <MemoryRouter>
        <ChatView who="Team desk" load={async () => chat([])} sendMessage={async () => ({ threadId: "th", pending: false })} placeholder="…" voiceNote={{ api: f.api, media: f.media, state: async () => ({ enabled: false }) }} />
      </MemoryRouter>,
    );
    await screen.findByLabelText("Message to the Team desk");
    await act(async () => await new Promise((r) => setTimeout(r, 0)));
    expect(screen.queryByTestId("note-button")).toBeNull();
  });

  it("a Chat voice note and a WhatsApp one land the same: his message, labelled a voice note, with its recording or its link", async () => {
    const chatNote = "🎙 Voice note (Chat), 2026-11-02 10:00Z · 2 min 31 s · $0.003 (gpt-4o-mini-transcribe) · vn_ab12cd34\nAudio: https://team.example.com/api/voice/notes/vn_ab12cd34/audio (2 parts)\n\nShip it today.";
    const waNote = "🎙 Voice note (WhatsApp → Memory), 2026-11-01 16:53Z\nMemory: Log/2026-11-01.md#^e-1 · https://github.com/x/y/blob/main/Log/2026-11-01.md\n\nAdd a row for voice notes.";
    expect(parseVoiceNote(chatNote)).toMatchObject({ source: "Chat", meta: "2 min 31 s · $0.003", audio: "/api/voice/notes/vn_ab12cd34/audio", parts: 2, words: "Ship it today." });
    expect(parseVoiceNote(waNote)).toMatchObject({ source: "WhatsApp → Memory", link: "https://github.com/x/y/blob/main/Log/2026-11-01.md", words: "Add a row for voice notes." });
    expect(parseVoiceNote("just text")).toBeUndefined();
    const at = new Date().toISOString();
    render(
      <MemoryRouter>
        <ChatView
          who="Team desk"
          load={async () =>
            chat([
              { id: "a", role: "user", kind: "message", status: "completed", text: chatNote, at },
              { id: "b", role: "user", kind: "message", status: "completed", text: waNote, at },
            ] as DeskChat["messages"])
          }
          sendMessage={async () => ({ threadId: "th", pending: false })}
          placeholder="…"
        />
      </MemoryRouter>,
    );
    const notes = await screen.findAllByTestId("chat-voice-note");
    expect(notes).toHaveLength(2);
    const labels = screen.getAllByTestId("chat-voice-note-label").map((l) => l.textContent);
    expect(labels[0]).toContain("Voice note · recorded in Chat");
    expect(labels[1]).toContain("Voice note · WhatsApp → Memory");
    const players = screen.getAllByTestId("chat-voice-note-audio");
    expect(players.map((p) => p.getAttribute("src"))).toEqual(["/api/voice/notes/vn_ab12cd34/audio?part=0", "/api/voice/notes/vn_ab12cd34/audio?part=1"]);
    expect(screen.getByText("The note in Memory").getAttribute("href")).toBe("https://github.com/x/y/blob/main/Log/2026-11-01.md");
    expect(screen.getByText("Ship it today.")).toBeTruthy();
  });
});
