// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type ReviewItem, type WaitingItem } from "@/api";
import { WaitingCard } from "@/components/waiting";
import { WaitingForReview } from "@/components/review";
import { SKINS, SkinProvider, type SkinId } from "@/lib/skin";
import { forgetWorld } from "@/lib/useSocial";
import { clearAnswerVoiceState } from "@/voice/AnswerVoice";
import { deskVoiceBase, forgetDeskVoiceWorld } from "@/voice/deskBase";

// (the owner 2026-11-10: "Is Epic Social like on an old version of Epic Team? I'm not seeing voice notes, buttons and so
// on"): both skins run one release and one card, chat and recorder code; the skin only picks words, colours and screens. This
// test renders the same ask card and the same review card in the EpicTeam skin (the home world's world) and the social product skin (a
// customer world) and fails when a control is on one and not the other. Before every card box recorded on the home world's
// /api/voice, which another world is refused (403 world_scope), so the social product's cards had no microphone.

const fake = vi.hoisted(() => {
  const track: any = { stop: () => undefined, readyState: "live", muted: false, addEventListener: () => undefined };
  const stream: any = { getAudioTracks: () => [track], getTracks: () => [track] };
  return {
    media: {
      microphone: async () => stream,
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
        return r;
      },
    },
  };
});
vi.mock("@/voice/noteEngine", async (orig) => ({ ...(await orig<typeof import("@/voice/noteEngine")>()), browserNoteMedia: () => fake.media }));

vi.mock("@/voice/noteEngine", async (orig) => ({ ...(await orig<typeof import("@/voice/noteEngine")>()), browserNoteMedia: () => fake.media }));

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;


const AUDIO = "https://social.example.com/api/tenants/social/desk/voice/notes/vn_ab12cd34/audio";
const SKIN_WORLD: Record<SkinId, string> = { console: "home", social: "social" };
let calls: { url: string; method: string; body?: any }[] = [];

function as(skin: SkinId) {
  const world = SKIN_WORLD[skin];
  const base = deskVoiceBase(world);
  vi.spyOn(api as Required<typeof api>, "getMe").mockResolvedValue({ mode: "on", identity: { kind: "session" }, tenant: { id: world, name: "Sam", skin } } as never);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, ...(body ? { body } : {}) });
      const json = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
      // the server's rule (auth/routeScope.ts): only the home world reaches /api/voice; a world reaches its own desk's voice routes
      if (!url.startsWith(base)) return json({ error: { code: "world_scope" } }, 403);
      if (url === `${base}/state`) return json({ enabled: true, monthUsd: 0.2, limits: { monthCapUsd: 25 } });
      if (url === `${base}/notes` && method === "POST") return json({ note: { id: "vn_ab12cd34" }, segmentS: 120, maxMin: 30, usdPerMin: 0.003, monthUsd: 0.2, monthCapUsd: 25 }, 201);
      if (/\/segments\/\d+$/.test(url)) return json({ segment: { n: 0, text: "ship it", costUsd: 0.0003 }, note: { costUsd: 0.0003 } });
      if (url.endsWith("/finish")) return json({ note: { id: "vn_ab12cd34", state: "transcribed", seconds: 6, costUsd: 0.0003, segments: 1, transcript: "ship it" }, audio: AUDIO });
      return json({ error: { message: "not faked" } }, 404);
    }),
  );
}

