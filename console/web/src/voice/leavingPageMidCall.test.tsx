// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { useCallDock, type VoiceState } from "./CallPanel";
import { CallProvider, CallTab, CallWidget } from "./CallProvider";
import type { Media, VoiceApi } from "./engine";

// he left the Chat page mid-call for another section; the mic stayed on, the voice went
// quiet, Chat said "A call is already on (one call at a time). Hang it up first." with no way to hang up, and a reload
// ended nothing, so the transcript was lost. Now the call is the tab's: it survives leaving the page (coming back shows it,
// Hang up and lines included), pagehide ends it with its transcript wherever the page is, and a page that finds its world's
// call on without holding it has a Hang up for it.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function fakes(o: { active?: string } = {}) {
  const dc: any = { readyState: "open", send: vi.fn(), close: vi.fn() };
  const pc: any = { addTrack: vi.fn(), createDataChannel: () => dc, createOffer: async () => ({ type: "offer", sdp: "o" }), setLocalDescription: vi.fn(async () => undefined), setRemoteDescription: vi.fn(async () => undefined), close: vi.fn(), connectionState: "connected" };
  const track: any = { enabled: true, stop: vi.fn() };
  const mic: any = { getAudioTracks: () => [track], getTracks: () => [track] };
  const m: Media = { microphone: vi.fn(async () => mic), peer: () => pc, exchange: vi.fn(async () => "a"), play: vi.fn() };
  const call = { id: "call_1", costUsd: 0, seconds: 0, usdPerMin: null };
  let active = o.active;
  const voice = {
    start: vi.fn(async () => ({ call: { ...call, startedAt: "" }, clientSecret: "ek_1", expiresAt: 0, model: "gpt-realtime-2.1-mini", limits: { callMaxMin: 20, callWarnMin: 18, quietHangupS: 120, monthCapUsd: 25 } })),
    beat: vi.fn(async () => ({ call, monthUsd: 0 })),
    usage: vi.fn(async () => ({ call, monthUsd: 0 })),
    end: vi.fn(async () => ({ call, monthUsd: 0 })),
    status: vi.fn(async () => ({ text: "" })),
    ask: vi.fn(async () => ({ askId: "q1" })),
    askState: vi.fn(async () => ({ state: "working" as const, waitedMs: 0, spokenWaitMs: 60_000 })),
    endActive: vi.fn(async (id: string) => {
      const ended = id === active;
      active = undefined;
      return { ended };
    }),
  } satisfies VoiceApi;
  const state = vi.fn(async (): Promise<VoiceState> => ({ available: true, enabled: true, monthUsd: 0.25, limits: { monthCapUsd: 25, callMaxMin: 20 }, ...(active ? { activeCall: { id: active, startedAt: "2026-11-02T09:41:00Z" } } : {}) }));
  const emit = async (ev: unknown) => act(async () => void (dc.onmessage({ data: JSON.stringify(ev) }), await new Promise((r) => setTimeout(r, 0))));
  return { voice, media: () => m, state, dc, track, emit, setActive: (id?: string) => (active = id) };
}
type F = ReturnType<typeof fakes>;

/** One page with the call bar (Chat or a campaign's chat), on `base`'s call routes. */
function Page(props: { f: F; base?: string }) {
  const call = useCallDock({ api: props.f.voice, media: props.f.media, state: props.f.state, base: props.base });
  return (
    <div>
      {call.bar}
      <ol>{call.live}</ol>
    </div>
  );
}

async function onCall(f: F) {
  fireEvent.click(await screen.findByTestId("call-start"));
  await waitFor(() => expect(f.voice.start).toHaveBeenCalled());
  await act(async () => void f.dc.onopen());
  await screen.findByTestId("call-hangup");
  await f.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "i1", transcript: "What's waiting on me?" });
}

