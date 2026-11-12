// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
// @ts-expect-error: the Tailwind config is plain JS with no types
import tailwind, { PHONE_MEDIA } from "../../tailwind.config.js";
import { useCallDock, type VoiceState } from "./CallPanel";
import type { Media, VoiceApi } from "./engine";

// on the phone the call buttons are big and easy to hit with cold hands outdoors.
// On a phone (narrow, or a touch screen turned sideways) every call control is 64 px tall with a visible label, Hang up is solid
// red and set apart from Mute by a wide gap; desktop keeps its compact bar.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
  return { voice, media: () => m, state, dc };
}

function Bar(props: { f: ReturnType<typeof fakes> }) {
  return <>{useCallDock({ api: props.f.voice, media: props.f.media, state: props.f.state }).bar}</>;
}

describe("T42-S32 big call buttons on the phone", () => {
  it("the phone variant covers a narrow screen and a phone turned sideways, and leaves the screens (max-sm: keeps working)", () => {
    expect(tailwind.theme.extend.screens).toBeUndefined();
    expect(PHONE_MEDIA).toBe("(max-width: 639.98px), (pointer: coarse) and (max-height: 540px)");
  });

  it("Mute and Hang up are 64 px on a phone with labels, Hang up solid red and set apart (T18-S8: the idle Call is compact)", async () => {
    const f = fakes();
    render(<Bar f={f} />);
    const start = await screen.findByTestId("call-start");
    // the idle Call no longer takes a 64 px row on the phone; the header's compact Call stands for it.
    expect(start.className).toMatch(/phone:hidden/);
    await act(async () => void fireEvent.click(start));
    await act(async () => void f.dc.onopen());
    await waitFor(() => expect(screen.getByTestId("call-hangup")).toBeTruthy());
    const mute = screen.getByTestId("call-mute");
    const hang = screen.getByTestId("call-hangup");
    for (const b of [mute, hang]) expect(b.className).toMatch(/phone:h-16/);
    expect(hang.className).toMatch(/phone:bg-red-700/);
    // The Mute label is read on screen, not only by a screen reader.
    expect(mute.textContent).toContain("Mute");
    expect(mute.querySelector(".sr-only, [class*='sr-only']")).toBeNull();
    // Mute left, Hang up right, a 40 px gap between them.
    expect(screen.getByTestId("call-controls").className).toMatch(/phone:gap-10/);
    expect(mute.compareDocumentPosition(hang) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => void fireEvent.click(hang));
  });
});
