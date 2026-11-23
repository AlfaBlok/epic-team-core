// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import type { DeskChat } from "@/api";
import { ChatView } from "@/pages/Chat";
import type { NoteClock, NoteMedia, NotesApi, RecorderLike } from "./noteEngine";
import { NoteProvider, NoteTab, NoteWidget } from "./NoteProvider";
import { linkRoute } from "./linkGuard";
import { InPlaceLinks } from "@/components/InPlaceLinks";
import { linkUrls } from "@/lib/linkjsx/links";

// (the owner 22 Nov 23:45Z, vn_787c5934: a 20-minute note was lost when he tapped "The whole kernel on one page"
// mid-recording; 23:50Z, vn_ce90e291: "if the link takes you to a page outside the app, then it is a new window"): a link
// tapped mid-recording never takes the page (and its microphone) away, and the note still arrives.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
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

/** Chat with a card's links under it: one out of the app, one plain link to an app page, one router link. */
function app(f: F, installed = false) {
  const load = async () => chat();
  const sendMessage = async () => ({ threadId: "th", pending: false });
  const voiceNote = { api: f.api, media: f.media, clock: f.clock, state: async () => ({ enabled: true, monthUsd: 0.2, limits: { monthCapUsd: 25 } }) };
  render(
    <NoteProvider tab={new NoteTab()}>
      <MemoryRouter initialEntries={["/chat"]}>
        <InPlaceLinks installed={() => installed} />
        {/* a review card's evidence and look links (target=_blank), and a URL written in a card line inside its button */}
        <a href="http://host1.example.net:9693/" target="_blank" rel="noreferrer">kernel evidence</a>
        <a href="/steps/view/abc" target="_blank" rel="noreferrer">a steps page</a>
        <a href={`${window.location.origin}/inbox?focus=E907-S3`} target="_blank" rel="noreferrer">the card in the inbox</a>
        <button type="button">{linkUrls("see https://example.org/kernel now")}</button>
        <a href="https://pages.example.com/kernel">The whole kernel on one page</a>
        <a href={`${window.location.origin}/milestones/ms_1?tab=deck`}>the deck</a>
        <a href="/steps-kit.js">a file</a>
        <Link to="/inbox">Inbox</Link>
        <Routes>
          <Route path="/chat" element={<ChatView who="Team desk" cacheKey="/api/voice" load={load} sendMessage={sendMessage} placeholder="…" panel voiceNote={voiceNote} />} />
          <Route path="/inbox" element={<p data-testid="inbox">Inbox page</p>} />
        </Routes>
        <NoteWidget />
      </MemoryRouter>
    </NoteProvider>,
  );
}

/** a tap as the browser makes it; true when the page itself would have navigated away (nothing stopped it). */
const tap = (el: Element) => fireEvent.click(el);

async function record(f: F, s: number) {
  const btn = await screen.findByTestId("note-button");
  await act(async () => void fireEvent.click(btn));
  await waitFor(() => expect(screen.getByTestId("note-strip").dataset.phase).toBe("recording"));
  await f.advance(s);
}

