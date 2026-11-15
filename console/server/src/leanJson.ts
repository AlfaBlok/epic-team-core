/**
 * Every JSON answer of the API goes out small. An owner on a phone may reach the console through a slow relay, not a
 * direct link, while the open page re-reads its lists every 30 s: close to 1 MB of uncompressed JSON a round, which took
 * up to 30 s through the relay although the console answered each call in under 2 s.
 *
 * Two cheap things on a GET that answers 200 with application/json:
 *  - an ETag (a hash of the body) and `Cache-Control: private, no-cache` (unless the route set its own): the browser
 *    keeps the answer and asks again with If-None-Match; an unchanged list comes back as a 304 with no body;
 *  - gzip when the body is 1 KB or more and the caller accepts it (about 4.7 times smaller for the sidebar's calls).
 * Streams (text/event-stream), downloads and anything already encoded pass untouched. A caller with no HTTP cache (curl,
 * node fetch, agents) never sends If-None-Match, so it always gets the full answer as before.
 */
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gzip as gzipCb } from "node:zlib";
import type { MiddlewareHandler } from "hono";

const gzip = promisify(gzipCb);
const GZIP_MIN = 1024;

/** true when an If-None-Match header names this ETag (weak compare, as browsers send it back). */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const bare = (t: string) => t.trim().replace(/^W\//, "");
  const want = bare(etag);
  return header.split(",").some((t) => t.trim() === "*" || bare(t) === want);
}

export function leanJson(o: { gzipMin?: number } = {}): MiddlewareHandler {
  const min = o.gzipMin ?? GZIP_MIN;
  return async function leanJsonMw(c, next) {
    await next();
    if (c.req.method !== "GET") return;
    const res = c.res;
    if (res.status !== 200 || !res.body) return;
    if (!(res.headers.get("Content-Type") ?? "").startsWith("application/json")) return;
    if (res.headers.has("Content-Encoding") || res.headers.has("ETag")) return;
    const body = Buffer.from(await res.arrayBuffer());
    const etag = `W/"${createHash("sha1").update(body).digest("base64url")}"`;
    const headers = new Headers(res.headers);
    headers.set("ETag", etag);
    if (!headers.has("Cache-Control")) headers.set("Cache-Control", "private, no-cache");
    const vary = headers.get("Vary");
    if (!vary) headers.set("Vary", "Accept-Encoding");
    else if (vary !== "*" && !/(^|,)\s*accept-encoding\s*(,|$)/i.test(vary)) headers.set("Vary", `${vary}, Accept-Encoding`);
    headers.delete("Content-Length");
    // Hono's res setter copies the old answer's headers onto the new one (a stale Content-Length among them): drop it first
    c.res = undefined as unknown as Response;
    if (etagMatches(c.req.header("If-None-Match"), etag)) {
      headers.delete("Content-Type");
      c.res = new Response(null, { status: 304, headers });
      return;
    }
    if (body.length >= min && /\bgzip\b/i.test(c.req.header("Accept-Encoding") ?? "")) {
      const packed = await gzip(body, { level: 6 });
      headers.set("Content-Encoding", "gzip");
      c.res = new Response(new Uint8Array(packed), { status: 200, headers });
      return;
    }
    c.res = new Response(new Uint8Array(body), { status: 200, headers });
  };
}
