import { afterEach, describe, expect, it, vi } from "vitest";
import { pollWhileVisible } from "@/lib/data";
import { createRealClient, RETRY_DELAYS_MS, retryRandom } from "@/api/real";

/**
 * the owner's Mac kept ~8
 * console tabs polling ~25 lists every 30 s whether shown or not (~330 requests a minute). A hidden tab stops polling and
 * catches up once when it is shown again; a visible tab polls as before.
 */
function fakeDoc(state: "visible" | "hidden" = "visible") {
  const fns = new Set<() => void>();
  return {
    visibilityState: state as DocumentVisibilityState,
    addEventListener: (_t: string, f: () => void) => void fns.add(f),
    removeEventListener: (_t: string, f: () => void) => void fns.delete(f),
    show(s: "visible" | "hidden") {
      this.visibilityState = s;
      fns.forEach((f) => f());
    },
    listeners: () => fns.size,
  };
}

afterEach(() => vi.useRealTimers());

describe("T6-S76 polling only while the tab is in view", () => {
  it("a visible tab refreshes every period, as before", () => {
    vi.useFakeTimers();
    const doc = fakeDoc();
    const refresh = vi.fn();
    pollWhileVisible(refresh, 30_000, doc as unknown as Document);
    vi.advanceTimersByTime(90_000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("a hidden tab sends nothing, then refreshes once when shown again", () => {
    vi.useFakeTimers();
    const doc = fakeDoc("hidden");
    const refresh = vi.fn();
    pollWhileVisible(refresh, 30_000, doc as unknown as Document);
    vi.advanceTimersByTime(10 * 60_000);
    expect(refresh).not.toHaveBeenCalled();
    doc.show("visible");
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("hiding and showing inside one period does not add a read", () => {
    vi.useFakeTimers();
    const doc = fakeDoc();
    const refresh = vi.fn();
    pollWhileVisible(refresh, 30_000, doc as unknown as Document);
    vi.advanceTimersByTime(10_000);
    doc.show("hidden");
    doc.show("visible");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("stop clears the timer and the listener; period 0 never polls", () => {
    vi.useFakeTimers();
    const doc = fakeDoc();
    const refresh = vi.fn();
    const stop = pollWhileVisible(refresh, 30_000, doc as unknown as Document);
    stop();
    vi.advanceTimersByTime(120_000);
    expect(refresh).not.toHaveBeenCalled();
    expect(doc.listeners()).toBe(0);
    pollWhileVisible(refresh, 0, doc as unknown as Document);
    vi.advanceTimersByTime(120_000);
    expect(refresh).not.toHaveBeenCalled();
    expect(doc.listeners()).toBe(0);
  });
});

describe("T6-S76 restart retries are spread", () => {
  const plain = retryRandom.next;
  afterEach(() => {
    retryRandom.next = plain;
    vi.unstubAllGlobals();
  });
  const firstRetryAt = async (r: number) => {
    vi.useFakeTimers();
    retryRandom.next = () => r;
    const answers = [() => new Response("", { status: 502 }), () => new Response(JSON.stringify([]), { status: 200 })];
    const fetchMock = vi.fn(async (_url: string) => answers.shift()!());
    vi.stubGlobal("fetch", fetchMock);
    const p = createRealClient().listWaitingOnOwner({ includeSuperseded: true });
    await vi.advanceTimersByTimeAsync(0);
    let at = 0;
    while (fetchMock.mock.calls.length < 2 && at < 5_000) (await vi.advanceTimersByTimeAsync(50), (at += 50));
    await p;
    return at;
  };

  it("the first wait (1 s planned) lands between 0.7 and 1.3 s, so open tabs come back at different moments", async () => {
    expect(RETRY_DELAYS_MS[0]).toBe(1000);
    expect(await firstRetryAt(0)).toBe(700);
    expect(await firstRetryAt(0.5)).toBe(1000);
    expect(await firstRetryAt(1)).toBe(1300);
  });
});