describe("a link tapped mid-recording never loses the note", () => {
  it("the kernel link opens a new window, the note keeps recording, and Send still delivers it", async () => {
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    const f = fakes();
    app(f);
    await record(f, 30);
    const left = tap(screen.getByText("The whole kernel on one page"));
    expect(left).toBe(false); // this page stayed
    expect(opened).toHaveBeenCalledWith("https://pages.example.com/kernel", "_blank", "noopener");
    await f.advance(30);
    expect(screen.getByTestId("note-strip").dataset.phase).toBe("recording");
    expect(screen.getByTestId("note-timer").textContent).toBe("1:00");
    expect(f.track.stop).not.toHaveBeenCalled();
    await act(async () => void fireEvent.click(screen.getByTestId("note-button")));
    await waitFor(() => expect(f.api.finish).toHaveBeenCalledWith("vn_1", 1, undefined));
    expect(f.api.discard).not.toHaveBeenCalled();
  });

  it("a plain link to an app page moves inside the app, no reload; a file opens a new window", async () => {
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    const f = fakes();
    app(f);
    await record(f, 10);
    expect(tap(screen.getByText("the deck"))).toBe(false);
    expect(window.location.pathname + window.location.search).toBe("/milestones/ms_1?tab=deck");
    expect(opened).not.toHaveBeenCalled();
    expect(tap(screen.getByText("a file"))).toBe(false);
    expect(opened).toHaveBeenCalledWith(`${window.location.origin}/steps-kit.js`, "_blank", "noopener");
    expect(screen.getByTestId("note-strip").dataset.phase).toBe("recording");
  });

  it("a router link is left to the app, and with no note on only links out of the app change", async () => {
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    const f = fakes();
    app(f);
    await act(async () => void fireEvent.click(screen.getByText("Inbox")));
    await screen.findByTestId("inbox");
    expect(opened).not.toHaveBeenCalled();
    expect(tap(screen.getByText("The whole kernel on one page"))).toBe(false);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("in the installed app on a phone, a card's outside link opens a new window and the note goes on", async () => {
    // his 23 Nov 00:57Z (vn_b58dfccb): "when I click the link, it says leave the site ... so the voice notes break"
    const loads: string[] = [];
    const assign = vi.fn((u: string) => loads.push(u));
    Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, assign, href: window.location.href, origin: window.location.origin, pathname: window.location.pathname, search: "", hash: "" } });
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    const f = fakes();
    try {
      app(f, true);
      await record(f, 20);
      // the evidence link: the browser's own target=_blank opens a new window; nothing unloads this page
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      screen.getByText("kernel evidence").dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
      // a URL in a card line: its own handler asks for a new window and gets one
      await act(async () => void fireEvent.click(screen.getByText("https://example.org/kernel")));
      expect(opened).toHaveBeenCalledWith("https://example.org/kernel", "_blank", "noopener,noreferrer");
      // a plain outside link: a new window too
      tap(screen.getByText("The whole kernel on one page"));
      expect(opened).toHaveBeenCalledWith("https://pages.example.com/kernel", "_blank", "noopener");
      // a server page of ours while recording: never loaded in place
      const sp = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      screen.getByText("a steps page").dispatchEvent(sp);
      expect(sp.defaultPrevented).toBe(false);
      // an app page: moves inside the app
      await act(async () => void fireEvent.click(screen.getByText("the card in the inbox")));
      expect(loads).toEqual([]);
      expect(assign).not.toHaveBeenCalled();
      await f.advance(20);
      // off the chat the floating pill carries the same note, still running
      expect(screen.getByTestId("note-widget-time").textContent).toContain("0:40");
      expect(f.track.stop).not.toHaveBeenCalled();
      await act(async () => void fireEvent.click(screen.getByTestId("note-widget-send")));
      await waitFor(() => expect(f.api.finish).toHaveBeenCalled());
      expect(f.api.discard).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: window.location });
    }
  });

  it("which taps are changed", () => {
    const here = new URL("https://console.example.com/chat?x=1") as unknown as Location;
    const a = (href: string, attrs: Record<string, string> = {}) => {
      const el = document.createElement("a");
      el.setAttribute("href", href);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      return el;
    };
    expect(linkRoute(a("https://other.example.com/p"), here, false)?.kind).toBe("window");
    expect(linkRoute(a("https://other.example.com/p", { target: "_blank" }), here, true)).toBeUndefined();
    expect(linkRoute(a("mailto:someone"), here, true)).toBeUndefined();
    expect(linkRoute(a("#top"), here, true)).toBeUndefined();
    expect(linkRoute(a("/inbox"), here, false)).toBeUndefined();
    expect(linkRoute(a("/inbox"), here, true)?.kind).toBe("app");
    expect(linkRoute(a("/api/voice/notes/vn_1/audio"), here, true)?.kind).toBe("window");
    expect(linkRoute(a("/r.pdf", { download: "" }), here, true)).toBeUndefined();
  });
});