describe("T42-S21 leaving the page mid-call", () => {
  it("navigating away keeps the call on (mic, heartbeat), and coming back shows it with its Hang up and lines; Hang up ends it with the transcript", async () => {
    const f = fakes();
    const page = render(<Page f={f} base="/t/a" />);
    await onCall(f);
    page.unmount(); // another section of the app
    expect(f.track.stop).not.toHaveBeenCalled();
    expect(f.voice.end).not.toHaveBeenCalled();
    await f.emit({ type: "response.output_audio_transcript.done", item_id: "o1", transcript: "Two drafts wait on you." });

    render(<Page f={f} base="/t/a" />);
    expect(await screen.findByTestId("call-hangup")).toBeTruthy();
    expect(screen.queryByTestId("call-start")).toBeNull();
    expect(screen.getByTestId("call-line-you").textContent).toBe("What's waiting on me?");
    expect(f.voice.start).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("call-hangup"));
    await waitFor(() => expect(f.voice.end).toHaveBeenCalled());
    const [id, body] = f.voice.end.mock.calls[0] as unknown as [string, { reason: string; transcript: { who: string; text: string }[] }];
    expect(id).toBe("call_1");
    expect(body.reason).toBe("hangup");
    expect(body.transcript.map((l) => l.text)).toContain("What's waiting on me?");
    expect(f.track.stop).toHaveBeenCalled();
  });

  it("a reload after leaving the page still ends the call with its transcript (pagehide is the tab's, not the page's)", async () => {
    const f = fakes();
    const page = render(<Page f={f} base="/t/b" />);
    await onCall(f);
    page.unmount();
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(f.voice.end).toHaveBeenCalledTimes(1);
    const [id, body, beacon] = f.voice.end.mock.calls[0] as unknown as [string, { reason: string; transcript: { text: string }[] }, boolean];
    expect(id).toBe("call_1");
    expect(body.reason).toBe("tab_closed");
    expect(body.transcript.map((l) => l.text)).toEqual(["What's waiting on me?"]);
    expect(beacon).toBe(true);
    expect(f.track.stop).toHaveBeenCalled();
  });

  it("the console stops a call hung up from another page: the next beat hangs it up here, transcript and all", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const f = fakes();
      render(<Page f={f} base="/t/c" />);
      await onCall(f);
      f.voice.beat.mockResolvedValue({ call: { id: "call_1", costUsd: 0, seconds: 20, usdPerMin: null }, monthUsd: 0, stop: "ended_elsewhere" } as never);
      await act(async () => void vi.advanceTimersByTime(20_000));
      await act(async () => void vi.advanceTimersByTime(1_000));
      await waitFor(() => expect(f.voice.end).toHaveBeenCalled());
      expect((f.voice.end.mock.calls[0] as unknown as [string, { reason: string; transcript: { text: string }[] }])[1]).toMatchObject({ reason: "ended_elsewhere", transcript: [{ text: "What's waiting on me?" }] });
      expect(await screen.findByTestId("call-ended")).toBeTruthy();
      expect(screen.getByTestId("call-ended").textContent).toContain("Hung up from another page.");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("T42-S21 a call this page does not hold", () => {
  it("shows a Hang up instead of the dead-end 'one call at a time', ends it on the console, then offers Call again", async () => {
    const f = fakes({ active: "call_9" });
    render(<Page f={f} base="/t/d" />);
    const note = await screen.findByTestId("call-other");
    expect(note.textContent).toContain("A call is still on (since 09:41Z)");
    expect(screen.queryByTestId("call-start")).toBeNull();
    fireEvent.click(screen.getByTestId("call-other-hangup"));
    await waitFor(() => expect(f.voice.endActive).toHaveBeenCalledWith("call_9"));
    expect(await screen.findByTestId("call-start")).toBeTruthy();
    expect(screen.queryByTestId("call-other")).toBeNull();
    expect(f.voice.end).not.toHaveBeenCalled();
  });

  it("after a refused Call (the world's call is on elsewhere) the page offers that Hang up, not only the error", async () => {
    const f = fakes();
    f.voice.start.mockRejectedValueOnce(new Error("A call is already on (one call at a time). Hang it up first."));
    render(<Page f={f} base="/t/e" />);
    f.setActive("call_7");
    fireEvent.click(await screen.findByTestId("call-start"));
    expect(await screen.findByTestId("call-other-hangup")).toBeTruthy();
    expect(screen.queryByTestId("call-error")).toBeNull();
    fireEvent.click(screen.getByTestId("call-other-hangup"));
    await waitFor(() => expect(f.voice.endActive).toHaveBeenCalledWith("call_7"));
    expect(await screen.findByTestId("call-start")).toBeTruthy();
    expect(screen.queryByTestId("call-error")).toBeNull();
  });

  it("a call this tab holds on another page's routes is hung up there, so its transcript still lands in that chat", async () => {
    const a = fakes();
    const first = render(<Page f={a} base="/t/f1" />);
    await onCall(a);
    first.unmount();
    const b = fakes({ active: "call_1" });
    render(<Page f={b} base="/t/f2" />);
    fireEvent.click(await screen.findByTestId("call-other-hangup"));
    await waitFor(() => expect(a.voice.end).toHaveBeenCalled());
    expect((a.voice.end.mock.calls[0] as unknown as [string, { transcript: { text: string }[] }])[1].transcript.map((l) => l.text)).toContain("What's waiting on me?");
    expect(b.voice.endActive).not.toHaveBeenCalled();
  });
});

/** The app's shape: the call owner above the router, a nav, three sections, and the floating widget on every page. */
function App(props: { f: F; tab: CallTab }) {
  return (
    <CallProvider tab={props.tab}>
      <MemoryRouter initialEntries={["/chat?page=Pipeline"]}>
        <nav>
          <Link to="/chat?page=Pipeline">Chat</Link>
          <Link to="/team">Team</Link>
          <Link to="/runs">Runs</Link>
        </nav>
        <Routes>
          <Route path="/chat" element={<Page f={props.f} base="/t/app" />} />
          <Route path="/team" element={<p>Team section</p>} />
          <Route path="/runs" element={<p>Runs section</p>} />
        </Routes>
        <CallWidget />
      </MemoryRouter>
    </CallProvider>
  );
}
const go = async (name: string) => act(async () => void fireEvent.click(screen.getByRole("link", { name })));

describe("T42-S21 the call stays on across the whole app (Sam's pick: option a)", () => {
  it("across several sections the call stays live and keeps its heartbeat; the widget shows it, with a link back to the same call and its lines", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const f = fakes();
      render(<App f={f} tab={new CallTab()} />);
      await onCall(f);
      expect(screen.queryByTestId("call-widget")).toBeNull(); // the call page shows its own bar
      for (const section of ["Team", "Runs", "Team"]) {
        const beats = f.voice.beat.mock.calls.length;
        await go(section);
        expect(await screen.findByText(`${section} section`)).toBeTruthy();
        expect(screen.queryByTestId("call-panel")).toBeNull();
        const w = screen.getByTestId("call-widget");
        expect(w.textContent).toContain("On call with the desk");
        expect(screen.getByTestId("call-widget-hangup")).toBeTruthy();
        await act(async () => void vi.advanceTimersByTime(20_000));
        expect(f.voice.beat.mock.calls.length).toBe(beats + 1);
        expect(screen.getByTestId("call-widget-time").textContent).toMatch(/^\d+:\d\d$/);
      }
      expect(f.track.stop).not.toHaveBeenCalled();
      expect(f.voice.end).not.toHaveBeenCalled();
      expect(f.voice.start).toHaveBeenCalledTimes(1);

      // Mute from the widget is the call's mute.
      fireEvent.click(screen.getByTestId("call-widget-mute"));
      expect(screen.getByTestId("call-widget-mute").getAttribute("aria-pressed")).toBe("true");
      expect(f.track.enabled).toBe(false);

      // Back to the page that started it: the same live call, its lines so far, no widget.
      await f.emit({ type: "response.output_audio_transcript.done", item_id: "o1", transcript: "Two drafts wait on you." });
      expect(screen.getByTestId("call-widget-back").getAttribute("href")).toBe("/chat?page=Pipeline");
      await act(async () => void fireEvent.click(screen.getByTestId("call-widget-back")));
      expect(await screen.findByTestId("call-hangup")).toBeTruthy();
      expect(screen.queryByTestId("call-widget")).toBeNull();
      expect(screen.getByTestId("call-line-you").textContent).toBe("What's waiting on me?");
      expect(screen.getByTestId("call-line-desk").textContent).toBe("Two drafts wait on you.");
      expect(screen.getByTestId("call-mute").getAttribute("aria-pressed")).toBe("true");
      const beats = f.voice.beat.mock.calls.length;
      await act(async () => void vi.advanceTimersByTime(20_000));
      expect(f.voice.beat.mock.calls.length).toBe(beats + 1);
      expect(f.voice.start).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the widget's Hang up ends the call and posts its transcript; the widget goes", async () => {
    const f = fakes();
    render(<App f={f} tab={new CallTab()} />);
    await onCall(f);
    await go("Team");
    await f.emit({ type: "response.output_audio_transcript.done", item_id: "o1", transcript: "Two drafts wait on you." });
    await go("Runs");
    fireEvent.click(screen.getByTestId("call-widget-hangup"));
    await waitFor(() => expect(f.voice.end).toHaveBeenCalled());
    const [id, body, beacon] = f.voice.end.mock.calls[0] as unknown as [string, { reason: string; transcript: { who: string; text: string }[] }, boolean | undefined];
    expect(id).toBe("call_1");
    expect(body.reason).toBe("hangup");
    expect(body.transcript.map((l) => l.text)).toEqual(["What's waiting on me?", "Two drafts wait on you."]);
    expect(beacon).toBeFalsy();
    expect(f.track.stop).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId("call-widget")).toBeNull());
    await go("Chat");
    expect(await screen.findByTestId("call-start")).toBeTruthy();
  });

  it("a reload after moving through sections still ends the call with its transcript (the owner's pagehide, not a page's)", async () => {
    const f = fakes();
    render(<App f={f} tab={new CallTab()} />);
    await onCall(f);
    await go("Team");
    await go("Runs");
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(f.voice.end).toHaveBeenCalledTimes(1);
    const [id, body, beacon] = f.voice.end.mock.calls[0] as unknown as [string, { reason: string; transcript: { text: string }[] }, boolean];
    expect(id).toBe("call_1");
    expect(body).toMatchObject({ reason: "tab_closed", transcript: [{ text: "What's waiting on me?" }] });
    expect(beacon).toBe(true);
    expect(f.track.stop).toHaveBeenCalled();
    expect(screen.queryByTestId("call-widget")).toBeNull();
  });

  it("the audio element is the owner's, in the document for the tab's life: leaving the page never removes it", async () => {
    const f = fakes();
    const seen: HTMLAudioElement[] = [];
    const media = f.media;
    f.media = ((audio: HTMLAudioElement) => (seen.push(audio), media())) as typeof f.media;
    render(<App f={f} tab={new CallTab()} />);
    await onCall(f);
    expect(seen.length).toBeGreaterThan(0);
    const el = seen[0];
    expect(new Set(seen).size).toBe(1);
    expect(el.parentElement).toBe(document.body);
    expect(screen.getByTestId("call-panel").contains(el)).toBe(false);
    await go("Team");
    await go("Runs");
    expect(document.body.contains(el)).toBe(true);
  });
});
