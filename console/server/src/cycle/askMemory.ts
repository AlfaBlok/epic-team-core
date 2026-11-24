import { createHash } from "node:crypto";
import type { Hono } from "hono";
import fs from "node:fs";
import type { DB } from "../db.js";
import { inside } from "../adapters/doc.js";
import { resolveContext } from "../inbox/asks.js";
import type { OpenAsk, Run, RunCheck } from "../store.js";
import type { Grant } from "./grants.js";
import { SKIP_PREFIX, checkDue, textHash } from "./skipUnchanged.js";
import { ownerName } from "../identity.js";
import { OWNER_ONLY_RUN, ownerOnlyWords } from "./ownerOnly.js";

/**
 * the Unblocker remembers each ask. The console keeps one row per (milestone, ask code): a fingerprint of what
 * the ask's verdict depends on (the ask line, the active grants, the owner's comments on its card, the files the line links
 * to), the run that assessed it and its verdict. An ask is assessed once when it appears and again only when that
 * fingerprint changes (or its last verdict was not `left` and it is still open). Unchanged asks are carried, shown as
 * `left (unchanged since <run>)`; an Unblocker cadence wake with no new or changed ask is skipped.
 *
 * Read by..S27 (new ask wakes the Unblocker, confidence rubric, numbers): `readAskMemory`, `classifyAsks`,
 * `GET /api/ask-memory?milestoneId=`.
 */
export const ASK_PARTS = ["text", "grants", "comment", "evidence"] as const;
export type AskPart = (typeof ASK_PARTS)[number];
export type AskParts = Record<AskPart, string>;

const PART_WORDS: Record<AskPart, string> = {
  text: "ask text",
  grants: "grants",
  comment: `${ownerName()}'s comment`,
  evidence: "linked evidence",
};

/** One remembered verdict. `parts` lets a later wake say what changed. */
export interface AskMemory {
  milestoneId: string;
  code: string;
  print: string;
  parts: AskParts;
  runId: string;
  verdict: RunCheck["decision"];
  why?: string;
  /** The check as the assessing run reported it (why, searched, answer, confidence, source…). */
  check: RunCheck;
  assessedAt: string;
}

/** Hash of the active grants (any grant change re-opens every ask: a grant may settle any of them). */
export function grantsHash(grants: Grant[]): string {
  return textHash(
    grants
      .map((x) => [x.code, x.scope, x.limits ?? "", x.expires ?? "", x.source].join("|"))
      .sort()
      .join("\n"),
  );
}

export const askParts = (a: OpenAsk, grantsH: string): AskParts => ({
  text: a.textHash ?? "",
  grants: grantsH,
  comment: a.commentHash ?? "",
  evidence: a.evidenceHash ?? "",
});

export const askPrint = (parts: AskParts) =>
  createHash("sha256").update(JSON.stringify(ASK_PARTS.map((k) => parts[k]))).digest("hex").slice(0, 16);

/** The open asks with their per-ask fingerprint (stored on the wake's run as `openAsks`). */
export const withPrints = (asks: OpenAsk[], grants: Grant[]): OpenAsk[] => {
  const g = grantsHash(grants);
  return asks.map((a) => {
    const parts = askParts(a, g);
    return { ...a, print: askPrint(parts), parts };
  });
};

// ---------- what feeds the fingerprint: the owner's comments, linked evidence ----------

/**
 * the owner's comments on an ask's card: messages sent with it as reference and answers saved for it that have not
 * closed the line yet (jordi_responses). Hash of their ids and texts; "" when none.
 */
export function commentHash(db: DB, itemId: string): string {
  const rows = [
    ...(db.prepare("SELECT id, text FROM messages WHERE ref_item_id = ? ORDER BY created_at, id").all(itemId) as { id: string; text: string }[]),
    ...(db.prepare("SELECT id, kind || ':' || text AS text FROM jordi_responses WHERE item_id = ? ORDER BY created_at, id").all(itemId) as { id: string; text: string }[]),
  ];
  return rows.length ? textHash(rows.map((r) => `${r.id}\u0000${r.text}`).join("\n")) : "";
}

const MD_TARGET = /\]\(([^)\s]+)\)/g;
const FIELD_TARGET = /\b(?:context|details|evidence|steps):\s*([^\s—|)]+)/gi;

