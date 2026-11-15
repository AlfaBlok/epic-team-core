import type { Context, Hono } from "hono";
import { z } from "zod";
import { DEFAULT_TENANT, type DB } from "../db.js";
import { currentAuth } from "../auth/identity.js";
import { sudoRead } from "../secretCache.js";
import { inQuiet, localParts, markText, teamLink, type Notifiable } from "./notice.js";
import { vapidFrom, webPushTransport, type PushMessage, type PushSub, type PushTransport, type Vapid } from "./webpushCrypto.js";
import { keyFile, ownerName } from "../identity.js";

export * from "./webpushCrypto.js";

/**
 * phone notifications from the installed app ('s home-screen web app; iOS 16.4+ only from
 * the installed app). Web Push with VAPID, no outside service and no new package: the payload is encrypted here
 * (RFC 8291 aes128gcm) and posted to the browser's push service (Apple, Google, Mozilla) with a signed VAPID JWT (RFC 8292).
 *
 * What goes out (one per item, no floods):
 * - the Team desk answered the owner: once per new reply still unread after `deskGraceMs` (he is not looking), several
 *   replies in one pass are one notification; the first pass only sets the cursor (turning it on never floods);
 * - a new ask or review card waits on him:'s notices (the same items and the same once-ever ledger, `wa_notices`),
 *   so an item that went out as a push is never sent again on WhatsApp, and one WhatsApp already sent is never pushed;
 *   more than `maxEach` in one pass are one summary notification; held in quiet hours as WhatsApp's; snoozed asks and
 *   snoozed review cards are not in the sources, so a snooze holds the push too.
 * Subscriptions are stored per login (`push_subs`); only the owner's world's are notified. A push service answering 404 or
 * 410 drops the subscription.
 */

export const vapidStoreFile = (): string => keyFile("WEBPUSH_VAPID_PRIVATE_KEY");
/** The console's key: env (dev, tests) or the secret store copy (production; staging reads none). */
export async function vapidFromEnv(readStore: (f: string) => Promise<string | undefined> = sudoRead): Promise<Vapid | undefined> {
  const raw = process.env.WEBPUSH_VAPID_PRIVATE_KEY || (await readStore(vapidStoreFile()));
  return raw ? vapidFrom(raw) : undefined;
}

export function ensurePushTables(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      device TEXT,
      created_at TEXT NOT NULL,
      last_ok_at TEXT,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS push_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      keys TEXT NOT NULL,
      subs INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS push_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
}

/** Who is subscribing: a login's user id; legacy trust (tailnet, host) is the owner's device. */
export function subscriberOf(): { tenant: string; userId: string } | undefined {
  const i = currentAuth()?.identity;
  if (!i) return { tenant: DEFAULT_TENANT, userId: "owner" }; // auth off (dev)
  if (i.kind === "session") return { tenant: i.tenant, userId: i.userId };
  if (i.kind === "legacy") return { tenant: i.tenant, userId: "owner" };
  return undefined; // agent tokens never subscribe
}

const oneLine = (s: string, max = 140) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** One notification per item; over `maxEach` new items in one pass become one summary. */
export function itemMessages(items: Notifiable[], maxEach = 3): { keys: string[]; msg: PushMessage }[] {
  if (items.length > maxEach) {
    const asks = items.filter((i) => i.kind === "ask").length;
    const reviews = items.length - asks;
    const parts = [asks ? `${asks} new thing${asks === 1 ? "" : "s"} wait${asks === 1 ? "s" : ""} on you` : "", reviews ? `${reviews} done, waiting for your review` : ""].filter(Boolean);
    // the summary says REAL, or TEST when every item is ours, or how many are tests.
    const tests = items.filter((i) => i.test).length;
    const title = tests === items.length ? "TEST · Team" : "Team";
    return [{ keys: items.map((i) => i.key), msg: { title, body: `${parts.join(" and ")}.${tests && tests < items.length ? ` ${tests} of them our own test${tests === 1 ? "" : "s"}.` : ""}`, url: "/", tag: "team-items" } }];
  }
  return items.map((it) => ({
    keys: [it.key],
    msg: {
      title: markText(it.kind === "review" ? "Done, waiting for your review" : it.kind === "application" ? "New tester application" : "Waiting on you", it.test),
      body: oneLine(it.title),
      url: it.teamUrl.startsWith(teamLink()) ? it.teamUrl.slice(teamLink().length) || "/" : "/",
      tag: it.key.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 60),
    },
  }));
}

export interface DeskPeek {
  /** When each finished reply arrived, oldest first. */
  replies: string[];
  /** The newest reply's text, for the notification body. */
  lastText?: string;
  lastOwnAt?: string;
  seenAt?: string;
}

export interface WebPushOptions {
  /** Undefined = no VAPID key: nothing is sent, subscribing answers 503. */
  vapid: () => Promise<Vapid | undefined>;
  transport?: (v: Vapid) => PushTransport;
  /** The Team desk's replies and the owner's marks (read fresh); undefined when the console has no T3. */
  desk?: () => Promise<DeskPeek | undefined>;
  now?: () => Date;
  timeZone?: string;
  quietHours?: [number, number];
  /** A reply this old and still unread is pushed (he is not looking at the Chat). */
  deskGraceMs?: number;
  maxEach?: number;
}

