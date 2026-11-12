// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type DeskChat } from "@/api";
import { ChatPage, ChatView } from "@/pages/Chat";
import { useCallDock, type VoiceState } from "./CallPanel";
import type { Media, VoiceApi } from "./engine";

// the chat history scrolls in its own panel; the call controls sit in one
// bar at the top, above that panel, and the chat box alone at the bottom (no two stacked rows); what is said on the call shows as
// the newest lines of the panel, never in a separate call window.

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const desk: DeskChat = {
  available: true,
  threadId: "th_desk",
  environmentId: "env_1",
  session: 1,
  status: "idle",
  working: false,
  sending: 0,
  hasEarlier: false,
  messages: Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? "assistant" : "user", kind: "message", status: "completed", text: `line ${i}`, at: new Date().toISOString() })) as DeskChat["messages"],
};

function fakes() {
  const dc: any = { readyState: "open", send: vi.fn(), close: vi.fn() };
  const pc: any = { addTrack: vi.fn(), createDataChannel: () => dc, createOffer: async () => ({ type: "offer", sdp: "o" }), setLocalDescription: vi.fn(async () => undefined), setRemoteDescription: vi.fn(async () => undefined), close: vi.fn(), connectionState: "connected" };
  const track: any = { enabled: true, stop: vi.fn() };
  const mic: any = { getAudioTracks: () => [track], getTracks: () => [track] };
  const m: Media = { microphone: vi.fn(async () => mic), peer: () => pc, exchange: vi.fn(async () => "a"), play: vi.fn() };
  const call = { id: "call_1", costUsd: 0, seconds: 0, usdPerMin: null };
  const voice = {
    start: vi.fn(async () => ({ call: { ...call, startedAt: "" }, clientSecret: "ek_1", expiresAt: 0, model: "gpt-realtime-2.1-mini", limits: { callMaxMin: 20, callWarnMin: 18, quietHangupS: 120, monthCapUsd: 25 } })),
    beat: vi.fn(async () => ({ call, monthUsd: 0 })),
    usage: vi.fn(async () => ({ call, monthUsd: 0 })),
    end: vi.fn(async () => ({ call, monthUsd: 0 })),
    status: vi.fn(async () => ({ text: "" })),
    ask: vi.fn(async () => ({ askId: "q1" })),
    askState: vi.fn(async () => ({ state: "working" as const, waitedMs: 0, spokenWaitMs: 60_000 })),
  } satisfies VoiceApi;
  const state = async (): Promise<VoiceState> => ({ available: true, enabled: true, monthUsd: 0.25, limits: { monthCapUsd: 25, callMaxMin: 20 } });
  const emit = async (ev: unknown) => act(async () => void (dc.onmessage({ data: JSON.stringify(ev) }), await new Promise((r) => setTimeout(r, 0))));
  return { voice, media: () => m, state, dc, emit };
}

function Harness(props: { f: ReturnType<typeof fakes> }) {
  const call = useCallDock({ api: props.f.voice, media: props.f.media, state: props.f.state });
  return <ChatView who="Team desk" load={async () => desk} sendMessage={async () => ({ threadId: "th_desk", pending: false })} placeholder="…" panel top={call.bar} live={call.live} liveKey={call.liveKey} />;
}

describe("T42-S6 call screen keeps the chat in view", () => {
  it("the Team desk page is one screen tall and its history scrolls in its own panel", async () => {
    vi.spyOn(api, "getDeskChat").mockResolvedValue(desk);
    render(
      <MemoryRouter>
        <ChatPage />
      </MemoryRouter>,
    );
    const panel = await screen.findByTestId("chat-scroll");
    expect(screen.getByTestId("chat-page").className).toMatch(/h-\[calc\(var\(--vvh,100dvh\)-6rem-env\(safe-area-inset-top\)-env\(safe-area-inset-bottom\)\)\]/);
    //'s top bar on desktop too (2.75rem),'s room for the phone's bars
    expect(screen.getByTestId("chat-page").className).toMatch(/md:h-\[calc\(var\(--vvh,100dvh\)-5.75rem-env\(safe-area-inset-top\)-env\(safe-area-inset-bottom\)\)\]/);
    expect(panel.className).toMatch(/overflow-y-auto/);
    expect(panel.className).toMatch(/flex-1/);
    expect(within(panel).getByTestId("chat-transcript")).toBeTruthy();
    // The chat box is in the dock under the panel, not inside it.
    expect(within(panel).queryByLabelText("Message to the Team desk")).toBeNull();
    expect(within(screen.getByTestId("chat-dock")).getByLabelText("Message to the Team desk")).toBeTruthy();
  });

  it("the call bar sits on top above the history, the chat box alone at the bottom; on a call Mute and Hang up stay on top and the live lines end the history", async () => {
    const f = fakes();
    render(<Harness f={f} />);
    const dock = await screen.findByTestId("chat-dock");
    const top = screen.getByTestId("chat-top");
    const start = await within(top).findByTestId("call-start");
    const panel0 = screen.getByTestId("chat-scroll");
    // Order on the page: call bar, history panel, chat box; the dock holds no call controls.
    const bar = within(top).getByTestId("call-panel");
    const box = within(dock).getByLabelText("Message to the Team desk");
    expect(bar.compareDocumentPosition(panel0) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel0.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(dock).queryByTestId("call-panel")).toBeNull();

    await act(async () => void fireEvent.click(start));
    await act(async () => void f.dc.onopen());
    await waitFor(() => expect(within(top).getByTestId("call-hangup")).toBeTruthy());
    expect(within(top).getByTestId("call-mute")).toBeTruthy();
    expect(within(dock).queryByTestId("call-hangup")).toBeNull();
    expect(screen.getByTestId("call-panel").dataset.onCall).toBe("true");

    await f.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "i1", transcript: "What's waiting on me?" });
    await f.emit({ type: "response.output_audio_transcript.delta", delta: "Two things" });
    const panel = screen.getByTestId("chat-scroll");
    // The call's lines are the newest lines of the history panel, after the chat's own messages; nothing call-ish outside it but the bar.
    expect(within(panel).getByTestId("call-divider")).toBeTruthy();
    expect(within(panel).getByTestId("call-line-you").textContent).toBe("What's waiting on me?");
    expect(within(panel).getByTestId("call-line-desk").textContent).toBe("Two things");
    expect(within(panel).getByText("line 29").compareDocumentPosition(within(panel).getByTestId("call-divider")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(top).queryByTestId("call-captions")).toBeNull();
    expect(screen.getAllByTestId("call-captions")).toHaveLength(1);
    expect(panel.contains(screen.getByTestId("call-captions"))).toBe(true);

    await act(async () => void fireEvent.click(within(top).getByTestId("call-hangup")));
    await waitFor(() => expect(within(top).getByTestId("call-start")).toBeTruthy());
    expect(within(panel).queryByTestId("call-divider")).toBeNull();
    expect(within(top).getByTestId("call-ended").textContent).toContain("The transcript is in the chat below.");
  });
});
