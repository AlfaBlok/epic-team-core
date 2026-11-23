import crypto from "node:crypto";
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { DB } from "../db.js";
import { sudoRead } from "../secretCache.js";
import { AuthError, outsideRequest, SESSION_COOKIE, SESSION_DAYS, type Auth } from "./identity.js";
import { customerHosts, platformBlocked, PLATFORM_PRIVATE, productOf, requestHost, type DoorKey, type Product } from "./gate.js";
import { keyFile, sites } from "../identity.js";
import { scopeName, validConnects, type ConnectSpec, type ConnectView } from "./connects.js";
import { mountEmailAccess, type MailSender } from "./emailAccess.js";
import { ENABLE_SCOPE, expectedChannels, projectNumberOf, resultPage, YOUTUBE_KEY_NAMES, YOUTUBE_SCOPES, youtubeGoogle, type StoreKey } from "./youtubeConnect.js";

/**
 * sign-up and sign-in with Google or GitHub on the customer sites (cloud.epicteam.app,
 * app.social.app; auth/gate.ts customerHosts), like the memory service's cloud.memory.dev.
 *
 *   GET  /api/access/oauth/providers             the buttons this site shows (only providers whose app is set up)
 *   GET  /api/access/oauth/<p>/start?next=&s=    to the provider; the state is bound to this browser (a cookie) and host
 *   GET  /api/access/oauth/<p>/callback          back: a verified email signs in (or signs up), then on to `next`
 *   POST /api/access/oauth/pick/peek, /pick      a login in several worlds picks one (a one-time link in the fragment)
 *   POST /api/access/oauth/making {token}        a new world still being made: 202 pending, then the session
 *
 * Who it is: the provider's verified email. A known provider account (oauth_identities) signs in as its login; else the
 * login with that email; else, for Google mail (gmail.com or a Google Workspace domain, where `a+tag@d` is delivered to
 * `a@d`), the one login `a+tag@d`, so the owner's `owner+the home world@our domain` signs in with his Google `owner@our domain`. Nobody
 * matched: a sign-up, which makes a new world for this site's product (the `signup` hook: the social product's free tester plan,
 * EpicTeam's plan waiting for payment) with the person as its owner. Sign-ups stop at CONSOLE_SIGNUP_PER_DAY (default 20)
 * a day, and CONSOLE_SIGNUP=off closes them (sign-in still works).
 *
 * The apps' keys (never in the repo, never printed): env first, else the console's secret store
 * (/etc/the home world-secrets/agent-team-console/<NAME>, what the Secrets page's paste box writes), re-read every 5 minutes, so a
 * pasted key works without a deploy. GitHub allows one callback host per OAuth app, so each site has its own:
 *   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET          one Google client, both sites' callbacks
 *   GITHUB_OAUTH_TEAM_CLIENT_ID, GITHUB_OAUTH_TEAM_CLIENT_SECRET     cloud.epicteam.app (was app.epicteam.app)
 *   GITHUB_OAUTH_SOCIAL_CLIENT_ID, GITHUB_OAUTH_SOCIAL_CLIENT_SECRET cloud.social.app (was app.social.app)
 * (GOOGLE_OAUTH_<TEAM|SOCIAL>_CLIENT_ID/_SECRET, when set, win for that site.)
 * `<GOOGLE|GITHUB>_OAUTH_<TEAM|SOCIAL>_CALLBACK_HOST` (env or store, optional) sends the provider back to that
 * host instead of this one, for a renamed site whose new callback the app does not list yet: cloud.epicteam.app with
 * `app.epicteam.app`, whose Traefik route redirects the callback (path and query kept) to cloud.epicteam.app, where this
 * browser's state cookie is. Remove the value once the app lists the new callback.
 *
 * a declared customer login (`CUSTOMER_LOGINS`) comes before all of
 * that on its product's site: the owner's Google `owner@our domain` on cloud.social.app (was app.) signs in as his a social world repo login
 * `someone@example.com`, a customer's (owner of that world only), not as the builder `owner+the home world@our domain` it is
 * linked to since 19:51Z 2026-11-10. Only a provider-verified email matches; the stored link is not rewritten, so one
 * revert of the line (or `CONSOLE_CUSTOMER_LOGINS=` empty) gives the builder login back.
 *
 * TEST provider: CONSOLE_OAUTH_TEST=1 outside NODE_ENV=production adds "test", whose sign-in page is this console's own
 * (type an email), so the whole path runs end to end before the real apps exist. Production never shows it.
 */

export type ProviderId = "google" | "github" | "test";
export const PROVIDERS: Record<ProviderId, { name: string }> = { google: { name: "Google" }, github: { name: "GitHub" }, test: { name: "TEST provider" } };
const STATE_MS = 10 * 60_000;
const PICK_MS = 5 * 60_000;
const STATE_COOKIE = "console_oauth";
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const random = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

export interface OAuthCreds {
  clientId: string;
  clientSecret: string;
  /** the host the provider sends the browser back to, when not this site's own (see the module comment). */
  callbackHost?: string;
}
export type CredsOf = (provider: ProviderId, product: Product) => Promise<OAuthCreds | undefined>;

/** Who the provider says signed in. `googleMail`: the address is Google-hosted (plus addresses reach its owner). */
export interface ProviderUser {
  subject: string;
  email: string;
  name: string;
  googleMail?: boolean;
}

export interface SignupInput {
  email: string;
  name: string;
  product: Product;
  /** `email`: the email sign-up's confirm link (auth/emailAccess.ts) */
  provider: ProviderId | "email";
  host: string;
  /** `TEST` for a test sign-up (`?s=TEST` on start): stored and counted as TEST, never a note to the owner. */
  visitSource?: string;
}

export interface OAuthOptions {
  db: DB;
  auth: Auth;
  /** Make the new person's world and make them its owner; answers the world id. */
  signup: (i: SignupInput) => Promise<{ world: string }>;
  creds?: CredsOf;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** store one key in the console's store (app agent-team-console); unset = the YouTube connect stores nothing. */
  storeKey?: StoreKey;
  /** whether a key is in the console's store (names only; default: its file reads non-empty, cached a minute) */
  hasKey?: (name: string) => Promise<boolean>;
  /** the one-button connects (auth/connects.ts); default sites().connects */
  connects?: ConnectSpec[];
  /** the sign-up and reset mail sender (auth/emailAccess.ts); default Cloudflare Email Sending */
  mail?: { send: MailSender; ready?: () => Promise<boolean> };
}

/**
 * a provider account (its verified email) that signs in as a given login on one product's site, before the
 * stored link and the email rules. `provider|email|product|login`, space- or comma-separated; `CONSOLE_CUSTOMER_LOGINS`
 * replaces the default, empty turns it off.
 */
