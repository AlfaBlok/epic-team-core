import crypto from "node:crypto";
import { sites } from "../identity.js";

/**
 * Web Push's crypto, with nothing from the app (so a script such as scripts/push-probe.ts loads it alone):
 * the VAPID key (RFC 8292), the payload encryption (RFC 8291 aes128gcm) and the POST to a push service.
 */

const VAPID_SUBJECT = (): string => sites().contact;

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url");

export interface Vapid {
  privateKey: crypto.KeyObject;
  /** The uncompressed P-256 public key (65 bytes), base64url: the browser's `applicationServerKey`. */
  publicKey: string;
}

/** A VAPID key from its stored form: base64url PKCS8 DER (what `secret put` holds) or a PEM. */
export function vapidFrom(stored: string): Vapid | undefined {
  try {
    const v = stored.trim();
    const privateKey = v.includes("-----BEGIN") ? crypto.createPrivateKey(v) : crypto.createPrivateKey({ key: unb64u(v), format: "der", type: "pkcs8" });
    const jwk = crypto.createPublicKey(privateKey).export({ format: "jwk" }) as { x: string; y: string; crv?: string };
    if (jwk.crv !== "P-256") return undefined;
    return { privateKey, publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])) };
  } catch {
    return undefined;
  }
}

/** RFC 8292: `vapid t=<ES256 JWT for the endpoint's origin>, k=<public key>`. */
export function vapidAuthorization(vapid: Vapid, endpoint: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const head = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSec + 12 * 3600, sub: VAPID_SUBJECT() })));
  const sig = crypto.sign("sha256", Buffer.from(`${head}.${body}`), { key: vapid.privateKey, dsaEncoding: "ieee-p1363" });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${vapid.publicKey}`;
}

const hmac = (key: Buffer, data: Buffer) => crypto.createHmac("sha256", key).update(data).digest();

/** RFC 8291 + RFC 8188 (aes128gcm, one record): the body a push service carries to the browser. */
export function encryptPayload(payload: Buffer, keys: { p256dh: string; auth: string }, o: { salt?: Buffer; ecdh?: crypto.ECDH } = {}): Buffer {
  const uaPublic = unb64u(keys.p256dh);
  const authSecret = unb64u(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("p256dh is not an uncompressed P-256 key");
  if (authSecret.length < 16) throw new Error("auth secret too short");
  const ecdh = o.ecdh ?? crypto.createECDH("prime256v1");
  if (!o.ecdh) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const salt = o.salt ?? crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

/** The receiving side of `encryptPayload` (tests and the live proof's test subscription). */
export function decryptPayload(body: Buffer, ua: { ecdh: crypto.ECDH; auth: Buffer }): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const uaPublic = ua.ecdh.getPublicKey();
  const shared = ua.ecdh.computeSecret(asPublic);
  const ikm = hmac(hmac(ua.auth, shared), Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  const end = plain.lastIndexOf(2);
  return plain.subarray(0, end < 0 ? plain.length : end);
}

/** What the service worker shows (web/public/sw.js). */
export interface PushMessage {
  title: string;
  body: string;
  /** Opened on tap (same origin). */
  url: string;
  /** Replaces an earlier notification with the same tag. */
  tag?: string;
}

export interface PushSub {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}
export type PushResult = { ok: true; status: number } | { ok: false; status?: number; gone?: boolean; error: string };
export type PushTransport = (sub: PushSub, msg: PushMessage) => Promise<PushResult>;

/** Posts one encrypted message to one subscription. Errors carry no key and no endpoint path. */
export function webPushTransport(vapid: Vapid, o: { fetch?: typeof fetch; ttlSec?: number } = {}): PushTransport {
  return async (sub, msg) => {
    try {
      const body = encryptPayload(Buffer.from(JSON.stringify(msg)), sub);
      const res = await (o.fetch ?? fetch)(sub.endpoint, {
        method: "POST",
        headers: {
          authorization: vapidAuthorization(vapid, sub.endpoint),
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          ttl: String(o.ttlSec ?? 24 * 3600),
          urgency: "high",
          ...(msg.tag ? { topic: msg.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "team" } : {}),
        },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(20_000),
      });
      await res.arrayBuffer().catch(() => undefined);
      if (res.ok) return { ok: true, status: res.status };
      return { ok: false, status: res.status, gone: res.status === 404 || res.status === 410, error: `push service answered HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, error: `push service unreachable: ${(e as Error).message.slice(0, 120)}` };
    }
  };
}
