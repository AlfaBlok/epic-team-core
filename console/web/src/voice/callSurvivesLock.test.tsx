// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCallDock, roleOf, type VoiceState } from "./CallPanel";
import type { Media, VoiceApi } from "./engine";
import { whoAnswers } from "./whoAnswers";
import { CallProvider, CallTab, HELD_KEY } from "./CallProvider";
import { noteOn } from "./linkGuard";
import { lostFor } from "./timeLeft";

// The owner: "if the phone gets locked or whatever, the calls drop ... That's a problem." A call stopped beating when the
// phone locked; the tab came back as a new page that no longer held the call, showed "A call is still on ... Hang it up
// here", and the reconnect never ran. Now the tab keeps its call in sessionStorage and a fresh page reconnects by itself.
// And: "the UX should show my mic, the levels of the mic ... the name of the person and like a persona ... a big part of the screen".

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => sessionStorage.clear());

function fakes(state: Partial<VoiceState> = {}) {
  const dc: any = { readyState: "open", send: vi.fn(), close: vi.fn() };
  const pc: any = { addTrack: vi.fn(), createDataChannel: () => dc, createOffer: async () => ({ type: "offer", sdp: "o" }), setLocalDescription: vi.fn(async () => undefined), setRemoteDescription: vi.fn(async () => undefined), close: vi.fn(), connectionState: "connected" };
  const track: any = { enabled: true, stop: vi.fn() };
  const mic: any = { getAudioTracks: () => [track], getTracks: () => [track] };
  const m: Media = { microphone: vi.fn(async () => mic), peer: () => pc, exchange: vi.fn(async () => "a"), play: vi.fn() };
  const call = { id: "call_2", costUsd: 0, seconds: 0, usdPerMin: null };
  const voice = {
    start: vi.fn(async () => ({ call: { ...call, startedAt: "" }, clientSecret: "ek_1", expiresAt: 0, model: "m", limits: { callMaxMin: 20, callWarnMin: 18, quietHangupS: 120, monthCapUsd: 25 } })),
    beat: vi.fn(async () => ({ call, monthUsd: 0 })),
    usage: vi.fn(async () => ({ call, monthUsd: 0 })),
    end: vi.fn(async () => ({ call, monthUsd: 0 })),
    status: vi.fn(async () => ({ text: "" })),
    ask: vi.fn(async () => ({ askId: "q1" })),
    askState: vi.fn(async () => ({ state: "working" as const, waitedMs: 0, spokenWaitMs: 60_000 })),
    endActive: vi.fn(async () => ({ ended: true })),
  } satisfies VoiceApi;
  const st = async (): Promise<VoiceState> => ({ available: true, enabled: true, monthUsd: 0, limits: { monthCapUsd: 25, callMaxMin: 20 }, ...state });
  return { voice, media: () => m, state: st, dc };
}

const W = whoAnswers.socialDeskPartner();
function Dock({ f }: { f: ReturnType<typeof fakes> }) {
  const d = useCallDock({ api: f.voice, media: f.media, state: f.state, callee: W.callee, name: W.shown, label: "Partner", wide: true, base: W.base });
  return (
    <>
      <header>{d.button}</header>
      {d.bar}
    </>
  );
}
const held = () => JSON.parse(sessionStorage.getItem(HELD_KEY(W.base)) ?? "null");

