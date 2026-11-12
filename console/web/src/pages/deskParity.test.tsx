// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { api, type DeskChat, type Me, type Milestone } from "@/api";
import { ChatPage } from "@/pages/Chat";
import { forgetWorld } from "@/lib/useSocial";
import { SKINS, SkinProvider, type Skin } from "@/lib/skin";

// the social skin's Chat is the world's team desk (no campaign picker, one desk across its
// campaigns, its own routes /api/tenants/<world>/desk/*), so both skins now have the same desk shape; each campaign's own chat
// is its page's Chat tab (the milestone chat). Was's campaign desk with a picker.
// desk parity (the owner 2026-11-02: "the social skin gets the console desk upgrades, so console upgrades flow to the skin
// from now on"). The Team desk (the home world, console skin) and a world's campaign desk (a social world repo, social skin) are rendered in
// the same states (idle, then on a call) and every element the Team desk shows (data-testid, button, labelled control) must
// be on the campaign desk too. A desk upgrade that reaches only the Team desk fails here and names what is missing: put it in
// DeskPage / ChatView / useCallDock (pages/Chat.tsx, voice/CallPanel.tsx), the one desk both skins use, or, only when it
// must not reach a world (the home world data), list it in TEAM_DESK_ONLY with the reason. Inventory: docs/status/e34-s24-desk-parity.md.

/** Team desk features a world's desk must not have, with why. Keep this empty unless a feature would show the home world's data. */
export const TEAM_DESK_ONLY: Record<string, string> = {};

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const now = new Date().toISOString();
/** A desk with every kind of line the chat draws: the seed divider, a page chip, an "updates sent along" chip, a reply still writing, working, a queued send and a failed one. */
const chat = (threadId: string): DeskChat =>
  ({
    available: true,
    threadId,
    environmentId: "env_1",
    session: 1,
    status: "running",
    working: true,
    workingSince: now,
    sending: 1,
    sendError: { text: "T3 refused" },
    hasEarlier: true,
    messages: [
      { id: "s", role: "user", kind: "seed", status: "completed", text: "", at: now, session: 1 },
      { id: "u1", role: "user", kind: "message", status: "completed", text: "What's waiting on me?", at: now, page: "Pipeline", since: "P-0006 posted" },
      { id: "a1", role: "assistant", kind: "message", status: "completed", text: "Two drafts. [P-0006](https://x.com/a)", at: now, truncated: true },
      { id: "a2", role: "assistant", kind: "message", status: "inProgress", text: "Checking", at: now },
    ],
  }) as unknown as DeskChat;

const me = (tenant: string, skin: string) => ({ mode: "on", identity: { kind: "session", role: "owner" }, tenant: { id: tenant, name: tenant, skin }, worlds: [] }) as unknown as Me;
const campaign = { id: "ms_z1", title: "Make Memo heard", repo: "social", path: "docs/spines/epic-1.md", owner: "Sam", paused: false } as unknown as Milestone;

