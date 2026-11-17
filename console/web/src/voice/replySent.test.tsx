// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { api, type ReviewItem, type WaitingItem } from "@/api";
import { WaitingCard } from "@/components/waiting";
import { WaitingForReview } from "@/components/review";
import { clearAnswerVoiceState, withVoiceNote } from "./AnswerVoice";
import { NoteProvider, NoteTab, NoteWidget } from "./NoteProvider";
import { openText } from "@/test/openText";

// (the owner 2026-11-08: "In a card pane (answer, new iteration with feedback) the owner can record a voice note as his answer,
// transcribed into the reply"): a microphone beside every card box that takes his words. The same
// control as Chat, and Send sends the answer at once through the box's own button, no second press. The reply names the voice
// note and keeps its recording.

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

const AUDIO = "https://team.example.com/api/voice/notes/vn_ab12cd34/audio";
let calls: { url: string; method: string; body?: any }[] = [];
let enabled = true;
let said = "ship it after the tests pass";

beforeEach(() => {
  calls = [];
  enabled = true;
  said = "ship it after the tests pass";
  clearAnswerVoiceState();
  // Each clock read is a second later: the recorded part is long enough to upload.
  let t = Date.parse("2026-11-08T17:00:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => (t += 1000));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, ...(body ? { body } : {}) });
      const json = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
      if (url === "/api/voice/state") return json({ enabled, monthUsd: 0.2, limits: { monthCapUsd: 25 } });
      if (url === "/api/voice/notes" && method === "POST") return json({ note: { id: "vn_ab12cd34" }, segmentS: 120, maxMin: 30, usdPerMin: 0.003, monthUsd: 0.2, monthCapUsd: 25 }, 201);
      if (/\/segments\/\d+$/.test(url)) return json({ segment: { n: 0, text: said, costUsd: 0.0003 }, note: { costUsd: 0.0003 } });
      if (url.endsWith("/finish"))
        return json({ note: { id: "vn_ab12cd34", state: said ? "transcribed" : "empty", seconds: 6, costUsd: 0.0003, segments: 1, ...(said ? { transcript: said } : {}) }, ...(said ? { audio: AUDIO } : {}) });
      return json({ error: { message: "not faked" } }, 404);
    }),
  );
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
const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>);

/** Tap Speak, talk, tap Send note: the answer goes out at once through the box's own button. */
async function speak(root: HTMLElement) {
  const mic = await within(root).findByTestId("answer-voice-button");
  expect(mic.getAttribute("aria-label")).toBe("Record a voice note");
  fireEvent.click(mic);
  await within(root).findByTestId("answer-voice-timer");
  const send = within(root).getByTestId("answer-voice-button");
  expect(send.textContent).toContain("Send note");
  fireEvent.click(send);
}

describe("T72-S8 the reply as it is sent", () => {
  it("what he typed, then his spoken words, then the voice note they came from and its recording", () => {
    expect(withVoiceNote("", { id: "vn_1", transcript: "ship it", audio: "https://x/a" })).toBe("ship it (voice note vn_1, audio https://x/a)");
    expect(withVoiceNote("after the tests", { id: "vn_1", transcript: "ship it" })).toBe("after the tests ship it (voice note vn_1)");
  });
});