/** Repo-relative files an ask line links to (markdown links, bare `context:` / `details:` / `evidence:` / `steps:` paths); URLs left out. */
export function evidencePaths(line: string, specRel: string, repoDir?: string): string[] {
  const out = new Set<string>();
  const add = (t: string) => {
    if (!t || /^[a-z][a-z0-9+.-]*:/i.test(t) || !/[/.]/.test(t)) return;
    const rel = resolveContext(t, specRel, repoDir).split("#")[0];
    if (rel && rel !== specRel) out.add(rel);
  };
  for (const m of line.matchAll(MD_TARGET)) add(m[1]);
  for (const m of line.matchAll(FIELD_TARGET)) add(m[1].replace(/[.,;:]+$/, ""));
  return [...out].sort();
}

/** Hash of the linked files' text (a missing file counts as such); "" when the line links nothing local. */
export function evidenceHash(line: string, specRel: string, repoDir?: string): string {
  const paths = evidencePaths(line, specRel, repoDir);
  if (!paths.length) return "";
  const h = createHash("sha256");
  for (const p of paths) {
    let text = "\u0001missing";
    try {
      const abs = repoDir ? inside(repoDir, p) : undefined;
      if (abs) text = fs.readFileSync(abs, "utf8");
    } catch {
      /* missing */
    }
    h.update(`${p}\0${text}\0`);
  }
  return h.digest("hex").slice(0, 16);
}

// ---------- the memory table ----------

