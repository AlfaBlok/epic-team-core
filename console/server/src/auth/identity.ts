import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { DEFAULT_TENANT, type DB } from "../db.js";
import { HOST_TOKEN_PREFIX, isHostToken } from "./owner.js";

/**
 * who is calling. `CONSOLE_AUTH`:
 *  - `off` (default, and any unknown value): today's behaviour, nothing is resolved or refused.
 *  - `shadow`: every request is judged exactly as `on` would, would-deny lines go to `auth_events`, nothing is refused.
 *  - `on`: enforced; the store is scoped to the caller's world.
 * Identity, in order: a session cookie (a human, one world) → `Authorization: Bearer at_…` (an agent token, one world) →
 * `Authorization: Bearer ho_…` (the console host's own owner token, the home world with owner powers) → legacy trust (only
 * the home world: a direct call from loopback or the tailnet, no cookie, not through a proxy; today's agents, the watchdog and the
 * spines' curl recipes keep working on day one; since never with owner powers under `on`, auth/owner.ts) → none.
 */
export type AuthMode = "off" | "shadow" | "on";
export const authModeFromEnv = (env: NodeJS.ProcessEnv = process.env): AuthMode => {
  const v = (env.CONSOLE_AUTH ?? "").trim().toLowerCase();
  return v === "on" || v === "shadow" ? v : "off";
};

export type Role = "owner" | "member";
export type Identity =
  | { kind: "session"; tenant: string; userId: string; email: string; name: string; role: Role }
  | { kind: "token"; tenant: string; tokenId: string; label: string; /** only these paths (undefined = the whole world). */ paths?: string[]; /** the persona a seat token acts as with no console run. */ personaId?: string }
  | { kind: "legacy"; tenant: string; peer: string; /** the console host's own call (host owner token, auth/owner.ts): owner powers */ host?: true }
  | { kind: "none"; peer?: string };

export const SESSION_COOKIE = "console_session";
export const SESSION_DAYS = 30;
const SETUP_HOURS = 24;
const HANDOFF_SECONDS = 120; // a world switch to the other host
const now = () => new Date().toISOString();
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const random = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
const newId = (p: string) => `${p}_${crypto.randomBytes(8).toString("hex")}`;

// ---------- request context (AsyncLocalStorage) ----------

export interface AuthContext {
  mode: AuthMode;
  identity: Identity;
  /** The world the store is scoped to for this request (`on` only; undefined = unscoped, today's behaviour). */
  scope?: string;
  /** set by the agent gateway (gateway/gateway.ts), which already judged and scoped the call to its token. */
  via?: "gateway";
}
const als = new AsyncLocalStorage<AuthContext>();
export const runWithAuth = <T>(ctx: AuthContext, fn: () => T): T => als.run(ctx, fn);
/** run `fn` outside the request's context (a background pass a request only starts reads every world, unscoped). */
export const outsideRequest = <T>(fn: () => T): T => als.exit(fn);
/** The current request's auth context; undefined outside a request (cycle, sweeps) or with CONSOLE_AUTH=off. */
export const currentAuth = (): AuthContext | undefined => als.getStore();
/**
 * the world a request's own credential names (an agent token or a login), in shadow as under `on`; undefined for
 * legacy trust, no identity, or outside a request. Routes whose body names an id (not the path, which rule 3 judges) use it
 * so a world's caller never acts on another world's row, whatever the mode.
 */
export const credentialWorld = (): string | undefined => {
  const i = currentAuth()?.identity;
  return i && (i.kind === "token" || i.kind === "session") ? i.tenant : undefined;
};