describe("T72-S8 + T72-S11 a voice note as the answer on an ask card", () => {
  it("Answer on a question: Send note sends the spoken answer at once, with what was typed, the note's id and recording", async () => {
    const spy = vi.spyOn(api, "respondToWaiting").mockResolvedValue({ id: "jr_1", itemId: "wj_1", kind: "answer", text: "x", delivery: "sent", createdAt: new Date().toISOString() });
    const { container } = wrap(<WaitingCard item={ask()} />);
    openText();
    fireEvent.change(await screen.findByLabelText("Feedback"), { target: { value: "Yes:" } });
    await speak(container);
    await waitFor(() => expect(spy).toHaveBeenCalledWith("wj_1", { kind: "answer", text: `Yes: ship it after the tests pass (voice note vn_ab12cd34, audio ${AUDIO})`, milestoneId: "ms_1", wake: true }));
    // The note went up as a card answer: words back for the card, nothing posted to the chat.
    expect(calls.find((c) => c.url === "/api/voice/notes")?.body).toEqual({ page: expect.stringMatching(/^card T4-A2: \S/), clientId: expect.stringMatching(/^[\w-]{8,64}$/) });
    expect(calls.find((c) => c.url.endsWith("/finish"))?.body).toEqual({ segments: 1, page: expect.stringMatching(/^card T4-A2: \S/), fill: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // an ask card has no Changes wanted any more (its spoken reason went as feedback); a spoken reason now goes with
  // No (kind deny, next test). What stays: Approve is one press with no words, and the microphone is not in the button row.
  it("an approve card: Approve stays one press with no words; the microphone is in the note box, not the buttons", async () => {
    const spy = vi.spyOn(api, "respondToWaiting").mockResolvedValue({ id: "jr_2", itemId: "wj_1", kind: "approve", text: "", delivery: "sent", createdAt: new Date().toISOString() });
    wrap(<WaitingCard item={ask({ ask: "approve", decidable: true, question: "Ship the logger?" })} />);
    expect(within(screen.getByTestId("answer-buttons")).queryByTestId("answer-voice-button")).toBeNull();
    expect(screen.queryByTestId("answer-voice-button")).toBeNull();
    fireEvent.click(screen.getByTestId("approve"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("wj_1", expect.objectContaining({ kind: "approve", text: "" })));
  });

  // No (testid decline, was Decline) opens the note on its first press; its own send is the same No button
  it("No's reason can be spoken and sends itself as deny; while the note is on, the No button waits", async () => {
    const spy = vi.spyOn(api, "respondToWaiting").mockResolvedValue({ id: "jr_3", itemId: "wj_1", kind: "deny", text: "x", delivery: "sent", createdAt: new Date().toISOString() });
    wrap(<WaitingCard item={ask({ ask: "approve", decidable: true, question: "Ship the logger?" })} />);
    fireEvent.click(screen.getByTestId("decline"));
    const pane = screen.getByTestId("answer-decline-box");
    fireEvent.click(await within(pane).findByTestId("answer-voice-button"));
    await within(pane).findByTestId("answer-voice-timer");
    expect((screen.getByTestId("decline") as HTMLButtonElement).disabled).toBe(true);
    expect(within(pane).getByTestId("note-dot")).toBeTruthy();
    fireEvent.click(within(pane).getByTestId("answer-voice-button"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("wj_1", expect.objectContaining({ kind: "deny", text: `ship it after the tests pass (voice note vn_ab12cd34, audio ${AUDIO})` })));
  });

  it("nothing heard sends nothing; Cancel throws the note away; voice switched off shows no microphone", async () => {
    said = "";
    const spy = vi.spyOn(api, "respondToWaiting").mockResolvedValue({ id: "jr_4", itemId: "wj_1", kind: "answer", text: "x", delivery: "sent", createdAt: new Date().toISOString() });
    const { container, unmount } = wrap(<WaitingCard item={ask()} />);
    await speak(container);
    expect((await screen.findByTestId("answer-voice-out")).textContent).toBe("Nothing was heard, so nothing was sent.");
    expect(spy).not.toHaveBeenCalled();
    openText();
    fireEvent.change(screen.getByLabelText("Feedback"), { target: { value: "pino" } });
    fireEvent.click(screen.getByTestId("answer"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("wj_1", expect.objectContaining({ text: "pino" })));
    unmount();
    enabled = false;
    clearAnswerVoiceState();
    wrap(<WaitingCard item={ask({ id: "wj_2" })} />);
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/voice/state").length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByTestId("answer-voice-button")).toBeNull();
  });

  it("Cancel on a card throws the note away and sends nothing", async () => {
    const spy = vi.spyOn(api, "respondToWaiting");
    const { container } = wrap(<WaitingCard item={ask({ id: "wj_3" })} />);
    fireEvent.click(await within(container).findByTestId("answer-voice-button"));
    await within(container).findByTestId("answer-voice-timer");
    fireEvent.click(within(container).getByTestId("note-discard"));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/discard"))).toBe(true));
    expect(spy).not.toHaveBeenCalled();
    expect(within(container).queryByTestId("answer-voice-strip")).toBeNull();
  });

  it("T72-S11: a card note keeps recording when he leaves the page, and Send in the floating pill lands it on that card", async () => {
    const spy = vi.spyOn(api, "respondToWaiting").mockResolvedValue({ id: "jr_5", itemId: "wj_5", kind: "answer", text: "x", delivery: "sent", createdAt: new Date().toISOString() });
    render(
      <NoteProvider tab={new NoteTab()}>
        <MemoryRouter initialEntries={["/"]}>
          <Link to="/runs">Runs</Link>
          <Routes>
            <Route path="/" element={<WaitingCard item={ask({ id: "wj_5" })} />} />
            <Route path="/runs" element={<p data-testid="runs">Runs page</p>} />
          </Routes>
          <NoteWidget />
        </MemoryRouter>
      </NoteProvider>,
    );
    openText();
    fireEvent.change(await screen.findByLabelText("Feedback"), { target: { value: "Use pino." } });
    fireEvent.click(await screen.findByTestId("answer-voice-button"));
    await screen.findByTestId("answer-voice-timer");
    expect(screen.queryByTestId("note-widget")).toBeNull();
    fireEvent.click(screen.getByText("Runs"));
    await screen.findByTestId("runs");
    const pill = await screen.findByTestId("note-widget");
    expect(pill.dataset.phase).toBe("recording");
    expect(screen.getByTestId("note-widget-to").textContent).toBe("to: Which logger should we use?");
    expect(screen.getByTestId("note-widget-back").getAttribute("href")).toBe("/");
    expect(calls.some((c) => c.url.endsWith("/discard"))).toBe(false);
    fireEvent.click(screen.getByTestId("note-widget-send"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("wj_5", expect.objectContaining({ kind: "answer", text: `Use pino. ship it after the tests pass (voice note vn_ab12cd34, audio ${AUDIO})` })));
    await waitFor(() => expect(screen.getByTestId("note-widget").textContent).toContain("Sent to Which logger should we use?"));
  });

  it("the microphone is a 44 px target on the phone (E948-S60: 44 px and labelled on every screen)", async () => {
    wrap(<WaitingCard item={ask({ id: "wj_4" })} />);
    expect((await screen.findByTestId("answer-voice-button")).className).toMatch(/\bh-11\b/);
  });
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

describe("T72-S8 a voice note on a review card", () => {
  const mount = () => {
    vi.spyOn(api, "listReviewItems").mockImplementation(async (q?: { state?: string }) => (q?.state ? [] : [ITEM]));
    return render(
      <MemoryRouter>
        <WaitingForReview fold="review" />
      </MemoryRouter>,
    );
  };

  // Give feedback (was Not yet, ↻ Changes wanted) opens the note box; the spoken words' Send starts the new round
  it("Give feedback: the spoken words' Send starts the new round with them and the note", async () => {
    const relaunch = vi.spyOn(api, "relaunchReviewItem").mockResolvedValue({ ...ITEM, state: "relaunched" });
    mount();
    const c = await screen.findByTestId("review-card");
    await speak(c);
    await waitFor(() => expect(relaunch).toHaveBeenCalledWith("rv_1", `ship it after the tests pass (voice note vn_ab12cd34, audio ${AUDIO})`));
    expect(calls.find((x) => x.url === "/api/voice/notes")?.body).toEqual({ page: expect.stringMatching(/^card T972-D4: \S/), clientId: expect.stringMatching(/^[\w-]{8,64}$/) });
  });

  it("Decline (under More): the spoken reason's Send declines", async () => {
    const deny = vi.spyOn(api, "denyReviewItem").mockResolvedValue({ ...ITEM, state: "denied" });
    mount();
    const c = await screen.findByTestId("review-card");
    fireEvent.click(within(c).getByTestId("review-title"));
    fireEvent.click(within(c).getByTestId("review-deny"));
    await speak(within(c).getByTestId("review-deny-panel"));
    await waitFor(() => expect(deny).toHaveBeenCalledWith("rv_1", `ship it after the tests pass (voice note vn_ab12cd34, audio ${AUDIO})`));
  });
});