export const DEFAULT_CUSTOMER_LOGINS = (): string => sites().customerLogins;
export const customerLogins = (env: NodeJS.ProcessEnv = process.env) =>
  (env.CONSOLE_CUSTOMER_LOGINS ?? DEFAULT_CUSTOMER_LOGINS())
    .split(/[\s,]+/)
    .map((part) => part.trim().toLowerCase().split("|"))
    .filter((f) => f.length === 4 && f.every(Boolean) && (f[2] === "team" || f[2] === "social"))
    .map(([provider, email, product, login]) => ({ provider, email, product: product as Product, login }));

/** The store names of a provider's app for a site's product (see the module comment). */
export function credNames(provider: ProviderId, product: Product): { id: string[]; secret: string[]; callbackHost?: string } {
  const P = product.toUpperCase();
  if (provider === "google") return { id: [`GOOGLE_OAUTH_${P}_CLIENT_ID`, "GOOGLE_OAUTH_CLIENT_ID"], secret: [`GOOGLE_OAUTH_${P}_CLIENT_SECRET`, "GOOGLE_OAUTH_CLIENT_SECRET"], callbackHost: `GOOGLE_OAUTH_${P}_CALLBACK_HOST` };
  if (provider === "github") return { id: [`GITHUB_OAUTH_${P}_CLIENT_ID`], secret: [`GITHUB_OAUTH_${P}_CLIENT_SECRET`], callbackHost: `GITHUB_OAUTH_${P}_CALLBACK_HOST` };
  return { id: [], secret: [] };
}


/**
 * Env, else the console's store; cached 5 minutes, values never logged. A missing name is cached 30 minutes: sign-in
 * pages ask for names no store has on every load, and a store read can be slow; a new key shows within that, a restart at once.
 */
export function storeCreds(o: { env?: NodeJS.ProcessEnv; read?: (file: string) => Promise<string | undefined>; now?: () => number } = {}): CredsOf {
  const env = o.env ?? process.env;
  const read = o.read ?? sudoRead;
  const now = o.now ?? Date.now;
  const cache = new Map<string, { v: string | undefined; at: number }>();
  const value = async (name: string) => {
    if (env[name]?.trim()) return env[name]!.trim();
    const c = cache.get(name);
    if (c && now() - c.at < (c.v ? 5 : 30) * 60_000) return c.v;
    const v = (await read(keyFile(name)).catch(() => undefined))?.trim() || undefined;
    cache.set(name, { v, at: now() });
    return v;
  };
  const first = async (names: string[]) => {
    for (const n of names) {
      const v = await value(n);
      if (v) return v;
    }
    return undefined;
  };
  return async (provider, product) => {
    if (provider === "test") return { clientId: "test", clientSecret: "test" };
    const n = credNames(provider, product);
    const clientId = await first(n.id);
    const clientSecret = clientId ? await first(n.secret) : undefined;
    if (!clientId || !clientSecret) return undefined;
    const via = n.callbackHost ? (await value(n.callbackHost))?.toLowerCase() : undefined;
    const callbackHost = via && /^[a-z0-9.-]+$/.test(via) ? via : undefined;
    return { clientId, clientSecret, ...(callbackHost ? { callbackHost } : {}) };
  };
}

export const testProviderOn = (env: NodeJS.ProcessEnv = process.env) => env.CONSOLE_OAUTH_TEST === "1" && env.NODE_ENV !== "production";

/**
 * A relative path on this site, else "/" (never another site: `//x`, `/\x`). No backslash, space or control
 * character anywhere either: a browser drops tabs and newlines from a URL and reads `\` as `/`, so `/<tab>/x` left the site.
 */
