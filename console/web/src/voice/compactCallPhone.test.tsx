// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCallDock, type VoiceState } from "./CallPanel";
import type { Media, VoiceApi } from "./engine";

// on the phone the chat history gets the screen. The idle call bar folds away on a
// phone and a compact Call (44 px, in the page's header row) stands for it; on a call, or when the bar has something the owner must
// read, the bar comes back. Desktop keeps the bar.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function fakes(over: Partial<VoiceState> = {}) {
  const dc: any = { readyState: "open", send: vi.fn(), close: vi.fn() };
  const pc: any = { addTrack: vi.fn(), createDataChannel: () => dc, createOffer: async () => ({ type: "offer", sdp: "o" }), setLocalDescription: vi.fn(async () => undefined), setRemoteDescription: vi.fn(async () => undefined), close: vi.fn(), connectionState: "connected" };
  const track: any = { enabled: true, stop: vi.fn() };
  const mic: any = { getAudioTracks: () => [track], getTracks: () => [track] };
  const m: Media = { microphone: vi.fn(async () => mic), peer: () => pc, exchange: vi.fn(async () => "a"), play: vi.fn() };
  const call = { id: "call_1", costUsd: 0, seconds: 0, usdPerMin: null };
  const voice = {
    start: vi.fn(async () => ({ call: { ...call, startedAt: "" }, clientSecret: "ek_1", expiresAt: 0, model: "m", limits: { callMaxMin: 20, callWarnMin: 18, quietHangupS: 120, monthCapUsd: 25 } })),
    beat: vi.fn(async () => ({ call, monthUsd: 0 })),
    usage: vi.fn(async () => ({ call, monthUsd: 0 })),
    end: vi.fn(async () => ({ call, monthUsd: 0 })),
    status: vi.fn(async () => ({ text: "" })),
    ask: vi.fn(async () => ({ askId: "q1" })),
    askState: vi.fn(async () => ({ state: "working" as const, waitedMs: 0, spokenWaitMs: 60_000 })),
  } satisfies VoiceApi;
  const state = async (): Promise<VoiceState> => ({ available: true, enabled: true, monthUsd: 3.1, limits: { monthCapUsd: 25, callMaxMin: 20 }, ...over });
  return { voice, media: () => m, state, dc };
}

function Dock({ f }: { f: ReturnType<typeof fakes> }) {
  const d = useCallDock({ api: f.voice, media: f.media, state: f.state });
  return (
    <>
      <header data-testid="head">{d.button}</header>
      {d.bar}
    </>
  );
}

describe("T18-S8 compact Call on the phone", () => {
  it("idle: the bar folds away on a phone, the compact Call shows only there, names whom it calls and starts the call", async () => {
    const f = fakes();
    render(<Dock f={f} />);
    const compact = await screen.findByTestId("call-start-compact");
    expect(compact.className).toMatch(/\bhidden\b/);
    expect(compact.className).toMatch(/phone:inline-flex/);
    expect(compact.className).toMatch(/h-11/);
    expect(compact.getAttribute("aria-label")).toBe("Call the desk");
    expect(compact.getAttribute("title")).toContain("$3.10 of $25.00");
    expect(screen.getByTestId("call-panel").className).toMatch(/phone:hidden/);
    await act(async () => void fireEvent.click(compact));
    await act(async () => void f.dc.onopen());
    await waitFor(() => expect(screen.getByTestId("call-hangup")).toBeTruthy());
    // On a call: the bar is back (big Mute and Hang up), the compact Call is gone.
    expect(screen.getByTestId("call-panel").className).not.toMatch(/phone:hidden/);
    expect(screen.queryByTestId("call-start-compact")).toBeNull();
    await act(async () => void fireEvent.click(screen.getByTestId("call-hangup")));
  });

  it("a reason Sam must read keeps the bar on the phone", async () => {
    const f = fakes({ available: false, reason: "Voice is off in the console." });
    render(<Dock f={f} />);
    await screen.findByTestId("call-reason");
    expect(screen.getByTestId("call-panel").className).not.toMatch(/phone:hidden/);
    expect((screen.getByTestId("call-start-compact") as HTMLButtonElement).disabled).toBe(true);
  });
});
