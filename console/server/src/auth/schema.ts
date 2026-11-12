import type { DB } from "../db.js";

/**
 * login tables (plan §2, D3). Additive and idempotent by name, like ensureTenancy (no user_version bump, so it is
 * safe with the parallel lanes' branches). Secrets are never stored: passwords as scrypt hashes, session ids, agent tokens
 * and setup links as sha256 hashes.
 *  - users / memberships(user, tenant, role owner|member): a user may belong to several worlds.
 *  - sessions: bound to one tenant (a switch issues a new session), 30 days sliding.
 *  - agent_tokens: bearer `at_…`, one tenant each, revocable.
 *  - auth_setups: one-time 24 h setup links (`console-admin invite`), so no password ever goes through chat.
 *  - auth_handoffs:, one-time 2 min links that sign the same login into one of its worlds on the other host
 *    (the production site <-> the social site; a session cookie is per host).
 *  - auth_events: what CONSOLE_AUTH=shadow would have denied (and `on` did deny), for the 24 h shadow check (D12).
 */
export function ensureAuth(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL DEFAULT '',
      pw_hash TEXT,
      created_at TEXT NOT NULL,
      disabled_at TEXT
    );
    CREATE TABLE IF NOT EXISTS memberships (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, tenant_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS agent_tokens (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT,
      last_used_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS agent_tokens_tenant ON agent_tokens(tenant_id);
    CREATE TABLE IF NOT EXISTS auth_setups (
      hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS auth_handoffs (
      hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS auth_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      mode TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status INTEGER NOT NULL,
      reason TEXT NOT NULL,
      kind TEXT NOT NULL,
      tenant_id TEXT,
      peer TEXT,
      agent INTEGER NOT NULL DEFAULT 0,
      caller TEXT
    );
    CREATE INDEX IF NOT EXISTS auth_events_at ON auth_events(at);
  `);
  // a token may be limited to some paths (space-separated exact /api paths; NULL = its whole world), e.g. the seats'
  // team-gmail MCP token reaches /api/mcp/gmail and nothing else.
  const cols = (db.prepare("PRAGMA table_info(agent_tokens)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("paths")) db.exec("ALTER TABLE agent_tokens ADD COLUMN paths TEXT");
  // a seat's own the services hub token acts as one persona of its world in sessions with no console run (T3 threads).
  if (!cols.includes("persona_id")) db.exec("ALTER TABLE agent_tokens ADD COLUMN persona_id TEXT");
  // a handoff link names the host it was made for (a row from before has none and is refused).
  const hcols = (db.prepare("PRAGMA table_info(auth_handoffs)").all() as { name: string }[]).map((c) => c.name);
  if (!hcols.includes("host")) db.exec("ALTER TABLE auth_handoffs ADD COLUMN host TEXT");
  // a session says how it was made (google, github, password,
  // switch, handoff) and on which host, so the onboarding scorecard ticks "signed in" only for a real provider sign-in on
  // a customer site; a row from before has neither and proves nothing.
  const scols = (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
  if (!scols.includes("via")) db.exec("ALTER TABLE sessions ADD COLUMN via TEXT");
  if (!scols.includes("host")) db.exec("ALTER TABLE sessions ADD COLUMN host TEXT");
}