beforeEach(() => {
  calls = [];
  forgetWorld();
  forgetDeskVoiceWorld();
  clearAnswerVoiceState();
  let t = Date.parse("2026-11-10T21:00:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => (t += 1000));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ask = (over: Partial<WaitingItem> = {}): WaitingItem => ({
  id: "wj_1",
  code: "T4-A2",
  source: "ask",
  state: "open",
  who: "Sam",
  row: "T4",
  milestoneId: "ms_1",
  milestoneTitle: "E904",
  nodeKey: "ms_1/T4",
  path: "docs/E904.md",
  title: "T4 Pick the logger layout",
  ask: "provide",
  question: "Which logger should we use?",
  options: [],
  contextLinks: [],
  owner: { kind: "delivery-manager", assignmentId: "as_1", personaName: "Delivery Manager", label: "Delivery Manager", threadId: "th_1" },
  since: new Date(Date.parse("2026-11-06T10:00:00Z")).toISOString(),
  decidable: false,
  ...over,
});
const FACE = {
  project: { name: "The TEST project", url: "https://team.example.com/" },
  goal: { text: "Try every button on a TEST card", code: "PLAN-972" },
  tasks: { done: 1, total: 2 },
  title: "A TEST card was put up to try a spoken answer.",
  taskGoal: "Sam can answer any card by voice.",
  delivered: [{ ok: true, text: "The microphone is on every card box." }],
  evidence: { url: "https://team.example.com", label: "Open the Team home" },
  screenshot: "docs/status/test.png",
  tree: [],
  after: "",
  next: [],
  closesGoal: false,
  openInGoal: [],
};
const ITEM = {
  id: "rv_1",
  title: "TEST card",
  liveUrl: "https://team.example.com",
  ref: "T972-D4",
  repo: "e67-feedback-test",
  path: "docs/spines/press-test.md",
  cardPath: "docs/cards/T972-D4.md",
  milestoneId: "ms_1",
  state: "review",
  status: "review",
  liveStatus: 200,
  checkedAt: "2026-11-08T17:00:00Z",
  createdAt: "2026-11-08",
  verdict: { kind: "card" },
  face: FACE,
} as unknown as ReviewItem;


const inSkin = (skin: SkinId, ui: React.ReactNode) =>
  render(
    <SkinProvider skin={SKINS[skin]}>
      <MemoryRouter>{ui}</MemoryRouter>
    </SkinProvider>,
  );

/** What a card offers him: every test id and every button's name, once the microphone is in. */
async function controls(root: () => HTMLElement, open?: (c: HTMLElement) => void): Promise<string[]> {
  const c = root();
  open?.(c);
  await within(root()).findByTestId("answer-voice-button");
  const r = root();
  const ids = [...r.querySelectorAll("[data-testid]")].map((e) => `id:${e.getAttribute("data-testid")}`);
  const buttons = [...r.querySelectorAll("button")].map((b) => `button:${(b.getAttribute("aria-label") || b.textContent || "").trim()}`);
  return [...new Set([...ids, ...buttons])].sort();
}

const CARDS: { name: string; mount: () => void; root: () => HTMLElement; open?: (c: HTMLElement) => void }[] = [
  { name: "a question (Answer)", mount: () => void inSkin(skinNow, <WaitingCard item={ask()} />), root: () => document.body },
  // two buttons per card; the second's first press opens the note box (was Changes wanted's own box)
  { name: "an approval (Approve, No with its note)", mount: () => void inSkin(skinNow, <WaitingCard item={ask({ ask: "approve", decidable: true, question: "Ship the logger?" })} />), root: () => document.body, open: () => fireEvent.click(screen.getByTestId("decline")) },
  {
    name: "a finished task (Mark complete, Give feedback with its note)",
    mount: () => {
      vi.spyOn(api, "listReviewItems").mockImplementation(async (q?: { state?: string }) => (q?.state ? [] : [ITEM]));
      inSkin(skinNow, <WaitingForReview fold="review" />);
    },
    root: () => screen.getByTestId("review-card"),
    open: (c) => fireEvent.click(within(c).getByTestId("review-iteration")),
  },
];
let skinNow: SkinId = "console";

describe("T101-S5 one card in both skins", () => {
  for (const card of CARDS)
    it(`${card.name}: the SocialApp card has every control the EpicTeam card has, the microphone included`, async () => {
      const seen: Record<string, string[]> = {};
      for (const skin of ["console", "social"] as SkinId[]) {
        skinNow = skin;
        forgetWorld();
        forgetDeskVoiceWorld();
        clearAnswerVoiceState();
        as(skin);
        card.mount();
        if (card.name.startsWith("a finished")) await screen.findByTestId("review-card");
        seen[skin] = await controls(card.root, card.open);
        cleanup();
        vi.unstubAllGlobals();
      }
      expect(seen.social).toContain("id:answer-voice-button");
      expect(seen.social).toEqual(seen.console);
    });

  it("an SocialApp card records on its world's desk, never on home's /api/voice", async () => {
    skinNow = "social";
    as("social");
    const spy = vi.spyOn(api, "respondToWaiting").mockResolvedValue({ id: "jr_1", itemId: "wj_1", kind: "answer", text: "x", delivery: "sent", createdAt: new Date().toISOString() });
    inSkin("social", <WaitingCard item={ask()} />);
    const mic = await screen.findByTestId("answer-voice-button");
    fireEvent.click(mic);
    await screen.findByTestId("answer-voice-timer");
    fireEvent.click(screen.getByTestId("answer-voice-button"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("wj_1", expect.objectContaining({ kind: "answer", text: `ship it (voice note vn_ab12cd34, audio ${AUDIO})` })));
    expect(calls.some((c) => c.url === "/api/tenants/social/desk/voice/notes" && c.method === "POST")).toBe(true);
    expect(calls.some((c) => c.url.startsWith("/api/voice") && c.method === "POST")).toBe(false);
  });

  it("the voice base: home's Team desk, any other world its own desk", () => {
    expect(deskVoiceBase(undefined)).toBe("/api/voice");
    expect(deskVoiceBase("home")).toBe("/api/voice");
    expect(deskVoiceBase("social")).toBe("/api/tenants/social/desk/voice");
  });
});
