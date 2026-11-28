import { describe, expect, it, vi } from "vitest";
import { again, fetchVoiceApi, frontDoorFailed } from "./callApi";

/**
 * on his calls of 28 Nov the hop in front of the console answered 502 for a moment: the relay of his feedback
 * (call_a41d905a, "the console answered an error") and the first handover (call_2332dcc1) were lost. A step safe to send
 * twice is sent again on a front-door failure, with the same relay key, so it lands once.
 */
const res = (status: number, body?: unknown) => new Response(body === undefined ? "<html>502 Bad Gateway</html>" : JSON.stringify(body), { status, headers: body === undefined ? {} : { "content-type": "application/json" } });

describe("a call step the front door dropped is sent again", () => {
  it("a 502 with no answer of the console's own, or a dropped connection, is the front door; the console's own refusal is not", () => {
    expect(frontDoorFailed(Object.assign(new Error("console answered 502"), { status: 502 }))).toBe(true);
    expect(frontDoorFailed(new TypeError("Load failed"))).toBe(true);
    expect(frontDoorFailed(Object.assign(new Error("ElevenLabs refused"), { status: 502, code: "elevenlabs_refused" }))).toBe(false);
    expect(frontDoorFailed(Object.assign(new Error("call ended"), { status: 409, code: "call_ended" }))).toBe(false);
  });

  it("gives up after its few tries and says why", async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error("console answered 502"), { status: 502 });
    });
    await expect(again(send, [1, 1], async () => undefined)).rejects.toThrow("console answered 502");
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("the relay goes again after a 502 with the same key, and lands", async () => {
    const bodies: string[] = [];
    let n = 0;
    const f = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return ++n === 1 ? res(502) : res(201, { desk: "team", state: "sent", result: "Passed to the Team desk." });
    }) as unknown as typeof fetch;
    const api = fetchVoiceApi(f, "/api/voice/marketing");
    const r = await api.relay!("call_x", { desk: "team", words: "You're going too fast" });
    expect(r.result).toBe("Passed to the Team desk.");
    expect(bodies).toHaveLength(2);
    const [a, b] = bodies.map((x) => JSON.parse(x));
    expect(a.key).toMatch(/^r/);
    expect(b.key).toBe(a.key);
  });

  it("the switch and the hang-up go again too; a 409 of the console's own is never sent twice", async () => {
    let n = 0;
    const f = vi.fn(async (u: RequestInfo | URL) => (String(u).endsWith("/lookup") && ++n === 1 ? res(502) : String(u).endsWith("/end") ? res(409, { error: { code: "call_ended", message: "ended" } }) : res(200, { name: "switch_to", result: "{}" }))) as unknown as typeof fetch;
    const api = fetchVoiceApi(f, "/api/voice/coach");
    await expect(api.lookup!("call_x", "switch_to", { to: "Buy a house" })).resolves.toMatchObject({ name: "switch_to" });
    await expect(api.end("call_x", { reason: "bye", transcript: [] })).rejects.toThrow("ended");
    expect((f as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) => String(c[0]).endsWith("/end"))).toHaveLength(1);
  }, 15_000);
});