describe("a call survives the phone locking and the page reloading", () => {
  it("while live the tab keeps its call; his hang-up forgets it", async () => {
    const f = fakes();
    render(
      <CallProvider tab={new CallTab()}>
        <Dock f={f} />
      </CallProvider>,
    );
    const startBtn = await screen.findByTestId("call-start-compact");
    await act(async () => void fireEvent.click(startBtn));
    await act(async () => void f.dc.onopen());
    await waitFor(() => expect(held()).toMatchObject({ id: "call_2" }));
    // a release mid-call never reloads the page under it (the chunk reload and links read this check)
    expect(noteOn()).toBe(true);
    await act(async () => void fireEvent.click(screen.getByTestId("call-hangup")));
    await waitFor(() => expect(held()).toBeNull());
    expect(noteOn()).toBe(false);
  });

  it("a fresh page in the same tab hangs the dead call up and reconnects by itself, saying how long we lost him", async () => {
    sessionStorage.setItem(HELD_KEY(W.base), JSON.stringify({ id: "call_1", aliveAt: Date.now() - 65_000 }));
    const f = fakes({ activeCall: { id: "call_1", startedAt: "2026-11-28T00:41:10.787Z" } });
    render(
      <CallProvider tab={new CallTab()}>
        <Dock f={f} />
      </CallProvider>,
    );
    await waitFor(() => expect(f.voice.start).toHaveBeenCalledTimes(1));
    expect(f.voice.endActive).toHaveBeenCalledWith("call_1");
    expect(f.voice.endActive.mock.invocationCallOrder[0]).toBeLessThan(f.voice.start.mock.invocationCallOrder[0]);
    await act(async () => void f.dc.onopen());
    await waitFor(() => expect(screen.getByTestId("call-notice").textContent).toMatch(/^We lost you for 1 min 0[45] s: the phone locked and the page reloaded\. Reconnected at .+; the voice remembers the call\.$/));
    expect(screen.queryByTestId("call-other-hangup")).toBeNull(); // never the "Hang it up here" dead end
    await act(async () => void fireEvent.click(screen.getByTestId("call-hangup")));
  });

  it("another device's call is never touched: the record goes, the Hang up bar stays", async () => {
    sessionStorage.setItem(HELD_KEY(W.base), JSON.stringify({ id: "call_1", aliveAt: Date.now() - 10_000 }));
    const f = fakes({ activeCall: { id: "call_9", startedAt: "2026-11-28T00:41:10.787Z" } });
    render(
      <CallProvider tab={new CallTab()}>
        <Dock f={f} />
      </CallProvider>,
    );
    await screen.findByTestId("call-other-hangup");
    expect(f.voice.start).not.toHaveBeenCalled();
    expect(f.voice.endActive).not.toHaveBeenCalled();
    expect(held()).toBeNull();
  });

  it("a call dropped more than 15 minutes ago does not reconnect by itself", async () => {
    sessionStorage.setItem(HELD_KEY(W.base), JSON.stringify({ id: "call_1", aliveAt: Date.now() - 16 * 60_000 }));
    const f = fakes();
    render(
      <CallProvider tab={new CallTab()}>
        <Dock f={f} />
      </CallProvider>,
    );
    await screen.findByTestId("call-start-compact");
    expect(f.voice.start).not.toHaveBeenCalled();
    expect(held()).toBeNull();
  });

  it("a page closed mid-call (its pagehide) keeps the record, so the reloaded tab reconnects", async () => {
    const tab = new CallTab();
    const f = fakes();
    render(
      <CallProvider tab={tab}>
        <Dock f={f} />
      </CallProvider>,
    );
    const startBtn = await screen.findByTestId("call-start-compact");
    await act(async () => void fireEvent.click(startBtn));
    await act(async () => void f.dc.onopen());
    await waitFor(() => expect(held()).toMatchObject({ id: "call_2" }));
    act(() => tab.pageHide());
    expect(held()).toMatchObject({ id: "call_2", droppedAt: expect.any(Number) });
  });

  it("the lost time counts from the lock, not from the page's last tick", async () => {
    const now = Date.now();
    sessionStorage.setItem(HELD_KEY(W.base), JSON.stringify({ id: "call_1", aliveAt: now - 5_000, hiddenAt: now - 40_000 }));
    const f = fakes({ activeCall: { id: "call_1", startedAt: "2026-11-28T00:41:10.787Z" } });
    render(
      <CallProvider tab={new CallTab()}>
        <Dock f={f} />
      </CallProvider>,
    );
    await waitFor(() => expect(f.voice.start).toHaveBeenCalledTimes(1));
    await act(async () => void f.dc.onopen());
    await waitFor(() => expect(screen.getByTestId("call-notice").textContent).toMatch(/^We lost you for 4[01] seconds:/));
    await act(async () => void fireEvent.click(screen.getByTestId("call-hangup")));
  });

  it("the lost time reads plainly", () => {
    expect(lostFor(40_000)).toBe("40 seconds");
    expect(lostFor(1_000)).toBe("1 second");
    expect(lostFor(125_000)).toBe("2 min 05 s");
  });
});

describe("the call screen: who he talks to, big, and his mic level", () => {
  it("the persona's name and role fill the top of the call, the mic meter under it", async () => {
    const f = fakes();
    render(
      <CallProvider tab={new CallTab()}>
        <Dock f={f} />
      </CallProvider>,
    );
    const startBtn = await screen.findByTestId("call-start-compact");
    await act(async () => void fireEvent.click(startBtn));
    await act(async () => void f.dc.onopen());
    await waitFor(() => expect(screen.getByTestId("call-who").textContent).toBe(`with the ${W.shown}`));
    expect(screen.getByTestId("call-persona").textContent).toContain("Senior partner: your objectives and key results");
    const meter = screen.getByTestId("call-level");
    expect(meter.getAttribute("role")).toBe("meter");
    expect(meter.getAttribute("data-level")).toBe("0");
    await act(async () => void fireEvent.click(screen.getByTestId("call-hangup")));
  });

  it("each line's role", () => {
    expect(roleOf("Acme briefer", "/api/voice/marketing")).toMatch(/^Briefer/);
    expect(roleOf("Team desk partner", "/api/voice/coach")).toMatch(/^Senior partner/);
    expect(roleOf("Team desk line", "/api/voice")).toMatch(/^Desk line/);
    expect(roleOf("manager of Acme: Launch", "/api/objectives/p1/voice")).toMatch(/^Objective manager/);
    expect(roleOf("manager of Spring", "/api/milestones/ms_1/voice")).toMatch(/^Campaign manager/);
  });
});
