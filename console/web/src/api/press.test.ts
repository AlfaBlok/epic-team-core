import { afterEach, describe, expect, it, vi } from "vitest";
import { createRealClient } from "./real";

/**
 * a review button's press carries an Idempotency-Key and is sent again (same key) when a restart's proxy answers
 * 502: the console returns the press it saved, so a deploy never turns a press into an error or a second write.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("T72-S3 a press", () => {
  it("carries an Idempotency-Key; a proxy 502 is retried with the same key; the saved press is followed until it lands", async () => {
    vi.useFakeTimers();
    const replies = [
      new Response("<html>502 Bad Gateway</html>", { status: 502 }),
      new Response(JSON.stringify({ press: { id: "pr_1", state: "landing", message: "Saved, landing…" } }), { status: 202, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({ id: "pr_1", state: "landed", response: { id: "rv_1", state: "approved" } }), { status: 200, headers: { "content-type": "application/json" } }),
    ];
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => replies.shift()!);
    vi.stubGlobal("fetch", fetch);
    const p = createRealClient().approveReviewItem("rv_1");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toEqual({ id: "rv_1", state: "approved" });
    const posts = fetch.mock.calls.filter((c) => (c[1] as RequestInit).method === "POST");
    expect(posts).toHaveLength(2);
    const keys = posts.map((c) => ((c[1] as RequestInit).headers as Record<string, string>)["idempotency-key"]);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(fetch.mock.calls[2][0]).toBe("/api/presses/pr_1");
  });
});