export const safeNext = (v: string | undefined) => (v && v.startsWith("/") && !v.startsWith("//") && !/[\\\s\x00-\x1f\x7f]/.test(v) ? v.slice(0, 500) : "/");

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function mountOAuth(api: Hono, o: OAuthOptions) {
  const env = o.env ?? process.env;
  const db = o.db;
  const auth = o.auth;
  const creds = o.creds ?? storeCreds({ env });
  const http = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_identities (
      provider TEXT NOT NULL,
      subject TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      signup_world TEXT,
      PRIMARY KEY (provider, subject)
    );
  `);

  /** Pending hops to a provider, by sha256(state); in memory (a restart in the 10 minutes means pressing the button again). */
  const states = new Map<string, { provider: ProviderId; host: string; next: string; verifier: string; visitSource?: string; exp: number; purpose?: "youtube" | "youtube-enable" | "connect"; pending?: string; connect?: string }>();
  /** a YouTube Allow held while its project's APIs are switched on, by a random id (10 minutes, in memory). */
  const ytPending = new Map<string, { refresh: string; host: string; exp: number; enabled?: boolean; connect?: string }>();
  /** One-time world choices (a login in several worlds), by sha256(token). */
  const picks = new Map<string, { userIds: string[]; host: string; next: string; exp: number; via?: string }>();
  /** TEST provider: one-time codes from its page. */
  const testCodes = new Map<string, { email: string; name: string; exp: number }>();
  /**
   * A new world is made in the background. A world can take longer than a proxy waits (the social world about
   * 106 s, past Cloudflare's 100 s), so the callback waits at most CONSOLE_SIGNUP_WAIT_MS (default 3 s) and otherwise sends
   * the browser to /login#making=<token>, where the page asks POST /access/oauth/making until the world is ready.
   * One job per product and email: a second sign-in, a refresh or an email confirm while it runs joins the same job, so a
   * retry never makes a second world. In memory: after a restart the person signs in again and the world is picked up.
   */
  const jobs = new Map<string, { p: Promise<{ userId: string; world: string }>; settled: boolean; exp: number }>();
  const makingTokens = new Map<string, { job: string; host: string; next: string; via: string; exp: number }>();
  const MAKING_MS = 30 * 60_000;
  const sweep = () => {
    const t = now();
    for (const m of [states, picks, testCodes, ytPending, makingTokens, jobs] as Map<string, { exp: number }>[]) {
      for (const [k, v] of m) if (v.exp < t) m.delete(k);
      if (m.size > 10_000) m.clear();
    }
  };

  const hostOf = (c: Context) => requestHost((n) => c.req.header(n)) ?? "";
  const testOn = testProviderOn(env);
  const customers = customerHosts(env);
  /** OAuth runs on the customer sites (their callbacks are what the apps register); the TEST provider on any host. */
  const siteOk = (host: string) => customers.has(host) || testOn;
  const enabled = async (p: ProviderId, host: string): Promise<boolean> => {
    if (p === "test") return testOn;
    if (!customers.has(host)) return false;
    return !!(await creds(p, productOf(host, env)));
  };
  /** This site's own address (Traefik passes the host and says https; a local proof keeps its port). */
  const origin = (c: Context, host: string) => {
    const proto = (c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "")).split(",")[0].trim() === "https" ? "https" : "http";
    const port = c.req.header("x-forwarded-host") ? "" : (/:(\d+)$/.exec(c.req.header("host") ?? "")?.[0] ?? "");
    return `${proto}://${host}${port}`;
  };
  const callbackUrl = (c: Context, host: string, p: ProviderId, via?: string) =>
    `${via ? `https://${via}` : origin(c, host)}/api/access/oauth/${p}/callback`;
  const secure = (c: Context, host: string) => origin(c, host).startsWith("https:");
  const back = (c: Context, code: string) => c.redirect(`/login?oauth_error=${encodeURIComponent(code)}`, 302);
  const providerParam = (c: Context): ProviderId | undefined => {
    const p = c.req.param("provider");
    return p === "google" || p === "github" || p === "test" ? p : undefined;
  };

  api.get("/access/oauth/providers", async (c) => {
    const host = hostOf(c);
    const product = productOf(host, env);
    const list: { id: ProviderId; name: string }[] = [];
    for (const p of ["google", "github", "test"] as ProviderId[]) if (await enabled(p, host)) list.push({ id: p, name: PROVIDERS[p].name });
    return c.json({ product, providers: list, signup: customers.has(host) && env.CONSOLE_SIGNUP !== "off" });
  });

  // the YouTube Allow on the console's own Google client (auth/youtubeConnect.ts). Before the :provider routes.
  const yt = youtubeGoogle(http);
  db.exec(`CREATE TABLE IF NOT EXISTS youtube_connect (id INTEGER PRIMARY KEY CHECK (id = 1), channel TEXT NOT NULL, at TEXT NOT NULL)`);
  let ytStarts: number[] = [];
  const ytPage = (c: Context, o: Parameters<typeof resultPage>[0], status: 200 | 400 | 409 | 502 | 503 = 200) => c.html(resultPage(o), status);
  const ytAgain = { href: "/api/access/oauth/youtube/start", label: "Try again" };

  // the one-button connects (auth/connects.ts): config entries, each a card with one button.
  db.exec(`CREATE TABLE IF NOT EXISTS oauth_connects (id TEXT PRIMARY KEY, detail TEXT NOT NULL, at TEXT NOT NULL)`);
  const connectList = () => validConnects(o.connects ?? sites().connects);
  const connectById = (id?: string) => (id ? connectList().find((x) => x.id === id) : undefined);
  const connectAgain = (spec: ConnectSpec) => ({ href: `/api/access/oauth/connect/${spec.id}/start`, label: "Try again" });
  const inboxUrl = () => `${(env.CONSOLE_TEAM_URL || sites().teamUrl).replace(/\/$/, "")}/inbox`;
  const markConnected = (id: string, detail: string) =>
    db.prepare("INSERT INTO oauth_connects (id, detail, at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET detail = excluded.detail, at = excluded.at").run(id, detail, new Date(now()).toISOString());
  const keySeen = new Map<string, { v: boolean; at: number }>();
  const hasKey =
    o.hasKey ??
    (async (name: string) => {
      const c = keySeen.get(name);
      if (c && now() - c.at < 60_000) return c.v;
      const v = !!(await sudoRead(keyFile(name)).catch(() => undefined))?.trim();
      keySeen.set(name, { v, at: now() });
      return v;
    });
  /** the customer site that carries a connect's callback: the first EpicTeam customer site (cloud.epicteam.app) */
  const connectHost = () => env.CONSOLE_CONNECT_HOST?.trim() || [...customers].find(([, p]) => p === "team")?.[0] || [...customers.keys()][0];
  const connectView = async (spec: ConnectSpec): Promise<ConnectView> => {
    const row = db.prepare("SELECT detail, at FROM oauth_connects WHERE id = ?").get(spec.id) as { detail: string; at: string } | undefined;
    const yt = spec.check === "youtube-channel" ? (db.prepare("SELECT channel, at FROM youtube_connect WHERE id = 1").get() as { channel: string; at: string } | undefined) : undefined;
    const keys = (await Promise.all([spec.keys.clientId, spec.keys.clientSecret, spec.keys.refreshToken].map(hasKey))).every(Boolean);
    const at = row?.at ?? yt?.at;
    const host = connectHost();
    return {
      id: spec.id,
      title: spec.title,
      what: spec.what,
      account: spec.account,
      ...(spec.channel ? { channel: spec.channel } : {}),
      gives: [...new Set(spec.scopes.map(scopeName))],
      connected: keys && !!at,
      ...(keys && at ? { at } : {}),
      startUrl: host ? `https://${host}/api/access/oauth/connect/${spec.id}/start` : `/api/access/oauth/connect/${spec.id}/start`,
      inbox: spec.inbox !== false,
    };
  };
  api.get("/connects", async (c) => c.json({ connects: await Promise.all(connectList().map(connectView)) }));
  api.get("/access/oauth/connect/:id/start", async (c) => {
    sweep();
    const spec = connectById(c.req.param("id"));
    const host = hostOf(c);
    if (!spec) return ytPage(c, { title: "No such connect", lines: ["Open the Connect button on the console's inbox again."], button: { href: inboxUrl(), label: "Open the inbox" } }, 400);
    // the button lives on the console; the provider's web client lists only the customer site's callback: hop there first
    if (!customers.has(host) || !(await enabled("google", host))) {
      const to = connectHost();
      if (to && to !== host && customers.has(to)) return c.redirect(`https://${to}/api/access/oauth/connect/${spec.id}/start`, 302);
      return ytPage(c, { title: "Not on this address", lines: ["The team's Google app is not set up here. The team has been told."] }, 400);
    }
    ytStarts = ytStarts.filter((t) => t > now() - 3600_000);
    if (ytStarts.length >= 30) return ytPage(c, { title: "Too many tries", lines: ["Wait an hour, then press the button again."] }, 409);
    ytStarts.push(now());
    return ytHop(c, host, spec.check === "youtube-channel" ? "youtube" : "connect", undefined, spec);
  });
  /** a plain connect's answer: every scope given, the named account, then its three keys into the store. */
  const connectFinish = async (c: Context, host: string, spec: ConnectSpec | undefined, t: { access: string; refresh?: string; scopes: string[] }) => {
    if (!spec) return ytPage(c, { title: "This page has expired", lines: ["Press the Connect button in the inbox again."], button: { href: inboxUrl(), label: "Open the inbox" } }, 400);
    const again = connectAgain(spec);
    const missing = spec.scopes.filter((x) => !t.scopes.includes(x));
    if (missing.length || !t.refresh) {
      await yt.revoke(t.refresh ?? t.access);
      return ytPage(c, { title: "Tick every box", lines: ["Google's screen has a box for each thing the team needs. Press Try again, tick every box, then Allow."], button: again }, 400);
    }
    const u = await http("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${t.access}` } });
    const email = u.ok ? String(((await u.json().catch(() => ({}))) as { email?: string }).email ?? "").toLowerCase() : "";
    if (email !== spec.account.toLowerCase()) {
      await yt.revoke(t.refresh);
      return ytPage(c, { title: "That is not the right Google account", lines: [`You picked ${email || "another account"}. Nothing was stored and that permission was given back.`, `Press Try again and pick ${spec.account}.`], button: again }, 409);
    }
    if (!o.storeKey) return ytPage(c, { title: "Nothing stored", lines: ["This console has no key store. The team has been told."] }, 503);
    const k = (await creds("google", productOf(host, env)))!;
    for (const [name, value] of [[spec.keys.clientId, k.clientId], [spec.keys.clientSecret, k.clientSecret], [spec.keys.refreshToken, t.refresh]] as const) {
      const r = await o.storeKey(name, value, `${spec.title}: Allow by ${spec.account} on ${host}`);
      if (!r.ok) {
        console.error(`connect ${spec.id}: ${name} not stored: ${r.message}`);
        return ytPage(c, { title: "Allowed, but not stored", lines: ["Google said yes, but the team's key store refused. The team has been told; you do not need to do anything."] }, 502);
      }
    }
    keySeen.clear();
    markConnected(spec.id, spec.account);
    console.log(`connect ${spec.id}: connected, three keys stored (names only)`);
    return ytPage(c, { ok: true, title: `Done: ${spec.title.replace(/^Connect /, "")} is connected`, lines: [spec.what, "Take it back any time in your Google account, Security, Third-party access."], button: { href: inboxUrl(), label: "Back to the inbox" } });
  };
  const ytHop = async (c: Context, host: string, purpose: "youtube" | "youtube-enable" | "connect", pending?: string, spec?: ConnectSpec) => {
    const k = (await creds("google", productOf(host, env)))!;
    const state = random();
    const verifier = random(48);
    states.set(sha256(state), { provider: "google", host, next: "/", verifier, exp: now() + STATE_MS, purpose, ...(pending ? { pending } : {}), ...(spec ? { connect: spec.id } : {}) });
    // a connect names its account: Google opens on it (signed in) or asks for exactly it, no account picker to guess at
    const scopes = purpose === "youtube" ? YOUTUBE_SCOPES : purpose === "connect" ? [...new Set(["openid", "email", ...(spec?.scopes ?? [])])] : [ENABLE_SCOPE];
    setCookie(c, STATE_COOKIE, state, { httpOnly: true, sameSite: "Lax", path: "/api/access/oauth", secure: secure(c, host), maxAge: STATE_MS / 1000 });
    const q = new URLSearchParams({
      client_id: k.clientId,
      redirect_uri: callbackUrl(c, host, "google", k.callbackHost),
      response_type: "code",
      scope: scopes.join(" "),
      state,
      code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      prompt: spec ? "consent" : "consent select_account",
      ...(spec ? { login_hint: spec.account } : {}),
      ...(purpose !== "youtube-enable" ? { access_type: "offline" } : {}),
    });
    return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`, 302);
  };
  /** The held Allow's channel: stored when it is ours, refused (and taken back) when not, another switch-on when the APIs are off. */
  const ytFinish = async (c: Context, host: string, refresh: string, w: { enabled?: boolean; access?: string; connect?: string } = {}) => {
    const k = (await creds("google", productOf(host, env)))!;
    const spec = connectById(w.connect);
    let ch = await yt.channel(w.access ?? (await yt.refresh({ refresh, clientId: k.clientId, clientSecret: k.clientSecret })));
    // a switch-on takes a little while to spread: a few tries inside the request, then a Check again button
    for (let i = 0; w.enabled && ch.kind === "api_off" && i < 4; i++) {
      await new Promise((r) => setTimeout(r, Number(env.YOUTUBE_CONNECT_RETRY_MS ?? 5000)));
      ch = await yt.channel(await yt.refresh({ refresh, clientId: k.clientId, clientSecret: k.clientSecret }));
    }
    if (ch.kind === "api_off") {
      const id = random(18);
      ytPending.set(id, { refresh, host, exp: now() + STATE_MS, ...(w.enabled ? { enabled: true } : {}), ...(spec ? { connect: spec.id } : {}) });
      if (w.enabled)
        return ytPage(c, { title: "Almost there", lines: ["YouTube is switched on for the team's Google app, but Google takes a minute to spread it.", "Wait one minute, then press Check again."], button: { href: `/api/access/oauth/youtube/finish?p=${id}`, label: "Check again" } });
      if (!projectNumberOf(k.clientId)) return ytPage(c, { title: "YouTube is off in the team's Google app", lines: ["The team could not tell which Google project to switch it on in. Nothing was stored; the team has been told."] }, 503);
      return ytPage(c, {
        title: "One more Allow",
        lines: ["Your YouTube Allow worked. The team's Google app still has YouTube switched off.", "Press the button and tap Allow once more: the team switches YouTube on in that app, then gives this second permission straight back."],
        button: { href: `/api/access/oauth/youtube/enable?p=${id}`, label: "Switch YouTube on" },
      });
    }
    if (ch.kind === "error") return ytPage(c, { title: "YouTube did not answer", lines: [`Google said ${ch.status}. Nothing was stored. Try again in a few minutes.`], button: ytAgain }, 502);
    const want = expectedChannels(env);
    if (ch.kind === "none" || !want.includes(ch.handle)) {
      await yt.revoke(refresh);
      const which = ch.kind === "none" ? "a Google login with no YouTube channel" : `the channel ${ch.title || ch.handle} (@${ch.handle})`;
      const pick = spec ? `Press Try again and pick the Google account ${spec.account}${spec.channel ? `, channel ${spec.channel.name} ${spec.channel.handle}` : ""}.` : want.length ? `Press Try again and pick @${want[0]}.` : "This console names no YouTube channel yet: the team has been told.";
      return ytPage(c, { title: "That is not the team's channel", lines: [`You picked ${which}. Nothing was stored and that permission was given back.`, pick], button: spec ? connectAgain(spec) : ytAgain }, 409);
    }
    if (!o.storeKey) return ytPage(c, { title: "Nothing stored", lines: ["This console has no key store. The team has been told."] }, 503);
    const note = `YouTube Allow for @${ch.handle} on ${host}`;
    const names = spec?.keys ?? YOUTUBE_KEY_NAMES;
    for (const [name, value] of [[names.clientId, k.clientId], [names.clientSecret, k.clientSecret], [names.refreshToken, refresh]] as const) {
      const r = await o.storeKey(name, value, note);
      if (!r.ok) {
        console.error(`youtube connect: ${name} not stored: ${r.message}`);
        return ytPage(c, { title: "Allowed, but not stored", lines: ["Google said yes, but the team's key store refused. The team has been told; you do not need to do anything."] }, 502);
      }
    }
    db.prepare("INSERT INTO youtube_connect (id, channel, at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET channel = excluded.channel, at = excluded.at").run(ch.handle, new Date(now()).toISOString());
    keySeen.clear();
    if (spec) markConnected(spec.id, `@${ch.handle}`);
    console.log(`youtube connect: @${ch.handle} connected, three keys stored (names only)`);
    return ytPage(c, { ok: true, title: "Done: YouTube is connected", lines: [`The team can now read @${ch.handle}'s numbers and post its approved Shorts.`, "Take it back any time in your Google account, Security, Third-party access."], button: { href: inboxUrl(), label: "Back to the inbox" } });
  };
  api.get("/access/oauth/youtube/status", async (c) => {
    const host = hostOf(c);
    const row = db.prepare("SELECT channel, at FROM youtube_connect WHERE id = 1").get() as { channel: string; at: string } | undefined;
    return c.json({ ready: customers.has(host) && (await enabled("google", host)), connected: !!row, ...(row ? { channel: `@${row.channel}`, at: row.at } : {}) });
  });
  api.get("/access/oauth/youtube/start", async (c) => {
    sweep();
    const host = hostOf(c);
    if (!customers.has(host) || !(await enabled("google", host))) return ytPage(c, { title: "Not on this address", lines: ["Open the link the team sent you: it starts on the team's sign-in site."] }, 400);
    ytStarts = ytStarts.filter((t) => t > now() - 3600_000);
    if (ytStarts.length >= 30) return ytPage(c, { title: "Too many tries", lines: ["Wait an hour, then open the link again."] }, 409);
    ytStarts.push(now());
    return ytHop(c, host, "youtube");
  });
  api.get("/access/oauth/youtube/enable", async (c) => {
    sweep();
    const host = hostOf(c);
    const p = ytPending.get(c.req.query("p") ?? "");
    if (!p || p.host !== host) return ytPage(c, { title: "This page has expired", lines: ["Open the link again and tap Allow."], button: ytAgain }, 400);
    return ytHop(c, host, "youtube-enable", c.req.query("p"));
  });
  api.get("/access/oauth/youtube/finish", async (c) => {
    sweep();
    const host = hostOf(c);
    const id = c.req.query("p") ?? "";
    const p = ytPending.get(id);
    if (!p || p.host !== host) return ytPage(c, { title: "This page has expired", lines: ["Open the link again and tap Allow."], button: ytAgain }, 400);
    ytPending.delete(id);
    try {
      return await ytFinish(c, host, p.refresh, { enabled: true, connect: p.connect });
    } catch (e) {
      console.error(`youtube connect finish: ${(e as Error).message}`);
      return ytPage(c, { title: "Google did not answer", lines: ["Nothing was stored. Open the link again in a few minutes."], button: ytAgain }, 502);
    }
  });
  /** Google's answer for a YouTube hop (from the shared callback). */
  const ytCallback = async (c: Context, host: string, st: { purpose?: "youtube" | "youtube-enable" | "connect"; pending?: string; verifier: string; connect?: string }, code: string) => {
    const k = await creds("google", productOf(host, env));
    if (!k) return ytPage(c, { title: "Not on this address", lines: ["Open the link the team sent you."] }, 400);
    const redirect = callbackUrl(c, host, "google", k.callbackHost);
    try {
      const t = await yt.exchange({ code, clientId: k.clientId, clientSecret: k.clientSecret, redirect, verifier: st.verifier });
      if (st.purpose === "youtube-enable") {
        const p = ytPending.get(st.pending ?? "");
        const number = projectNumberOf(k.clientId);
        const done = number ? await yt.enable(t.access, number) : { ok: false as const, status: 0 };
        await yt.revoke(t.access); // the switch-on permission goes straight back
        if (!p) return ytPage(c, { title: "This page has expired", lines: ["Open the link again and tap Allow."], button: ytAgain }, 400);
        ytPending.delete(st.pending!);
        if (!done.ok) {
          console.error(`youtube connect: switch-on refused (${done.status})`);
          return ytPage(c, { title: "Google refused to switch YouTube on", lines: ["That Google login cannot change the team's Google app. Press Try again and pick the Google login that owns the app."], button: ytAgain }, 409);
        }
        return await ytFinish(c, host, p.refresh, { enabled: true, connect: p.connect });
      }
      if (st.purpose === "connect") return await connectFinish(c, host, connectById(st.connect), t);
      const missing = YOUTUBE_SCOPES.filter((s) => !t.scopes.includes(s));
      if (missing.length || !t.refresh) {
        await yt.revoke(t.refresh ?? t.access);
        return ytPage(c, { title: "Tick every box", lines: ["Google's screen has a box for each thing the team needs. Press Try again, tick every box, then Allow."], button: ytAgain }, 400);
      }
      return await ytFinish(c, host, t.refresh, { access: t.access, connect: st.connect });
    } catch (e) {
      console.error(`youtube connect: ${(e as Error).message}`);
      return ytPage(c, { title: "Google did not answer", lines: ["Nothing was stored. Open the link again in a few minutes."], button: ytAgain }, 502);
    }
  };

  api.get("/access/oauth/:provider/start", async (c) => {
    sweep();
    const p = providerParam(c);
    const host = hostOf(c);
    if (!p || !siteOk(host) || !(await enabled(p, host))) return back(c, "provider_off");
    const product = productOf(host, env);
    const state = random();
    const verifier = random(48);
    const s = c.req.query("s");
    states.set(sha256(state), { provider: p, host, next: safeNext(c.req.query("next")), verifier, ...(s === "TEST" ? { visitSource: "TEST" } : {}), exp: now() + STATE_MS });
    setCookie(c, STATE_COOKIE, state, { httpOnly: true, sameSite: "Lax", path: "/api/access/oauth", secure: secure(c, host), maxAge: STATE_MS / 1000 });
    if (p === "test") return c.redirect(`/api/access/oauth/test/authorize?${new URLSearchParams({ state, redirect_uri: callbackUrl(c, host, p) })}`, 302);
    const k = (await creds(p, product))!;
    const redirect = callbackUrl(c, host, p, k.callbackHost);
    if (p === "google") {
      const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      const q = new URLSearchParams({
        client_id: k.clientId,
        redirect_uri: redirect,
        response_type: "code",
        scope: "openid email profile",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        prompt: "select_account",
      });
      return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`, 302);
    }
    const q = new URLSearchParams({ client_id: k.clientId, redirect_uri: redirect, scope: "read:user user:email", state, allow_signup: "true" });
    return c.redirect(`https://github.com/login/oauth/authorize?${q}`, 302);
  });

  /** The provider's answer to a code: who signed in, with a verified email; throws an AuthError code otherwise. */
  async function whoIs(p: ProviderId, code: string, redirect: string, verifier: string, product: Product): Promise<ProviderUser> {
    if (p === "test") {
      const t = testCodes.get(sha256(code));
      testCodes.delete(sha256(code));
      if (!t || t.exp < now()) throw new AuthError(400, "bad_code", "the sign-in code is invalid or expired");
      return { subject: `test:${t.email}`, email: t.email, name: t.name, googleMail: true };
    }
    const k = await creds(p, product);
    if (!k) throw new AuthError(400, "provider_off", "this sign-in is not set up");
    const json = async (r: Response) => {
      if (!r.ok) throw new AuthError(400, "provider_refused", `${PROVIDERS[p].name} answered ${r.status}`);
      return (await r.json()) as Record<string, any>;
    };
    const t = AbortSignal.timeout(15_000);
    if (p === "google") {
      const tok = await json(
        await http("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams({ code, client_id: k.clientId, client_secret: k.clientSecret, redirect_uri: redirect, grant_type: "authorization_code", code_verifier: verifier }),
          signal: t,
        }),
      );
      if (typeof tok.access_token !== "string") throw new AuthError(400, "provider_refused", "Google sent no access token");
      const u = await json(await http("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${tok.access_token}` }, signal: t }));
      const email = String(u.email ?? "").trim().toLowerCase();
      if (!u.sub || !EMAIL.test(email) || u.email_verified !== true) throw new AuthError(400, "email_unverified", "Google did not confirm an email address");
      const domain = email.split("@")[1];
      return { subject: String(u.sub), email, name: String(u.name ?? ""), googleMail: domain === "gmail.com" || (typeof u.hd === "string" && u.hd.toLowerCase() === domain) };
    }
    const tok = await json(
      await http("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ code, client_id: k.clientId, client_secret: k.clientSecret, redirect_uri: redirect }),
        signal: t,
      }),
    );
    if (typeof tok.access_token !== "string") throw new AuthError(400, "provider_refused", "GitHub sent no access token");
    const h = { authorization: `Bearer ${tok.access_token}`, accept: "application/vnd.github+json", "user-agent": "epicteam-console" };
    const u = await json(await http("https://api.github.com/user", { headers: h, signal: t }));
    const emails = (await json(await http("https://api.github.com/user/emails", { headers: h, signal: t }))) as unknown as { email: string; primary?: boolean; verified?: boolean }[];
    const list = Array.isArray(emails) ? emails.filter((e) => e && e.verified && EMAIL.test(String(e.email))) : [];
    const pick = list.find((e) => e.primary) ?? list[0];
    if (!u.id || !pick) throw new AuthError(400, "email_unverified", "GitHub has no verified email on this account");
    return { subject: String(u.id), email: String(pick.email).trim().toLowerCase(), name: String(u.name || u.login || "") };
  }

  type Row = Record<string, any>;
  const enabledUser = (id: string) => db.prepare("SELECT id, email FROM users WHERE id = ? AND disabled_at IS NULL").get(id) as Row | undefined;
  /** The logins this provider account is (see the module comment), enabled ones only. */
  const declared = customerLogins(env);
  /** the declared customer login of this provider account on this product's site (a verified email: whoIs refuses any other). */
  const declaredLogin = (p: ProviderId, u: ProviderUser, product: Product): string | undefined => {
    const as = declared.find((d) => d.provider === p && d.email === u.email && d.product === product);
    return as && ((db.prepare("SELECT id FROM users WHERE email = ? AND disabled_at IS NULL").get(as.login) as Row | undefined)?.id as string | undefined);
  };
  function loginsFor(p: ProviderId, u: ProviderUser, product: Product): string[] {
    const customer = declaredLogin(p, u, product);
    if (customer) return [customer];
    const linked = db.prepare("SELECT user_id FROM oauth_identities WHERE provider = ? AND subject = ?").get(p, u.subject) as Row | undefined;
    if (linked) return enabledUser(linked.user_id) ? [linked.user_id] : [];
    const exact = db.prepare("SELECT id FROM users WHERE email = ? AND disabled_at IS NULL").get(u.email) as Row | undefined;
    if (exact) return [exact.id];
    if (!u.googleMail) return [];
    const [local, domain] = u.email.split("@");
    if (local.includes("+")) return [];
    return (db.prepare("SELECT id, email FROM users WHERE disabled_at IS NULL AND email LIKE ? ESCAPE '\\'").all(`${local.replace(/[\\%_]/g, "\\$&")}+%@${domain.replace(/[\\%_]/g, "\\$&")}`) as Row[])
      .filter((r) => String(r.email).toLowerCase().split("@")[1] === domain)
      .map((r) => r.id as string);
  }
  const linkedTo = (p: ProviderId, u: ProviderUser) =>
    (db.prepare("SELECT user_id FROM oauth_identities WHERE provider = ? AND subject = ?").get(p, u.subject) as Row | undefined)?.user_id as string | undefined;
  const link = (p: ProviderId | "email", u: ProviderUser, userId: string, signupWorld?: string) => {
    const at = new Date(now()).toISOString();
    db.prepare(
      `INSERT INTO oauth_identities (provider, subject, user_id, email, created_at, last_used_at, signup_world) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, subject) DO UPDATE SET last_used_at = excluded.last_used_at, email = excluded.email`,
    ).run(p, u.subject, userId, u.email, at, at, signupWorld ?? null);
  };
  const skinOf = (tenant: string) => (db.prepare("SELECT skin FROM tenants WHERE id = ?").get(tenant) as Row | undefined)?.skin as string | undefined;
  const fits = (tenant: string, product: Product) => (skinOf(tenant) === "social") === (product === "social");
  const loginEmail = (userId: string) => (db.prepare("SELECT email FROM users WHERE id = ?").get(userId) as Row | undefined)?.email as string | undefined;
  /** the door is passed by a Google or GitHub sign-in of a login it names (gate.ts throughDoor). */
  const doorKey = (userId: string, via: string): DoorKey => ({ email: loginEmail(userId), via });
  const startSession = (c: Context, host: string, userId: string, tenant: string, via?: string) => {
    if (platformBlocked(host, tenant, env, { email: loginEmail(userId), via: via ?? "" })) throw new AuthError(403, PLATFORM_PRIVATE.code, PLATFORM_PRIVATE.message);
    const s = auth.createSession(userId, tenant, { via, host }); // the scorecard's proof of a provider sign-in
    setCookie(c, SESSION_COOKIE, s.id, { httpOnly: true, sameSite: "Lax", path: "/", secure: secure(c, host), maxAge: SESSION_DAYS * 86400 });
  };
  /** One world-making per product and email at a time (Google, GitHub and the email confirm share it). */
  const inFlight = new Map<string, Promise<{ world: string }>>();
  const signupOnce = (i: SignupInput): Promise<{ world: string }> => {
    const k = `${i.product}|${i.email.toLowerCase()}`;
    let p = inFlight.get(k);
    if (!p) {
      p = outsideRequest(() => o.signup(i)).finally(() => inFlight.delete(k));
      inFlight.set(k, p);
    }
    return p;
  };
  const jobKey = (product: Product, email: string) => `${product}|${email.toLowerCase()}`;
  const waitFor = <T,>(p: Promise<T>, ms: number): Promise<T | undefined> => {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([p, new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), ms)))]).finally(() => clearTimeout(timer));
  };
  const envMs = (v: string | undefined, d: number) => (v === undefined || v === "" || !Number.isFinite(Number(v)) ? d : Math.max(0, Number(v)));
  /** hand the browser a one-time link to wait on a running job (the fragment never reaches a server or a proxy log). */
  const toMaking = (c: Context, job: string, host: string, next: string, via: string) => {
    const token = random();
    makingTokens.set(sha256(token), { job, host, next, via, exp: now() + MAKING_MS });
    return c.redirect(`/login#making=${token}`, 302);
  };
  const signupsToday = () =>
    (db.prepare("SELECT COUNT(*) AS n FROM oauth_identities WHERE signup_world IS NOT NULL AND created_at >= ?").get(new Date(now() - 86400_000).toISOString()) as Row).n as number;

  // sign-up by email (a confirm link) and password reset, the same identity and daily cap as Google and GitHub.
  mountEmailAccess(api, {
    db,
    auth,
    signup: signupOnce,
    customers,
    signupsToday,
    startSession,
    linkSignup: (email, userId, world) => link("email", { subject: `email:${email}`, email, name: "" }, userId, world),
    ...(o.mail ? { send: o.mail.send, ready: o.mail.ready } : {}),
    env,
    now,
  });

  api.get("/access/oauth/:provider/callback", async (c) => {
    sweep();
    const p = providerParam(c);
    const host = hostOf(c);
    const state = c.req.query("state") ?? "";
    const cookie = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/api/access/oauth" });
    const st = states.get(sha256(state));
    states.delete(sha256(state));
    // The state must be the one this browser started, on this host, for this provider, in the last 10 minutes.
    if (st?.purpose && st.exp >= now() && cookie === state && st.host === host && p === "google") {
      const code = c.req.query("code") ?? "";
      if (c.req.query("error") || !code) return ytPage(c, { title: "Nothing changed", lines: ["You did not tap Allow, so nothing was stored. Open the link again when you are ready."], button: ytAgain });
      return ytCallback(c, host, st, code);
    }
    if (!p || !st || st.exp < now() || !cookie || cookie !== state || st.host !== host || st.provider !== p) return back(c, "state");
    if (c.req.query("error")) return back(c, "cancelled");
    const code = c.req.query("code") ?? "";
    if (!code) return back(c, "cancelled");
    const product = productOf(host, env);
    let who: ProviderUser;
    try {
      const via = p === "test" ? undefined : (await creds(p, product))?.callbackHost;
      who = await whoIs(p, code, callbackUrl(c, host, p, via), st.verifier, product);
    } catch (e) {
      if (e instanceof AuthError) return back(c, e.code);
      console.error(`oauth ${p}: ${(e as Error).message}`);
      return back(c, "provider_down");
    }
    try {
      // a world for this person is still being made (a second press, a refresh): wait on that one, never make another.
      const running = jobs.get(jobKey(product, who.email));
      if (running && !running.settled) return toMaking(c, jobKey(product, who.email), host, st.next, p);
      const logins = loginsFor(p, who, product);
      if (logins.length) {
        // Sign-in: the worlds of the login(s) this person is; one that fits this site's product first.
        const all = logins.flatMap((u) => auth.memberships(u).map((m) => ({ ...m, userId: u })));
        // the platform world is never signed into on a customer site (the owner's Google maps to his the home world login):
        // a person whose only world it is is refused there, never linked and never signed up as someone new.
        const worlds = all.filter((w) => !platformBlocked(host, w.tenantId, env, doorKey(w.userId, p)));
        if (all.length && !worlds.length) return back(c, PLATFORM_PRIVATE.code);
        if (worlds.length) {
          const fitting = worlds.filter((w) => fits(w.tenantId, product));
          const one = fitting.length === 1 ? fitting[0] : worlds.length === 1 ? worlds[0] : undefined;
          // a declared login is never stored as the link (its revert gives the stored one back); its use is still dated.
          const keep = declaredLogin(p, who, product) ? linkedTo(p, who) : logins[0];
          if (logins.length === 1 && keep) link(p, who, keep);
          if (one) {
            startSession(c, host, one.userId, one.tenantId, p);
            return c.redirect(st.next, 302);
          }
          const token = random();
          picks.set(sha256(token), { userIds: logins, host, next: st.next, exp: now() + PICK_MS, via: p });
          return c.redirect(`/login#pick=${token}`, 302);
        }
        if (logins.length > 1) return back(c, "no_world");
      }
      // Sign-up: a new world for this site's product.
      if (db.prepare("SELECT 1 FROM users WHERE email = ? AND disabled_at IS NOT NULL").get(who.email)) return back(c, "disabled");
      if (!customers.has(host) && p !== "test") return back(c, "no_account");
      if (env.CONSOLE_SIGNUP === "off") return back(c, "signup_closed");
      if (signupsToday() >= Math.max(0, Number(env.CONSOLE_SIGNUP_PER_DAY ?? 20) || 0)) return back(c, "signup_full");
      const key = jobKey(product, who.email);
      const job = {
        p: signupOnce({ email: who.email, name: who.name, product, provider: p, host, ...(st.visitSource ? { visitSource: st.visitSource } : {}) }).then((made) => {
          const userId = (db.prepare("SELECT id FROM users WHERE email = ?").get(who.email) as Row | undefined)?.id as string | undefined;
          if (!userId) throw new AuthError(400, "signup_failed", "your account could not be made: try again in a few minutes");
          link(p, who, userId, made.world);
          return { userId, world: made.world };
        }),
        settled: false,
        exp: now() + MAKING_MS,
      };
      job.p.then(
        () => (job.settled = true),
        (e) => {
          job.settled = true;
          console.error(`oauth ${p} sign-up of ${who.email} on ${host}: ${(e as Error).message}`);
        },
      );
      jobs.set(key, job);
      const done = await waitFor(job.p, envMs(env.CONSOLE_SIGNUP_WAIT_MS, 3_000));
      if (!done) return toMaking(c, key, host, st.next, p);
      startSession(c, host, done.userId, done.world, p);
      return c.redirect(st.next, 302);
    } catch (e) {
      console.error(`oauth ${p} sign-in: ${(e as Error).message}`);
      return back(c, e instanceof AuthError ? e.code : "signup_failed");
    }
  });

  const body = async (c: Context): Promise<Row> => {
    try {
      const b = await c.req.json();
      return b && typeof b === "object" ? b : {};
    } catch {
      return {};
    }
  };
  const pickOf = (token: unknown, host: string) => {
    const k = sha256(typeof token === "string" ? token : "");
    const v = picks.get(k);
    if (!v || v.exp < now() || v.host !== host) throw new AuthError(400, "invalid_pick", "this sign-in has expired: sign in again");
    return { k, v };
  };
  const worldsOf = (userIds: string[], host: string, via: string) =>
    userIds.flatMap((u) => auth.memberships(u).map((m) => ({ ...m, userId: u }))).filter((w) => !platformBlocked(host, w.tenantId, env, doorKey(w.userId, via)));
  api.post("/access/oauth/pick/peek", async (c) => {
    try {
      const { v } = pickOf((await body(c)).token, hostOf(c));
      return c.json({ choose: worldsOf(v.userIds, v.host, String(v.via ?? "")).map(({ tenantId, tenantName }) => ({ tenantId, tenantName })) });
    } catch (e) {
      if (e instanceof AuthError) return c.json({ error: { code: e.code, message: e.message } }, e.status);
      throw e;
    }
  });
  api.post("/access/oauth/pick", async (c) => {
    const host = hostOf(c);
    try {
      const b = await body(c);
      const { k, v } = pickOf(b.token, host);
      const w = worldsOf(v.userIds, host, String(v.via ?? "")).find((x) => x.tenantId === b.tenant);
      if (!w) throw new AuthError(403, "not_member", "pick one of your worlds");
      picks.delete(k);
      startSession(c, host, w.userId, w.tenantId, v.via);
      return c.json({ ok: true, next: v.next });
    } catch (e) {
      if (e instanceof AuthError) return c.json({ error: { code: e.code, message: e.message } }, e.status);
      throw e;
    }
  });

  // the waiting page asks until the new world is ready (each ask answers within CONSOLE_MAKING_WAIT_MS, default
  // 20 s, well inside a proxy's limit): 202 `pending` while it is made, then the session and where to go.
  api.post("/access/oauth/making", async (c) => {
    const host = hostOf(c);
    const k = sha256(String((await body(c)).token ?? ""));
    const m = makingTokens.get(k);
    if (!m || m.exp < now() || m.host !== host) return c.json({ error: { code: "invalid_making", message: "this sign-up link has expired: sign in again, your account is kept" } }, 400);
    const job = jobs.get(m.job);
    if (!job) {
      makingTokens.delete(k);
      return c.json({ error: { code: "invalid_making", message: "this sign-up link has expired: sign in again, your account is kept" } }, 400);
    }
    try {
      const done = await waitFor(job.p, envMs(env.CONSOLE_MAKING_WAIT_MS, 20_000));
      if (!done) return c.json({ pending: true, message: "Your world is being made: this takes about two minutes the first time." }, 202);
      makingTokens.delete(k);
      startSession(c, host, done.userId, done.world, m.via);
      return c.json({ ok: true, next: m.next });
    } catch (e) {
      makingTokens.delete(k);
      if (e instanceof AuthError) return c.json({ error: { code: e.code, message: e.message } }, e.status);
      return c.json({ error: { code: "signup_failed", message: "your account could not be made: try again in a few minutes" } }, 400);
    }
  });

  // The TEST provider's sign-in page: an email and a name, then back to the callback with a one-time code.
  if (testOn) {
    const page = (state: string, redirect: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TEST provider</title>
<style>body{font:16px system-ui;display:grid;place-items:center;min-height:100vh;margin:0}form{width:min(340px,92vw);border:2px dashed #b45309;border-radius:12px;padding:20px}input,button{width:100%;box-sizing:border-box;padding:10px;margin:6px 0;font:inherit}</style></head>
<body><form method="post"><h1>TEST provider</h1><p>Not Google, not GitHub: a stand-in for tests (CONSOLE_OAUTH_TEST=1).</p>
<input type="hidden" name="state" value="${state.replace(/[^\w-]/g, "")}"><input type="hidden" name="redirect_uri" value="${redirect.replace(/["<>]/g, "")}">
<label>Email<input name="email" type="email" required></label><label>Name<input name="name"></label><button>Continue</button></form></body></html>`;
    api.get("/access/oauth/test/authorize", (c) => c.html(page(c.req.query("state") ?? "", c.req.query("redirect_uri") ?? "")));
    api.post("/access/oauth/test/authorize", async (c) => {
      const f = await c.req.parseBody();
      const email = String(f.email ?? "").trim().toLowerCase();
      const redirect = String(f.redirect_uri ?? "");
      if (!EMAIL.test(email)) return c.text("an email, please", 400);
      let u: URL;
      try {
        u = new URL(redirect);
      } catch {
        return c.text("bad redirect", 400);
      }
      if (u.host !== (c.req.header("host") ?? "") || u.pathname !== "/api/access/oauth/test/callback") return c.text("bad redirect", 400);
      const code = random();
      testCodes.set(sha256(code), { email, name: String(f.name ?? "").slice(0, 120), exp: now() + 120_000 });
      u.search = new URLSearchParams({ code, state: String(f.state ?? "") }).toString();
      return c.redirect(`${u.pathname}${u.search}`, 302);
    });
  }
}
