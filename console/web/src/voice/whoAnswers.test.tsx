// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCallDock, type VoiceState } from "./CallPanel";
import type { Media, VoiceApi } from "./engine";
import { whoAnswers } from "./whoAnswers";
import { deskPartner } from "@/pages/Chat";

// the owner 27 Nov: "I'm pressing this button when I'm on my chat, and it says
// Partner. So here, I would expect to be talking to the team desk. But somehow, I was put through to the strategist of one
// objective"; and: "on the call, I should see a name of who I'm talking to".
// The map: where he presses → who answers (the routes and the name on the call screen).

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("who answers each Call, by where he presses it", () => {
  it("the map", () => {
    const map = [
      ["Team desk chat · Partner", deskPartner(true)],
      ["Team desk chat · Call", whoAnswers.teamDeskCall()],
      ["social desk chat · Partner", deskPartner(false)],
      ["an objective's page · Call", whoAnswers.objective("pursuit_1", "Acme: Get 5 testers")],
      ["a campaign's chat · Call", whoAnswers.campaign("ms_1", "Spring launch")],
    ].map(([where, w]) => [where, (w as { base: string }).base, (w as { name: string }).name]);
    expect(map).toEqual([
      ["Team desk chat · Partner", "/api/voice/coach", "Team desk partner"],
      ["Team desk chat · Call", "/api/voice", "Team desk line"],
      ["social desk chat · Partner", "/api/voice/marketing", "SocialApp partner"],
      ["an objective's page · Call", "/api/objectives/pursuit_1/voice", "Get 5 testers manager"],
      ["a campaign's chat · Call", "/api/milestones/ms_1/voice", "Spring launch manager"],
    ]);
  });

  it("Partner in his Team desk chat never reaches the product launch strategist (one objective's call)", () => {
    expect(deskPartner(true).base).not.toBe("/api/voice/strategy");
    expect(deskPartner(true).name).toBe("Team desk partner");
  });
});

function fakes() {
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
  const state = async (): Promise<VoiceState> => ({ available: true, enabled: true, monthUsd: 0, limits: { monthCapUsd: 25, callMaxMin: 20 } });
  return { voice, media: () => m, state, dc };
}

function Dock({ f }: { f: ReturnType<typeof fakes> }) {
  const w = whoAnswers.teamDeskPartner();
  const d = useCallDock({ api: f.voice, media: f.media, state: f.state, callee: w.callee, name: w.name, label: "Partner", wide: true });
  return (
    <>
      <header data-testid="head">{d.button}</header>
      {d.bar}
    </>
  );
}

describe("the call screen says who answers", () => {
  it("before (the button and while it connects) and during the call", async () => {
    const f = fakes();
    render(<Dock f={f} />);
    const b = await screen.findByTestId("call-start-compact");
    expect(b.getAttribute("aria-label")).toBe("Call the Team desk partner");
    await act(async () => void fireEvent.click(b));
    expect(screen.getByTestId("call-who").textContent).toMatch(/Team desk partner/);
    await act(async () => void f.dc.onopen());
    await waitFor(() => expect(screen.getByTestId("call-hangup")).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId("call-who").textContent).toBe("with Team desk partner"));
    await act(async () => void fireEvent.click(screen.getByTestId("call-hangup")));
  });
});
