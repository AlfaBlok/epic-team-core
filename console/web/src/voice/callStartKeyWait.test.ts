import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchVoiceApi, KEY_LATE_TEXT, START_AGAIN_MS } from "./callApi";

// a briefer once said "the console has no ELEVENLABS_API_KEY" while the key was in the vault: a start the console
// answers key_wait, or never answers (restarting), stays on "Connecting…" and starts again.
const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const started = { call: { id: "vc_1" }, provider: "elevenlabs", signedUrl: "wss://x" };

describe("a call start waits for a key Bitwarden is slow to give", () => {
  afterEach(() => vi.useRealTimers());

  it("key_wait, then a restarting console, then the call starts", async () => {
    vi.useFakeTimers();
    const answers = [
      () => res(503, { error: { code: "key_wait", message: "Connecting" } }),
      () => res(502, "bad gateway"),
      () => Promise.reject(new TypeError("fetch failed")),
      () => res(201, started),
    ];
    const f = vi.fn(async () => answers.shift()!());
    const p = fetchVoiceApi(f as never, "/api/voice/marketing").start();
    await vi.runAllTimersAsync();
    await expect(p).resolves.toMatchObject({ call: { id: "vc_1" } });
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("a true no_key is said at once, never retried", async () => {
    const f = vi.fn(async () => res(503, { error: { code: "no_key", message: "the console has no ELEVENLABS_API_KEY" } }));
    await expect(fetchVoiceApi(f as never).start()).rejects.toThrow(/no ELEVENLABS_API_KEY/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a key still not given after every wait says so plainly, never no key", async () => {
    vi.useFakeTimers();
    const f = vi.fn(async () => res(503, { error: { code: "key_wait", message: "Connecting" } }));
    const p = fetchVoiceApi(f as never).start().catch((e) => e);
    await vi.runAllTimersAsync();
    expect(((await p) as Error).message).toBe(KEY_LATE_TEXT);
    expect(f).toHaveBeenCalledTimes(START_AGAIN_MS.length + 1);
  });
});
