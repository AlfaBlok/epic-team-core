// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { NoteProvider, NoteTab } from "./NoteProvider";
import { useAnswerVoice } from "./AnswerVoice";
import { clearNoteState, noteState, STATE_RETRY_MS } from "./useNote";

// (the owner 2026-11-12: "Why microphone gone from this box??"): a card box asked the console once whether voice is
// on, and a lost request (a phone page waking up) was kept as "off", so the box had no microphone until a reload.

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearNoteState();
});

const ON = { enabled: true, monthUsd: 1, limits: { monthCapUsd: 25 } };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

function Box() {
  const v = useAnswerVoice({ origin: "review:rv_1:changes", to: "a card", page: "card E907-S3", typed: "", deliver: async () => undefined });
  return <div data-testid="box">{v.button}</div>;
}
const show = () =>
  render(
    <MemoryRouter>
      <NoteProvider tab={new NoteTab()}>
        <Box />
      </NoteProvider>
    </MemoryRouter>,
  );
const mic = () => screen.queryByTestId("answer-voice-button");
const settle = () => act(async () => void (await Promise.resolve()));

describe("a card box's microphone after a lost voice read", () => {
  it("comes back by itself when the first read had no network", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("Load failed")).mockResolvedValue(json(ON));
    vi.stubGlobal("fetch", fetch);
    show();
    for (let i = 0; i < 5; i++) await settle();
    expect(mic()).toBeNull();
    await act(async () => void vi.advanceTimersByTime(STATE_RETRY_MS[0]));
    for (let i = 0; i < 5; i++) await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(mic()).not.toBeNull();
  });

  it("comes back when the page is looked at again after a 5xx", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({}, 502)).mockResolvedValue(json(ON));
    vi.stubGlobal("fetch", fetch);
    show();
    for (let i = 0; i < 5; i++) await settle();
    expect(mic()).toBeNull();
    await act(async () => void window.dispatchEvent(new Event("focus")));
    for (let i = 0; i < 5; i++) await settle();
    expect(mic()).not.toBeNull();
  });

  it("a lost read is never kept for the next box, a clear no is", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("Load failed")).mockResolvedValue(json({ error: { code: "world_scope" } }, 403));
    vi.stubGlobal("fetch", fetch);
    expect(await noteState("/api/voice")).toEqual({ enabled: false, unknown: true });
    expect(await noteState("/api/voice")).toBeUndefined();
    expect(await noteState("/api/voice")).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stays off without asking again when the console says voice is off", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue(json({ enabled: false }));
    vi.stubGlobal("fetch", fetch);
    show();
    for (let i = 0; i < 5; i++) await settle();
    await act(async () => void vi.advanceTimersByTime(60_000));
    expect(mic()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
