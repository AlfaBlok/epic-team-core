import type { VoiceApi } from "./engine";

/**
 * the console's call routes, apart from the call engine (engine.ts), so a page can hold a call's api (Hang up
 * on a call another page holds) while the engine itself loads only when he starts a call (lazyCall.ts).
 */
/** The console's /api/voice routes. */
/** `base`: the call routes' root, `/api/voice` (the Team desk) or `/api/milestones/<id>/voice` (a campaign chat). */
export function fetchVoiceApi(f: typeof fetch = (...a) => fetch(...a), base = "/api/voice"): VoiceApi {
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await f(`${base}${path}`, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), keepalive: method === "POST" && (path.endsWith("/end") || path.endsWith("/ask")) });
    const j = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) throw new Error(j?.error?.message ?? `console answered ${r.status}`);
    return j as T;
  };
  return {
    start: (focus) => call("POST", "/calls", focus ? { focus } : undefined),
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
  };
}
