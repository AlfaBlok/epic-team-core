// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { DeskChat } from "@/api";
import { ChatView } from "@/pages/Chat";
import { bestVoice, createSpeaker, pieces, setReplySpeaker, speakable, SPEAK_REPLIES_KEY, type SpeakMedia } from "./speak";

// "right now I hear like a robotic voice and I cannot stop that robotic voice … I didn't press
// that button". A reply speaks only on Play (or when he turned Speak replies on), in the team's warm voice, and Pause and
// Stop are always there; a tap anywhere else or a new message stops it.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  setReplySpeaker(undefined);
  localStorage.clear();
  vi.restoreAllMocks();
});

const tick = () => act(async () => await new Promise((r) => setTimeout(r, 0)));

function fakeMedia(o: { down?: boolean } = {}) {
  const el: any = {
    src: "",
    ended: false,
    onended: null as null | (() => void),
    onerror: null,
    played: [] as string[],
    play: vi.fn(async () => void el.played.push(el.src)),
    pause: vi.fn(),
  };
  const spoken: SpeechSynthesisUtterance[] = [];
  const synth: any = {
    getVoices: () => [
      { name: "Fred", lang: "en-US" },
      { name: "Samantha (Enhanced)", lang: "en-US" },
      { name: "Thomas", lang: "fr-FR" },
    ],
    speak: vi.fn((u: SpeechSynthesisUtterance) => spoken.push(u)),
    pause: vi.fn(),
    resume: vi.fn(),
    cancel: vi.fn(),
  };
  const fetched: string[] = [];
  const media: SpeakMedia = {
    fetchPiece: vi.fn(async (text: string, signal: AbortSignal) => {
      if (o.down) throw new Error("reply voice 503");
      if (signal.aborted) throw new Error("aborted");
      fetched.push(text);
      return new Blob([text], { type: "audio/wav" });
    }),
    audio: () => el,
    synth: () => synth,
  };
  return { media, el, synth, spoken, fetched, end: () => act(() => el.onended?.()) };
}

beforeEach(() => {
  (globalThis as any).SpeechSynthesisUtterance ??= class {
    text: string;
    voice: unknown;
    lang = "";
    rate = 1;
    pitch = 1;
    onend: null | (() => void) = null;
    onerror: null | (() => void) = null;
    constructor(t: string) {
      this.text = t;
    }
  };
  URL.createObjectURL ??= () => "blob:x";
  URL.revokeObjectURL ??= () => undefined;
});

describe("T42-S40 the words it says", () => {
  it("drops code, links and marks, and cuts the reply into short pieces at sentence ends", () => {
    expect(speakable("**Done.** See [the page](https://x.y/z) or https://a.b/c.\n```\ncode\n```\nBye `now`.")).toBe("Done. See the page or Bye now.");
    const p = pieces("Short one. " + "A longer sentence that goes on for a while to fill the piece. ".repeat(8));
    expect(p[0]).toBe("Short one. A longer sentence that goes on for a while to fill the piece.");
    expect(p.every((x) => x.length <= 300)).toBe(true);
    expect(p.join(" ").replace(/\s+/g, " ")).toContain("fill the piece.");
  });
  it("the device's voice is its best English one, never a novelty or robotic one", () => {
    const v = (name: string, lang = "en-US") => ({ name, lang }) as SpeechSynthesisVoice;
    expect(bestVoice([v("Fred"), v("Albert"), v("Samantha"), v("Ava (Premium)"), v("Amélie", "fr-CA")])?.name).toBe("Ava (Premium)");
    expect(bestVoice([v("Microsoft Aria Online (Natural) - English (United States)"), v("Microsoft David - English (United States)")])?.name).toMatch(/Aria/);
    expect(bestVoice([v("Fred"), v("Zarvox")])).toBeUndefined();
  });
});

describe("T42-S40 the one player", () => {
  it("Play speaks in the team's voice piece by piece; Pause, Resume and Stop work at any time", async () => {
    const f = fakeMedia();
    const s = createSpeaker(f.media);
    act(() => s.play("m1", "First piece is here and it is long enough to stand. Second piece follows. " + "More words to say. ".repeat(20)));
    await tick();
    expect(s.get()).toMatchObject({ phase: "playing", id: "m1", voice: "heart" });
    expect(f.fetched[0]).toMatch(/^First piece/);
    expect(f.el.played).toContain("blob:x");
    act(() => s.pause());
    expect(s.get().phase).toBe("paused");
    expect(f.el.pause).toHaveBeenCalled();
    act(() => s.resume());
    expect(s.get().phase).toBe("playing");
    await f.end();
    await tick();
    expect(f.fetched.length).toBeGreaterThanOrEqual(2);
    act(() => s.stop());
    expect(s.get().phase).toBe("idle");
    const n = f.fetched.length;
    await f.end();
    await tick();
    expect(f.fetched.length).toBe(n); // nothing more after Stop
    expect(f.synth.speak).not.toHaveBeenCalled();
  });
  it("the team's voice down: the device's best voice says it (never Fred), and Stop cancels it", async () => {
    const f = fakeMedia({ down: true });
    const s = createSpeaker(f.media);
    act(() => s.play("m1", "Hello there. This is the reply."));
    await tick();
    expect(s.get()).toMatchObject({ phase: "playing", voice: "device" });
    expect(f.spoken[0].voice).toMatchObject({ name: "Samantha (Enhanced)" });
    expect(f.spoken[0].rate).toBeLessThan(1);
    act(() => s.pause());
    expect(f.synth.pause).toHaveBeenCalled();
    act(() => s.stop());
    expect(f.synth.cancel).toHaveBeenCalled();
    expect(s.get().phase).toBe("idle");
  });
});

