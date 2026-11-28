// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCallDock, type VoiceState } from "./CallPanel";
import type { Media, VoiceApi } from "./engine";
import { whoAnswers } from "./whoAnswers";
import { CallProvider } from "./CallProvider";
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

  it("Partner on a workspace's desk reaches the Team desk partner over every objective, never the social product's partner", async () => {
    const src = (await import("../pages/Chat.tsx?raw")).default as string;
    const world = src.slice(src.indexOf("function WorldDesk"), src.indexOf("function TeamDeskChat"));
    expect(world).toContain("partner={deskPartner(true)}");
    expect(world).not.toContain("deskPartner(false)");
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

function Dock({ f, w = whoAnswers.teamDeskPartner() }: { f: ReturnType<typeof fakes>; w?: ReturnType<typeof whoAnswers.teamDeskPartner> }) {
  const d = useCallDock({ api: f.voice, media: f.media, state: f.state, callee: w.callee, name: w.shown, label: "Partner", wide: true, base: w.base });
  return (
    <>
      <header data-testid="head">{d.button}</header>
      {d.bar}
    </>
  );
}

// the owner (27 Nov): "a long objective name is cut short on the call bar". The call bar names
// the objective or campaign in full, the product too, never clipped or an id, and wraps instead of truncating.
describe("the call bar shows the full objective or campaign name", () => {
  const long = "Acme: Launch Acme and Acme Team to the first hundred paying startups before the end of the year with posts every day";
  it("the label is the whole name, the product included", () => {
    expect(whoAnswers.objective("pursuit_9", "Acme: Launch Acme").shown).toBe("manager of Acme: Launch Acme");
    expect(whoAnswers.objective("pursuit_9", long).shown).toBe(`manager of ${long}`);
    expect(whoAnswers.campaign("ms_9", "  Acme:  Spring\n launch ").shown).toBe("manager of Acme: Spring launch");
    expect(whoAnswers.objective("pursuit_9", "").shown).toBe("manager of pursuit_9");
    expect(whoAnswers.socialDeskCall("/api/tenants/t/desk/voice").shown).toBe("SocialApp desk line");
    expect(whoAnswers.socialDeskPartner().shown).toBe("SocialApp partner");
  });
  it("on the call bar, whole and wrapping, never truncated", async () => {
    const f = fakes();
    render(
      <CallProvider>
        <Dock f={f} w={whoAnswers.objective("pursuit_9", long)} />
      </CallProvider>,
    );
    const b = await screen.findByTestId("call-start-compact");
    await act(async () => void fireEvent.click(b));
    await act(async () => void f.dc.onopen());
    await waitFor(() => expect(screen.getByTestId("call-who").textContent).toBe(`with the manager of ${long}`));
    expect(screen.getByTestId("call-with").className).not.toMatch(/truncate/);
    await act(async () => void fireEvent.click(screen.getByTestId("call-hangup")));
  });
});

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
    await waitFor(() => expect(screen.getByTestId("call-who").textContent).toBe("with the Team desk partner"));
    await act(async () => void fireEvent.click(screen.getByTestId("call-hangup")));
  });
});

