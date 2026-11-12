/**
 * API paths are judged as raw bytes, before Hono decodes them. Hono's
 * router and the gate (gate.ts, gateway.ts) see `decodeURI(path)`, which turns `%5C` into `\`; fetch then reads `\` as
 * `/` and resolves `..`, so `/api/auth-sync/..%5Cbrowse` passed the gate as an open token URL and reached the Team
 * Browser's `/api/browse`. No console API path needs an encoded separator or a dot segment (ids are plain; anything
 * path-like travels in the query string), so any of them is refused with 400 before the gate judges the path.
 *
 * Refused in the path part (never the query) of /api/*, /auth-sync/* and /mcp:
 *  - an encoded slash or backslash (`%2F`, `%5C`, any case), a raw backslash, a NUL or a control character;
 *  - a dot segment (`.`, `..`) once each segment is decoded (`%2E%2E`, `.%2e`), and a malformed escape.
 * Pages (the web app's own routes, e.g. a node key with `%2F`) are not API paths and are left to the web app.
 */
export function apiPathRefusal(rawUrl: string): string | undefined {
  const raw = rawPath(rawUrl);
  if (!/^\/(api|auth-sync|mcp)(\/|%|\\|$)/i.test(raw)) return undefined;
  if (/%(2f|5c|00)/i.test(raw) || /[\\\u0000-\u001f\u007f]/.test(raw)) return "encoded separator or control character";
  for (const seg of raw.split("/")) {
    let s: string;
    try {
      s = decodeURIComponent(seg);
    } catch {
      return "malformed escape";
    }
    if (s === "." || s === "..") return "dot segment";
    if (/[\\/]/.test(s)) return "encoded separator";
  }
  return undefined;
}

/** The path as the client sent it (percent escapes kept); Request URLs are already parsed, so this is their pathname. */
function rawPath(rawUrl: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(rawUrl);
  return m ? m[1] || "/" : rawUrl.split(/[?#]/)[0];
}
