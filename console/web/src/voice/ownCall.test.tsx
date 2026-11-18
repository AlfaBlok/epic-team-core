// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DeskChat } from "@/api";
import { sayable, useOwnCall } from "./OwnCall";

/**
 * a workspace on its own server calls with the
 * browser's own speech: what the owner says becomes one chat message, the workspace's own AI answers in the chat, and the
 * browser reads the answer aloud. No call or note route of ours is touched.
 */
class FakeRec {
  static last: FakeRec | undefined;
  lang = "";
  interimResults = true;
  continuous = true;
  onresult: ((e: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  start = vi.fn(() => (FakeRec.last = this));
  abort = vi.fn();
  say(text: string) {
    this.onresult?.({ results: [[{ transcript: text }]] });
    this.onend?.();
  }
}
const spoken: string[] = [];
class Utterance {
  lang = "";
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

function Harness(p: { load: () => Promise<DeskChat>; send: (t: string) => Promise<unknown> }) {
  const c = useOwnCall({ load: p.load, send: (t) => p.send(t) });
  return <div>{c.bar}</div>;
}
const chat = (replies: string[]): DeskChat => ({
  available: true,
  working: false,
  sending: 0,
  hasEarlier: false,
  messages: replies.map((t, i) => ({ id: `a${i}`, role: "assistant" as const, kind: "message" as const, text: t, status: "completed" })),
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  spoken.length = 0;
  delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
});

describe("the call of a workspace on its own server", () => {
  it("hears, sends one chat message, and speaks the reply from its own AI", async () => {
    vi.useFakeTimers();
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition = FakeRec;
    vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: { speak: (u: Utterance) => (spoken.push(u.text), setTimeout(() => u.onend?.(), 0)), cancel: vi.fn() },
    });
    let replies = ["hello earlier"];
    const sent: string[] = [];
    render(<Harness load={async () => chat(replies)} send={async (t) => (sent.push(t), (replies = [...replies, "Your first result is green."]))} />);
    fireEvent.click(screen.getByTestId("own-call-start"));
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    expect(screen.getByTestId("own-call-state").textContent).toBe("Listening…");
    await act(async () => FakeRec.last!.say("what is next"));
    await act(async () => void (await vi.advanceTimersByTimeAsync(2100)));
    expect(sent).toEqual(["what is next"]);
    expect(spoken).toEqual(["Listening.", "Your first result is green."]);
    fireEvent.click(screen.getByTestId("own-call-end"));
    expect(screen.getByTestId("own-call-note").textContent).toBe("Call ended.");
  });

  it("a browser that cannot listen says so and sends nothing", () => {
    const send = vi.fn();
    render(<Harness load={async () => chat([])} send={send} />);
    fireEvent.click(screen.getByTestId("own-call-start"));
    expect(screen.getByTestId("own-call-note").textContent).toMatch(/cannot listen/);
    expect(send).not.toHaveBeenCalled();
  });

  it("reads links and marks as plain words", () => {
    expect(sayable("See **[Home](https://x.y/z)** and https://a.b/c")).toBe("See Home and the link in the chat");
  });
});
