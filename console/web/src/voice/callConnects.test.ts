import { describe, expect, it, vi } from "vitest";
import { warmOnce, WARM_EVERY_MS } from "./CallPanel";
import { connectingText } from "./connecting";
import { fetchVoiceApi } from "./callApi";

/** the call page asks for the next call's link as it opens (not on every render), and Connecting counts seconds. */
describe("a call connects in a few seconds and shows it is connecting", () => {
  it("asks the console once per call line, again only after a few minutes", () => {
    const warm = vi.fn(async () => ({}));
    const api = { warm } as any;
    expect(warmOnce("/api/voice/t1", api, 1_000)).toBe(true);
    expect(warmOnce("/api/voice/t1", api, 2_000)).toBe(false);
    expect(warmOnce("/api/voice/t2", api, 2_000)).toBe(true);
    expect(warmOnce("/api/voice/t1", api, 1_000 + WARM_EVERY_MS)).toBe(true);
    expect(warm).toHaveBeenCalledTimes(3);
    expect(warmOnce("/api/voice/t3", {} as any, 0)).toBe(false);
  });

  it("the console route: POST <base>/calls/warm", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ warming: true }), { status: 202 }));
    await fetchVoiceApi(f as any, "/api/voice/marketing").warm!();
    expect((f.mock.calls[0] as any)[0]).toBe("/api/voice/marketing/calls/warm");
    expect(((f.mock.calls[0] as any)[1] as RequestInit).method).toBe("POST");
  });

  it("Connecting… with seconds once it takes one", () => {
    expect(connectingText(0)).toBe("Connecting…");
    expect(connectingText(4)).toBe("Connecting… 4 s");
  });
});