// ---------- passwords (scrypt) ----------

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}
export function verifyPassword(pw: string, stored: string | null | undefined): boolean {
  const parts = (stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    crypto.scryptSync(pw, "x", SCRYPT.keylen, SCRYPT); // same cost either way: no user-exists timing signal
    return false;
  }
  const [, N, r, p, salt, hash] = parts;
  const want = Buffer.from(hash, "base64");
  const got = crypto.scryptSync(pw, Buffer.from(salt, "base64"), want.length, { N: Number(N), r: Number(r), p: Number(p) });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
export const PASSWORD_MIN = 12;

// ---------- legacy trust ----------

/** Loopback (127/8,:1) or the tailnet (the tailnet address/10, fd7a:115c:a1e0:/48). */
export function trustedPeer(addr: string | undefined): boolean {
  if (!addr) return false;
  let a = addr.trim().toLowerCase();
  if (a.startsWith("::ffff:")) a = a.slice(7);
  if (a === "::1" || a.startsWith("127.")) return true;
  if (a.startsWith("fd7a:115c:a1e0:")) return true;
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(a);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}
/** A proxied request (the production site via Traefik) is never legacy-trusted: the client is somewhere else. */
export const proxied = (header: (n: string) => string | undefined) =>
  !!(header("x-forwarded-for") || header("forwarded") || header("x-real-ip") || header("x-forwarded-host"));

// ---------- the auth service ----------

export interface Member {
  tenantId: string;
  tenantName: string;
  role: Role;
}
export interface AgentTokenInfo {
  id: string;
  tenantId: string;
  label: string;
  createdAt: string;
  createdBy?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  paths?: string[];
  personaId?: string;
}
type Row = Record<string, any>;
const toToken = (r: Row): AgentTokenInfo => ({
  id: r.id,
  tenantId: r.tenant_id,
  label: r.label,
  createdAt: r.created_at,
  ...(r.created_by ? { createdBy: r.created_by } : {}),
  ...(r.last_used_at ? { lastUsedAt: r.last_used_at } : {}),
  ...(r.revoked_at ? { revokedAt: r.revoked_at } : {}),
  ...(r.paths ? { paths: String(r.paths).split(" ") } : {}),
  ...(r.persona_id ? { personaId: r.persona_id } : {}),
});

export class AuthError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 429, readonly code: string, message: string) {
    super(message);
  }
}