const chat = (messages: DeskChat["messages"]): DeskChat => ({ available: true, threadId: "th", session: 1, status: "idle", working: false, sending: 0, hasEarlier: false, messages }) as DeskChat;
const reply = (id: string, text: string, at = new Date().toISOString()) => ({ id, role: "assistant", status: "completed", text, at }) as DeskChat["messages"][number];
const mine = (id: string, text: string) => ({ id, role: "user", status: "completed", text, at: new Date().toISOString() }) as DeskChat["messages"][number];

function renderChat(load: () => Promise<DeskChat>) {
  return render(
    <MemoryRouter>
      <ChatView who="Team desk" load={load} sendMessage={async () => ({ threadId: "th", pending: false })} placeholder="…" panel voiceNote={{ state: async () => ({ enabled: true, monthUsd: 0, limits: { monthCapUsd: 25 } }) }} />
    </MemoryRouter>,
  );
}

describe("T42-S40 in Chat", () => {
  it("never speaks by itself: a reply to his voice note arrives and nothing plays, even with the old switch left on", async () => {
    localStorage.setItem("voiceNote.readAloud", "on"); //'s switch, never read again
    const f = fakeMedia();
    setReplySpeaker(createSpeaker(f.media));
    renderChat(async () => chat([mine("u1", "🎙 Voice note (Chat), 2026-11-09 16:00Z · 0 min 10 s\n\nhow are we?"), reply("a1", "All good, the deploy is live.")]));
    await screen.findByText("All good, the deploy is live.");
    await tick();
    expect(f.media.fetchPiece).not.toHaveBeenCalled();
    expect(f.synth.speak).not.toHaveBeenCalled();
    expect(screen.getByTestId("reply-play")).toBeTruthy();
    expect(screen.queryByTestId("reply-speaking")).toBeNull();
  });
  it("Play speaks that reply with Pause and Stop on it and by the box; a tap elsewhere stops it", async () => {
    const f = fakeMedia();
    setReplySpeaker(createSpeaker(f.media));
    renderChat(async () => chat([reply("a1", "All good, the deploy is live.")]));
    fireEvent.click(await screen.findByTestId("reply-play"));
    await tick();
    expect(f.fetched).toEqual(["All good, the deploy is live."]);
    expect(screen.getAllByTestId("reply-stop")).toHaveLength(2); // on the reply and in the bar by the box
    expect(screen.getByTestId("reply-speaking").textContent).toMatch(/Speaking the reply/);
    fireEvent.click(screen.getAllByTestId("reply-pause")[0]);
    expect(screen.getByTestId("reply-speaking").textContent).toMatch(/Paused/);
    fireEvent.click(screen.getAllByTestId("reply-resume")[0]);
    fireEvent.click(screen.getByTestId("chat-transcript")); // a tap anywhere else
    await waitFor(() => expect(screen.queryByTestId("reply-speaking")).toBeNull());
    expect(f.el.pause).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("reply-play"));
    await tick();
    fireEvent.click(screen.getAllByTestId("reply-stop")[1]);
    await waitFor(() => expect(screen.queryByTestId("reply-speaking")).toBeNull());
  });
  it("a new message stops the reply that is speaking", async () => {
    const f = fakeMedia();
    setReplySpeaker(createSpeaker(f.media));
    let msgs = [reply("a1", "First answer.")];
    const load = vi.fn(async () => chat(msgs));
    const r = renderChat(load);
    fireEvent.click(await screen.findByTestId("reply-play"));
    await tick();
    expect(screen.getByTestId("reply-speaking")).toBeTruthy();
    msgs = [...msgs, mine("u2", "another thing")];
    r.rerender(
      <MemoryRouter>
        <ChatView who="Team desk" load={async () => chat(msgs)} sendMessage={async () => ({ threadId: "th", pending: false })} placeholder="…" panel voiceNote={{ state: async () => ({ enabled: true, monthUsd: 0, limits: { monthCapUsd: 25 } }) }} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.queryByText("another thing")).toBeTruthy(), { timeout: 8000 });
    await waitFor(() => expect(screen.queryByTestId("reply-speaking")).toBeNull());
  }, 15_000);
  it("Speak replies is off by default, and on/off is remembered on this device", async () => {
    const { SpeakRepliesSwitch } = await import("./ReplyVoice");
    render(<SpeakRepliesSwitch />);
    const sw = screen.getByTestId("speak-replies");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.textContent).toMatch(/Speak replies: off/);
    fireEvent.click(sw);
    expect(localStorage.getItem(SPEAK_REPLIES_KEY)).toBe("on");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    cleanup();
    render(<SpeakRepliesSwitch />);
    expect(screen.getByTestId("speak-replies").textContent).toMatch(/Speak replies: on/);
  });
});
