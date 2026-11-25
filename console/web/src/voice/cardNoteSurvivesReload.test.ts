// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NoteClock, NoteMedia, NotesApi } from "./noteShared";

// (the owner 25 Nov: "I click voice, and then I follow the link ... and then I click back, and
// then I land where the voice note started ... right now ... it reloads the app"): his installed phone app goes to the back
// while a card link's page is in front, and the phone may reload it there. A card's note was held only in memory, so the
// reload lost it. Now a card's note is kept on the phone like a chat's: after the reload it is back, paused, on its card,
// with where it started, and Send lands it on that card (or on the card's row when the card is not shown).

const api = {
  start: vi.fn(async () => ({ note: { id: "vn_card" }, segmentS: 120, maxMin: 30, usdPerMin: 0.003, monthUsd: 0, monthCapUsd: 25 })),
  segment: vi.fn(async (_id: string, n: number) => ({ segment: { n, text: "the tiers look right", costUsd: 0 }, note: { costUsd: 0 } })),
  finish: vi.fn(async (_id: string, segments: number) => ({ note: { id: "vn_card", state: "transcribed", transcript: "the tiers look right", seconds: 20, costUsd: 0, segments } })),
  discard: vi.fn(async () => ({})),
  state: vi.fn(async () => "recording"),
} satisfies NotesApi;

function media(): NoteMedia {
  const track: any = { stop: vi.fn(), readyState: "live", muted: false, addEventListener: () => undefined };
  const stream: any = { getAudioTracks: () => [track], getTracks: () => [track] };
  return {
    microphone: vi.fn(async () => stream),
    recorder: () => {
      const r: any = {
        mimeType: "audio/webm;codecs=opus",
        ondataavailable: null,
        onstop: null,
        start: () => undefined,
        stop: () =>
          queueMicrotask(() => {
            r.ondataavailable?.({ data: new Blob(["said".repeat(4000)], { type: "audio/webm" }) });
            r.onstop?.();
          }),
      };
      return r;
    },
  };
}

vi.mock("./noteEngine", async (orig) => {
  const m = await orig<typeof import("./noteEngine")>();
  return { ...m, fetchNotesApi: () => api, browserNoteMedia: () => media() };
});

const { NoteTab } = await import("./NoteProvider");

/** a clock he talks against: 20 seconds pass in `talk`. */
function clock() {
  const c = { t: Date.now(), ticks: [] as (() => void)[] };
  const nc: NoteClock = {
    now: () => c.t,
    every: (_ms, fn) => {
      c.ticks.push(fn);
      return () => (c.ticks = c.ticks.filter((f) => f !== fn));
    },
  };
  const talk = async (s = 20) => {
    for (let i = 0; i < s * 4; i++) {
      c.t += 250;
      for (const f of [...c.ticks]) f();
    }
    await settle();
  };
  return { nc, talk };
}

const settle = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe("a card's voice note survives the installed app being reloaded behind a link's page", () => {
  it("comes back paused on its card after a reload, and Send lands it on the card's row when the card is gone", async () => {
    // before the reload: Voice pressed on a card on /inbox
    const before = new NoteTab(undefined);
    const k = clock();
    const h = before.note("review:rv_tiers:changes", { fill: true, base: "/api/voice", to: "Prices", clock: k.nc });
    h.deliver = vi.fn(async () => undefined);
    h.page = "card rv_tiers: Prices";
    h.card = { repo: "repo1", row: "E907-S3" } as never;
    before.started(h, "/inbox?focus=rv_tiers");
    await h.engine.start(h.page);
    await k.talk();
    expect(h.engine.view().phase).toBe("recording");
    // the page goes to the back (the link's page is in front): what was said is closed and kept
    await h.engine.pageVisible(false);
    await settle();
    expect(localStorage.getItem("voice-note-open:review:rv_tiers:changes")).toContain("vn_card");

    // the phone reloads the app: a new tab owner, nothing in memory
    const toCard = vi.fn(async () => ({}));
    const toDesk = vi.fn(async () => ({}));
    const after = new NoteTab(undefined, toDesk, toCard);
    after.restore();
    await settle(40);
    const back = after.get("review:rv_tiers:changes");
    expect(back).toBeDefined();
    expect(back!.engine.view().phase).toBe("paused");
    expect(back!.route).toBe("/inbox?focus=rv_tiers");
    expect(back!.card).toMatchObject({ row: "E907-S3" });

    // he taps Send in the pill (the card is not on screen): it lands on the card's row, never lost
    after.finish(back!);
    await settle(60);
    expect(api.finish).toHaveBeenCalled();
    expect(toCard).toHaveBeenCalledWith(expect.objectContaining({ row: "E907-S3" }), expect.stringContaining("vn_card"), "card-note:vn_card");
    expect(localStorage.getItem("voice-note-open:review:rv_tiers:changes")).toBeNull();
  });

  it("when the card shows again, its own press takes the note", async () => {
    const before = new NoteTab(undefined);
    const k = clock();
    const h = before.note("review:rv_b:changes", { fill: true, base: "/api/voice", to: "B", clock: k.nc });
    h.deliver = vi.fn(async () => undefined);
    before.started(h, "/inbox");
    await h.engine.start("card rv_b");
    await k.talk();
    await h.engine.pageVisible(false);
    await settle();

    const toCard = vi.fn(async () => ({}));
    const after = new NoteTab(undefined, undefined, toCard);
    after.restore();
    await settle(40);
    const back = after.get("review:rv_b:changes")!;
    // the card's control mounts and hooks its press (useNote does this)
    const press = vi.fn(async () => undefined);
    back.deliver = press;
    after.finish(back);
    await settle(60);
    expect(press).toHaveBeenCalledTimes(1);
    expect(toCard).not.toHaveBeenCalled();
  });
});
