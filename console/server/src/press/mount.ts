import type { Context, Hono } from "hono";
import { authModeFromEnv, currentAuth, runWithAuth, type AuthMode } from "../auth/identity.js";
import { DEFAULT_TENANT, type DB } from "../db.js";
import { timeWrites, withPress, type BackgroundPushes } from "../inbox/spineWrite.js";
import { judge, serverTiming, undoHoldMs, type Presses, type PressRequest, type Verdict } from "./presses.js";

/**
 * the press log and outbox on the routes behind the owner's buttons (Team home, review cards, asks, the inbox, and the
 * desk and chat calls that register his answers). One middleware, so a route's own code is unchanged:
 * - `outbox` routes (the review buttons, Reopen, an ask's Snooze): the press is saved before the route runs; when the
 *   write fails for a reason a later try can get past (git, the checkout), the reply is `202 {press: {state: "landing"}}`
 *   (the card says "Saved, landing…") and the worker below replays the same request with backoff until it lands, then
 *   GET /api/presses/:id says `landed` with the route's answer. A refusal (the row left review, bad input) is logged and
 *   answered as before.
 * - `answerFirst` (production): an outbox press is answered `202 {press: {state: "landing"}}` as soon as it is
 *   saved, in milliseconds, and the worker runs the route (the git write) at once in the background; the browser never
 *   waits for git, a queue or a restart. A repeat of a press still landing gets that press back. A repeat of a press that
 *   landed is a new press; when the route refuses it ("not in review any more") it takes the first one's landing, never
 *   a refusal. A refusal right after another press on the same card landed is tried again (the view may lag behind the
 *   repo for a moment). Presses on the same card land in the order pressed.
 * - `answer` (respond): already saved first by its own job; the press row follows that job.
 * - `log` (change, deliver, a pasted key): logged with their result; never replayed. A key's body is never stored.
 */
type Mode = "outbox" | "answer" | "log";
interface PressRoute {
  re: RegExp;
  mode: Mode;
  action: (m: RegExpExecArray, body: Record<string, unknown>) => string;
  target: (m: RegExpExecArray, body: Record<string, unknown>) => string;
}

const dec = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export const PRESS_ROUTES: PressRoute[] = [
  {
    re: /^\/review-items\/([^/]+)\/(approve|deny|relaunch|complete|snooze)$/,
    mode: "outbox",
    action: (m) => `review ${m[2] === "relaunch" ? "feedback" : m[2]}`,
    target: (m) => dec(m[1]),
  },
  {
    // Bring it back after the press landed, and Add comment on a closed card (both write the spine first)
    re: /^\/review-items\/reopen$/,
    mode: "outbox",
    action: () => "review bring back",
    // the card's id when sent: the same target as the press it undoes, so it lands after that press (press order)
    target: (_m, b) => (typeof b.id === "string" && b.id ? b.id : `${String(b.repo ?? "")}:${String(b.ref ?? "")}`),
  },
  {
    re: /^\/closed-cards\/comment$/,
    mode: "outbox",
    action: (_m, b) => `${b.kind === "ask" ? "ask" : "review"} comment`,
    target: (_m, b) => `${String(b.repo ?? "")}:${String(b.ref ?? "")}`,
  },
  {
    re: /^\/review-goals\/reopen$/,
    mode: "outbox",
    action: () => "goal reopen",
    target: (_m, b) => String(b.key ?? ""),
  },
  {
    re: /^\/waiting-on-owner\/([^/]+)\/snooze$/,
    mode: "outbox",
    action: (_m, b) => (b.until === null ? "ask unsnooze" : "ask snooze"),
    target: (m) => dec(m[1]),
  },
  {
    re: /^\/waiting-on-owner\/([^/]+)\/respond$/,
    mode: "answer",
    action: (_m, b) => `ask ${typeof b.kind === "string" ? b.kind : "answer"}`,
    target: (m) => dec(m[1]),
  },
  {
    re: /^\/owner-responses\/([^/]+)\/change$/,
    mode: "log",
    action: () => "answer change",
    target: (m) => dec(m[1]),
  },
  {
    re: /^\/owner-responses\/([^/]+)\/deliver$/,
    mode: "log",
    action: () => "answer retry",
    target: (m) => dec(m[1]),
  },
  {
    re: /^\/waiting-on-owner\/([^/]+)\/secret$/,
    mode: "log",
    action: () => "ask key",
    target: (m) => dec(m[1]),
  },
];

