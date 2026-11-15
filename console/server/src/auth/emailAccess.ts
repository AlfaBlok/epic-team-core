import crypto from "node:crypto";
import type { Context, Hono } from "hono";
import type { DB } from "../db.js";
import { sudoRead } from "../secretCache.js";
import { clientAddress } from "../clientAddress.js";
import { keyFile, sites, socialProduct } from "../identity.js";
import { AuthError, hashPassword, outsideRequest, PASSWORD_MIN, type Auth } from "./identity.js";
import { platformBlocked, productOf, requestHost, type Product } from "./gate.js";
import type { SignupInput } from "./oauth.js";

/**
 * sign-up by email (a confirm link) and password reset on the customer sites (the team site,
 * the social site), on the same customer identity as Google and GitHub sign-in (auth/oauth.ts mounts this).
 *
 *   POST /api/access/email/signup        {email, password, name?, next?, s?}  a confirm link to that address (60 min)
 *   POST /api/access/email/confirm       {token}            the link's one use: the world is made, the person signed in
 *   POST /api/access/email/reset         {email}            a reset link to that address (30 min), when it has a login here
 *   POST /api/access/email/reset/finish  {token, password}  the link's one use: the new password, old sessions end
 *
 * The answer to signup and reset is the same whether or not the address has an account (no account list for strangers).
 * Links carry the token in the fragment (`/login#confirm=…`, `#reset=…`): never sent to a server, so no proxy log and no
 * mail scanner's prefetch spends it; only its sha256 is stored, it is bound to the site that sent it, single use
 * (a conditional update), and a newer reset link ends the older ones.
 * Mail goes only to the address in the request, one recipient, from noreply@<the site's domain>; nothing else is sent.
 * Limits: 8 mail requests (24 link uses) per visitor and site per 15 min, 3 mails per address per hour, CONSOLE_MAIL_PER_DAY (default 200) mails a
 * day in all; sign-ups share Google's and GitHub's CONSOLE_SIGNUP_PER_DAY and CONSOLE_SIGNUP=off.
 * Every send is one row in access_mail_log (when, kind, site, to, outcome, the provider's message id; never the link)
 * and one journal line.
 *
 * The sender: Cloudflare Email Sending (docs/email-sending.md), the account sites().mailAccount (env
 * CONSOLE_MAIL_ACCOUNT wins), key CLOUDFLARE_EMAIL_SEND_TOKEN from env or the console's store. No account or no key:
 * the email forms stay hidden and the routes answer 503 mail_off.
 */

export interface Mail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}
export type MailResult = { ok: true; id?: string } | { ok: false; message: string };
export type MailSender = (m: Mail) => Promise<MailResult>;

export const MAIL_KEY = "CLOUDFLARE_EMAIL_SEND_TOKEN";
const SIGNUP_MS = 60 * 60_000;
const RESET_MS = 30 * 60_000;
const VISITOR_WINDOW_MS = 15 * 60_000;
const VISITOR_MAX = 8;
const ADDRESS_HOUR_MAX = 3;
const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const random = () => crypto.randomBytes(32).toString("base64url");
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** the mail account in force: CONSOLE_MAIL_ACCOUNT, else sites().mailAccount */
export const mailAccount = (env: NodeJS.ProcessEnv = process.env) => (env.CONSOLE_MAIL_ACCOUNT ?? sites().mailAccount).trim();

