// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import type { DeskChat } from "@/api";
import { ChatView } from "@/pages/Chat";
import type { NoteClock, NoteMedia, NotesApi, RecorderLike } from "./noteEngine";
import { NoteProvider, NoteTab, NoteWidget } from "./NoteProvider";

// (the owner 2026-11-08: a Chat voice note keeps recording while he moves to other pages; a floating pill takes him back;
// back on Chat the same note goes on, never a fresh one) and (while recording: a pulsing red dot, Send sends in one
// tap, Cancel throws it away; the controls float and follow him across pages).

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
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
  const recorders: RecorderLike[] = [];
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
            r.ondataavailable?.({ data: new Blob(["said"], { type: "audio/webm" }) });
            r.onstop?.();
          }),
      };
      recorders.push(r);
      return r;
    },
  };
  const api = {
    start: vi.fn(async () => ({ note: { id: "vn_1" }, segmentS: 120, maxMin: 30, usdPerMin: 0.003, monthUsd: 0.2, monthCapUsd: 25 })),
    segment: vi.fn(async (_id: string, n: number) => ({ segment: { n, text: `t${n}`, costUsd: 0.001 }, note: { costUsd: 0.001 } })),
    finish: vi.fn(async (_id: string, segments: number) => ({ note: { id: "vn_1", state: "posted", seconds: 75, costUsd: 0.004, segments } })),
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
type F = ReturnType<typeof fakes>;

const chat = (): DeskChat => ({ available: true, threadId: "th", session: 1, status: "idle", working: false, sending: 0, hasEarlier: false, messages: [] }) as unknown as DeskChat;

/** The app in small: the note owner above the router, Chat and one other page, and the floating pill on every page. */
function app(f: F, tab = new NoteTab()) {
  const load = async () => chat();
  const sendMessage = async () => ({ threadId: "th", pending: false });
  const voiceNote = { api: f.api, media: f.media, clock: f.clock, state: async () => ({ enabled: true, monthUsd: 0.2, limits: { monthCapUsd: 25 } }) };
  render(
    <NoteProvider tab={tab}>
      <MemoryRouter initialEntries={["/chat?page=T42-S36"]}>
        <nav>
          <Link to="/inbox">Inbox</Link>
        </nav>
        <Routes>
          <Route path="/chat" element={<ChatView who="Team desk" cacheKey="/api/voice" load={load} sendMessage={sendMessage} placeholder="…" panel voiceNote={voiceNote} />} />
          <Route path="/inbox" element={<p data-testid="inbox">Inbox page</p>} />
        </Routes>
        <NoteWidget />
      </MemoryRouter>
    </NoteProvider>,
  );
  return tab;
}

async function record(f: F, s: number) {
  const btn = await screen.findByTestId("note-button");
  await act(async () => void fireEvent.click(btn));
  await waitFor(() => expect(screen.getByTestId("note-strip").dataset.phase).toBe("recording"));
  await f.advance(s);
}
const leave = async () => {
  await act(async () => void fireEvent.click(screen.getByText("Inbox")));
  await screen.findByTestId("inbox");
};

describe("T42-S36 a voice note survives moving around the site", () => {
  it("leaving Chat keeps the one recorder going, the pill shows it, and its link back finds the same note going on", async () => {
    const f = fakes();
    app(f);
    expect(screen.queryByTestId("note-widget")).toBeNull();
    await record(f, 20);
    // While Chat shows the note, it does not float.
    expect(screen.queryByTestId("note-widget")).toBeNull();
    await leave();
    expect(screen.queryByTestId("note-strip")).toBeNull();
    const pill = screen.getByTestId("note-widget");
    expect(pill.dataset.phase).toBe("recording");
    await f.advance(15);
    expect(screen.getByTestId("note-widget-time").textContent).toBe("0:35");
    // Still the one recorder: nothing stopped, no second note opened.
    expect(f.track.stop).not.toHaveBeenCalled();
    expect(f.recorders).toHaveLength(1);
    expect(f.api.start).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("note-widget-back").getAttribute("href")).toBe("/chat?page=T42-S36");

    await act(async () => void fireEvent.click(screen.getByTestId("note-widget-back")));
    await waitFor(() => expect(screen.getByTestId("note-strip").dataset.phase).toBe("recording"));
    expect(screen.queryByTestId("note-widget")).toBeNull();
    await f.advance(5);
    expect(screen.getByTestId("note-timer").textContent).toBe("0:40");
    expect(screen.getByTestId("note-button").getAttribute("aria-label")).toBe("Send the voice note to Chat");
    await act(async () => void fireEvent.click(screen.getByTestId("note-button")));
    await waitFor(() => expect(f.api.finish).toHaveBeenCalledWith("vn_1", 1, undefined));
    expect(f.api.start).toHaveBeenCalledTimes(1);
  });

  it("what he typed in the chat box is still there when he comes back", async () => {
    const f = fakes();
    app(f);
    fireEvent.change(await screen.findByLabelText("Message to the Team desk"), { target: { value: "half a thought" } });
    await leave();
    cleanup();
    app(f);
    expect(((await screen.findByLabelText("Message to the Team desk")) as HTMLTextAreaElement).value).toBe("half a thought");
  });
});

