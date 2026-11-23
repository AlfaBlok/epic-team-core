import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createRealClient, retryRandom } from "./real";

/**
 * A key paste that met a release swap got the proxy's 502 and the card came back empty. A key save now waits out a restart like a GET does; the console's own errors and our 30 s timeout are never resent.
 */
retryRandom.next = () => 0.5;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const proxy502 = () => new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
const saved = { id: "jr_1", stored: { app: "agent-team-console", name: "EXA_API_KEY", deployed: false } };

describe("Save key through a console restart", () => {
  it("a proxy 502 and a refused connection, then the console: the key is saved, sent three times, never shown", async () => {
    vi.useFakeTimers();
    const answers = [() => proxy502(), () => Promise.reject(new TypeError("Failed to fetch")), () => new Response(JSON.stringify(saved), { status: 201 })];
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => answers.shift()!());
    vi.stubGlobal("fetch", fetchMock);
    const p = createRealClient().saveKey("wj_1", { value: "k-secret", milestoneId: "ms_1" });
    await vi.advanceTimersByTimeAsync(1000 + 2000);
    expect(await p).toEqual(saved);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/waiting-on-owner/wj_1/secret");
  });

  it("the console's own 502 (key not stored) is shown at once, not resent", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: "secret_put_failed", message: "key not stored: x" } }), { status: 502 }));
    vi.stubGlobal("fetch", fetchMock);
    const e = await createRealClient().saveKey("wj_1", { value: "k" }).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).message).toBe("key not stored: x");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
