import { isIP } from "node:net";
import { KNOWN_ORIGINS } from "../status/mark.js";
import { customerHosts, socialHosts } from "./gate.js";
import { siteDomain } from "../identity.js";

/**
 * the console's ambient credentials (the session cookie, and legacy
 * trust for a loopback or tailnet caller with no credential) are not usable from another site.
 *
 *  - **Host** (DNS rebinding): an /api request is answered only for a host name the console serves: an IP literal,
 *    localhost, a single-label or tailnet (`*.ts.net`) name, `*.our domain`, the social and customer hosts, CONSOLE_PUBLIC_HOSTS and
 *    CONSOLE_ALLOWED_HOSTS. A page on `evil.example` rebound to the console's address sends `Host: evil.example`.
 *  - **Cross-site writes** (CSRF, sibling subdomains, login CSRF): an unsafe method from a browser must come from the
 *    console's own page. `Sec-Fetch-Site` same-origin (or none: typed by the user) passes; cross-site and same-site do not,
 *    unless the `Origin` is a known console origin. Without `Sec-Fetch-Site` (plain http to a tailnet IP) the `Origin`
 *    decides: its host must be the request's own host, a known console origin or loopback. No `Origin` and no
 *    `Sec-Fetch-Site` is not a browser (curl, the seats, the watchdog, Node fetch): passes, as before.
 *
 * Exempt: the public routes another site posts to on purpose (the tester signup form, the Stripe webhook, the memory service's
 * voice-note hook) and the Mac's one-time auth-sync upload; each has its own guard.
 */

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const EXEMPT = [/^\/api\/public\//, /^\/api\/hooks\//, /^\/api\/auth-sync\//];

const list = (v: string | undefined) => (v ?? "").split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean);

/** The host name without port or IPv6 brackets, lower case. */
export const hostName = (hostPort: string): string => {
  const h = hostPort.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(1, h.indexOf("]") > 0 ? h.indexOf("]") : undefined);
  return h.replace(/:\d+$/, "");
};

const publicUrlHost = (env: NodeJS.ProcessEnv) => {
  try {
    return env.CONSOLE_PUBLIC_URL ? new URL(env.CONSOLE_PUBLIC_URL).hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
};

/** A host name this console answers /api for. */
export function hostAllowed(host: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const h = hostName(host);
  if (!h) return true; // HTTP/1.0 without Host: not a browser
  if (isIP(h)) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (!h.includes(".")) return true; // a single-label (MagicDNS / LAN) name never resolves through public DNS
  if (h.endsWith(".ts.net") || h === siteDomain() || h.endsWith(`.${siteDomain()}`)) return true;
  // + the customer sites (cloud.epicteam.app, app.social.app)
  const extra = new Set([...socialHosts(env), ...customerHosts(env).keys(), ...list(env.CONSOLE_PUBLIC_HOSTS), ...list(env.CONSOLE_ALLOWED_HOSTS), publicUrlHost(env)]);
  return extra.has(h);
}

const knownOrigins = (env: NodeJS.ProcessEnv) =>
  new Set(
    [...KNOWN_ORIGINS(), ...[...socialHosts(env), ...customerHosts(env).keys()].map((h) => `https://${h}`), ...list(env.CONSOLE_ORIGINS), env.CONSOLE_PUBLIC_URL ?? ""]
      .map((o) => o.replace(/\/+$/, "").toLowerCase())
      .filter(Boolean),
  );

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

export type CsrfRefusal = { code: "bad_host" | "cross_site"; message: string };

/** Why this request is refused (host or cross-site), or undefined. `path` is the decoded path. */
export function crossSiteRefusal(method: string, path: string, header: (n: string) => string | undefined, env: NodeJS.ProcessEnv = process.env): CsrfRefusal | undefined {
  if (!path.startsWith("/api/") || EXEMPT.some((re) => re.test(path))) return undefined;
  const host = header("host") ?? "";
  const fwd = (header("x-forwarded-host") ?? "").split(",")[0].trim();
  if (!hostAllowed(host, env) || (fwd && !hostAllowed(fwd, env)))
    return { code: "bad_host", message: `this console does not answer for the host ${hostName(fwd || host)}` };
  if (!UNSAFE.has(method)) return undefined;
  const origin = header("origin")?.trim().toLowerCase().replace(/\/+$/, "");
  const known = !!origin && knownOrigins(env).has(origin);
  const site = header("sec-fetch-site")?.trim().toLowerCase();
  if (site === "same-origin" || site === "none") return undefined;
  if (site === "cross-site" || site === "same-site") return known ? undefined : { code: "cross_site", message: "a write from another site is refused: use the console's own page" };
  if (!origin) return undefined; // not a browser
  if (origin === "null") return { code: "cross_site", message: "a write from an opaque origin is refused: use the console's own page" };
  let oh: string;
  try {
    oh = new URL(origin).host;
  } catch {
    return { code: "cross_site", message: "a write with an unreadable Origin is refused" };
  }
  const own = [host, fwd].filter(Boolean).map((h) => h.toLowerCase());
  if (own.includes(oh) || known || LOOPBACK.has(hostName(oh))) return undefined;
  return { code: "cross_site", message: `a write from ${origin} is refused: use the console's own page` };
}