describe("T42-S37 the recording controls: red dot, Send, Cancel", () => {
  it("the pill's Send stops and sends the note in one tap, says so, then goes", async () => {
    const f = fakes();
    app(f);
    await record(f, 12);
    await leave();
    expect(screen.getByTestId("note-dot").querySelector(".animate-ping")?.className).toMatch(/motion-reduce:hidden/);
    await act(async () => void fireEvent.click(screen.getByTestId("note-widget-send")));
    await waitFor(() => expect(f.api.finish).toHaveBeenCalledWith("vn_1", 1, undefined));
    await waitFor(() => expect(screen.getByTestId("note-widget").dataset.phase).toBe("sent"));
    expect(screen.getByTestId("note-widget").textContent).toContain("Voice note sent");
    expect(f.track.stop).toHaveBeenCalled();
    await act(async () => await new Promise((r) => setTimeout(r, 4100)));
    expect(screen.queryByTestId("note-widget")).toBeNull();
  }, 10_000);

  it("Cancel throws a short note away at once; a long one asks first, and Keep keeps it recording", async () => {
    const f = fakes();
    app(f);
    await record(f, 10);
    await leave();
    await act(async () => void fireEvent.click(screen.getByTestId("note-discard")));
    await waitFor(() => expect(f.api.discard).toHaveBeenCalledWith("vn_1"));
    expect(screen.queryByTestId("note-widget")).toBeNull();
    expect(f.api.finish).not.toHaveBeenCalled();

    const g = fakes();
    cleanup();
    app(g);
    await record(g, 75);
    await leave();
    await act(async () => void fireEvent.click(screen.getByTestId("note-discard")));
    expect(g.api.discard).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Throw away this voice note?" }).textContent).toContain("1:15");
    fireEvent.click(screen.getByTestId("note-discard-keep"));
    expect(screen.getByTestId("note-widget").dataset.phase).toBe("recording");
    await act(async () => void fireEvent.click(screen.getByTestId("note-discard")));
    await act(async () => void fireEvent.click(screen.getByTestId("note-discard-confirm")));
    await waitFor(() => expect(g.api.discard).toHaveBeenCalledWith("vn_1"));
    expect(screen.queryByTestId("note-widget")).toBeNull();
  });

  it("inside Chat the same controls: red dot, Cancel, and the Send button in place of a Stop", async () => {
    const f = fakes();
    app(f);
    await record(f, 3);
    expect(screen.getByTestId("note-dot")).toBeTruthy();
    expect(screen.getByTestId("note-discard").textContent).toContain("Cancel");
    expect(screen.getByTestId("note-button").textContent).toContain("Send note");
    expect(screen.getByTestId("note-hint").textContent).toMatch(/other pages keep recording/);
    await act(async () => void fireEvent.click(screen.getByTestId("note-discard")));
    await waitFor(() => expect(f.api.discard).toHaveBeenCalled());
    expect(screen.queryByTestId("note-strip")).toBeNull();
  });
});
