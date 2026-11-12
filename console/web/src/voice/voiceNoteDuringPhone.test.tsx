// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { DeskChat } from "@/api";
import { ChatView } from "@/pages/Chat";
import { MIC_BUSY_TEXT, micError, NoteEngine, type NoteClock, type NoteMedia, type NotesApi, type RecorderLike } from "./noteEngine";

// (the owner 2026-11-09, WhatsApp voice note: "The message I got was, I can't record messages during a phone call. And then
// I click OK, and then the next time I can."): a microphone a call holds is said plainly, the button stays ready, and the next
// press once the call is over records with no second error.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** What Chrome throws while a phone call holds the microphone. */
const onACall = () => Object.assign(new Error("Could not start audio source"), { name: "NotReadableError" });

function fakes() {
  const clock = { t: 1_000_000, ticks: [] as (() => void)[] };
  const c: NoteClock = {
    now: () => clock.t,
    every: (_ms, fn) => {
      clock.ticks.push(fn);
      return () => (clock.ticks = clock.ticks.filter((f) => f !== fn));
    },
  };
  const track: any = { stop: vi.fn(), readyState: "live", muted: false, listeners: {} as Record<string, () => void>, addEventListener: (e: string, f: () => void) => (track.listeners[e] = f) };
  const stream: any = { getAudioTracks: () => [track], getTracks: () => [track] };
  const recorders: (RecorderLike & { started: boolean })[] = [];
  const media: NoteMedia = {
    microphone: vi.fn(async () => stream),
    recorder: () => {
      const r: any = {
        mimeType: "audio/webm;codecs=opus",
        started: false,
        ondataavailable: null,
        onstop: null,
        start: () => (r.started = true),
        stop: () => queueMicrotask(() => (r.ondataavailable?.({ data: new Blob(["x"], { type: "audio/webm" }) }), r.onstop?.())),
      };
      recorders.push(r);
      return r;
    },
  };
  const api = {
    start: vi.fn(async () => ({ note: { id: "vn_1" }, segmentS: 120, maxMin: 30, usdPerMin: 0.003, monthUsd: 0.2, monthCapUsd: 25 })),
    segment: vi.fn(async (_id: string, n: number) => ({ segment: { n, text: `t${n}`, costUsd: 0.001 }, note: { costUsd: 0.001 } })),
    finish: vi.fn(async (_id: string, segments: number) => ({ note: { id: "vn_1", state: "posted", seconds: 5, costUsd: 0.001, segments } })),
    discard: vi.fn(async () => ({})),
  } satisfies NotesApi;
  return { clock, c, media, api, recorders, track };
}

describe("T42-S45 a voice note during a phone call", () => {
  it("names a held microphone plainly, whatever the browser calls it", () => {
    expect(micError(onACall())).toBe(MIC_BUSY_TEXT);
    expect(micError(Object.assign(new Error("Concurrent mic process limit."), { name: "AbortError" }))).toBe(MIC_BUSY_TEXT);
    expect(micError(new Error("Requested device is in use"))).toBe(MIC_BUSY_TEXT);
    expect(micError(Object.assign(new Error("x"), { name: "NotAllowedError" }))).toMatch(/blocked for this page/);
    expect(MIC_BUSY_TEXT).toMatch(/You're on a call/);
  });

  it("during the call: the plain message, nothing left open; after the call the next press records, no second error", async () => {
    const f = fakes();
    (f.media.microphone as any).mockRejectedValueOnce(onACall());
    const e = new NoteEngine(f.api, f.media, f.c);
    await e.start();
    expect(e.view()).toMatchObject({ phase: "failed", error: MIC_BUSY_TEXT });
    await waitFor(() => expect(f.api.discard).toHaveBeenCalledWith("vn_1"));
    // The call is over: one press, recording.
    await e.start();
    expect(e.view().phase).toBe("recording");
    expect(e.view().error).toBeUndefined();
    expect(f.recorders.at(-1)!.started).toBe(true);
  });

  it("a call in the middle of a note pauses it (kept); Resume while still on the call says so and stays paused, then goes on", async () => {
    const f = fakes();
    const e = new NoteEngine(f.api, f.media, f.c);
    await e.start();
    f.track.listeners.ended();
    expect(e.view().phase).toBe("paused");
    expect(e.view().info).toMatch(/a call came in/);
    (f.media.microphone as any).mockRejectedValueOnce(onACall());
    await e.resume();
    expect(e.view()).toMatchObject({ phase: "paused", error: MIC_BUSY_TEXT });
    await e.resume();
    expect(e.view().phase).toBe("recording");
    expect(e.view().error).toBeUndefined();
  });

  it("in Chat: the message shows by the button, which stays ready; the next press records", async () => {
    const f = fakes();
    (f.media.microphone as any).mockRejectedValueOnce(onACall());
    const chat = { available: true, threadId: "th", session: 1, status: "idle", working: false, sending: 0, hasEarlier: false, messages: [] } as unknown as DeskChat;
    render(
      <MemoryRouter>
        <ChatView who="Team desk" load={async () => chat} sendMessage={async () => ({ threadId: "th", pending: false })} placeholder="…" panel voiceNote={{ api: f.api, media: f.media, clock: f.c, state: async () => ({ enabled: true, monthUsd: 0.2, limits: { monthCapUsd: 25 } }) }} />
      </MemoryRouter>,
    );
    const btn = await screen.findByTestId("note-button");
    await act(async () => void fireEvent.click(btn));
    const msg = await screen.findByTestId("note-error");
    expect(msg.textContent).toBe(MIC_BUSY_TEXT);
    expect(msg.className).not.toMatch(/destructive/);
    expect(screen.queryByTestId("note-again")).toBeNull();
    const again = screen.getByTestId("note-button");
    expect(again.hasAttribute("disabled")).toBe(false);
    await act(async () => void fireEvent.click(again));
    await waitFor(() => expect(screen.getByTestId("note-strip").getAttribute("data-phase")).toBe("recording"));
    expect(screen.queryByTestId("note-error")).toBeNull();
  });
});
