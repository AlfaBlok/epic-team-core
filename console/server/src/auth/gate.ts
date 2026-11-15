import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { DEFAULT_TENANT, type DB } from "../db.js";
import type { Store } from "../store.js";
import { AuthError, createAuth, currentAuth, runWithAuth, SESSION_COOKIE, SESSION_DAYS, type Auth, type AuthMode, type Identity } from "./identity.js";
import { judge } from "./routeScope.js";
import { apiPathRefusal } from "./pathGuard.js";
import { LOGIN_PAGE } from "./loginPage.js";
import { SOCIAL_HEAD, socialHead, TEAM_HEAD } from "../brand.js";
import { hasOwnerPower } from "./owner.js";
import { crossSiteRefusal } from "./csrf.js";
import { clientAddress } from "../clientAddress.js";
import { homeWorld, hostOf, sites } from "../identity.js";
import { companyViewOn } from "../plug/companyView.js";
import { gunzipSync, inflateSync } from "node:zlib";

/**
 * The health answer's `ok`, read through its encoding. leanJson gzips a JSON answer of 1 KB or more when the
 * caller accepts it, and Cloudflare always does, so a plain .json() read failed on the gzip bytes and the customer sites
 * said {"ok":false} while the console was up.
 */
async function healthUp(res: Response): Promise<boolean> {
  try {
    const raw = Buffer.from(await res.clone().arrayBuffer());
    const enc = (res.headers.get("content-encoding") ?? "").toLowerCase();
    const body = enc === "gzip" ? gunzipSync(raw) : enc === "deflate" ? inflateSync(raw) : raw;
    return (JSON.parse(body.toString("utf8")) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

/** The socket peer of a request (@hono/node-server puts the IncomingMessage on env); undefined in app.request tests. */
const peerOf = (c: Context): string | undefined => (c.env as any)?.incoming?.socket?.remoteAddress;

/** A browser page call carries fetch metadata or an Origin/Referer; anything else (curl, python, node) is an agent. */
export function looksLikeAgent(header: (n: string) => string | undefined): boolean {
  if (header("x-run-id") || header("x-console-run")) return true;
  return !(header("sec-fetch-mode") || header("sec-fetch-site") || header("origin") || header("referer"));
}
const callerOf = (header: (n: string) => string | undefined) =>
  header("x-console-run") || header("x-run-id") || (header("user-agent") ?? "").split(/[\s/]/)[0] || undefined;

/**
 * hosts that serve the social skin (web/src/lib/skin.tsx SOCIAL_HOSTS). `CONSOLE_SOCIAL_HOSTS`
 * (space- or comma-separated) replaces the default.
 */
export const socialHosts = (env: NodeJS.ProcessEnv = process.env): Set<string> =>
  new Set([
    ...(env.CONSOLE_SOCIAL_HOSTS ?? hostOf(sites().socialUrl)).split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean),
    ...[...customerHosts(env)].filter(([, p]) => p === "social").map(([h]) => h), // cloud.social.app, app.social.app
  ]);

/** the two products a customer signs up for. */
export type Product = "team" | "social";
/**
 * the customer sites. Each product's own domain keeps its product page at / (scripts/epic_domains) and
 * serves this console on its `app.` subdomain, like memory.dev and cloud.memory.dev: the console's /login, /api and app
 * routes stay at the root of their own host (no path rewriting, a cookie per host), and the page at / is untouched.
 * `CONSOLE_CUSTOMER_HOSTS` (`host=team|social`, space- or comma-separated) replaces the default; empty turns them off.
 */
/**
 * EpicTeam lives on cloud.epicteam.app; app.epicteam.app answers a
 * permanent redirect there at Traefik (hosted/console/traefik/agent-team-customer.yml) and stays a customer host here, so the
 * platform-world block holds for it too if that route ever serves it again. The first host of a product is its
 * address (the world switch between the two sites).
 */
/*
 * the social product likewise lives on cloud.social.app;
 * app.social.app answers a 301 there at Traefik and stays a customer host here for the same reason.
 */
export const DEFAULT_CUSTOMER_HOSTS = (): string => sites().customerHosts;
export const customerHosts = (env: NodeJS.ProcessEnv = process.env): Map<string, Product> => {
  const out = new Map<string, Product>();
  for (const part of (env.CONSOLE_CUSTOMER_HOSTS ?? DEFAULT_CUSTOMER_HOSTS()).split(/[\s,]+/)) {
    const [h, p] = part.trim().toLowerCase().split("=");
    if (h && (p === "team" || p === "social")) out.set(h, p);
  }
  return out;
};

/** the product a host shows: a customer site's own, the social hosts the social product, any other EpicTeam. */
export const productOf = (host: string | undefined, env: NodeJS.ProcessEnv = process.env): Product =>
  (host && customerHosts(env).get(host)) || (host && socialHosts(env).has(host) ? "social" : "team");

/**
 * the platform's own world (the home world: owner powers over secrets, services, agent tokens, every
 * world's platform pages) is never reachable from a customer site, which is the internet: no session starts there into it
 * (password login, Google or GitHub, the world pick, a switch or its one-time link) and the home world credential that arrives
 * there anyway (a session, an agent token, the host owner token) counts as no credential. the production site on the tailnet
 * stays the way in. the owner as a customer gets a builder login of his own.
 */
export const PLATFORM_PRIVATE = { code: "platform_private", message: "the platform is managed from the private console" } as const;
/**
 * the door (the owner as customer one on the EpicTeam site). `CONSOLE_PLATFORM_DOOR` names the logins
 * (emails, space- or comma-separated) that may open the home world on a customer site; unset or empty = off, the default,
 * and then nothing changes. A door login comes in only by Google or GitHub sign-in (never a password, a switch or its
 * one-time link, an agent token or the host owner token), and its session there is judged like any customer world's:
 * only the TENANT_SAFE routes (routeScope.ts judge), no owner powers and never the platform owner (owner.ts). Switching the
 * door off (unset and restart) refuses its sessions at once: they count as no credential again.
 */
export const DOOR_VIA = new Set(["google", "github"]);
export const doorLogins = (env: NodeJS.ProcessEnv = process.env): Set<string> =>
  new Set((env.CONSOLE_PLATFORM_DOOR ?? "").split(/[\s,]+/).map((e) => e.trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+$/.test(e)));
/** the login (and, when a session starts, the way in) that may pass the door; any other caller passes nothing. */
export type DoorKey = { email?: string; via?: string };
export const throughDoor = (door: DoorKey | undefined, env: NodeJS.ProcessEnv = process.env): boolean =>
  !!door?.email && (door.via === undefined || DOOR_VIA.has(door.via)) && doorLogins(env).has(door.email.trim().toLowerCase());
export const platformBlocked = (host: string | undefined, tenant: string | undefined, env: NodeJS.ProcessEnv = process.env, door?: DoorKey): boolean =>
  tenant === DEFAULT_TENANT && !!host && customerHosts(env).has(host) && !throughDoor(door, env);
const platformRefusal = () => new AuthError(403, PLATFORM_PRIVATE.code, PLATFORM_PRIVATE.message);

/**
 * the social site, the tailnet's social host, sends a browser to
 * the social product's customer site, where he signs in with Google as a customer (oauth.ts CUSTOMER_LOGINS). Page loads only (a
 * navigation, 302 so one revert ends it): /api, agents and scripts answer as before. A world switch from the production site
 * to a social world opens that site's sign-in, never a builder session there. `CONSOLE_SOCIAL_MOVED_TO` (a social
 * customer host) replaces the default, empty turns it off; never on a staging copy.
 */
export const socialMovedTo = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  if (env.CONSOLE_STAGING === "1") return undefined;
  const to = (env.CONSOLE_SOCIAL_MOVED_TO ?? sites().socialMovedTo).trim().toLowerCase();
  return to && customerHosts(env).get(to) === "social" ? to : undefined;
};

/** The host name the browser asked for: Traefik's X-Forwarded-Host, else Host; lower case, no port. */
export function requestHost(header: (n: string) => string | undefined): string | undefined {
  const raw = (header("x-forwarded-host") || header("host") || "").split(",")[0].trim().toLowerCase();
  return raw ? raw.replace(/:\d+$/, "") : undefined;
}

/** The identity's public shape (no hashes, no secrets): GET /api/me and the login answers. */
function publicIdentity(i: Identity) {
  switch (i.kind) {
    case "session":
      return { kind: i.kind, tenantId: i.tenant, email: i.email, name: i.name, role: i.role, ...(i.door ? { door: true } : {}) }; // door: the customer screens only
    case "token":
      return { kind: i.kind, tenantId: i.tenant, label: i.label };
    case "legacy":
      return { kind: i.kind, tenantId: i.tenant, ...(i.host ? { host: true } : {}) };
    default:
      return { kind: "none" as const };
  }
}

/**
 * mount auth on the app. Registers (before every other route) the gate middleware and the routes /api/me and
 * /api/access/{login,logout,setup,switch,tokens,events}, and the page /login. Returns the auth service (the CLI uses
 * createAuth directly). `mode` defaults to CONSOLE_AUTH.
 */
export function mountAuth(
  app: Hono,
  api: Hono,
  o: {
    db: DB;
    store: Store;
    mode: AuthMode;
    socialHosts?: Set<string>;
    /** why a world's agents are held (cycle/worldGate.ts) */
    worldHold?: (world: string) => string | undefined;
    /** a world's billing state when it is not simply on (`awaiting_payment`: an EpicTeam sign-up before it pays). */
    billingOf?: (world: string) => string | undefined;
  },
): Auth {
  const auth = createAuth(o.db);
  const mode = o.mode;
  const social = o.socialHosts ?? socialHosts();
  const customers = customerHosts();
  const hostOfReq = (c: Context) => requestHost((n) => c.req.header(n));
  const resolve = (c: Context): Identity => {
    const i = auth.resolve({ header: (n) => c.req.header(n), cookie: getCookie(c, SESSION_COOKIE), peer: peerOf(c) });
    // the home world credential on a customer site is no credential (its open pages still answer, the rest is 401).
    // a door login keeps its session, marked as the door (a customer world's rules, no owner powers).
    if (i.kind === "session") {
      const host = hostOfReq(c);
      if (platformBlocked(host, i.tenant, process.env, { email: i.email })) return { kind: "none", peer: peerOf(c) };
      return platformBlocked(host, i.tenant) ? { ...i, role: "member", door: true } : i;
    }
    return "tenant" in i && platformBlocked(hostOfReq(c), i.tenant) ? { kind: "none", peer: peerOf(c) } : i;
  };

  // an API path with an encoded separator or a dot segment never reaches the gate or a route, in every auth
  // mode and through the gateway (pathGuard.ts): the gate judges decoded paths, fetch would resolve them again.
  app.use("*", async (c, next) => {
    const bad = apiPathRefusal(c.req.url);
    if (bad) return c.json({ error: { code: "bad_path", message: `path refused: ${bad}` } }, 400);
    return next();
  });

  // the social site's pages open on the social product's customer site (socialMovedTo).
  const movedTo = socialMovedTo();
  app.use("*", async (c, next) => {
    const host = hostOfReq(c);
    if (!movedTo || !host || !social.has(host) || customers.has(host)) return next();
    if ((c.req.method !== "GET" && c.req.method !== "HEAD") || c.req.path === "/api" || c.req.path.startsWith("/api/")) return next();
    if (c.req.header("sec-fetch-mode") !== "navigate" && !(c.req.header("accept") ?? "").includes("text/html")) return next();
    const u = new URL(c.req.url);
    return c.redirect(`https://${movedTo}${u.pathname}${u.search}`, 302);
  });

  // the customer sites are the console on the internet.
  //  - Closed unless CONSOLE_AUTH=on: production's unit file says shadow and only cycle.env says on, so a missing env file
  //    would leave a public console that refuses nothing.
  //  - /api/health answers up or down only (the full answer names the platform's jobs, disk and checkouts).
  //  - Framing by another site, MIME sniffing and full referrers off; HSTS on https.
  app.use("*", async (c, next) => {
    if (!customers.has(requestHost((n) => c.req.header(n)) ?? "")) return next();
    if (mode !== "on") return c.json({ error: { code: "auth_off", message: "this site is closed: the console does not enforce its login (CONSOLE_AUTH)" } }, 503);
    await next();
    if (c.req.path === "/api/health" && c.res.status !== 304) {
      const ok = await healthUp(c.res);
      const status = c.res.status;
      // Hono's res setter copies the old answer's headers (its Content-Encoding: gzip among them) onto the new one
      c.res = undefined as unknown as Response;
      c.res = new Response(JSON.stringify({ ok }), { status, headers: { "content-type": "application/json" } });
    }
    // a new Response, not headers set on the old one: @hono/node-server writes a plain text/html answer (the /login page)
    // from its own cached headers, so a header added afterwards never left the server (seen on the local copy).
    const h = new Headers(c.res.headers);
    const set = (n: string, v: string) => {
      if (!h.has(n)) h.set(n, v);
    };
    set("X-Frame-Options", "SAMEORIGIN");
    set("Content-Security-Policy", "frame-ancestors 'self'");
    set("X-Content-Type-Options", "nosniff");
    set("Referrer-Policy", "strict-origin-when-cross-origin");
    if (c.req.header("x-forwarded-proto") === "https") set("Strict-Transport-Security", "max-age=31536000");
    c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers: h });
  });

  // no ambient credential (cookie, legacy trust) from another site or a rebound host name (csrf.ts),
  // in every auth mode; the gateway takes bearer tokens only.
  app.use("*", async (c, next) => {
    if (currentAuth()?.via === "gateway") return next();
    const no = crossSiteRefusal(c.req.method, c.req.path, (n) => c.req.header(n));
    if (no) return c.json({ error: no }, no.code === "bad_host" ? 421 : 403);
    return next();
  });

  app.use("*", async (c, next) => {
    if (mode === "off" || currentAuth()?.via === "gateway") return next(); // the gateway judged and scoped it
    const identity = resolve(c);
    const path = c.req.path;
    const v = judge(o.db, identity, c.req.method, path);
    const header = (n: string) => c.req.header(n);
    if (!v.allow) {
      auth.logEvent({ mode, method: c.req.method, path, status: v.status, reason: v.reason, identity, peer: peerOf(c), agent: looksLikeAgent(header), caller: callerOf(header) });
      if (mode === "on") {
        if (!path.startsWith("/api/") && v.status === 401) return c.redirect(`/login?next=${encodeURIComponent(path)}`, 302);
        return c.json({ error: { code: v.reason, message: v.message } }, v.status);
      }
    }
    // shadow: judged and logged, never scoped or refused; on: scoped to the caller's world.
    const scope = mode === "on" && identity.kind !== "none" ? identity.tenant : undefined;
    return runWithAuth({ mode, identity, scope }, () => next());
  });

  // on a social host the login page names the social product (its title and link-preview tags).
  // on a customer site its own address replaces team/the social site in the page's link-preview tags.
  app.get("/login", (c) => {
    const host = requestHost((n) => c.req.header(n)) ?? "";
    const page = social.has(host) ? socialHead(LOGIN_PAGE()) : LOGIN_PAGE();
    return c.html(customers.has(host) ? page.split(social.has(host) ? SOCIAL_HEAD.origin : TEAM_HEAD.origin).join(`https://${host}`) : page);
  });

  /** The caller as the access routes see it; with auth off nothing was resolved, so a non-identity counts as today (the home world). */
  const caller = (c: Context): Identity => {
    const i = currentAuth()?.identity ?? resolve(c);
    return i.kind === "none" && mode === "off" ? { kind: "legacy", tenant: DEFAULT_TENANT, peer: peerOf(c) ?? "" } : i;
  };
  const fail = (c: Context, e: unknown) => {
    if (e instanceof AuthError) return c.json({ error: { code: e.code, message: e.message } }, e.status);
    throw e;
  };
  const secure = (c: Context) => c.req.header("x-forwarded-proto") === "https" || new URL(c.req.url).protocol === "https:";
  const startSession = (c: Context, userId: string, tenant: string, via?: string) => {
    const email = (o.db.prepare("SELECT email FROM users WHERE id = ?").get(userId) as { email?: string } | undefined)?.email;
    if (platformBlocked(hostOfReq(c), tenant, process.env, { email, via: via ?? "" })) throw platformRefusal();
    const s = auth.createSession(userId, tenant, { via, host: hostOfReq(c) ?? undefined }); // how and where
    setCookie(c, SESSION_COOKIE, s.id, { httpOnly: true, sameSite: "Lax", path: "/", secure: secure(c), maxAge: SESSION_DAYS * 86400 });
    return auth.session(s.id)!;
  };
  /**
   * the world /api/me names. A session or an agent token decides. Before login (no session, no token) with auth
   * off or shadow, the social hostname reads the world whose skin is social (the first one, by creation), so
   * the social site keeps its campaign after the move; any other host, or no social world yet, reads the home world as
   * before. Under `on` a caller without identity has no world: the login decides.
   */
  const worldOf = (c: Context, i: Identity): string | undefined => {
    if (i.kind === "session" || i.kind === "token") return i.tenant;
    if (mode !== "on") {
      const host = requestHost((n) => c.req.header(n));
      // never on a customer site: a stranger there has no world before they sign in.
      if (host && social.has(host) && !customers.has(host)) {
        const w = o.store.listTenants().find((t) => t.skin === "social" && t.id !== DEFAULT_TENANT);
        if (w) return w.id;
      }
    }
    return "tenant" in i ? i.tenant : undefined;
  };
  const me = (c: Context, i: Identity) => {
    const tenantId = worldOf(c, i);
    const tenant = tenantId ? o.store.getTenant(tenantId) ?? null : null;
    const wakeHold = tenant ? o.worldHold?.(tenant.id) : undefined; // the Personas page says why nobody wakes
    const billing = tenant ? o.billingOf?.(tenant.id) : undefined; // an EpicTeam sign-up waits for its payment
    const worlds = i.kind === "session" ? auth.memberships(i.userId).filter((m) => !platformBlocked(hostOfReq(c), m.tenantId, process.env, { email: i.email })) : [];
    return c.json({ mode, identity: publicIdentity(i), tenant, worlds, ...(wakeHold ? { wakeHold } : {}), ...(billing ? { billing } : {}), ...(companyViewOn() ? { companyView: true } : {}) }); // the parked Company view
  };
  /**
   * the origin a world opens on when it is not this host: social worlds on the social host, the others on
   * the team host. Only between those public hosts (CONSOLE_TEAM_URL, CONSOLE_SOCIAL_URL); a staging copy, the tailnet URL
   * or localhost switch in place, as before.
   */
  const homeOrigin = (tenant: string, host: string | undefined): string | undefined => {
    if (!host || process.env.CONSOLE_STAGING === "1") return undefined;
    // on a customer site the pair is the two customer sites (cloud.epicteam.app <-> cloud.social.app).
    if (customers.has(host)) {
      const w = o.db.prepare("SELECT skin FROM tenants WHERE id = ?").get(tenant) as { skin?: string } | undefined;
      if (!w) return undefined;
      const want = [...customers].find(([, p]) => p === (w.skin === "social" ? "social" : "team"))?.[0];
      return want && want !== host ? `https://${want}` : undefined;
    }
    const origin = (u: string) => {
      try {
        return new URL(u).origin;
      } catch {
        return undefined;
      }
    };
    const team = origin(process.env.CONSOLE_TEAM_URL || sites().teamUrl);
    const socialUrl = movedTo ? `https://${movedTo}` : origin(process.env.CONSOLE_SOCIAL_URL || `https://${[...social][0] ?? hostOf(sites().socialUrl)}`);
    const onTeam = !!team && host === new URL(team).hostname;
    if (!onTeam && !social.has(host)) return undefined;
    // the tenants table itself: the store is scoped to the caller's current world here
    const w = o.db.prepare("SELECT skin FROM tenants WHERE id = ?").get(tenant) as { skin?: string } | undefined;
    if (!w) return undefined;
    const want = w.skin === "social" ? socialUrl : team;
    return want && new URL(want).hostname !== host ? want : undefined;
  };
  const body = async (c: Context): Promise<Record<string, unknown>> => {
    try {
      const b = await c.req.json();
      return b && typeof b === "object" ? b : {};
    } catch {
      return {};
    }
  };
  const str = (v: unknown) => (typeof v === "string" ? v : "");

  // Login throttle: 10 failures per address+email per 15 min. And 100 per email from all addresses together (a
  // public site's guesses come from many addresses), and a flood of other keys no longer empties the table (it dropped
  // every count at 10,000 keys): expired counts go first, then the oldest.
  const LOGIN_WINDOW_MS = 15 * 60_000;
  const EMAIL_FAILURES = 100;
  const failures = new Map<string, { n: number; first: number }>();
  const throttled = (key: string, max = 10) => {
    const f = failures.get(key);
    if (f && Date.now() - f.first > LOGIN_WINDOW_MS) failures.delete(key);
    return (failures.get(key)?.n ?? 0) >= max;
  };
  const failed = (key: string) => {
    const f = failures.get(key) ?? { n: 0, first: Date.now() };
    f.n++;
    failures.set(key, f);
    if (failures.size > 50_000) {
      const t = Date.now();
      for (const [k, v] of failures) if (t - v.first > LOGIN_WINDOW_MS) failures.delete(k);
      for (const k of failures.keys()) {
        if (failures.size <= 40_000) break;
        failures.delete(k);
      }
    }
  };

  /**
   * switch links are limited per login and per address, in one-minute windows. Minting: 10 a login,
   * 30 an address. Reading or using one (peek + redeem, each switch makes one of each): 30 calls an address, and 10 used
   * links a login. Every call counts, refused or not, so a flood stops at the cap. A refusal is 429 with Retry-After.
   */
  const LIMIT_WINDOW_MS = 60_000;
  const HANDOFF_LIMITS = { mintLogin: 10, mintAddress: 30, useAddress: 30, useLogin: 10 } as const;
  const hits = new Map<string, { n: number; first: number }>();
  const overLimit = (key: string, max: number) => {
    const t = Date.now();
    let h = hits.get(key);
    if (!h || t - h.first >= LIMIT_WINDOW_MS) {
      if (hits.size > 10_000) hits.clear();
      h = { n: 0, first: t };
      hits.set(key, h);
    }
    return ++h.n > max;
  };
  const tooMany = (c: Context) => {
    c.header("Retry-After", "60");
    return c.json({ error: { code: "too_many_switches", message: "too many world switches in a minute: wait a minute and switch again" } }, 429);
  };
  const addressOf = (c: Context) => clientAddress(peerOf(c), (n) => c.req.header(n));

  api.get("/me", (c) => me(c, caller(c)));

  api.post("/access/login", async (c) => {
    const b = await body(c);
    const email = str(b.email).trim().toLowerCase();
    // keyed by the visitor (clientAddress), not the proxy: on a public site every caller shares the proxy's address,
    // so ten wrong tries from anyone would have locked the real owner out.
    const key = `${addressOf(c)}|${email}`;
    const emailKey = `email|${email}`;
    if (throttled(key) || throttled(emailKey, EMAIL_FAILURES)) return c.json({ error: { code: "too_many_attempts", message: "too many failed logins: wait 15 minutes" } }, 429);
    try {
      const { userId, members: all } = auth.checkPassword(email, str(b.password));
      failures.delete(key);
      failures.delete(emailKey);
      // on a customer site the platform world is not one of this login's worlds; a login with only that one is refused.
      const members = all.filter((m) => !platformBlocked(hostOfReq(c), m.tenantId));
      if (all.length && !members.length) throw platformRefusal();
      if (!members.length) return c.json({ error: { code: "no_world", message: "this login belongs to no world yet" } }, 403);
      const want = str(b.tenant);
      if (!want && members.length > 1) return c.json({ choose: members });
      const tenant = want || members[0].tenantId;
      return me(c, startSession(c, userId, tenant, "password"));
    } catch (e) {
      if (e instanceof AuthError && e.status === 401) {
        failed(key);
        failed(emailKey);
      }
      return fail(c, e);
    }
  });

  api.post("/access/logout", (c) => {
    const raw = getCookie(c, SESSION_COOKIE);
    if (raw) auth.endSession(raw);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  api.post("/access/setup", async (c) => {
    const b = await body(c);
    try {
      return c.json({ email: auth.useSetup(str(b.token), str(b.password)) });
    } catch (e) {
      return fail(c, e);
    }
  });

  /** Switch world: a new session bound to another world the same user belongs to; the old one ends. */
  api.post("/access/switch", async (c) => {
    const i = caller(c);
    if (i.kind !== "session") return c.json({ error: { code: "session_only", message: "only a logged-in person switches world" } }, 403);
    try {
      const want = str((await body(c)).tenant);
      // a world that lives on the other host (a social world on the social site, the rest on
      // the production site) opens there, signed in by a one-time link; this host's session stays as it was.
      const there = homeOrigin(want, requestHost((n) => c.req.header(n)));
      // never into the platform world on a customer site, nor by a link made for the other customer site.
      if (platformBlocked(hostOfReq(c), want) || (there && platformBlocked(new URL(there).hostname, want))) throw platformRefusal();
      // the token rides in the fragment (#handoff=), which the browser never sends, so no proxy log holds it.
      // from the tailnet to a customer site: its sign-in page, where the person signs in as the customer they are.
      if (there && customers.has(new URL(there).hostname) && !customers.has(hostOfReq(c) ?? "")) return c.json({ handoff: `${there}/login` });
      if (there) {
        const overLogin = overLimit(`mint-login|${i.userId}`, HANDOFF_LIMITS.mintLogin);
        if (overLimit(`mint-addr|${addressOf(c)}`, HANDOFF_LIMITS.mintAddress) || overLogin) return tooMany(c);
        return c.json({ handoff: `${there}/login#handoff=${auth.createHandoff(i.userId, want, new URL(there).hostname)}` });
      }
      const next = startSession(c, i.userId, want, "switch");
      const raw = getCookie(c, SESSION_COOKIE);
      if (raw) auth.endSession(raw);
      return me(c, next);
    } catch (e) {
      return fail(c, e);
    }
  });

  // the login page asks before it redeems: who and which world a link signs in, the link left unspent.
  api.post("/access/handoff/peek", async (c) => {
    if (overLimit(`use-addr|${addressOf(c)}`, HANDOFF_LIMITS.useAddress)) return tooMany(c);
    try {
      const peek = auth.peekHandoff(str((await body(c)).token), requestHost((n) => c.req.header(n)));
      if (platformBlocked(hostOfReq(c), peek.tenant)) throw platformRefusal(); // the link stays unspent
      return c.json(peek);
    } catch (e) {
      return fail(c, e);
    }
  });

  // the other host's login page posts its one-time switch link here (only on the person's click,
  // and only on the host the link was made for); a session starts on this host.
  api.post("/access/handoff", async (c) => {
    if (overLimit(`use-addr|${addressOf(c)}`, HANDOFF_LIMITS.useAddress)) return tooMany(c);
    try {
      const token = str((await body(c)).token);
      const host = requestHost((n) => c.req.header(n));
      // the login a link names is known before it is spent; past its cap the link stays unspent.
      const peek = auth.peekHandoff(token, host);
      if (overLimit(`use-login|${peek.email}`, HANDOFF_LIMITS.useLogin)) return tooMany(c);
      if (platformBlocked(host, peek.tenant)) throw platformRefusal(); // refused before the link is spent
      const h = auth.useHandoff(token, host);
      const was = getCookie(c, SESSION_COOKIE);
      const next = startSession(c, h.userId, h.tenant, "handoff");
      if (was) auth.endSession(was); // the session this host had (maybe another login of the same person) ends
      return me(c, next);
    } catch (e) {
      return fail(c, e);
    }
  });

  /**
   * Agent tokens of the caller's own world: an owner session, or (the home world) the console host with its host owner token; never
   * an agent token. Under `on`, legacy trust without a credential mints, lists and revokes nothing.
   */
  const tokenAdmin = (c: Context): Identity | Response => {
    const i = caller(c);
    if ((i.kind === "session" || i.kind === "legacy") && hasOwnerPower(i, mode)) return i;
    return c.json(
      { error: { code: "owner_only", message: "agent tokens are managed by the world's owner (logged in) or the console host (its host owner token)" } },
      i.kind === "none" ? 401 : 403,
    );
  };
  api.get("/access/tokens", (c) => {
    const i = tokenAdmin(c);
    return i instanceof Response ? i : c.json(auth.listTokens((i as { tenant: string }).tenant));
  });
  api.post("/access/tokens", async (c) => {
    const i = tokenAdmin(c);
    if (i instanceof Response) return i;
    try {
      const by = i.kind === "session" ? i.email : `${i.kind === "legacy" && i.host ? "host-owner" : "legacy"}:${(i as { peer: string }).peer || "host"}`;
      const b = await body(c);
      // a token may act as one persona of the world with no console run (e.g. the EpicBooks server as Books);
      // the hub then applies that persona's switches (createToken refuses a persona of another world).
      const personaId = str(b.personaId) || undefined;
      const { token, info } = auth.createToken({ tenant: (i as { tenant: string }).tenant, label: str(b.label), createdBy: by, ...(personaId ? { personaId } : {}) });
      return c.json({ ...info, token }, 201);
    } catch (e) {
      return fail(c, e);
    }
  });
  api.delete("/access/tokens/:id", (c) => {
    const i = tokenAdmin(c);
    if (i instanceof Response) return i;
    return auth.revokeToken((i as { tenant: string }).tenant, c.req.param("id"))
      ? c.json({ ok: true })
      : c.json({ error: { code: "not_found", message: `token ${c.req.param("id")} not found` } }, 404);
  });

  /** The shadow check (D12): would-deny counts since `since` (default 24 h), agent vs browser. the home world only. */
  api.get("/access/events", (c) => {
    const i = caller(c);
    if (!("tenant" in i) || i.tenant !== DEFAULT_TENANT || !hasOwnerPower(i, mode))
      return c.json({ error: { code: "world_scope", message: `the access log is the platform's (${homeWorld()})` } }, 403);
    const since = c.req.query("since") || new Date(Date.now() - 86400_000).toISOString();
    return c.json({ mode, ...auth.events(since, Math.min(Number(c.req.query("limit")) || 50, 500)) });
  });

  return auth;
}
