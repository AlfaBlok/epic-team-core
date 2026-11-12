// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useState } from "react";
import { api } from "@/api";
import { TeamPage } from "@/pages/Team";
import { useCallDock, type VoiceState } from "./CallPanel";
import type { Media, VoiceApi } from "./engine";

// each Focus milestone card on Team home gets Chat and Call. Chat opens the milestone's chat;
// Call opens it with ?call=1, and the milestone's own voice (its /api/milestones/:id/voice routes) starts by itself, once.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => localStorage.clear());

describe("T42-S14 Team home: Chat and Call on every focus milestone card", () => {
  it("a focus card links Chat to its chat tab and Call to the same tab with the call flag; other milestones have neither", async () => {
    const mk = (title: string, bigRoot?: number) => api.createMilestone({ title, repo: "Acme/home_repo", path: "docs/spines/m2-team-console.md", owner: "Sam", ...(bigRoot ? { bigRoot } : {}) });
    const a = await mk("Talk to the desk", 1);
    await mk("Lanes", 2);
    const other = await mk("Side quest");
    render(
      <MemoryRouter>
        <TeamPage section="settings" />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getAllByTestId("card-talk")).toHaveLength(2));
    const card = screen.getAllByTestId("milestone-card").find((c) => within(c).queryByText("Talk to the desk"))!;
    const chat = within(card).getByTestId("card-chat");
    const call = within(card).getByTestId("card-call");
    expect(chat.getAttribute("href")).toBe(`/milestones/${a.id}?tab=chat`);
    expect(call.getAttribute("href")).toBe(`/milestones/${a.id}?tab=chat&call=1`);
    expect(call.textContent!.trim()).toBe("Call");
    expect(chat.textContent!.trim()).toBe("Chat");
    expect(call.getAttribute("aria-label")).toBe("Call Talk to the desk");
    // Not nested in the card's own link (a link inside a link is invalid and swallows the click).
    expect(call.closest("a")).toBe(call);
    expect(call.parentElement!.closest("a")).toBeNull();
    const plain = screen.getAllByTestId("milestone-card").find((c) => within(c).queryByText(other.title))!;
    expect(within(plain).queryByTestId("card-talk")).toBeNull();
  });
});

function fakes(available = true) {
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
  const state = async (): Promise<VoiceState> => ({ available, enabled: true, monthUsd: 0, limits: { monthCapUsd: 25, callMaxMin: 20 } });
  return { voice, media: () => m, state, dc };
}

function Harness(props: { f: ReturnType<typeof fakes>; autoStart: boolean }) {
  const [cleared, setCleared] = useState(0);
  const call = useCallDock({ api: props.f.voice, media: props.f.media, state: props.f.state, autoStart: props.autoStart, onAutoStart: () => setCleared((n) => n + 1) });
  return (
    <div>
      {call.bar}
      <span data-testid="cleared">{cleared}</span>
    </div>
  );
}

describe("T42-S14 the call flag starts the milestone's voice by itself", () => {
  it("with the flag the call starts once the voice is available, once, and the flag is cleared", async () => {
    const f = fakes();
    const { rerender } = render(<Harness f={f} autoStart />);
    await waitFor(() => expect(f.voice.start).toHaveBeenCalledTimes(1));
    await act(async () => void f.dc.onopen());
    await waitFor(() => expect(screen.getByTestId("call-hangup")).toBeTruthy());
    expect(screen.getByTestId("cleared").textContent).toBe("1");
    rerender(<Harness f={f} autoStart />);
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(f.voice.start).toHaveBeenCalledTimes(1);
  });

  it("no flag, or the voice not available (off, capped, another world): nothing starts by itself", async () => {
    const f = fakes();
    render(<Harness f={f} autoStart={false} />);
    await screen.findByTestId("call-start");
    const off = fakes(false);
    render(<Harness f={off} autoStart />);
    await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
    expect(f.voice.start).not.toHaveBeenCalled();
    expect(off.voice.start).not.toHaveBeenCalled();
  });
});