/** Fake WebRTC + microphone, and the console's voice routes (both desks' roots), recorded. */
let calls: string[] = [];
let dc: any;
beforeEach(() => {
  calls = [];
  dc = undefined;
  const track: any = { enabled: true, stop: vi.fn() };
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getAudioTracks: () => [track], getTracks: () => [track] })) } });
  (globalThis as any).RTCPeerConnection = class {
    connectionState = "connected";
    addTrack() {}
    createDataChannel() {
      dc = { readyState: "open", send: vi.fn(), close: vi.fn() };
      return dc;
    }
    async createOffer() {
      return { type: "offer", sdp: "o" };
    }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    close() {}
  };
  const call = { id: "call_1", costUsd: 0.004, seconds: 3, usdPerMin: null };
  const state = { available: true, enabled: true, monthUsd: 0.25, monthMinutes: 4, limits: { monthCapUsd: 5, callMaxMin: 20 }, lastCall: { costUsd: 0.05, seconds: 60, usdPerMin: 0.05 } };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://api.openai.com/")) return new Response("v=0 answer", { status: 201 });
    if (url.endsWith("/voice/state")) return json(state);
    if (/\/voice\/calls$/.test(url) && init?.method === "POST") return json({ call: { ...call, startedAt: now }, clientSecret: "ek_1", expiresAt: 0, model: "gpt-realtime-2.1-mini", limits: { callMaxMin: 20, callWarnMin: 18, quietHangupS: 120, monthCapUsd: 5 } }, 201);
    return json({ call, monthUsd: 0.25 });
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** What a desk shows: every data-testid, every button by name, every labelled control. */
function features(root: HTMLElement): Set<string> {
  const out = new Set<string>();
  for (const el of root.querySelectorAll("[data-testid]")) out.add(`testid:${el.getAttribute("data-testid")}`);
  for (const b of within(root).queryAllByRole("button")) out.add(`button:${(b.textContent ?? "").replace(/\s+/g, " ").trim() || b.getAttribute("aria-label")}`);
  for (const el of root.querySelectorAll("textarea[aria-label], input[aria-label], section[aria-label], [role=status], [role=alert]"))
    out.add(`${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[${el.getAttribute("role")}]` : ""}:${(el.getAttribute("aria-label") ?? "").replace(/Team desk|Campaign desk/, "<desk>")}`);
  return out;
}

async function desk(skin: Skin, world: string): Promise<{ idle: Set<string>; onCall: Set<string>; teamDeskLoads: number; worldDeskLoads: number }> {
  forgetWorld(); // each desk is opened as its own tab (a tab remembers its world)
  vi.spyOn(api as Required<typeof api>, "getMe").mockResolvedValue(me(world, skin.id));
  const teamDesk = vi.spyOn(api, "getDeskChat").mockResolvedValue(chat("th_desk"));
  vi.spyOn(api, "listMilestones").mockResolvedValue([campaign]);
  vi.spyOn(api, "getMilestoneChat").mockResolvedValue(chat("th_campaign"));
  const worldDesk = vi.spyOn(api, "getWorldDeskChat").mockResolvedValue(chat("th_world"));
  const { container, unmount } = render(
    <SkinProvider skin={skin}>
      <MemoryRouter initialEntries={["/chat?page=Pipeline"]}>
        <Routes>
          <Route path="/chat" element={<ChatPage />} />
        </Routes>
      </MemoryRouter>
    </SkinProvider>,
  );
  await screen.findByTestId("chat-working");
  const start = await screen.findByTestId("call-start");
  const idle = features(container);
  await act(async () => void fireEvent.click(start));
  await waitFor(() => expect(dc).toBeTruthy());
  await act(async () => void dc.onopen());
  await act(async () => void dc.onmessage({ data: JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "i1", transcript: "Anything stuck?" }) }));
  await act(async () => void dc.onmessage({ data: JSON.stringify({ type: "response.output_audio_transcript.delta", delta: "Nothing" }) }));
  await screen.findByTestId("call-hangup");
  const onCall = features(container);
  await act(async () => void fireEvent.click(screen.getByTestId("call-hangup")));
  // the call is the tab's, not the page's: let the hang-up finish before the page goes (the next desk reuses the engine).
  await waitFor(() => expect((screen.getByTestId("call-start") as HTMLButtonElement).disabled).toBe(false));
  unmount();
  return { idle, onCall, teamDeskLoads: teamDesk.mock.calls.length, worldDeskLoads: worldDesk.mock.calls.length };
}

const missing = (team: Set<string>, world: Set<string>) => [...team].filter((f) => !world.has(f) && !(f in TEAM_DESK_ONLY));

describe("T34-S24 / T58-S4 desk parity: every Team desk feature is on the social skin's team desk", () => {
  it("idle and on a call, the world's team desk shows everything the Team desk shows", async () => {
    const team = await desk(SKINS.console, "home");
    const teamCalls = calls.splice(0);
    const world = await desk(SKINS.social, "social");
    const worldCalls = calls.splice(0);

    // The check really looked at a full desk (a broken render would compare two empty sets).
    for (const f of ["testid:chat-top", "testid:call-panel", "testid:chat-scroll", "testid:chat-dock", "testid:chat-working", "testid:chat-sending", "testid:chat-send-error", "testid:chat-hint", "testid:chat-divider", "testid:chat-page-chip", "testid:chat-since-chip", "testid:call-month", "button:Call the desk", "button:Send"])
      expect(team.idle, f).toContain(f);
    for (const f of ["testid:call-divider", "testid:call-line-you", "testid:call-line-desk", "testid:call-cost", "button:Hang up", "button:Mute"]) expect(team.onCall, f).toContain(f);

    expect(missing(team.idle, world.idle), "Team desk features missing on the campaign desk (idle)").toEqual([]);
    expect(missing(team.onCall, world.onCall), "Team desk features missing on the campaign desk (on a call)").toEqual([]);

    // Same features, each desk on its own routes: the campaign's chat and Call, never the platform's Team desk or its voice.
    expect(teamCalls.some((c) => c === "POST /api/voice/calls")).toBe(true);
    expect(worldCalls.some((c) => c === "POST /api/tenants/social/desk/voice/calls")).toBe(true);
    expect(worldCalls.filter((c) => /\/api\/voice\//.test(c) || /\/api\/desk\//.test(c))).toEqual([]);
    expect(team.teamDeskLoads).toBeGreaterThan(0);
    expect(world.teamDeskLoads).toBe(0);
    expect(world.worldDeskLoads).toBeGreaterThan(0);
    expect(team.worldDeskLoads).toBe(0);
    // no campaign picker on either desk; the world's desk is its team desk, not one campaign's.
    expect([...world.idle].some((f) => f === "testid:desk-campaign")).toBe(false);
    expect(worldCalls.some((c) => /\/api\/milestones\/[^/]+\/(chat|voice)/.test(c))).toBe(false);
  });

  it("TEAM_DESK_ONLY holds no stale entries (each still names a Team desk feature)", async () => {
    const team = await desk(SKINS.console, "home");
    for (const f of Object.keys(TEAM_DESK_ONLY)) expect(team.idle.has(f) || team.onCall.has(f), f).toBe(true);
  });
});
