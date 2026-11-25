// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { NoteMedia, NotesApi } from "./noteEngine";
import { clearAnswerVoiceState, useAnswerVoice } from "./AnswerVoice";
import { NoteProvider, NoteTab, NoteWidget } from "./NoteProvider";

// (the owner 2026-11-15 03:16Z, vn_5ef65752): "if I'm recording a voice note and it goes out of the screen
// ... the voice note should kind of stay the red thing where I have the timing and the voice bar. That part should stay visible
// when I scroll down". While a card's note records and its strip leaves the screen, the floating pill (red dot, time, level,
// Cancel, Send) shows at the bottom. 2026-11-25 15:27Z (vn_c9beca39): "it should show immediately": the pill shows from the
// press on, with no scroll, while the note is on. The pill's link scrolls back to the card.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearAnswerVoiceState();
});

/** IntersectionObserver as the browser runs it: `seen(false)` is the strip scrolled off screen. */
function viewport() {
  const live: { cb: IntersectionObserverCallback; el?: Element }[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      o: { cb: IntersectionObserverCallback; el?: Element };
      constructor(cb: IntersectionObserverCallback) {
        this.o = { cb };
        live.push(this.o);
      }
      observe(el: Element) {
        this.o.el = el;
      }
      disconnect() {
        live.splice(live.indexOf(this.o), 1);
      }
      unobserve() {}
    },
  );
  return {
    watching: () => live.filter((o) => o.el).length,
    seen: (on: boolean) =>
      act(() => {
        for (const o of [...live]) o.cb([{ isIntersecting: on, target: o.el } as IntersectionObserverEntry], {} as IntersectionObserver);
      }),
  };
}

function fakes() {
  const track: any = { stop: () => undefined, readyState: "live", muted: false, addEventListener: () => undefined };
  const stream: any = { getAudioTracks: () => [track], getTracks: () => [track] };
  const media: NoteMedia = {
    microphone: async () => stream,
    recorder: () => ({ mimeType: "audio/webm;codecs=opus", ondataavailable: null, onstop: null, start: () => undefined, stop: () => undefined }) as never,
  };
  const api = {
    start: vi.fn(async () => ({ note: { id: "vn_1" }, segmentS: 120, maxMin: 30, usdPerMin: 0.003, monthUsd: 0.2, monthCapUsd: 25 })),
    segment: vi.fn(async (_id: string, n: number) => ({ segment: { n, text: `t${n}`, costUsd: 0.001 }, note: { costUsd: 0.001 } })),
    finish: vi.fn(async (_id: string, segments: number) => ({ note: { id: "vn_1", state: "posted", seconds: 5, costUsd: 0.001, segments } })),
    discard: vi.fn(async () => ({})),
  } satisfies NotesApi;
  return { media, api };
}

function Card({ f }: { f: ReturnType<typeof fakes> }) {
  const voice = useAnswerVoice({
    origin: "review:r1:changes",
    to: "The card",
    page: "card r1",
    typed: "",
    deliver: async () => undefined,
    api: f.api,
    media: f.media,
    state: async () => ({ enabled: true, monthUsd: 0.2, limits: { monthCapUsd: 25 } }),
    big: true,
  });
  return (
    <article>
      {voice.button}
      {voice.strip}
    </article>
  );
}

describe("the owner 2026-11-15: the recording bar stays on screen", () => {
  it("pressing Voice on a card floats the pill at once, with no scroll, and it stays while recording", async () => {
    // (the owner 2026-11-25 15:27Z, vn_c9beca39): "it should show immediately ... the floating pane at the bottom, whenever
    // we're recording, should just go on"
    const vp = viewport();
    const f = fakes();
    render(
      <NoteProvider tab={new NoteTab()}>
        <MemoryRouter initialEntries={["/inbox"]}>
          <Card f={f} />
          <NoteWidget />
        </MemoryRouter>
      </NoteProvider>,
    );
    const mic = await screen.findByTestId("answer-voice-button", {}, { timeout: 3000 });
    await act(async () => void fireEvent.click(mic));
    await waitFor(() => expect(screen.getByTestId("answer-voice-strip").dataset.phase).toBe("recording"));
    // no scroll at all: the pill with the time, the level and Send is already at the bottom of the screen
    const pill = await screen.findByTestId("note-widget");
    expect(pill.dataset.phase).toBe("recording");
    expect(screen.getByTestId("note-widget-time")).toBeTruthy();
    expect(screen.getByTestId("note-widget-send")).toBeTruthy();
    expect(screen.getByTestId("answer-voice-strip").dataset.floating).toBe("yes");
    // its link scrolls back to the card, it does not open the page again
    const scrolled = vi.fn();
    screen.getByTestId("answer-voice-strip").scrollIntoView = scrolled;
    fireEvent.click(screen.getByTestId("note-widget-back"));
    expect(scrolled).toHaveBeenCalled();
    // still recording, in view or not: the pill stays
    vp.seen(true);
    vp.seen(false);
    expect(screen.getByTestId("note-widget").dataset.phase).toBe("recording");
  });

  it("an idle microphone is never watched and never floats", async () => {
    const vp = viewport();
    const f = fakes();
    render(
      <NoteProvider tab={new NoteTab()}>
        <MemoryRouter>
          <Card f={f} />
          <NoteWidget />
        </MemoryRouter>
      </NoteProvider>,
    );
    await screen.findByTestId("answer-voice-button");
    vp.seen(false);
    expect(screen.queryByTestId("note-widget")).toBeNull();
  });
});
