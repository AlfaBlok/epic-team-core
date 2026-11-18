/**
 * Every outgoing fetch of the server reads its whole answer at once, before the caller sees it.
 *
 * Why: Node's bundled HTTP client (undici 6.29.1 in Node 22.23.4) ends the process with `assert(!this.paused)` in
 * Parser.finish when an answer sent with `Connection: close` is still being read chunk by chunk, with the event loop busy
 * between chunks (the parser paused for backpressure), and the other side closes its socket. The console's event loop is
 * often blocked for seconds under load, so any caller reading slowly could trip it; it ended the console nine times on
 * 2026-11-18 (00:23-00:34Z, 02:44Z, 02:46Z). Read in full right away, a body never sits paused on a socket.
 *
 * Callers get a Response built from those bytes (status, headers and url kept), so `.json()`, `.text()`, `.body` and
 * `.clone()` work as before. No server code streams an outgoing answer; one that must (a long event stream) calls
 * `rawFetch` and reads it without gaps.
 */
type Fetch = typeof globalThis.fetch;
const MARK = Symbol.for("console.fetchSafe");

export let rawFetch: Fetch = globalThis.fetch;

/** a fetch whose answers are read in full before they are returned. */
export function bufferedFetch(inner: Fetch): Fetch {
  const f = (async (input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]) => {
    const res = await inner(input, init);
    if (!res.body) return res;
    const bytes = await res.arrayBuffer();
    const out = new Response(res.status === 204 || res.status === 205 || res.status === 304 ? null : bytes, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
    // a Response made here has no url or redirected flag: keep the real ones (callers read res.url after redirects)
    Object.defineProperty(out, "url", { value: res.url });
    Object.defineProperty(out, "redirected", { value: res.redirected });
    return out;
  }) as Fetch;
  (f as unknown as Record<symbol, boolean>)[MARK] = true;
  return f;
}

/** Install once at start (index.ts, before anything captures fetch). Idempotent. */
export function installBufferedFetch(): void {
  const g = globalThis as unknown as { fetch: Fetch };
  if ((g.fetch as unknown as Record<symbol, boolean>)[MARK]) return;
  rawFetch = g.fetch;
  g.fetch = bufferedFetch(rawFetch);
}