export const REPLAY_HEADER = "x-press-replay";
/** how many times a refusal right after another press on the same card landed is tried again. */
export const SIBLING_RETRIES = 3;
/** presses written at the same time (each on its own card), and how many of them the daily press test may hold. */
export const PRESS_CONCURRENCY = 8;
export const PRESS_TEST_SLOTS = 4;
/** The daily press test's own presses (it presses as the console host with `x-console-run: press-test`, dailyTest.ts). */
const isTestPress = (r: PressRequest) => r.headers?.["x-console-run"] === "press-test";
/** the owner's due presses first, then the daily press test's, each in press order (a stable sort keeps it). */
const byPriority = <T extends { request: PressRequest }>(due: T[]): T[] => [...due].sort((a, b) => Number(isTestPress(a.request)) - Number(isTestPress(b.request)));
/** Headers a replay carries over (never a cookie or a token: the replay runs as the console host). */
const KEEP_HEADERS = ["content-type", "x-console-run"];

function match(p: string): { r: PressRoute; m: RegExpExecArray } | undefined {
  for (const r of PRESS_ROUTES) {
    const m = r.re.exec(p);
    if (m) return { r, m };
  }
  return undefined;
}

/** Who pressed: the login's name, the agent token's label, or the host / tailnet peer. */
export function whoPressed(): { who: string; tenant: string } {
  const i = currentAuth()?.identity;
  if (!i) return { who: "console user (auth off)", tenant: DEFAULT_TENANT };
  if (i.kind === "session") return { who: i.name || i.email, tenant: i.tenant };
  if (i.kind === "token") return { who: `token ${i.label}`, tenant: i.tenant };
  if (i.kind === "legacy")
    return {
      who: i.host ? "console host" : `trusted peer ${i.peer}`,
      tenant: i.tenant,
    };
  return {
    who: `unknown${i.peer ? ` ${i.peer}` : ""}`,
    tenant: DEFAULT_TENANT,
  };
}

const json = (s: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.clone().json();
  } catch {
    return undefined;
  }
}

export interface PressMountOptions {
  db: DB;
  presses: Presses;
  /** The app's own fetch (the outbox replays through it). */
  fetch: (req: Request) => Response | Promise<Response>;
  authMode?: AuthMode;
  /** Clone writer status for /api/write-health. */
  clones?: () => unknown;
  log?: (msg: string) => void;
  /** answer an outbox press once it is saved and land it in the worker (production); off = the route runs in the request. */
  answerFirst?: boolean;
  /** the spine writer's background pushes (a deploy waits for them; a graceful stop drains them). */
  pushes?: () => BackgroundPushes | undefined;
  /** a review card's row (repo, spine, code), kept with the press so his words land even if the row moves on. */
  cardOf?: (id: string) => PressRequest["card"];
}

