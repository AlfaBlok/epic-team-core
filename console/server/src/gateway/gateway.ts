import { isIP } from "node:net";
import type { DB } from "../db.js";
import { createAuth, runWithAuth, type Identity } from "../auth/identity.js";
import { isTenantSafe, judge } from "../auth/routeScope.js";
import { dispatcherFace, type FaceRunner } from "./dispatcherFace.js";

/**
 * the agent gateway (plan §2, D4). A second listener in the console process, for tenant boxes: their ssh
 * reverse tunnel lands on the main server loopback, so on the main port they would fall into legacy trust (the home world). This port
 * trusts the bearer token only:
 *  - no `Authorization: Bearer at_…` that checks out → 401; a request carrying a Cookie → 401 (no sessions here);
 *    the peer address is never looked at (loopback and tailnet get nothing for free).
 *  - only agent routes: the world-safe routes (auth/routeScope.ts TENANT_SAFE, minus /api/access/*), /api/health,
 *    /api/me and the dispatcher face (dispatcherFace.ts); anything else → 404.
 *  - every forwarded call is judged as CONSOLE_AUTH=on (another world's id → 404) and runs scoped to the token's
 *    world (`via: "gateway"`; the main gate leaves such a context alone), whatever CONSOLE_AUTH the main port has.
 *  - the forwarded request has no socket and no Cookie; Set-Cookie never comes back.
 * Tokens are never logged or stored raw (only identity.ts's sha256 lookup).
 *
 * Off unless CONSOLE_GATEWAY_PORT is set; it binds to CONSOLE_GATEWAY_HOST (default 127.0.0.1), which must be loopback or
 * a tailnet address: a public bind is refused at start (opening it is an exposure call, plan §8 Q3).
 */

export type Fetch = (req: Request, env?: unknown) => Response | Promise<Response>;

const DISPATCHER = /^\/api\/dispatcher\/(status|pick|done)$/;
/** a world's secret routes are world-safe on the main port, but never reachable from a box. */
const SECRETS = /^\/api\/(secrets(\/|$)|waiting-on-owner\/[^/]+\/secret$)/;
const isGatewayRoute = (method: string, path: string) =>
  (method === "GET" && (path === "/api/health" || path === "/api/me")) ||
  (!path.startsWith("/api/access/") && !SECRETS.test(path) && isTenantSafe(method, path));

const refuse = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ error: { code, message } }), { status, headers: { "content-type": "application/json", "www-authenticate": "Bearer" } });

export function createGateway(o: { db: DB; fetch: Fetch; dispatcher?: FaceRunner }) {
  const auth = createAuth(o.db);
  const face = o.dispatcher ? dispatcherFace(o.db, o.dispatcher) : undefined;

  const identify = (req: Request): Extract<Identity, { kind: "token" }> | Response => {
    if (req.headers.has("cookie")) return refuse(401, "token_only", "the agent gateway takes agent tokens only, never cookies");
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
    if (!bearer) return refuse(401, "token_required", "call the agent gateway with Authorization: Bearer <agent token>");
    const t = auth.token(bearer);
    return t ?? refuse(401, "bad_token", "unknown or revoked agent token");
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const method = req.method === "HEAD" ? "GET" : req.method;
    const id = identify(req);
    if (id instanceof Response) return id;

    const d = DISPATCHER.exec(url.pathname);
    if (d) {
      if (!face) return refuse(503, "no_dispatcher", "this console has no dispatcher (EPICSPINE_DISPATCHER unset)");
      const want = d[1] === "status" ? "GET" : "POST";
      if (method !== want) return refuse(405, "method_not_allowed", `${want} ${url.pathname}`);
      let body: Record<string, unknown> = {};
      if (want === "POST") {
        try {
          const b = await req.json();
          if (b && typeof b === "object" && !Array.isArray(b)) body = b as Record<string, unknown>;
        } catch {
          /* empty or not JSON: no options */
        }
      }
      const a = d[1] === "status" ? await face.status(id.tenant) : d[1] === "pick" ? await face.pick(id.tenant, body) : await face.done(id.tenant, body);
      return new Response(a.body, { status: a.status, headers: { "content-type": "application/json" } });
    }

    if (!isGatewayRoute(method, url.pathname)) return refuse(404, "not_found", `no agent route ${req.method} ${url.pathname} on the gateway`);
    const v = judge(o.db, id, method, url.pathname);
    if (!v.allow) return refuse(v.status, v.reason, v.message);

    const headers = new Headers(req.headers);
    for (const h of ["cookie", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded"]) headers.delete(h);
    const fwd = new Request(url, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
    });
    const res = await runWithAuth({ mode: "on", identity: id, scope: id.tenant, via: "gateway" }, () => o.fetch(fwd, {}));
    if (!res.headers.has("set-cookie")) return res;
    const out = new Headers(res.headers);
    out.delete("set-cookie");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  };
}

/** Loopback (127/8,:1) or the tailnet (the tailnet address/10, fd7a:115c:a1e0:/48): the only binds allowed for now. */
export function privateBind(host: string): boolean {
  if (host === "localhost") return true;
  const v = isIP(host);
  if (v === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 127 || (a === 100 && b >= 64 && b <= 127);
  }
  if (v === 6) {
    const h = host.toLowerCase();
    return h === "::1" || h.startsWith("fd7a:115c:a1e0:");
  }
  return false;
}

/** CONSOLE_GATEWAY_PORT (unset = no gateway, today), CONSOLE_GATEWAY_HOST (default 127.0.0.1), the dispatcher command. */
export function gatewayConfigFromEnv(env: NodeJS.ProcessEnv = process.env): { host: string; port: number; dispatcherCmd?: string } | undefined {
  const raw = env.CONSOLE_GATEWAY_PORT?.trim();
  if (!raw) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`CONSOLE_GATEWAY_PORT must be a port number, got ${raw}`);
  const host = env.CONSOLE_GATEWAY_HOST?.trim() || "127.0.0.1";
  if (!privateBind(host)) throw new Error(`CONSOLE_GATEWAY_HOST ${host} is not loopback or tailnet: the agent gateway is not opened publicly (plan §8 Q3)`);
  if (port === Number(env.PORT || 8750)) throw new Error("CONSOLE_GATEWAY_PORT must differ from the console port");
  return { host, port, dispatcherCmd: env.CONSOLE_GATEWAY_DISPATCHER || env.EPICSPINE_DISPATCHER || undefined };
}
