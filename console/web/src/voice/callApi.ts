import type { VoiceApi } from "./engine";
import { getCallLang } from "./callLang";

/**
 * the console's call routes, apart from the call engine (engine.ts), so a page can hold a call's api (Hang up
 * on a call another page holds) while the engine itself loads only when he starts a call (lazyCall.ts).
 */
/** the waits between starts again (about 2 minutes in all, on top of the console's own wait for Bitwarden). */
export const START_AGAIN_MS = [3_000, 5_000, 10_000, 15_000, 20_000, 30_000, 30_000];
export const KEY_LATE_TEXT = "Bitwarden did not give the call's key in time. Tap Call again in a minute.";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** a start worth sending again: the key still coming, or the console never answered it. */
export function startAgain(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  const x = e as { status?: number; code?: string };
  return x.code === "key_wait" || (!x.code && (x.status === 502 || x.status === 503 || x.status === 504));
}
/** The console's /api/voice routes. */
/** `base`: the call routes' root, `/api/voice` (the Team desk) or `/api/milestones/<id>/voice` (a campaign chat). */
export function fetchVoiceApi(f: typeof fetch = (...a) => fetch(...a), base = "/api/voice"): VoiceApi {
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await f(`${base}${path}`, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), keepalive: method === "POST" && (path.endsWith("/end") || path.endsWith("/ask")) });
    const j = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) throw Object.assign(new Error(j?.error?.message ?? `console answered ${r.status}`), { status: r.status, code: j?.error?.code as string | undefined });
    return j as T;
  };
  return {
    start: async (focus) => {
      // Bitwarden slow to give the call's key (key_wait), or the console restarting mid-start (a proxy 502/503/504
      // with no console answer, a dropped connection): the page stays on "Connecting…" and starts again. No call row is made
      // before the key is in hand, so a start again never makes two calls.
      for (let i = 0; ; i++) {
        try {
          return await call("POST", "/calls", { ...(focus ? { focus } : {}), lang: getCallLang() });
        } catch (e) {
          if (!startAgain(e)) throw e;
          if (i >= START_AGAIN_MS.length) throw (e as { code?: string }).code === "key_wait" ? new Error(KEY_LATE_TEXT) : e;
          await wait(START_AGAIN_MS[i]);
        }
      }
    },
    beat: (id) => call("POST", `/calls/${id}/beat`),
    usage: (id, ev) => call("POST", `/calls/${id}/usage`, ev),
    end: (id, body, beacon) => {
      if (beacon && typeof navigator !== "undefined" && navigator.sendBeacon) return Promise.resolve(navigator.sendBeacon(`${base}/calls/${id}/end`, JSON.stringify(body)));
      return call("POST", `/calls/${id}/end`, body);
    },
    status: (id) => call("GET", `/calls/${id}/status`),
    ask: (id, request, confirmed, words, kind) => call("POST", `/calls/${id}/ask`, { request, confirmed, ...(words ? { words } : {}), ...(kind ? { kind } : {}) }),
    askState: (id, askId) => call("GET", `/calls/${id}/ask/${askId}`),
    endActive: (id) => call("POST", "/active/end", { id }),
    tool: (id, name, args) => call("POST", `/calls/${id}/tool`, { name, args }),
    relay: (id, args) => call("POST", `/calls/${id}/relay`, args),
    lookup: (id, name, args) => call("POST", `/calls/${id}/lookup`, { name, args }),
    warm: () => call("POST", "/calls/warm", { lang: getCallLang() }),
  };
}