/** presses that carry the owner's words (Changes wanted, Deny with a reason): never refused into nothing. */
const WORDS_ROUTE = /\/review-items\/([^/?]+)\/(relaunch|deny)(?:\?|$)/;
/** Text compared loosely (a status cell squares brackets and folds spaces). */
const loose = (t: string) => t.replace(/[()[\]“”"]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

export interface PressWorker {
  tick(): Promise<number>;
  start(everyMs?: number): void;
  stop(): void;
  /** Boot: a first try cut off by a restart is due again now. */
  resume(): number;
  /** presses being written now plus presses due now (a deploy waits while this is above 0). */
  busy(): { inFlight: number; due: number };
  /** graceful stop: wait (at most `ms`) for the presses being written now; true when none is left. */
  drain(ms: number): Promise<boolean>;
}

/** what a saved press answers (the card says "Saved" and follows GET /api/presses/:id until it lands). */
const landingReply = (p: { id: string; reason?: string; nextAt?: string }) => ({
  press: { id: p.id, state: "landing" as const, message: "Saved, landing…", ...(p.reason ? { reason: p.reason } : {}), ...(p.nextAt ? { nextAt: p.nextAt } : {}) },
});

export function mountPresses(api: Hono, o: PressMountOptions): PressWorker {
  const { presses, db } = o;
  const log = o.log ?? ((m: string) => console.warn(m));
  const mode = o.authMode ?? authModeFromEnv();

  /** The answer job `ref` has ended (done or failed): every press it carries takes that end. True when it had ended. */
  const jobEnd = (ref: string): boolean => {
    const j = db.prepare("SELECT job_state, job_attempts, job_error, spine_sha FROM jordi_responses WHERE id = ?").get(ref) as
      { job_state: string | null; job_attempts: number | null; job_error: string | null; spine_sha: string | null } | undefined;
    if (j?.job_state !== "done" && j?.job_state !== "failed") return false;
    presses.answerJob(ref, { state: j.job_state, attempts: j.job_attempts ?? 1, error: j.job_error, sha: j.spine_sha });
    return true;
  };
  /** An answer press linked to its job: take the job's state now (in `done` ack mode it finished before the reply). */
  const followAnswer = (id: string, ref: string, reply?: { status: number; ms: number }) => {
    presses.link(id, ref, reply);
    jobEnd(ref);
  };

  api.use("*", async (c: Context, next) => {
    if (c.req.method !== "POST") return next();
    const t00 = Date.now();
    const p = c.req.path.replace(/^\/api(?=\/)/, "");
    const hit = match(p);
    if (!hit || c.req.header(REPLAY_HEADER)) return next();
    const { r, m } = hit;
    const raw = r.mode === "outbox" || r.mode === "answer" ? await c.req.text().catch(() => "") : "";
    const body = json(raw);
    let key = r.mode === "outbox" ? c.req.header("idempotency-key")?.trim() || undefined : undefined;
    if (key) {
      const prior = presses.byKey(key);
      // a failed press with that key: this is a new press (Retry on the card), logged on its own
      if (prior?.state === "failed") key = undefined;
      else if (prior) {
        if (prior.state === "landed" && prior.response !== undefined) return c.json(prior.response as object, (prior.httpStatus ?? 200) as 200);
        if (prior.state === "landing")
          return c.json(
            {
              press: {
                id: prior.id,
                state: "landing",
                message: "Saved, landing…",
                reason: prior.reason,
              },
            },
            202,
          );
      }
    }
    // pressing again while the first press is landing (a double click, a second tab) returns that press
    if (r.mode === "outbox" && o.answerFirst) {
      const prior = presses.repeatOf(r.target(m, body), p, raw);
      if (prior) {
        const res = c.json(landingReply(prior), 202);
        res.headers.set("x-press-id", prior.id);
        res.headers.set("x-press-repeat", "1");
        return res;
      }
    }
    const { who, tenant } = whoPressed();
    const run = c.req.header("x-console-run")?.trim() || undefined;
    const ident = currentAuth()?.identity;
    const peer = ident?.kind === "legacy" && ident.host && ident.peer ? ident.peer : undefined;
    const q = new URL(c.req.url).search;
    const request: PressRequest | undefined =
      r.mode === "outbox"
        ? {
            method: "POST",
            path: c.req.path + q,
            body: raw,
            headers: Object.fromEntries(KEEP_HEADERS.map((h) => [h, c.req.header(h)]).filter((x): x is [string, string] => !!x[1])),
            ...(peer ? { peer } : {}),
            ...(() => {
              // a press with his words keeps the card's row, from the stored view (no spine read)
              const w = WORDS_ROUTE.exec(p);
              if (!w || !o.cardOf) return {};
              try {
                const card = o.cardOf(dec(w[1]));
                return card ? { card } : {};
              } catch {
                return {};
              }
            })(),
          }
        : undefined;
    const first = r.mode === "outbox" && !!o.answerFirst;
    // a card press waits out its Bring it back window before the worker writes it
    const hold = first ? undoHoldMs(c.req.header("x-undo-ms")) : 0;
    let id: string;
    try {
      id = presses.open({
        action: r.action(m, body),
        target: r.target(m, body),
        who: run ? `${who} via ${run}` : who,
        ...(run ? { via: run } : {}),
        route: p,
        ...(request ? { request } : {}),
        ...(key ? { clientKey: key } : {}),
        tenant,
        ...(first ? { due: true } : {}),
        ...(hold ? { holdMs: hold } : {}),
      });
    } catch (e) {
      // the log never stops a press
      log(`press log: not saved (${(e as Error).message}); the press runs as before`);
      return next();
    }
    if (first) {
      // saved; the worker writes it now, the browser has its answer
      presses.replied(id, { status: 202, ms: Date.now() - t00 });
      const go = () => void worker.tick().catch((e) => log(`press outbox: ${(e as Error).message}`));
      if (hold) setTimeout(go, hold + 20).unref?.();
      else setImmediate(go);
      const res = c.json({ press: { ...landingReply({ id }).press, ...(hold ? { undoMs: hold } : {}) } }, 202);
      res.headers.set("x-press-id", id);
      return res;
    }
    const t0 = Date.now();
    try {
      await next();
    } catch (e) {
      presses.settle(id, {
        verdict: { kind: "retry", reason: (e as Error).message },
        status: 500,
        ms: Date.now() - t0,
        retry: r.mode === "outbox",
      });
      throw e;
    }
    const res = c.res;
    const out = await readJson(res);
    const ms = Date.now() - t0;
    const steps = serverTiming(res.headers.get("server-timing"));
    if (r.mode === "answer" && res.status >= 200 && res.status < 300 && out && typeof (out as { id?: unknown }).id === "string") {
      followAnswer(id, (out as { id: string }).id, { status: res.status, ms });
    } else {
      const verdict = judge(res.status, out);
      const settled = presses.settle(id, {
        verdict,
        status: res.status,
        ms,
        ...(steps ? { steps } : {}),
        ...(verdict.kind === "landed" ? { response: out } : {}),
        retry: r.mode === "outbox",
      });
      if (r.mode === "outbox" && settled.state === "landing")
        c.res = new Response(
          JSON.stringify({
            press: {
              id,
              state: "landing",
              message: "Saved, landing…",
              reason: settled.reason,
              nextAt: settled.nextAt,
            },
          }),
          { status: 202, headers: { "content-type": "application/json" } },
        );
    }
    try {
      c.res.headers.set("x-press-id", id);
    } catch {
      /* immutable headers: the id is in the log all the same */
    }
  });

  api.get("/presses", (c) => {
    const state = c.req.query("state");
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json(
      presses.list({
        limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
        ...(state === "landing" || state === "landed" || state === "failed" ? { state } : {}),
      }),
    );
  });
  // Bring it back on a card press still in its undo window: nothing was written, nobody woken. 409 `landed`
  // (or `writing`) once the worker has it: the card then reopens through the route that undoes what landed.
  api.post("/presses/:id/undo", (c) => {
    const id = c.req.param("id");
    const p = presses.get(id);
    if (!p) return c.json({ error: { code: "not_found", message: "no press with that id" } }, 404);
    const { who, tenant } = whoPressed();
    // a world takes back only its own presses
    if ((db.prepare("SELECT tenant_id FROM presses WHERE id = ?").get(id) as { tenant_id: string | null } | undefined)?.tenant_id !== tenant && mode === "on")
      return c.json({ error: { code: "not_found", message: "no press with that id" } }, 404);
    if (p.state === "undone") return c.json({ undone: true, press: p });
    if (inFlight.has(id) || p.state !== "landing" || p.attempts > 0)
      return c.json({ error: { code: p.state === "landed" ? "landed" : "writing", message: p.state === "landed" ? "it is in the project already" : "it is being written now" }, press: p }, 409);
    if (!presses.undo(id, `brought back by ${who} before it was written`)) return c.json({ error: { code: "writing", message: "it is being written now" } }, 409);
    log(`press ${id} (${p.action} ${p.target}): brought back by ${who} before it was written`);
    return c.json({ undone: true, press: presses.get(id) });
  });
  // a world asks after its own presses (TENANT_SAFE); before, another world's page got 403 world_scope here and
  // its "writing it to the project…" line spun for minutes after the press had landed (the social site 2026-11-11).
  api.get("/presses/:id", (c) => {
    const id = c.req.param("id");
    const p = presses.get(id, true);
    const { tenant } = whoPressed();
    const own = (db.prepare("SELECT tenant_id FROM presses WHERE id = ?").get(id) as { tenant_id: string | null } | undefined)?.tenant_id ?? DEFAULT_TENANT;
    if (p && mode === "on" && tenant !== DEFAULT_TENANT && own !== tenant) return c.json({ error: { code: "not_found", message: "no press with that id" } }, 404);
    return p ? c.json(p) : c.json({ error: { code: "not_found", message: "no press with that id" } }, 404);
  });
  // counts per day, what is still landing, the last failures and the clones; agents read it (GET, no secrets).
  api.get("/write-health", (c) => {
    const days = Math.min(Math.max(Number(c.req.query("days") ?? 14) || 14, 1), 90);
    return c.json({
      ...presses.health(days),
      clones: o.clones?.() ?? { enabled: false },
    });
  });

  const inFlight = new Set<string>();
  /** the daily press test's presses among those in flight. */
  const testPress = new Set<string>();
  /** the cards a press is being written for now (a later press on the same card waits its turn). */
  const busyTargets = new Set<string>();
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function replay(id: string, req: PressRequest, tenant?: string): Promise<void> {
    if (presses.get(id)?.state !== "landing") return; // brought back meanwhile
    const t0 = Date.now();
    let verdict: Verdict;
    let status = 0;
    let out: unknown;
    let steps: Record<string, number> | undefined;
    const w = tenant ?? DEFAULT_TENANT;
    const ctx = {
      mode,
      identity: {
        kind: "legacy" as const,
        tenant: w,
        peer: req.peer ?? "press-outbox",
        host: true as const,
      },
      ...(mode === "on" ? { scope: w } : {}),
      via: "gateway" as const,
    };
    try {
      // the write's steps come back as Server-Timing (review routes); the worker also tallies them itself.
      // its own tally first (it has the lock wait and every write of the try; the header can be lost on the way back)
      // as press `id`, so its commit names it (a commit the background push cannot land puts it back in the outbox)
      const { out: res, steps: tally } = await timeWrites(() =>
        withPress(id, () =>
          runWithAuth(ctx, async () =>
            o.fetch(
              new Request(`http://console.local${req.path}`, {
                method: req.method,
                headers: { ...(req.headers ?? {}), [REPLAY_HEADER]: id },
                ...(req.body ? { body: req.body } : {}),
              }),
            ),
          ),
        ),
      );
      status = res.status;
      out = await readJson(res);
      steps = Object.keys(tally).length ? tally : serverTiming(res.headers.get("server-timing"));
      verdict = judge(status, out);
    } catch (e) {
      verdict = { kind: "retry", reason: (e as Error).message };
      status = 500;
    }
    if (verdict.kind === "refused" && (status === 404 || status === 409)) {
      // the same press landed already (pressed again after it landed): this press is that landing, not a refusal
      const twin = presses.landedTwin(id);
      if (twin) {
        verdict = { kind: "landed", ...(twin.sha ? { sha: twin.sha } : {}), note: `the same press landed at ${twin.landedAt ?? twin.at} (${twin.id})` };
        out = twin.response;
      } else if ((presses.get(id)?.attempts ?? 0) < SIBLING_RETRIES && presses.siblingLanded(id)) {
        // another press on this card just landed: the console's view of the spine may not have it yet; try again shortly
        verdict = { kind: "retry", reason: `${verdict.reason} (just after another press on this card landed: trying again)` };
      } else if (WORDS_ROUTE.test(req.path)) {
        // the row moved on before his words were written (2026-11-11 05:03Z): they land all the same
        const kept = await landWords(id, req, verdict.reason, ctx, "moved");
        if (kept) {
          verdict = kept.verdict;
          if (kept.out !== undefined) out = kept.out;
          if (verdict.kind === "landed") status = 200;
        }
      }
    } else if (verdict.kind === "refused" && (status === 400 || status === 413 || status === 422) && WORDS_ROUTE.test(req.path)) {
      // the card refused his words as bad input after the press had already answered "saved" (2026-11-15 03:32-03:42Z:
      // two long voice notes, 11 presses, refused at a 4,000 character cap): the press must not end his words there
      const kept = await landWords(id, req, verdict.reason, ctx, "refused");
      if (kept) {
        verdict = kept.verdict;
        if (kept.out !== undefined) out = kept.out;
        if (verdict.kind === "landed") status = 200;
      }
    }
    const p = presses.settle(id, {
      verdict,
      status,
      ms: Date.now() - t0,
      ...(steps ? { steps } : {}),
      ...(verdict.kind === "landed" ? { response: out } : {}),
      retry: true,
    });
    log(`press ${id} (${p.action} ${p.target}): try ${p.attempts} ${p.state === "landed" ? "landed" : p.state === "failed" ? `failed: ${p.reason}` : `not yet (${p.reason}), again at ${p.nextAt}`} in ${Date.now() - t0} ms${steps ? ` (${Object.entries(steps).map(([k, v]) => `${k} ${v}`).join(", ")})` : " (no steps)"}`);
  }

  /**
   * a Changes wanted (or Deny with a reason) refused because the row left review before it was written, or refused as bad input (too long) after the press answered "saved". His words
   * are never dropped: when the row already carries them (an earlier try of this press wrote them and was cut off) the
   * press is that landing; else they go into the row's spine as a Decisions row through Add comment (which also tells the
   * row's Delivery manager), and the press lands as that. Only a card whose row is unknown keeps the refusal (the words
   * stay in the press log, the failure shows on /api/write-health).
   */
  async function landWords(id: string, req: PressRequest, reason: string, ctx: Parameters<typeof runWithAuth>[0], cause: "moved" | "refused" = "moved"): Promise<{ verdict: Verdict; out?: unknown } | undefined> {
    const m = WORDS_ROUTE.exec(req.path);
    if (!m) return undefined;
    const body = json(req.body ?? "");
    const words = String((m[2] === "relaunch" ? body.feedback : body.reason) ?? "").trim();
    const files = Array.isArray(body.attachments) ? (body.attachments as unknown[]).filter((x): x is string => typeof x === "string") : [];
    if (!words && !files.length) return undefined;
    const head = loose(words).slice(0, 30);
    if (head.length >= 12 && loose(reason).includes(head))
      return { verdict: { kind: "landed", note: `the row already carries these words (an earlier try of this press wrote them): ${reason.slice(0, 200)}` } };
    if (!req.card) return { verdict: { kind: "refused", reason: `${reason} (his words are kept in the press log: the card's row was not known when it was pressed)` } };
    const pressedAt = presses.get(id)?.at ?? new Date().toISOString();
    const kind = m[2] === "relaunch" ? "Changes wanted" : "Deny";
    const what = cause === "moved" ? "the row had moved on before it was written" : "the card refused it";
    const text = `[${kind} pressed ${pressedAt.slice(0, 16).replace("T", " ")}Z on the review card; ${what}: ${reason.replace(/^not written: /, "").slice(0, 200)}] ${words}`;
    try {
      const res = await withPress(id, () =>
        runWithAuth(ctx, async () =>
          o.fetch(
            new Request("http://console.local/api/closed-cards/comment", {
              method: "POST",
              headers: { "content-type": "application/json", [REPLAY_HEADER]: id },
              body: JSON.stringify({ kind: "review", ...req.card, text, ...(files.length ? { attachments: files } : {}), via: "text" }),
            }),
          ),
        ),
      );
      const out = (await readJson(res)) as { sha?: string; error?: { message?: string } } | undefined;
      if (res.status >= 200 && res.status < 300)
        return { verdict: { kind: "landed", ...(out?.sha ? { sha: out.sha } : {}), note: `${cause === "moved" ? "the row had moved on" : "the card refused them"} (${reason.slice(0, 160)}): his words were written as a Decisions row of ${req.card.ref}${out?.sha ? ` (${out.sha})` : ""} and its Delivery manager told` }, out };
      const why = out?.error?.message ?? `HTTP ${res.status}`;
      return res.status >= 500 ? { verdict: { kind: "retry", reason: `${reason}; writing his words as a Decisions row failed: ${why}` } } : { verdict: { kind: "refused", reason: `${reason}; his words could not be written as a Decisions row either (${why}); they are kept in the press log` } };
    } catch (e) {
      return { verdict: { kind: "retry", reason: `${reason}; writing his words as a Decisions row failed: ${(e as Error).message}` } };
    }
  }

  const worker: PressWorker = {
    async tick() {
      if (stopped) return 0;
      let n = 0;
      // in press order; a press waits while an earlier press on the same card is being written or still landing. After
      // each write the due list is read again, so the press it held back goes next in this same tick.
      // presses on different cards are written at the same time (up to PRESS_CONCURRENCY), so the spine writer
      // can put the ones in one repo in one commit and push (inbox/groupWrite.ts) and a slow press never holds up another;
      // the owner's presses go before the daily press test's, which never takes more than PRESS_TEST_SLOTS of them.
      const tried = new Set<string>(); // one try per press per tick (a retry waits for the next tick)
      const running = new Set<Promise<void>>();
      for (;;) {
        while (!stopped && inFlight.size < PRESS_CONCURRENCY) {
          const tests = [...inFlight].filter((id) => testPress.has(id)).length;
          const d = byPriority(presses.due()).find(
            (x) =>
              !tried.has(x.id) &&
              !inFlight.has(x.id) &&
              !busyTargets.has(x.target) &&
              !(isTestPress(x.request) && tests >= PRESS_TEST_SLOTS) &&
              !presses.earlierLanding(x.id),
          );
          if (!d) break;
          tried.add(d.id);
          inFlight.add(d.id);
          busyTargets.add(d.target);
          if (isTestPress(d.request)) testPress.add(d.id);
          n++;
          const p: Promise<void> = replay(d.id, d.request, d.tenant)
            .catch((e) => log(`press outbox: ${(e as Error).message}`))
            .finally(() => {
              inFlight.delete(d.id);
              busyTargets.delete(d.target);
              testPress.delete(d.id);
              running.delete(p);
            });
          running.add(p);
        }
        if (!running.size) break;
        // one press ended: the presses it held back (same card, or a free slot) may go now
        await Promise.race(running);
      }
      return n;
    },
    start(everyMs = 5_000) {
      if (timer) return;
      timer = setInterval(() => void worker.tick().catch((e) => log(`press outbox: ${(e as Error).message}`)), everyMs);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    busy() {
      // a commit still pushing counts as a press being written (a deploy waits for it)
      return { inFlight: inFlight.size + (o.pushes?.()?.active() ?? 0), due: presses.due().filter((d) => !inFlight.has(d.id)).length };
    },
    async drain(ms) {
      const until = Date.now() + ms;
      while (inFlight.size > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      // a push waiting for its retry survives the restart (resumePushes); the drain only waits for the others
      await o.pushes?.()?.drain(Math.max(0, until - Date.now()));
      return inFlight.size === 0 && (o.pushes?.()?.active() ?? 0) === 0;
    },
    resume() {
      const n = db.prepare("UPDATE presses SET next_at = ? WHERE state = 'landing' AND request IS NOT NULL AND next_at IS NULL").run(new Date().toISOString()).changes;
      if (n) log(`press outbox: ${n} press(es) cut off by a restart are due again`);
      // an answer press whose job ended while nothing listened (a restart, a repeated press linked late) takes its end now
      let settled = 0;
      try {
        for (const { ref } of db.prepare("SELECT DISTINCT ref FROM presses WHERE state = 'landing' AND ref IS NOT NULL").all() as { ref: string }[]) if (jobEnd(ref)) settled++;
      } catch (e) {
        log(`press log: answer presses not reconciled (${(e as Error).message})`);
      }
      if (settled) log(`press log: the presses of ${settled} ended answer job(s) took their end at start`);
      return n;
    },
  };
  return worker;
}