const ensured = new WeakSet<object>();
/** Created on first use (not a numbered migration, so parallel branches never collide on the migration index). */
export function ensureAskMemory(db: DB): void {
  if (ensured.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ask_memory (
      milestone_id TEXT NOT NULL,
      code TEXT NOT NULL,
      print TEXT NOT NULL,
      parts TEXT NOT NULL,
      run_id TEXT NOT NULL,
      verdict TEXT NOT NULL,
      why TEXT,
      check_json TEXT NOT NULL DEFAULT '{}',
      assessed_at TEXT NOT NULL,
      PRIMARY KEY (milestone_id, code)
    );
  `);
  ensured.add(db);
}

const bareCode = (c: string) => c.trim().replace(/^.*\//, "").toUpperCase();

type Row = { milestone_id: string; code: string; print: string; parts: string; run_id: string; verdict: string; why: string | null; check_json: string; assessed_at: string };
const toMemory = (r: Row): AskMemory => ({
  milestoneId: r.milestone_id,
  code: r.code,
  print: r.print,
  parts: JSON.parse(r.parts) as AskParts,
  runId: r.run_id,
  verdict: r.verdict as RunCheck["decision"],
  ...(r.why ? { why: r.why } : {}),
  check: JSON.parse(r.check_json) as RunCheck,
  assessedAt: r.assessed_at,
});

/** Every remembered ask (one milestone, or all), newest assessment first. */
export function readAskMemory(db: DB, milestoneId?: string): AskMemory[] {
  ensureAskMemory(db);
  const rows = db
    .prepare("SELECT * FROM ask_memory WHERE (? IS NULL OR milestone_id = ?) ORDER BY assessed_at DESC, code")
    .all(milestoneId ?? null, milestoneId ?? null) as Row[];
  return rows.map(toMemory);
}

/**
 * A finished Unblocker run: remember each ask it assessed (its own checks, not carried or skipped ones) under the
 * fingerprint the ask had when the wake prompt was built. Failed runs remember nothing. Returns the codes stored.
 */
export function rememberChecks(db: DB, run: Run, milestoneId: string, at = new Date().toISOString()): string[] {
  if (!run.openAsks?.length || !run.checks?.length || run.outcome === "failed" || run.outcome === "running") return [];
  ensureAskMemory(db);
  const asks = new Map(run.openAsks.filter((a) => a.print && a.parts).map((a) => [bareCode(a.code), a]));
  const put = db.prepare(
    `INSERT INTO ask_memory (milestone_id, code, print, parts, run_id, verdict, why, check_json, assessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (milestone_id, code) DO UPDATE SET print = excluded.print, parts = excluded.parts, run_id = excluded.run_id,
       verdict = excluded.verdict, why = excluded.why, check_json = excluded.check_json, assessed_at = excluded.assessed_at`,
  );
  const stored: string[] = [];
  for (const c of run.checks) {
    if (c.carriedFrom || c.skipped) continue;
    const a = asks.get(bareCode(c.code));
    if (!a) continue;
    put.run(milestoneId, bareCode(a.code), a.print!, JSON.stringify(a.parts), run.id, c.decision, c.why ?? null, JSON.stringify(c), at);
    stored.push(bareCode(a.code));
  }
  return stored;
}

/**
 * the memory is a memo of the run log, never a source. Rebuilt from the Unblocker runs' stored
 * `openAsks` and `checks` (oldest first, so the newest assessment of an ask wins), it equals what the finishing PATCHes
 * stored. Whether an ask is open or answered is read from its spine line, never from here. Returns the rows written.
 */
export function rebuildAskMemory(db: DB, runs: Run[], milestoneOf: (r: Run) => string | undefined): number {
  ensured.delete(db); // the table may have been dropped (that is the point): create it again
  ensureAskMemory(db);
  db.transaction(() => {
    db.exec("DELETE FROM ask_memory");
    for (const r of [...runs].sort((a, b) => (a.endedAt ?? a.startedAt).localeCompare(b.endedAt ?? b.startedAt))) {
      const m = r.milestoneId ?? milestoneOf(r);
      if (m) rememberChecks(db, r, m, r.endedAt ?? r.startedAt);
    }
  })();
  return (db.prepare("SELECT COUNT(*) AS n FROM ask_memory").get() as { n: number }).n;
}

// ---------- new / changed / unchanged ----------

export interface AskStatus {
  code: string;
  status: "new" | "changed" | "unchanged";
  /** changed: the parts that differ (empty when the last verdict was not `left` and the ask is still open). */
  changed?: AskPart[];
  memory?: AskMemory;
}

/** the memory an owner-only ask is carried with (never assessed by a run). */
export function ownerOnlyMemory(a: OpenAsk, grants: Grant[], milestoneId = ""): AskMemory {
  const parts = askParts(a, grantsHash(grants));
  const why = a.ownerOnly!.why;
  return {
    milestoneId,
    code: bareCode(a.code),
    print: askPrint(parts),
    parts,
    runId: OWNER_ONLY_RUN,
    verdict: "left",
    why,
    check: { code: a.code, decision: "left", why, floor: [a.ownerOnly!.floor] } as RunCheck,
    assessedAt: a.since ?? "",
  };
}

/** Parts whose change alone never re-opens an ask left on the hard floor (its wording or linked files; a grant or his comment does). */
const FLOOR_QUIET: AskPart[] = ["text", "evidence"];

/**
 * Each open ask against the memory. Unchanged = same fingerprint and last verdict `left`. An ask only the
 * owner can do (`ownerOnly`) is always unchanged (carried as left with its floor), and an ask already left on the hard
 * floor stays unchanged when only its wording or linked files changed.
 */
export function classifyAsks(asks: OpenAsk[], grants: Grant[], memory: AskMemory[]): AskStatus[] {
  const g = grantsHash(grants);
  const byCode = new Map(memory.map((m) => [bareCode(m.code), m]));
  return asks.map((a) => {
    const mem = byCode.get(bareCode(a.code));
    if (a.ownerOnly) return { code: a.code, status: "unchanged", memory: mem?.verdict === "left" ? mem : ownerOnlyMemory(a, grants, mem?.milestoneId) };
    if (!mem) return { code: a.code, status: "new" };
    const parts = askParts(a, g);
    if (askPrint(parts) === mem.print && mem.verdict === "left") return { code: a.code, status: "unchanged", memory: mem };
    const changed = ASK_PARTS.filter((k) => mem.parts[k] !== parts[k]);
    const onFloor = mem.verdict === "left" && (mem.check?.floor?.length ?? 0) > 0;
    if (onFloor && changed.length && changed.every((k) => FLOOR_QUIET.includes(k))) return { code: a.code, status: "unchanged", memory: mem };
    return { code: a.code, status: "changed", changed, memory: mem };
  });
}

/** " new; changed (ask text, grants)". */
export function statusWords(s: AskStatus[]): string {
  return s
    .filter((x) => x.status !== "unchanged")
    .map((x) =>
      x.status === "new"
        ? `${x.code} new`
        : `${x.code} changed (${x.changed?.length ? x.changed.map((k) => PART_WORDS[k]).join(", ") : `last verdict ${x.memory?.verdict}, still open`})`,
    )
    .join("; ");
}

/** The check a carried ask gets: its remembered `left`, shown as `left (unchanged since <run>)`. */
export const carriedCheck = (m: AskMemory, spine?: string): RunCheck => {
  const { skipped: _s, carriedFrom: _c, ...was } = m.check ?? { code: m.code, decision: "left" };
  return { ...was, code: was.code ?? m.code, decision: "left", why: m.why ?? was.why ?? "no reason given", carriedFrom: m.runId, ...(spine ? { spine } : {}) };
};

/** How Activity and summaries name a carried verdict. */
export const carriedLabel = (runId: string) => (runId === OWNER_ONLY_RUN ? `left (${ownerOnlyWords()})` : `left (unchanged since ${runId})`);

const spineOf = (a?: OpenAsk) => (a?.path ? `${a.path}${a.line ? `:${a.line}` : ""}` : undefined);

/** Annotate the wake's open asks: unchanged ones get `carriedFrom` (the run that assessed them). */
export function markCarried(asks: OpenAsk[], statuses: AskStatus[]): OpenAsk[] {
  const byCode = new Map(statuses.map((s) => [bareCode(s.code), s]));
  return asks.map((a) => {
    const s = byCode.get(bareCode(a.code));
    return s?.status === "unchanged" && s.memory ? { ...a, carriedFrom: s.memory.runId } : a;
  });
}

/**
 * The finishing PATCH's checks plus a carried `left` for every open ask the agent did not report and that was carried at
 * wake time (the agent may still re-assess a carried ask: its own entry wins).
 */
export function withCarriedChecks(openAsks: OpenAsk[], checks: RunCheck[] | null | undefined, memory: AskMemory[]): RunCheck[] {
  const own = checks ?? [];
  const seen = new Set(own.map((c) => bareCode(c.code)));
  const mem = new Map(memory.map((m) => [bareCode(m.code), m]));
  const carried: RunCheck[] = [];
  for (const a of openAsks) {
    if (!a.carriedFrom || seen.has(bareCode(a.code))) continue;
    const m = mem.get(bareCode(a.code)) ?? (a.ownerOnly ? ownerOnlyMemory(a, []) : undefined);
    carried.push(m ? carriedCheck(m, spineOf(a)) : { code: a.code, decision: "left", why: "no reason given", carriedFrom: a.carriedFrom, ...(spineOf(a) ? { spine: spineOf(a) } : {}) });
  }
  return [...own, ...carried];
}

const counted = (r: Run) => !r.parentRunId && r.kind !== "answer_run" && !!r.askFingerprint;
const isSkip = (r: Run) => r.summary.startsWith(SKIP_PREFIX);

/**
 * Unblocker cadence skip (replaces's all-asks rule): skip when no open ask is new or changed and the
 * last real wake finished (not running, failed or unreported, no check due). The cap of 12 skips no longer
 * forces a re-check of unchanged asks: only a new or changed ask wakes the Unblocker. `runs` newest first.
 */
export function memorySkipDecision(
  runs: Run[],
  asks: OpenAsk[],
  statuses: AskStatus[],
  now = Date.now(),
): { skip: false; why: string } | { skip: true; sourceRunId: string; checks: RunCheck[]; summary: string } {
  const fp = runs.filter(counted);
  const newest = fp[0];
  if (!newest) return { skip: false, why: "first wake (no earlier wake to compare)" };
  if (newest.outcome === "running") return { skip: false, why: "a wake is still running" };
  const last = fp.find((r) => !isSkip(r));
  if (!last) return { skip: false, why: "no earlier real wake" };
  if (last.outcome === "failed" || last.outcome === "blank_report") return { skip: false, why: `last wake ended ${last.outcome}` };
  if (checkDue(last, now)) return { skip: false, why: "its next check is due" };
  const fresh = statusWords(statuses);
  if (fresh) return { skip: false, why: `new or changed asks: ${fresh}` };
  const byCode = new Map(asks.map((a) => [bareCode(a.code), a]));
  const checks = statuses.map((s) => ({ ...carriedCheck(s.memory!, spineOf(byCode.get(bareCode(s.code)))), skipped: true }));
  const note = checks.length ? checks.map((c) => `${c.code} ${carriedLabel(c.carriedFrom!)}`).join("; ") : "no open asks";
  return { skip: true, sourceRunId: last.id, checks, summary: `${SKIP_PREFIX} ${last.id} (${note})` };
}

/** GET /api/ask-memory[?milestoneId=]: every remembered ask (code, fingerprint parts, run, verdict, when). */
export function mountAskMemory(api: Hono, db: DB): void {
  api.get("/ask-memory", (c) => c.json(readAskMemory(db, c.req.query("milestoneId") || undefined)));
}
