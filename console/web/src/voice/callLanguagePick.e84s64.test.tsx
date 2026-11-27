// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCallDock, type VoiceState } from "./CallPanel";
import type { VoiceApi } from "./engine";
import { fetchVoiceApi } from "./callApi";
import { getCallLang, setCallLang } from "./callLang";

// every call screen has a one-tap language pick (English, Español) beside its Call, kept on this device;
// the call start and the page-open link carry it, so a Spanish call runs on the Spanish voice.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setCallLang("en");
});

function Dock({ st, api }: { st: VoiceState; api: VoiceApi }) {
  const d = useCallDock({ api, state: async () => st, wide: true, callee: "the SocialApp briefer", base: `/t${Math.random()}` });
  return (
    <>
      <header data-testid="head">{d.button}</header>
      {d.bar}
    </>
  );
}

describe("the call's language pick", () => {
  it("shows beside Call, one tap picks Español, kept on the device, and warms the Spanish link", async () => {
    const warm = vi.fn(async () => ({}));
    const api = { start: vi.fn(), beat: vi.fn(), usage: vi.fn(), end: vi.fn(), status: vi.fn(), ask: vi.fn(), askState: vi.fn(), warm } as unknown as VoiceApi;
    render(<Dock st={{ available: true, enabled: true }} api={api} />);
    const head = await screen.findByTestId("head");
    await waitFor(() => expect(head.querySelector('[data-testid="call-lang-es"]')).not.toBeNull());
    const es = head.querySelector('[data-testid="call-lang-es"]') as HTMLButtonElement;
    expect(es.disabled).toBe(false);
    expect(head.querySelector('[data-testid="call-lang-en"]')!.getAttribute("aria-pressed")).toBe("true");
    const before = warm.mock.calls.length;
    fireEvent.click(es);
    expect(getCallLang()).toBe("es");
    expect(localStorage.getItem("call-lang")).toBe("es");
    await waitFor(() => expect(es.getAttribute("aria-pressed")).toBe("true"));
    // every pick on the page follows (the bar's pick too)
    for (const b of screen.getAllByTestId("call-lang-es")) expect(b.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(warm.mock.calls.length).toBeGreaterThan(before));
  });

  it("the call start and the page-open link send the picked language", async () => {
    const seen: { url: string; body: any }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ call: { id: "c" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const api = fetchVoiceApi(f);
    setCallLang("es");
    await api.start();
    await api.warm!();
    expect(seen[0]).toEqual({ url: "/api/voice/calls", body: { lang: "es" } });
    expect(seen[1]).toEqual({ url: "/api/voice/calls/warm", body: { lang: "es" } });
    setCallLang("en");
    await api.start({ section: "S", cards: [] });
    expect(seen[2].body).toEqual({ focus: { section: "S", cards: [] }, lang: "en" });
  });
});
