// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { CardFeedback } from "@/components/cardFeedback";
import { SentOr } from "@/components/sentRow";
import { resetSent } from "@/lib/sentRows";
import { clearAnswerVoiceState } from "./AnswerVoice";
import { NoteProvider, NoteTab, NoteWidget } from "./NoteProvider";

// E948-S174 (the owner 22 Nov 18:56Z, vn_3b3cf02e): "the moment I press Send, it compacts into this row. It's just that
// instead of saying Sent, it stays spinning until it fully has been sent ... There is no notification or anything."
//
//   [ card, recording ] ──Send──▶ [ ◌ Sending · Voice note ] ──card has it──▶ [ ✓ Sent ]
//                                         └── refused ──▶ [ Not sent yet · why · Send again ]

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
vi.mock("@/voice/noteEngine", async (orig) => ({ ...(await orig<typeof import("./noteEngine")>()), browserNoteMedia: () => fake.media }));

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

let finishGate: Promise<void>;
let openFinish: () => void;
beforeEach(() => {
  resetSent();
  clearAnswerVoiceState();
  finishGate = new Promise((ok) => (openFinish = ok));
  let t = Date.parse("2026-11-22T19:00:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => (t += 1000));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const json = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
      if (url === "/api/voice/state") return json({ enabled: true, monthUsd: 0.2, limits: { monthCapUsd: 25 } });
      if (url === "/api/voice/notes" && method === "POST") return json({ note: { id: "vn_e48s174" }, segmentS: 120, maxMin: 30, usdPerMin: 0.003, monthUsd: 0.2, monthCapUsd: 25 }, 201);
      if (/\/segments\/\d+$/.test(url)) return json({ segment: { n: 0, text: "ship it", costUsd: 0.0003 }, note: { costUsd: 0.0003 } });
      if (url.endsWith("/finish")) {
        await finishGate; // writing out takes a while: the card is already its row
        return json({ note: { id: "vn_e48s174", state: "transcribed", seconds: 6, costUsd: 0.0003, segments: 1, transcript: "ship it" } });
      }
      return json({ error: { message: "not faked" } }, 404);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Card({ send }: { send: (words: string) => Promise<unknown> }) {
  return (
    <SentOr slot="status:s1">
      <div data-testid="the-card">
        <CardFeedback origin="card:s1" title="The logger layout" refName="T4" send={(w) => send(w)} />
      </div>
    </SentOr>
  );
}
const page = (send: (words: string) => Promise<unknown>) =>
  render(
    <MemoryRouter>
      <NoteProvider tab={new NoteTab()}>
        <Card send={send} />
        <NoteWidget />
      </NoteProvider>
    </MemoryRouter>,
  );

async function recordAndSend() {
  const mic = await screen.findByTestId("answer-voice-button");
  fireEvent.click(mic);
  await screen.findByTestId("answer-voice-timer");
  fireEvent.click(screen.getByTestId("answer-voice-button"));
}

describe("E948-S174 a voice note on a card: one row that spins until it is truly sent", () => {
  it("Send collapses the card at once; its row spins (no button spinner, no floating notice) until the card has it, then Sent", async () => {
    let land!: () => void;
    const send = vi.fn(() => new Promise<void>((ok) => (land = ok)));
    page(send);
    await recordAndSend();
    // at once: the card is gone, its one row spins
    const row = await screen.findByTestId("sent-row");
    expect(screen.queryByTestId("the-card")).toBeNull();
    expect(row.dataset.sentState).toBe("sending");
    expect(within(row).getByTestId("sent-row-word").textContent?.trim()).toBe("Sending");
    expect(screen.queryByTestId("note-widget")).toBeNull();
    expect(screen.queryByTestId("after-close-note")).toBeNull();
    expect(screen.queryByText(/✓|Sent ✓/)).toBeNull();
    // written out, handed to the card's press: still spinning until the press answers
    await act(async () => openFinish());
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(screen.getByTestId("sent-row").dataset.sentState).toBe("sending");
    expect(screen.queryByTestId("note-widget")).toBeNull();
    await act(async () => land());
    await waitFor(() => expect(screen.getByTestId("sent-row").dataset.sentState).toBe("sent"));
    expect(within(screen.getByTestId("sent-row")).getByTestId("sent-row-word").textContent).toContain("Sent");
    expect(screen.queryByTestId("note-widget")).toBeNull();
    expect(screen.queryByTestId("the-card")).toBeNull();
  });

  it("a refusal shows on the row with its reason and Send again, which spins the row again and lands it", async () => {
    let n = 0;
    const send = vi.fn(async () => {
      if (n++ === 0) throw new Error("the console is restarting");
    });
    page(send);
    await recordAndSend();
    await act(async () => openFinish());
    await waitFor(() => expect(screen.getByTestId("sent-row").dataset.sentState).toBe("failed"));
    const row = screen.getByTestId("sent-row");
    expect(within(row).getByTestId("sent-row-failed").textContent).toContain("restarting");
    expect(screen.queryByTestId("note-widget")).toBeNull();
    await act(async () => void fireEvent.click(within(row).getByTestId("sent-row-again")));
    await waitFor(() => expect(screen.getByTestId("sent-row").dataset.sentState).toBe("sent"));
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("E948-S174 an empty recording on a card", () => {
  it("says Empty recording, not sent on the row at once: never sending, never waiting, nothing to the card", async () => {
    const empty = fake.media.recorder;
    // the microphone gives no audio at all (0 bytes)
    fake.media.recorder = () => {
      const r: any = { mimeType: "audio/webm", ondataavailable: null, onstop: null, start: () => undefined, stop: () => queueMicrotask(() => (r.ondataavailable?.({ data: new Blob([], { type: "audio/webm" }) }), r.onstop?.())) };
      return r;
    };
    try {
      const send = vi.fn(async () => undefined);
      page(send);
      await recordAndSend();
      await waitFor(() => expect(screen.getByTestId("sent-row").dataset.sentState).toBe("empty"));
      const row = screen.getByTestId("sent-row");
      expect(within(row).getByTestId("sent-row-said").textContent).toBe("Empty recording, not sent");
      expect(within(row).getByTestId("sent-row-word").textContent?.trim()).toBe("Not sent");
      expect(row.querySelector(".animate-spin")).toBeNull();
      expect(send).not.toHaveBeenCalled();
      expect(screen.queryByTestId("note-widget")).toBeNull();
      expect(screen.queryByTestId("note-kept")).toBeNull();
    } finally {
      fake.media.recorder = empty;
    }
  });
});
