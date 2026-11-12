// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { DeskChat } from "@/api";
import { Layout } from "@/components/Layout";
import { deskVoiceBase } from "@/voice/deskBase";
import { ChatView } from "@/pages/Chat";
import type { NoteClock, NoteMedia, NotesApi, RecorderLike } from "./noteEngine";
import { NoteProvider, NoteTab, NoteWidget } from "./NoteProvider";
import { clearNoteState } from "./useNote";
import { TOP_BAR_TO, TopBarVoice } from "./TopBarVoice";

// a microphone in the top bar, next to Chat. One tap records a voice note to the Team
// desk from any page; the floating recorder stays put, sends on Send, says it was sent, and the page never switches to Chat.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  clearNoteState();
  localStorage.clear();
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
    start: vi.fn(async (_page?: string) => ({ note: { id: "vn_1" }, segmentS: 120, maxMin: 30, usdPerMin: 0.003, monthUsd: 0.2, monthCapUsd: 25 })),
    segment: vi.fn(async (_id: string, n: number) => ({ segment: { n, text: `t${n}`, costUsd: 0.001 }, note: { costUsd: 0.001 } })),
    finish: vi.fn(async (_id: string, segments: number) => ({ note: { id: "vn_1", state: "posted", seconds: 12, costUsd: 0.001, segments } })),
    discard: vi.fn(async () => ({})),
  } satisfies NotesApi;
  const advance = async (s: number) => {
    for (let i = 0; i < s * 4; i++) {
      clock.t += 250;
      for (const f of [...clock.ticks]) f();
    }
    await act(async () => await new Promise((r) => setTimeout(r, 0)));
  };
  return { clock: c, media, api, recorders, advance };
}
type F = ReturnType<typeof fakes>;

const ON = async () => ({ enabled: true, monthUsd: 0.2, limits: { monthCapUsd: 25 } });
const chat = (): DeskChat => ({ available: true, threadId: "th", session: 1, status: "idle", working: false, sending: 0, hasEarlier: false, messages: [] }) as unknown as DeskChat;

function Where() {
  const l = useLocation();
  return <span data-testid="where">{l.pathname + l.search}</span>;
}

/** The app in small: the note owner, a top bar with the mic, a card page and Chat, and the floating pill on every page. */
function app(f: F, opts: { state?: () => Promise<any>; at?: string } = {}) {
  const tab = new NoteTab();
  const voice = { api: f.api, media: f.media, clock: f.clock, state: opts.state ?? ON };
  render(
    <NoteProvider tab={tab}>
      <MemoryRouter initialEntries={[opts.at ?? "/milestones/ms_1?tab=deck"]}>
        <header>
          <Link to="/chat">Chat</Link>
          <TopBarVoice {...voice} />
        </header>
        <Routes>
          <Route path="/milestones/:id" element={<p data-testid="deck">The deck</p>} />
          <Route path="/chat" element={<ChatView who="Team desk" cacheKey="/api/voice" load={async () => chat()} sendMessage={async () => ({ threadId: "th", pending: false })} placeholder="…" panel voiceNote={voice} />} />
        </Routes>
        <Where />
        <NoteWidget />
      </MemoryRouter>
    </NoteProvider>,
  );
  return tab;
}