export function createAuth(db: DB) {
  const tenantExists = (t: string) => !!db.prepare("SELECT 1 FROM tenants WHERE id = ?").get(t);
  const userByEmail = (email: string) => db.prepare("SELECT * FROM users WHERE email = ?").get(email.trim()) as Row | undefined;
  /** an unused, unexpired handoff link of an enabled login, made for this host (L-1), or 400. */
  const handoffRow = (token: string, host: string | undefined): Row => {
    const h = db
      .prepare(
        "SELECT h.*, u.disabled_at, u.email, t.name AS tenant_name FROM auth_handoffs h JOIN users u ON u.id = h.user_id LEFT JOIN tenants t ON t.id = h.tenant_id WHERE h.hash = ?",
      )
      .get(sha256(token ?? "")) as Row | undefined;
    if (!h || h.used_at || h.expires_at < now() || h.disabled_at) throw new AuthError(400, "invalid_handoff", "this switch link is invalid, used or expired: switch again");
    if (!h.host || h.host !== (host ?? "").toLowerCase()) throw new AuthError(400, "wrong_host", "this switch link was made for another site: switch again");
    return h;
  };
  const memberships = (userId: string): Member[] =>
    (
      db
        .prepare("SELECT m.tenant_id, m.role, t.name FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = ? ORDER BY m.created_at, m.tenant_id")
        .all(userId) as Row[]
    ).map((r) => ({ tenantId: r.tenant_id, tenantName: r.name, role: r.role }));

  const self = {
    tenantExists,
    memberships,

    /** Create (or find) a user and give them a role in a world. Returns the user id. */
    addMember(input: { email: string; tenant: string; role?: Role; name?: string }): string {
      const email = input.email.trim();
      if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new AuthError(400, "validation_error", "a valid email is required");
      if (!tenantExists(input.tenant)) throw new AuthError(404, "not_found", `tenant ${input.tenant} not found`);
      let u = userByEmail(email);
      if (!u) {
        const id = newId("usr");
        db.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)").run(id, email, input.name ?? "", now());
        u = { id };
      }
      db.prepare(
        "INSERT INTO memberships (user_id, tenant_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, tenant_id) DO UPDATE SET role = excluded.role",
      ).run(u.id, input.tenant, input.role ?? "owner", now());
      return u.id as string;
    },

    /** A one-time setup link token (24 h) for a user to set their own password. The raw token is returned once. */
    createSetup(email: string): { token: string; expiresAt: string } {
      const u = userByEmail(email);
      if (!u) throw new AuthError(404, "not_found", `user ${email} not found`);
      const token = random();
      const expiresAt = new Date(Date.now() + SETUP_HOURS * 3600_000).toISOString();
      db.prepare("INSERT INTO auth_setups (hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha256(token), u.id, now(), expiresAt);
      return { token, expiresAt };
    },
    /** Use a setup link: sets the password, returns the user's email. */
    useSetup(token: string, password: string): string {
      if (password.length < PASSWORD_MIN) throw new AuthError(400, "weak_password", `use at least ${PASSWORD_MIN} characters`);
      const s = db.prepare("SELECT * FROM auth_setups WHERE hash = ?").get(sha256(token)) as Row | undefined;
      if (!s || s.used_at || s.expires_at < now()) throw new AuthError(400, "invalid_setup", "this setup link is invalid, used or expired: ask for a new one");
      db.transaction(() => {
        db.prepare("UPDATE auth_setups SET used_at = ? WHERE hash = ?").run(now(), s.hash);
        db.prepare("UPDATE users SET pw_hash = ? WHERE id = ?").run(hashPassword(password), s.user_id);
        db.prepare("DELETE FROM sessions WHERE user_id = ?").run(s.user_id); // a new password ends old sessions
      })();
      return (db.prepare("SELECT email FROM users WHERE id = ?").get(s.user_id) as Row).email;
    },

    /**
     * a one-time link (2 min) that signs this login into one of its worlds on the other host, as a session
     * cookie belongs to one host. Only a world the login belongs to. The raw token is returned once; only its hash is kept.
     */
    createHandoff(userId: string, tenant: string, host: string): string {
      if (!memberships(userId).some((m) => m.tenantId === tenant)) throw new AuthError(403, "not_member", `not a member of ${tenant}`);
      const token = random();
      db.prepare("DELETE FROM auth_handoffs WHERE expires_at < ?").run(now());
      // the link is bound to the host it was made for; another host refuses it.
      db.prepare("INSERT INTO auth_handoffs (hash, user_id, tenant_id, created_at, expires_at, host) VALUES (?, ?, ?, ?, ?, ?)").run(
        sha256(token),
        userId,
        tenant,
        now(),
        new Date(Date.now() + HANDOFF_SECONDS * 1000).toISOString(),
        host.toLowerCase(),
      );
      return token;
    },
    /**
     * what a handoff link would do, without spending it: the login's email and the world's name, so the
     * login page asks "Continue as <email> into <world>" and redeems only on a click. Same refusals as useHandoff.
     */
    peekHandoff(token: string, host: string | undefined): { email: string; tenant: string; tenantName: string } {
      const h = handoffRow(token, host);
      if (!memberships(h.user_id).some((m) => m.tenantId === h.tenant_id)) throw new AuthError(403, "not_member", `not a member of ${h.tenant_id}`);
      return { email: h.email, tenant: h.tenant_id, tenantName: h.tenant_name ?? h.tenant_id };
    },
    /**
     * Use a handoff link once, on the host it was made for: the login and world it names (still a member, not disabled),
     * or 400. Single use is a conditional update (unused, unexpired, this host), checked by its row count.
     */
    useHandoff(token: string, host: string | undefined): { userId: string; tenant: string } {
      const h = handoffRow(token, host);
      const r = db
        .prepare("UPDATE auth_handoffs SET used_at = ? WHERE hash = ? AND used_at IS NULL AND expires_at >= ? AND host = ?")
        .run(now(), h.hash, now(), h.host);
      if (r.changes !== 1) throw new AuthError(400, "invalid_handoff", "this switch link is invalid, used or expired: switch again");
      return { userId: h.user_id, tenant: h.tenant_id };
    },

    /** Check a password. Returns the user and their worlds, or throws 401 (same answer for unknown user and bad password). */
    checkPassword(email: string, password: string): { userId: string; members: Member[] } {
      const u = userByEmail(email ?? "");
      const ok = verifyPassword(password ?? "", u?.pw_hash);
      if (!u || !ok || u.disabled_at) throw new AuthError(401, "bad_login", "wrong email or password");
      return { userId: u.id, members: memberships(u.id) };
    },

    /** A new session bound to one world the user belongs to. Returns the raw cookie value once. */
    /** `how` records the way in (google, github, password, switch, handoff) and the host, for the scorecard's proof. */
    createSession(userId: string, tenant: string, how?: { via?: string; host?: string }): { id: string; expiresAt: string } {
      if (!memberships(userId).some((m) => m.tenantId === tenant)) throw new AuthError(403, "not_member", `not a member of ${tenant}`);
      const id = random();
      const at = now();
      const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
      db.prepare("INSERT INTO sessions (id_hash, user_id, tenant_id, created_at, expires_at, last_seen_at, via, host) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        sha256(id), userId, tenant, at, expiresAt, at, how?.via ?? null, how?.host ?? null,
      );
      return { id, expiresAt };
    },
    endSession(raw: string): void {
      db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(sha256(raw));
    },
    /** The session's identity (sliding expiry), or undefined when unknown, expired, disabled or no longer a member. */
    session(raw: string): Extract<Identity, { kind: "session" }> | undefined {
      const h = sha256(raw);
      const s = db
        .prepare(
          "SELECT s.*, u.email, u.name, u.disabled_at, m.role FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN memberships m ON m.user_id = s.user_id AND m.tenant_id = s.tenant_id WHERE s.id_hash = ?",
        )
        .get(h) as Row | undefined;
      if (!s) return undefined;
      const t = now();
      if (s.expires_at < t || s.disabled_at || !s.role) {
        db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(h);
        return undefined;
      }
      if (Date.now() - Date.parse(s.last_seen_at) > 3600_000)
        db.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ?").run(t, new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString(), h);
      return { kind: "session", tenant: s.tenant_id, userId: s.user_id, email: s.email, name: s.name, role: s.role };
    },

    /** A new agent token for one world. The raw `at_…` value is returned once and never stored. */
    createToken(input: { tenant: string; label: string; createdBy?: string; paths?: string[]; personaId?: string }): { token: string; info: AgentTokenInfo } {
      if (!tenantExists(input.tenant)) throw new AuthError(404, "not_found", `tenant ${input.tenant} not found`);
      const label = (input.label ?? "").trim();
      if (!label || label.length > 120) throw new AuthError(400, "validation_error", "label is required (up to 120 characters)");
      const paths = input.paths?.map((p) => p.trim()).filter(Boolean);
      if (paths?.some((p) => !/^\/api\/[A-Za-z0-9/_.-]+$/.test(p))) throw new AuthError(400, "validation_error", "paths are exact /api/… paths");
      // a token's persona is one of its own world's (never another world's), checked here and on every hub call.
      if (input.personaId && !db.prepare("SELECT 1 FROM personas WHERE id = ? AND tenant_id = ?").get(input.personaId, input.tenant))
        throw new AuthError(400, "validation_error", `persona ${input.personaId} is not a persona of ${input.tenant}`);
      const token = `at_${random()}`;
      const id = newId("tok");
      db.prepare("INSERT INTO agent_tokens (id, tenant_id, hash, label, created_at, created_by, paths, persona_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        id,
        input.tenant,
        sha256(token),
        label,
        now(),
        input.createdBy ?? null,
        paths?.length ? paths.join(" ") : null,
        input.personaId ?? null,
      );
      return { token, info: toToken(db.prepare("SELECT * FROM agent_tokens WHERE id = ?").get(id) as Row) };
    },
    listTokens: (tenant: string): AgentTokenInfo[] =>
      (db.prepare("SELECT * FROM agent_tokens WHERE tenant_id = ? ORDER BY created_at, id").all(tenant) as Row[]).map(toToken),
    /** Revoke a token of this world; false when it is not this world's. */
    revokeToken(tenant: string, id: string): boolean {
      return db.prepare("UPDATE agent_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ? AND tenant_id = ?").run(now(), id, tenant).changes > 0;
    },
    token(raw: string): Extract<Identity, { kind: "token" }> | undefined {
      if (!raw.startsWith("at_")) return undefined;
      const r = db.prepare("SELECT * FROM agent_tokens WHERE hash = ?").get(sha256(raw)) as Row | undefined;
      if (!r || r.revoked_at) return undefined;
      if (!r.last_used_at || Date.now() - Date.parse(r.last_used_at) > 60_000) db.prepare("UPDATE agent_tokens SET last_used_at = ? WHERE id = ?").run(now(), r.id);
      return {
        kind: "token",
        tenant: r.tenant_id,
        tokenId: r.id,
        label: r.label,
        ...(r.paths ? { paths: String(r.paths).split(" ") } : {}),
        ...(r.persona_id ? { personaId: r.persona_id } : {}),
      };
    },

    /**
     * Resolve the caller. A bearer that does not check out is not downgraded to legacy trust: it resolves to none (the
     * caller asked to be a token and is not). A stale cookie is ignored (the browser then logs in again, or a tailnet
     * browser keeps today's legacy trust).
     */
    resolve(req: { header: (n: string) => string | undefined; cookie?: string; peer?: string }): Identity {
      const s = req.cookie ? self.session(req.cookie) : undefined;
      if (s) return s;
      const authz = req.header("authorization");
      const bearer = /^Bearer\s+(\S+)$/i.exec(authz ?? "")?.[1];
      if (bearer?.startsWith("at_")) return self.token(bearer) ?? { kind: "none", peer: req.peer };
      if (bearer?.startsWith(HOST_TOKEN_PREFIX))
        return isHostToken(bearer) ? { kind: "legacy", tenant: DEFAULT_TENANT, peer: req.peer ?? "", host: true } : { kind: "none", peer: req.peer };
      if (trustedPeer(req.peer) && !proxied(req.header)) return { kind: "legacy", tenant: DEFAULT_TENANT, peer: req.peer! };
      return { kind: "none", peer: req.peer };
    },

    logEvent(e: { mode: AuthMode; method: string; path: string; status: number; reason: string; identity: Identity; peer?: string; agent: boolean; caller?: string }): void {
      try {
        db.prepare(
          "INSERT INTO auth_events (at, mode, method, path, status, reason, kind, tenant_id, peer, agent, caller) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(now(), e.mode, e.method, e.path.slice(0, 300), e.status, e.reason, e.identity.kind, "tenant" in e.identity ? e.identity.tenant : null, e.peer ?? null, e.agent ? 1 : 0, e.caller?.slice(0, 120) ?? null);
        if (Math.random() < 0.01) db.prepare("DELETE FROM auth_events WHERE at < ?").run(new Date(Date.now() - 14 * 86400_000).toISOString());
      } catch (err) {
        console.error("auth event not logged:", err);
      }
    },
    /** Would-deny / deny counts since `since`, split agent vs browser, plus the newest rows (no secrets in them). */
    events(since: string, limit = 50) {
      const rows = db.prepare("SELECT * FROM auth_events WHERE at >= ? ORDER BY id DESC LIMIT ?").all(since, limit) as Row[];
      const counts = db.prepare("SELECT reason, kind, agent, COUNT(*) AS n FROM auth_events WHERE at >= ? GROUP BY reason, kind, agent ORDER BY n DESC").all(since) as Row[];
      const agent = (db.prepare("SELECT COUNT(*) AS n FROM auth_events WHERE at >= ? AND agent = 1").get(since) as Row).n as number;
      const total = (db.prepare("SELECT COUNT(*) AS n FROM auth_events WHERE at >= ?").get(since) as Row).n as number;
      return {
        since,
        total,
        agent,
        counts: counts.map((r) => ({ reason: r.reason, kind: r.kind, agent: !!r.agent, n: r.n })),
        recent: rows.map((r) => ({ at: r.at, mode: r.mode, method: r.method, path: r.path, status: r.status, reason: r.reason, kind: r.kind, tenantId: r.tenant_id ?? undefined, peer: r.peer ?? undefined, agent: !!r.agent, caller: r.caller ?? undefined })),
      };
    },
  };
  return self;
}
export type Auth = ReturnType<typeof createAuth>;