/** Cloudflare Email Sending, one REST call; the key from env, else the store (re-read while missing, cached 5 min). */
export function cloudflareSender(o: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; read?: (file: string) => Promise<string | undefined>; now?: () => number } = {}) {
  const env = o.env ?? process.env;
  const http = o.fetch ?? fetch;
  const read = o.read ?? sudoRead;
  const now = o.now ?? Date.now;
  let cached: { v?: string; at: number } | undefined;
  const key = async () => {
    if (env[MAIL_KEY]?.trim()) return env[MAIL_KEY]!.trim();
    if (cached && now() - cached.at < (cached.v ? 5 : 1) * 60_000) return cached.v;
    const v = (await read(keyFile(MAIL_KEY)).catch(() => undefined))?.trim() || undefined;
    cached = { v, at: now() };
    return v;
  };
  const ready = async () => !!mailAccount(env) && !!(await key());
  const send: MailSender = async (m) => {
    const account = mailAccount(env);
    const k = await key();
    if (!account || !k) return { ok: false, message: "mail is not set up (no account or key)" };
    try {
      const r = await http(`https://api.cloudflare.com/client/v4/accounts/${account}/email/sending/send`, {
        method: "POST",
        headers: { authorization: `Bearer ${k}`, "content-type": "application/json" },
        body: JSON.stringify(m),
        signal: AbortSignal.timeout(20_000),
      });
      const j = (await r.json().catch(() => ({}))) as { success?: boolean; result?: { message_id?: string; permanent_bounces?: unknown[] }; errors?: { code?: number; message?: string }[] };
      if (!r.ok || j.success === false) return { ok: false, message: `HTTP ${r.status} ${(j.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ")}`.trim() };
      if (j.result?.permanent_bounces?.length) return { ok: false, message: "bounced" };
      return { ok: true, ...(j.result?.message_id ? { id: j.result.message_id } : {}) };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  };
  return { send, ready };
}

export interface EmailAccessOptions {
  db: DB;
  auth: Auth;
  signup: (i: SignupInput) => Promise<{ world: string }>;
  /** the customer sites (gate.ts customerHosts) */
  customers: Map<string, Product>;
  /** sign-ups of the last 24 h, all ways in together (oauth.ts) */
  signupsToday: () => number;
  /** a session cookie for this login in this world on this site (oauth.ts; refuses the platform world) */
  startSession: (c: Context, host: string, userId: string, tenant: string, via?: string) => void;
  /** record the sign-up beside Google's and GitHub's (oauth_identities, provider `email`) */
  linkSignup: (email: string, userId: string, world: string) => void;
  send?: MailSender;
  ready?: () => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

type Row = Record<string, any>;

/** The site's mail domain and product name: cloud.example.com -> example.com. */
export function mailFrom(host: string, product: Product): { from: string; name: string; domain: string } {
  const parts = host.split(".");
  const domain = parts.length > 2 ? parts.slice(1).join(".") : host;
  const name = product === "social" ? socialProduct() : "EpicTeam";
  return { from: `${name} <noreply@${domain}>`, name, domain };
}

/** The mail itself: one link, plain words, the same in text and html. */
export function mailBody(kind: "signup" | "exists" | "reset", o: { name: string; link: string; minutes: number; loginUrl: string }) {
  const lines =
    kind === "signup"
      ? { subject: `Confirm your ${o.name} account`, intro: `Press the link to confirm this email and open your new ${o.name} account.`, button: "Confirm my account", after: `The link works once, for ${o.minutes} minutes. If you did not sign up, ignore this mail: no account is made.` }
      : kind === "exists"
        ? { subject: `You already have a ${o.name} account`, intro: `Someone, maybe you, tried to sign up with this email, which already has a ${o.name} account. Log in at ${o.loginUrl}, or set a new password with the link.`, button: "Set a new password", after: `The link works once, for ${o.minutes} minutes. If it was not you, ignore this mail: nothing changes.` }
        : { subject: `Reset your ${o.name} password`, intro: `Press the link to set a new password for your ${o.name} account.`, button: "Set a new password", after: `The link works once, for ${o.minutes} minutes. If you did not ask, ignore this mail: your password stays as it is.` };
  const text = `${lines.intro}\n\n${o.link}\n\n${lines.after}\n`;
  const html = `<!doctype html><html><body style="font:16px/1.5 system-ui,-apple-system,sans-serif;color:#111;max-width:520px;margin:0 auto;padding:24px">
<p style="font-weight:600;font-size:18px;margin:0 0 16px">${esc(o.name)}</p>
<p>${esc(lines.intro)}</p>
<p style="margin:24px 0"><a href="${esc(o.link)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px">${esc(lines.button)}</a></p>
<p style="color:#555;font-size:14px">${esc(lines.after)}</p>
<p style="color:#555;font-size:13px;overflow-wrap:anywhere">Or open: ${esc(o.link)}</p></body></html>`;
  return { subject: lines.subject, text, html };
}

export function mountEmailAccess(api: Hono, o: EmailAccessOptions) {
  const db = o.db;
  const env = o.env ?? process.env;
  const now = o.now ?? Date.now;
  const cf = o.send ? undefined : cloudflareSender({ env });
  const send = o.send ?? cf!.send;
  const ready = o.ready ?? (o.send ? async () => true : cf!.ready);
  db.exec(`
    CREATE TABLE IF NOT EXISTS email_tokens (
      hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      email TEXT NOT NULL,
      host TEXT NOT NULL,
      name TEXT,
      pw_hash TEXT,
      next TEXT,
      visit_source TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS access_mail_log (
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      host TEXT NOT NULL,
      to_addr TEXT NOT NULL,
      outcome TEXT NOT NULL,
      message_id TEXT,
      detail TEXT
    );
  `);
  const iso = (t = now()) => new Date(t).toISOString();
  const hostOf = (c: Context) => requestHost((n) => c.req.header(n)) ?? "";
  const peerOf = (c: Context): string | undefined => (c.env as any)?.incoming?.socket?.remoteAddress;
  const visitor = (c: Context) => clientAddress(peerOf(c), (n) => c.req.header(n));
  const err = (c: Context, status: 400 | 403 | 429 | 503, code: string, message: string) => c.json({ error: { code, message } }, status);
  const body = async (c: Context): Promise<Row> => {
    try {
      const b = await c.req.json();
      return b && typeof b === "object" ? b : {};
    } catch {
      return {};
    }
  };
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const safeNext = (v: string) => (v.startsWith("/") && !v.startsWith("//") && !/[\\\s\x00-\x1f\x7f]/.test(v) ? v.slice(0, 500) : "/");

  // per visitor and site: 8 requests in 15 minutes (in memory; a restart forgets, the per-address and daily caps are in the db)
  const hits = new Map<string, { n: number; first: number }>();
  const visitorOver = (key: string, max: number) => {
    const t = now();
    let h = hits.get(key);
    if (!h || t - h.first >= VISITOR_WINDOW_MS) {
      if (hits.size > 20_000) for (const [k, v] of hits) if (t - v.first >= VISITOR_WINDOW_MS) hits.delete(k);
      h = { n: 0, first: t };
      hits.set(key, h);
    }
    return ++h.n > max;
  };
  const sentSince = (since: number, to?: string) =>
    (to
      ? (db.prepare("SELECT COUNT(*) AS n FROM access_mail_log WHERE outcome = 'sent' AND at >= ? AND to_addr = ?").get(iso(since), to) as Row)
      : (db.prepare("SELECT COUNT(*) AS n FROM access_mail_log WHERE outcome = 'sent' AND at >= ?").get(iso(since)) as Row)
    ).n as number;
  const perDay = () => Math.max(0, Number(env.CONSOLE_MAIL_PER_DAY ?? 200) || 0);
  const logMail = (kind: string, host: string, to: string, outcome: string, id?: string, detail?: string) => {
    db.prepare("INSERT INTO access_mail_log (at, kind, host, to_addr, outcome, message_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)").run(iso(), kind, host, to, outcome, id ?? null, detail ?? null);
    console.log(`access mail ${kind} on ${host} to ${to}: ${outcome}${id ? ` ${id}` : ""}${detail ? ` (${detail})` : ""}`);
  };
  /** one mail to the address that asked, inside the caps; the caller answers the same either way. */
  const mail = async (kind: "signup" | "exists" | "reset", host: string, to: string, link: string, minutes: number) => {
    if (sentSince(now() - 3600_000, to) >= ADDRESS_HOUR_MAX) return logMail(kind, host, to, "capped", undefined, "address hour");
    if (sentSince(now() - 86400_000) >= perDay()) return logMail(kind, host, to, "capped", undefined, "day");
    const product = o.customers.get(host) ?? productOf(host, env);
    const f = mailFrom(host, product);
    const b = mailBody(kind, { name: f.name, link, minutes, loginUrl: `https://${host}/login` });
    const r = await send({ from: f.from, to, subject: b.subject, text: b.text, html: b.html });
    if (r.ok) logMail(kind, host, to, "sent", r.id);
    else logMail(kind, host, to, "failed", undefined, r.message.slice(0, 200));
  };
  const origin = (c: Context, host: string) => {
    const https = (c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "")).split(",")[0].trim() === "https";
    const port = c.req.header("x-forwarded-host") ? "" : (/:(\d+)$/.exec(c.req.header("host") ?? "")?.[0] ?? "");
    return `${https ? "https" : "http"}://${host}${port}`;
  };
  const userByEmail = (email: string) => db.prepare("SELECT id, email, disabled_at FROM users WHERE lower(email) = ?").get(email) as Row | undefined;
  /** a login that may use this site: enabled, with a world that is not the platform's here */
  const usableHere = (u: Row | undefined, host: string) =>
    !!u && !u.disabled_at && o.auth.memberships(u.id).some((m) => !platformBlocked(host, m.tenantId, env));
  const newToken = (kind: "signup" | "reset", email: string, host: string, ms: number, extra: { name?: string; pwHash?: string; next?: string; visitSource?: string } = {}) => {
    const token = random();
    db.prepare("DELETE FROM email_tokens WHERE expires_at < ?").run(iso(now() - 86400_000));
    // a newer link of the same kind ends the older unused ones of that address on this site
    db.prepare("UPDATE email_tokens SET used_at = ? WHERE kind = ? AND email = ? AND host = ? AND used_at IS NULL").run(iso(), kind, email, host);
    db.prepare("INSERT INTO email_tokens (hash, kind, email, host, name, pw_hash, next, visit_source, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      sha256(token), kind, email, host, extra.name ?? null, extra.pwHash ?? null, extra.next ?? null, extra.visitSource ?? null, iso(), iso(now() + ms),
    );
    return token;
  };
  /** spend a link once: unused, unexpired, this kind, this site; else 400 */
  const spend = (kind: "signup" | "reset", token: string, host: string): Row => {
    const h = sha256(token);
    const r = db.prepare("UPDATE email_tokens SET used_at = ? WHERE hash = ? AND kind = ? AND host = ? AND used_at IS NULL AND expires_at >= ?").run(iso(), h, kind, host, iso());
    if (r.changes !== 1)
      throw new AuthError(400, kind === "signup" ? "invalid_confirm" : "invalid_reset", kind === "signup" ? "this confirm link is used or expired: sign up again" : "this reset link is used or expired: ask for a new one");
    return db.prepare("SELECT * FROM email_tokens WHERE hash = ?").get(h) as Row;
  };
  /** the four routes run on the customer sites only, with mail set up */
  const gate = async (c: Context, sends = true): Promise<Response | undefined> => {
    const host = hostOf(c);
    if (!o.customers.has(host)) return err(c, 403, "not_here", "email sign-up runs on the customer sites");
    if (!(await ready())) return err(c, 503, "mail_off", "email sign-in is not switched on here yet");
    if (visitorOver(`${sends ? "mail" : "use"}|${host}|${visitor(c)}`, sends ? VISITOR_MAX : VISITOR_MAX * 3)) {
      c.header("Retry-After", "900");
      return err(c, 429, "too_many_requests", "too many tries: wait 15 minutes");
    }
    return undefined;
  };
  const fail = (c: Context, e: unknown) => {
    if (e instanceof AuthError) return c.json({ error: { code: e.code, message: e.message } }, e.status as 400);
    throw e;
  };
  const SENT = { ok: true, message: "If that address can use this, a mail is on its way. Check your inbox." };

  /** whether this site shows the email forms (the login page asks) */
  api.get("/access/email/status", async (c) => {
    const host = hostOf(c);
    return c.json({ email: o.customers.has(host) && (await ready()), signup: o.customers.has(host) && env.CONSOLE_SIGNUP !== "off" });
  });

  api.post("/access/email/signup", async (c) => {
    const no = await gate(c);
    if (no) return no;
    const host = hostOf(c);
    const b = await body(c);
    const email = str(b.email).trim().toLowerCase();
    const password = str(b.password);
    if (!EMAIL.test(email) || email.length > 254) return err(c, 400, "validation_error", "a valid email, please");
    if (password.length < PASSWORD_MIN) return err(c, 400, "weak_password", `use at least ${PASSWORD_MIN} characters`);
    if (env.CONSOLE_SIGNUP === "off") return err(c, 403, "signup_closed", "new accounts are closed right now");
    const u = userByEmail(email);
    if (u) {
      // the address has a login: a reset link instead (same answer, so the form tells nobody who has an account)
      if (usableHere(u, host)) {
        const token = newToken("reset", email, host, RESET_MS);
        await mail("exists", host, email, `${origin(c, host)}/login#reset=${token}`, RESET_MS / 60_000);
      } else logMail("exists", host, email, "skipped", undefined, u.disabled_at ? "disabled" : "no world here");
      return c.json(SENT);
    }
    const name = str(b.name).trim().slice(0, 120);
    const s = str(b.s);
    const token = newToken("signup", email, host, SIGNUP_MS, { name, pwHash: hashPassword(password), next: safeNext(str(b.next)), ...(s === "TEST" ? { visitSource: "TEST" } : {}) });
    await mail("signup", host, email, `${origin(c, host)}/login#confirm=${token}`, SIGNUP_MS / 60_000);
    return c.json(SENT);
  });

  api.post("/access/email/confirm", async (c) => {
    const no = await gate(c, false);
    if (no) return no;
    const host = hostOf(c);
    try {
      if (env.CONSOLE_SIGNUP === "off") throw new AuthError(403, "signup_closed", "new accounts are closed right now");
      if (o.signupsToday() >= Math.max(0, Number(env.CONSOLE_SIGNUP_PER_DAY ?? 20) || 0)) throw new AuthError(429, "signup_full", "today's new accounts are full: try again tomorrow");
      const t = spend("signup", str((await body(c)).token), host);
      if (userByEmail(t.email)) throw new AuthError(400, "account_exists", "this email already has an account: log in, or reset the password");
      const product = o.customers.get(host)!;
      const made = await outsideRequest(() => o.signup({ email: t.email, name: t.name ?? "", product, provider: "email", host, ...(t.visit_source ? { visitSource: t.visit_source } : {}) }));
      const u = userByEmail(t.email);
      if (!u) throw new AuthError(400, "signup_failed", "your account could not be made: try again in a few minutes");
      db.prepare("UPDATE users SET pw_hash = ? WHERE id = ?").run(t.pw_hash, u.id);
      o.linkSignup(t.email, u.id, made.world);
      o.startSession(c, host, u.id, made.world, "email");
      return c.json({ ok: true, next: t.next || "/" });
    } catch (e) {
      return fail(c, e);
    }
  });

  api.post("/access/email/reset", async (c) => {
    const no = await gate(c);
    if (no) return no;
    const host = hostOf(c);
    const email = str((await body(c)).email).trim().toLowerCase();
    if (!EMAIL.test(email) || email.length > 254) return err(c, 400, "validation_error", "a valid email, please");
    const u = userByEmail(email);
    if (usableHere(u, host)) {
      const token = newToken("reset", email, host, RESET_MS);
      await mail("reset", host, email, `${origin(c, host)}/login#reset=${token}`, RESET_MS / 60_000);
    } else logMail("reset", host, email, "skipped", undefined, !u ? "no login" : u.disabled_at ? "disabled" : "no world here");
    return c.json(SENT);
  });

  api.post("/access/email/reset/finish", async (c) => {
    const no = await gate(c, false);
    if (no) return no;
    const host = hostOf(c);
    const b = await body(c);
    const password = str(b.password);
    if (password.length < PASSWORD_MIN) return err(c, 400, "weak_password", `use at least ${PASSWORD_MIN} characters`);
    try {
      const t = spend("reset", str(b.token), host);
      const u = userByEmail(t.email);
      if (!usableHere(u, host)) throw new AuthError(400, "invalid_reset", "this reset link is used or expired: ask for a new one");
      db.transaction(() => {
        db.prepare("UPDATE users SET pw_hash = ? WHERE id = ?").run(hashPassword(password), u!.id);
        db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u!.id); // a new password ends old sessions
      })();
      return c.json({ ok: true, email: u!.email });
    } catch (e) {
      return fail(c, e);
    }
  });
}
