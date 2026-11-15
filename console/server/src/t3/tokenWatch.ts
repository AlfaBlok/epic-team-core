import fs from "node:fs";

/**
 * the T3 MCP tokens the console calls T3 with (the main server's `.t3token`, the worker server's
 * `.t3token-<host>`) are 30-day tokens. On 2026-11-12 the main server's expired unseen: every wake send got
 * `T3 MCP HTTP 401 invalid_mcp_credential`, a planner persona's run sat "running" with no thread for 2.5 h,
 * and the watchdog's own alert to the HQ thread failed with the same token.
 *
 * This watch reads each token's expiry (the `exp` in its payload, else the file's write time + 30 days), warns
 * WARN_DAYS before it, and turns any 401 invalid_mcp_credential from T3 into an alert line: the log, /api/health
 * `t3Tokens` and (production) one WhatsApp per episode. How to rotate: hosted/console/README.md "Rotating the T3 MCP tokens".
 */

export const WARN_DAYS = 5;
export const TOKEN_LIFE_DAYS = 30;
const DAY = 86_400_000;
export const ROTATE_HINT = 'rotate it with m0/tools/mcp_login.py (hosted/console/README.md "Rotating the T3 MCP tokens")';

export interface TokenFile {
  host: string;
  file: string;
}

export interface TokenState {
  host: string;
  file: string;
  /** missing = no file (that host is not used here); the rest from the expiry. */
  state: "ok" | "warn" | "expired" | "missing";
  expiresAt?: string;
  daysLeft?: number;
  /** where the expiry came from: the token's own `exp`, or the file's write time + 30 days. */
  from?: "token" | "file";
  /** the last 401 T3 gave with this token, if after the file was last written (a rotation clears it). */
  refusedAt?: string;
  refused?: string;
}

/**
 * when a T3 MCP token expires, read without ever printing it: the payload before the first `.` is base64url JSON
 * with `exp` (ms since epoch on T3 2026-11; seconds accepted too). Undefined when it is not that shape.
 */
export function tokenExpiry(token: string): number | undefined {
  const head = token.trim().split(".")[0];
  if (!head) return undefined;
  try {
    const j = JSON.parse(Buffer.from(head, "base64url").toString("utf8"));
    const exp = Number(j?.exp);
    if (!Number.isFinite(exp) || exp <= 0) return undefined;
    return exp < 1e12 ? exp * 1000 : exp;
  } catch {
    return undefined;
  }
}

/** a T3 refusal of the credential itself (expired, revoked), not any other 401. */
export const isCredentialRefusal = (text: string) => /HTTP 401/.test(text) && /invalid_mcp_credential|credential is required|unauthori[sz]ed/i.test(text);

// ---------- the refusals the T3 client saw (module-wide: every McpT3Client reports here) ----------
const refusals = new Map<string, { at: number; text: string }>();
const listeners = new Set<(file: string, text: string, first: boolean) => void>();

/** called by McpT3Client on a 401 from T3. `first` = the first refusal since the file was last written (an episode). */
export function reportRefusal(file: string, text: string, now = Date.now()): void {
  const prev = refusals.get(file);
  const written = mtime(file);
  const first = !prev || (written !== undefined && written > prev.at);
  refusals.set(file, { at: now, text: text.slice(0, 300) });
  for (const l of listeners) l(file, text, first);
}
export function onRefusal(l: (file: string, text: string, first: boolean) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
/** tests */
export function clearRefusals(): void {
  refusals.clear();
}

function mtime(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

/** one token file's state now. */
export function readTokenState(t: TokenFile, now = Date.now(), warnDays = WARN_DAYS): TokenState {
  let raw: string;
  let written: number;
  try {
    raw = fs.readFileSync(t.file, "utf8");
    written = fs.statSync(t.file).mtimeMs;
  } catch {
    return { ...t, state: "missing" };
  }
  const exp = tokenExpiry(raw);
  const at = exp ?? written + TOKEN_LIFE_DAYS * DAY;
  const daysLeft = Math.round(((at - now) / DAY) * 10) / 10;
  const r = refusals.get(t.file);
  const refused = r && r.at >= written ? r : undefined; // a refusal before the last rotation is history
  const state: TokenState["state"] = at <= now || refused ? "expired" : daysLeft <= warnDays ? "warn" : "ok";
  return {
    ...t,
    state,
    expiresAt: new Date(at).toISOString(),
    daysLeft,
    from: exp ? "token" : "file",
    ...(refused ? { refusedAt: new Date(refused.at).toISOString(), refused: refused.text } : {}),
  };
}

export interface TokenWatch {
  /** check every token now (logs and alerts each new warn/expired episode); returns the states. */
  check(now?: number): TokenState[];
  /** for /api/health: `alert` when a token is expired or refused, `warn` within WARN_DAYS, else `ok`. */
  health(): { state: "ok" | "warn" | "alert" | "off"; warnDays: number; tokens: TokenState[]; rotate?: string };
  start(everyMs: number): void;
  stop(): void;
}

/**
 * the watch. `files` lists the token files in use (re-read each check, so a new host shows up). `alert` is called once
 * per episode: a token entering warn, expired, or a fresh 401 refusal; a rotation (the file rewritten) ends the episode.
 */
export function createTokenWatch(o: {
  files: () => TokenFile[];
  log: (m: string) => void;
  alert?: (kind: string, text: string) => void;
  warnDays?: number;
  now?: () => number;
}): TokenWatch {
  const warnDays = o.warnDays ?? WARN_DAYS;
  const now = o.now ?? Date.now;
  /** file -> the episode already alerted (state + the file's write time it was about). */
  const alerted = new Map<string, string>();
  let last: TokenState[] = [];
  let timer: NodeJS.Timeout | undefined;
  const files = () => {
    const seen = new Set<string>();
    return o.files().filter((f) => f.file && f.file !== "/dev/null" && !seen.has(f.file) && (seen.add(f.file), true));
  };
  const line = (s: TokenState) =>
    s.state === "expired"
      ? `[ALERT] T3 MCP token for ${s.host} ${s.refused ? `refused by T3 at ${s.refusedAt} (${s.refused.slice(0, 120)})` : `expired at ${s.expiresAt}`}: wakes on ${s.host} cannot start; ${ROTATE_HINT}`
      : `[WARN] T3 MCP token for ${s.host} expires ${s.expiresAt} (${s.daysLeft} days left): ${ROTATE_HINT}`;
  const check = (at = now()) => {
    last = files().map((f) => readTokenState(f, at, warnDays));
    for (const s of last) {
      if (s.state !== "warn" && s.state !== "expired") {
        alerted.delete(s.file);
        continue;
      }
      const key = `${s.state}@${mtime(s.file) ?? 0}`;
      if (alerted.get(s.file) === key) continue;
      alerted.set(s.file, key);
      const text = line(s);
      o.log(text);
      o.alert?.(`t3-token-${s.host}`, text);
    }
    return last;
  };
  // a 401 from T3 is an alert line at once (check() logs it as `expired`, refused by T3), never a silent retry
  const off = onRefusal((_file, _text, first) => {
    if (first) check();
  });
  return {
    check,
    health() {
      check(); // two small file reads; alerts stay once per episode
      const used = last.filter((s) => s.state !== "missing");
      const state = used.some((s) => s.state === "expired") ? "alert" : used.some((s) => s.state === "warn") ? "warn" : "ok";
      return { state, warnDays, tokens: last, ...(state !== "ok" ? { rotate: ROTATE_HINT } : {}) };
    },
    start(everyMs: number) {
      check();
      timer = setInterval(() => void check(), everyMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      off();
    },
  };
}