describe("T18-S20 a voice note from the top bar, on any page", () => {
  it("one tap records on the page he is on; the floating recorder shows it going to the Team desk; Send posts it and the page stays", async () => {
    const f = fakes();
    app(f);
    const mic = await screen.findByTestId("topbar-voice");
    expect(mic.getAttribute("aria-label")).toBe(`Record a voice note to the ${TOP_BAR_TO}`);
    expect(screen.queryByTestId("note-widget")).toBeNull();
    await act(async () => void fireEvent.click(mic));
    await waitFor(() => expect(screen.getByTestId("note-widget").dataset.phase).toBe("recording"));
    expect(f.media.microphone).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("note-widget-to").textContent).toBe("to: Team desk");
    // the note tells the desk where he was, like Chat's page hint
    expect(f.api.start).toHaveBeenCalledWith("voice note from the top bar, on /milestones/ms_1?tab=deck");
    expect(screen.getByTestId("deck")).toBeTruthy();
    await f.advance(12);
    // while recording, the mic is a red Send
    expect(screen.getByTestId("topbar-voice").dataset.phase).toBe("recording");
    expect(screen.getByTestId("topbar-voice").getAttribute("aria-label")).toBe(`Send the voice note to the ${TOP_BAR_TO}`);
    await act(async () => void fireEvent.click(screen.getByTestId("note-widget-send")));
    await waitFor(() => expect(f.api.finish).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("note-widget").dataset.phase).toBe("sent"));
    // a small confirmation, never a page change
    expect(screen.getByTestId("note-widget").textContent).toContain("Voice note sent to Team desk");
    expect(screen.getByTestId("where").textContent).toBe("/milestones/ms_1?tab=deck");
    expect(screen.getByTestId("deck")).toBeTruthy();
    expect(screen.getByTestId("topbar-voice").dataset.phase).toBe("sent");
  });

  it("tapping the red Send in the top bar sends too, in one tap", async () => {
    const f = fakes();
    app(f);
    const mic = await screen.findByTestId("topbar-voice");
    await act(async () => void fireEvent.click(mic));
    await waitFor(() => expect(screen.getByTestId("topbar-voice").dataset.phase).toBe("recording"));
    await f.advance(5);
    await act(async () => void fireEvent.click(screen.getByTestId("topbar-voice")));
    await waitFor(() => expect(f.api.finish).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("where").textContent).toBe("/milestones/ms_1?tab=deck");
  });

  it("it is Chat's own note: opening Chat while it records shows the same note there, not a second one", async () => {
    const f = fakes();
    app(f);
    const mic = await screen.findByTestId("topbar-voice");
    await act(async () => void fireEvent.click(mic));
    await waitFor(() => expect(screen.getByTestId("note-widget").dataset.phase).toBe("recording"));
    await f.advance(4);
    await act(async () => void fireEvent.click(screen.getByText("Chat")));
    await waitFor(() => expect(screen.getByTestId("note-strip").dataset.phase).toBe("recording"));
    expect(screen.queryByTestId("note-widget")).toBeNull();
    expect(f.api.start).toHaveBeenCalledTimes(1);
  });

  it("voice off, or this month's cap reached: no mic in the top bar", async () => {
    const f = fakes();
    app(f, { state: async () => ({ enabled: false }) });
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByTestId("topbar-voice")).toBeNull();
    cleanup();
    app(fakes(), { state: async () => ({ enabled: true, monthUsd: 25, limits: { monthCapUsd: 25 } }) });
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByTestId("topbar-voice")).toBeNull();
  });

  it("the desk it talks to is the Chat page's: home's Team desk, or the world's own desk in its skin", () => {
    expect(deskVoiceBase(undefined)).toBe("/api/voice");
    expect(deskVoiceBase("home")).toBe("/api/voice");
    expect(deskVoiceBase("social")).toBe("/api/tenants/social/desk/voice");
  });

  it("the Layout's top bar carries the mic right after Chat, on every page", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u) =>
      String(u).endsWith("/voice/state") ? new Response(JSON.stringify({ enabled: true, monthUsd: 0, limits: { monthCapUsd: 25 } }), { status: 200 }) : new Response("{}", { status: 404 }),
    );
    render(
      <MemoryRouter initialEntries={["/runs"]}>
        <Layout />
      </MemoryRouter>,
    );
    const bar = await screen.findByTestId("topbar-pills");
    const mic = await within(bar).findByTestId("topbar-voice");
    expect(within(bar).getByTestId("topbar-chat").nextElementSibling).toBe(mic);
  });
});