export function createWebPush(db: DB, o: WebPushOptions) {
  ensurePushTables(db);
  const now = o.now ?? (() => new Date());
  const timeZone = o.timeZone ?? "America/Mexico_City";
  const quiet = o.quietHours ?? [22, 8];
  const grace = o.deskGraceMs ?? 45_000;
  let cached: { at: number; v?: Vapid } | undefined;
  const vapid = async () => {
    if (!cached || Date.now() - cached.at > 5 * 60_000) cached = { at: Date.now(), v: await o.vapid() };
    return cached.v;
  };
  const meta = (k: string) => (db.prepare("SELECT value FROM push_meta WHERE key = ?").get(k) as { value: string } | undefined)?.value;
  const setMeta = (k: string, v: string) => db.prepare("INSERT INTO push_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v);
  const subsOf = (where: string, ...args: string[]) => db.prepare(`SELECT id, endpoint, p256dh, auth FROM push_subs WHERE ${where} ORDER BY id`).all(...args) as unknown as PushSub[];
  const ownerSubs = () => subsOf("tenant_id = ?", DEFAULT_TENANT);

  /** Sends one message to `subs`; drops gone ones. True when at least one device took it. */
  async function deliver(kind: string, keys: string[], msg: PushMessage, subs: PushSub[]): Promise<{ ok: boolean; error?: string; sent: number }> {
    const v = await vapid();
    if (!v || !subs.length) return { ok: false, error: v ? "no device subscribed" : "not_configured", sent: 0 };
    const send = (o.transport ?? webPushTransport)(v);
    let sent = 0;
    let error: string | undefined;
    for (const s of subs) {
      const r = await send(s, msg);
      const at = now().toISOString();
      if (r.ok) {
        sent++;
        db.prepare("UPDATE push_subs SET last_ok_at = ?, last_error = NULL WHERE id = ?").run(at, s.id);
      } else if (r.gone) db.prepare("DELETE FROM push_subs WHERE id = ?").run(s.id);
      else {
        error = r.error;
        db.prepare("UPDATE push_subs SET last_error = ? WHERE id = ?").run(r.error.slice(0, 200), s.id);
      }
    }
    db.prepare("INSERT INTO push_sends (at, kind, keys, subs, ok, error) VALUES (?, ?, ?, ?, ?, ?)").run(
      now().toISOString(),
      kind,
      keys.join(" ").slice(0, 2000),
      subs.length,
      sent ? 1 : 0,
      sent ? null : (error ?? "every subscription was gone").slice(0, 300),
    );
    return { ok: sent > 0, sent, ...(sent ? {} : { error: error ?? "every subscription was gone" }) };
  }

  /**
   *'s hook: push the notices not sent yet, return the keys that reached a device (WhatsApp then skips them).
   * Nothing is pushed in quiet hours or with no device: WhatsApp keeps them as before.
   */
  async function items(pending: Notifiable[]): Promise<string[]> {
    const mine = pending.filter((i) => i.kind === "ask" || i.kind === "review");
    if (!mine.length || inQuiet(localParts(now(), timeZone).hour, quiet)) return [];
    const subs = ownerSubs();
    if (!subs.length || !(await vapid())) return [];
    const done: string[] = [];
    for (const m of itemMessages(mine, o.maxEach ?? 3)) if ((await deliver("item", m.keys, m.msg, subs)).ok) done.push(...m.keys);
    return done;
  }

  /** One pass over the Team desk: a reply still unread after the grace time is one notification. Never throws. */
  async function deskTick(): Promise<{ sent: number; note?: string }> {
    try {
      if (!o.desk) return { sent: 0, note: "no desk" };
      const peek = await o.desk();
      if (!peek) return { sent: 0, note: "no live desk" };
      const t = now().getTime();
      const cursor = meta("desk_cursor");
      const newest = peek.replies.at(-1);
      if (!cursor) {
        setMeta("desk_cursor", newest ?? new Date(t).toISOString());
        return { sent: 0, note: "cursor set" };
      }
      const after = Math.max(...[cursor, peek.seenAt, peek.lastOwnAt].map((x) => (x ? Date.parse(x) : -Infinity)));
      const fresh = peek.replies.filter((at) => Date.parse(at) > after);
      if (!fresh.length) return { sent: 0 };
      if (t - Date.parse(fresh.at(-1)!) < grace) return { sent: 0, note: `waiting: ${ownerName()} may be reading` };
      const subs = ownerSubs();
      if (!subs.length || !(await vapid())) {
        setMeta("desk_cursor", fresh.at(-1)!); // no device: nothing to catch up on later
        return { sent: 0, note: "no device" };
      }
      const msg: PushMessage = {
        title: markText(fresh.length === 1 ? "The Team desk answered you" : `The Team desk answered you (${fresh.length} new)`),
        body: peek.lastText ? oneLine(peek.lastText) : "Open Chat to read it.",
        url: "/chat",
        tag: "desk",
      };
      const r = await deliver("desk", fresh.map((at) => `desk:${at}`), msg, subs);
      if (r.ok) setMeta("desk_cursor", fresh.at(-1)!);
      return { sent: r.sent };
    } catch (e) {
      return { sent: 0, note: (e as Error).message };
    }
  }

  return {
    vapid,
    items,
    deskTick,
    deliver,
    subsOf,
    subscribe(who: { tenant: string; userId: string }, s: { endpoint: string; keys: { p256dh: string; auth: string } }, device?: string) {
      db.prepare(
        `INSERT INTO push_subs (tenant_id, user_id, endpoint, p256dh, auth, device, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET tenant_id = excluded.tenant_id, user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device, last_error = NULL`,
      ).run(who.tenant, who.userId, s.endpoint, s.keys.p256dh, s.keys.auth, device ?? null, now().toISOString());
    },
    unsubscribe(who: { tenant: string; userId: string }, endpoint: string): boolean {
      return db.prepare("DELETE FROM push_subs WHERE endpoint = ? AND tenant_id = ? AND user_id = ?").run(endpoint, who.tenant, who.userId).changes > 0;
    },
    lastSends(n = 5) {
      return db.prepare("SELECT at, kind, subs, ok, error FROM push_sends ORDER BY id DESC LIMIT ?").all(n) as { at: string; kind: string; subs: number; ok: number; error: string | null }[];
    },
  };
}
export type WebPush = ReturnType<typeof createWebPush>;

const subIn = z
  .object({
    subscription: z.object({
      endpoint: z.string().url().max(1000).refine((u) => u.startsWith("https://"), "endpoint must be https"),
      keys: z.object({ p256dh: z.string().min(80).max(120), auth: z.string().min(16).max(40) }),
    }),
    device: z.string().trim().max(120).optional(),
  })
  .strict();
const endpointIn = z.object({ endpoint: z.string().url().max(1000) }).strict();

/** `/api/push`: the key and this login's devices; subscribe, unsubscribe, and a test to the caller's own devices only. */
export function mountWebPush(api: Hono, p: WebPush, o: { now?: () => number; testGapMs?: number } = {}): void {
  const clock = o.now ?? Date.now;
  const gap = o.testGapMs ?? 60_000;
  const lastTest = new Map<string, number>();
  const who = (c: Context) => subscriberOf() ?? c.json({ error: { code: "login_only", message: "a person's login subscribes, not an agent token" } }, 403);

  api.get("/push", async (c) => {
    const w = who(c);
    if (w instanceof Response) return w;
    const v = await p.vapid();
    const mine = p.subsOf("tenant_id = ? AND user_id = ?", w.tenant, w.userId);
    return c.json({ configured: !!v, ...(v ? { publicKey: v.publicKey } : {}), devices: mine.length, endpoints: mine.map((s) => s.endpoint), notifies: w.tenant === DEFAULT_TENANT });
  });
  api.post("/push/subscribe", async (c) => {
    const w = who(c);
    if (w instanceof Response) return w;
    if (!(await p.vapid())) return c.json({ error: { code: "not_configured", message: "the console has no notification key yet" } }, 503);
    const b = subIn.safeParse(await c.req.json().catch(() => undefined));
    if (!b.success) return c.json({ error: { code: "validation_error", message: "body is {subscription: {endpoint, keys: {p256dh, auth}}, device?}" } }, 400);
    p.subscribe(w, b.data.subscription, b.data.device);
    return c.json({ ok: true });
  });
  api.post("/push/unsubscribe", async (c) => {
    const w = who(c);
    if (w instanceof Response) return w;
    const b = endpointIn.safeParse(await c.req.json().catch(() => undefined));
    if (!b.success) return c.json({ error: { code: "validation_error", message: "body is {endpoint}" } }, 400);
    return c.json({ ok: true, removed: p.unsubscribe(w, b.data.endpoint) });
  });
  // Only the caller's own devices (or one of them), never anyone else's: "this is how it will look".
  api.post("/push/test", async (c) => {
    const w = who(c);
    if (w instanceof Response) return w;
    const k = `${w.tenant}/${w.userId}`;
    if (clock() - (lastTest.get(k) ?? 0) < gap) return c.json({ ok: false, error: "a test was sent in the last minute" }, 429);
    const b = (await c.req.json().catch(() => ({}))) as { endpoint?: unknown };
    const subs = p.subsOf("tenant_id = ? AND user_id = ?", w.tenant, w.userId).filter((s) => typeof b.endpoint !== "string" || s.endpoint === b.endpoint);
    if (!subs.length) return c.json({ ok: false, error: "this device is not subscribed" }, 409);
    lastTest.set(k, clock());
    const r = await p.deliver("test", ["test"], { title: "TEST · Team", body: "Notifications are on. This is how the desk and new asks will reach you.", url: "/chat", tag: "test" }, subs);
    return c.json(r, r.ok ? 200 : r.error === "not_configured" ? 503 : 502);
  });
}
