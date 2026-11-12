import fs from "node:fs";
import path from "node:path";
import type { Context, Hono } from "hono";
import { inside } from "./adapters/doc.js";
import { proseLines } from "./adapters/markdown.js";
import type { SpinesJson } from "./adapters/spines.js";
import type { Cycle } from "./cycle/service.js";
import { CycleError } from "./cycle/service.js";
import { oneLine, type SpineWrite, type SpineWriter } from "./inbox/spineWrite.js";
import { isDm, ownerFor } from "./inbox/waiting.js";
import type { Milestone, Store } from "./store.js";
import { ownerName } from "./identity.js";

/**
 * the milestone's standing approvals in the console (epicspine-skill docs/doctrine/standing-approvals.md).
 * Read: `spines.py --json` node `grants` (own first, then inherited, with source spine, state and `uses`), plus the
 * Decisions rows that cite each code (`under <code>`) so the tab can link every use. Write: add / edit / revoke one
 * grant line under `## Standing approvals` plus a Decisions row, through the inbox spine writer (same guards, same
 * per-checkout lock, commit + push on main); then the milestone's Delivery Manager is woken when switched on.
 */

export type GrantState = "active" | "expired" | "revoked";

export interface GrantUse {
  path: string;
  /** 1-based line of the Decisions row. */
  line: number;
  date?: string;
  text: string;
}

export interface ApprovalGrant {
  code: string;
  who?: string | null;
  scope: string;
  limits?: string | null;
  expires?: string | null;
  context?: string | null;
  since?: string | null;
  state: GrantState;
  revoked?: string | null;
  why?: string | null;
  source: string;
  inherited: boolean;
  uses: number;
  useRows: GrantUse[];
}

export interface ApprovalsView {
  /** The milestone spine (repo-relative): where Add writes. */
  path?: string;
  grants: ApprovalGrant[];
  /** The code Add would take now (a hint; the server takes the next free one at write time). */
  nextCode?: string;
  /** Why the list is empty or partial (spines.py missing / slow, no spine path). */
  note?: string;
}

// ---------- reading ----------

const GRANT_ID = String.raw`[A-Za-z0-9][A-Za-z0-9-]*-G\d+`;
// Mirrors epicspine-skill scripts/grants.py UNDER: `under`, `under`, `under`.
const UNDER = new RegExp(String.raw`\bunder\s+(${GRANT_ID}(?:(?:\s*[,+&]\s*|\s+and\s+)${GRANT_ID})*)`, "g");
const DATE = /\d{4}-\d\d-\d\d/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/** Line range [head, end) of the first section whose heading matches (end = next heading of the same or higher level). */
export function sectionRange(text: string, title: RegExp): { head: number; end: number; level: number } | undefined {
  const lines = proseLines(text);
  const head = lines.findIndex((l) => {
    const h = HEADING.exec(l);
    return !!h && title.test(h[2].replace(/[*_`]/g, "").trim());
  });
  if (head < 0) return undefined;
  const level = HEADING.exec(lines[head])![1].length;
  let end = lines.length;
  for (let i = head + 1; i < lines.length; i++) {
    const h = HEADING.exec(lines[i]);
    if (h && h[1].length <= level) {
      end = i;
      break;
    }
  }
  return { head, end, level };
}

const DECISIONS = /^decisions\b/i;
const APPROVALS = /^standing approvals\b/i;

/** Decisions rows of one spine that cite grant codes as `under <code>` (a row counts once per code). */
export function citedRows(text: string, rel: string): { code: string; use: GrantUse }[] {
  const r = sectionRange(text, DECISIONS);
  if (!r) return [];
  const lines = proseLines(text);
  const out: { code: string; use: GrantUse }[] = [];
  for (let i = r.head + 1; i < r.end; i++) {
    const line = lines[i];
    const codes = new Set([...line.matchAll(UNDER)].flatMap((m) => m[1].match(new RegExp(GRANT_ID, "g")) ?? []));
    if (!codes.size) continue;
    const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
    const date = DATE.exec(line)?.[0];
    const text = (cells.find((c) => /\bunder\s/.test(c)) ?? cells.slice(0, 3).join(" · ")).slice(0, 240);
    for (const code of codes) out.push({ code, use: { path: rel, line: i + 1, ...(date ? { date } : {}), text } });
  }
  return out;
}

const str = (v: unknown) => (typeof v === "string" ? v : null);

/** Every grant of the node at `rel` (all states), own then inherited, with the Decisions rows citing it. */
export function approvalsFor(spines: SpinesJson, rel: string, repoDir: string): ApprovalsView {
  const node = spines.nodes.find((n) => n.path === rel);
  if (!node) return { path: rel, grants: [], note: "the spine is not in the spines.py tree" };
  const raw = (node as { grants?: unknown }).grants;
  if (!Array.isArray(raw)) return { path: rel, grants: [], note: "spines.py does not report grants (EpicSpine older than 2026.10.24.1)" };
  // Uses over every spine of the tree (as spines.py counts them).
  const rows = new Map<string, GrantUse[]>();
  for (const n of spines.nodes) {
    const abs = inside(repoDir, n.path);
    let text = "";
    try {
      text = abs ? fs.readFileSync(abs, "utf8") : "";
    } catch {
      continue;
    }
    for (const { code, use } of citedRows(text, n.path)) rows.set(code, [...(rows.get(code) ?? []), use]);
  }
  const grants = raw
    .filter((g): g is Record<string, unknown> => !!g && typeof g === "object" && typeof (g as { code?: unknown }).code === "string")
    .map((g): ApprovalGrant => {
      const code = g.code as string;
      const useRows = rows.get(code) ?? [];
      const state: GrantState = g.state === "revoked" || g.state === "expired" ? g.state : "active";
      return {
        code,
        who: str(g.who),
        scope: str(g.scope) ?? "",
        limits: str(g.limits),
        expires: str(g.expires),
        context: str(g.context),
        since: str(g.since),
        state,
        revoked: str(g.revoked),
        why: str(g.why),
        source: str(g.source) ?? rel,
        inherited: g.inherited === true,
        uses: typeof g.uses === "number" ? g.uses : useRows.length,
        useRows,
      };
    });
  return { path: rel, grants };
}

// ---------- writing (pure text edits) ----------

/** One field value: one line, no ` — ` separators (the grant parser splits fields on them). */
const clean = (s: string) => oneLine(s).replace(/\s*[–—]\s*$/, "");
/** A Decisions cell: one line, no pipes. */
const cell = (s: string) => oneLine(s).replace(/\|/g, "/");

/** The grant code prefix of a spine: its own grant codes, else its ask codes, else the node id (`` → `E8`). */
export function grantPrefix(text: string, id?: string): string {
  const r = sectionRange(text, APPROVALS);
  const lines = text.split("\n");
  if (r)
    for (let i = r.head + 1; i < r.end; i++) {
      const m = /\[(?:grant|revoked)\s+([A-Za-z0-9][A-Za-z0-9-]*)-G\d+\b/i.exec(lines[i]);
      if (m) return m[1];
    }
  const ask = /\[(?:ask|answered|superseded)\s+([A-Za-z0-9][A-Za-z0-9-]*)-A\d+\b/i.exec(text);
  if (ask) return ask[1];
  const e = id ? /^EPIC-(\d+)$/i.exec(id.trim()) : null;
  if (e) return `E${e[1]}`;
  const safe = id?.trim().replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "G";
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Next free `<prefix>-G<n>`: highest n seen anywhere in the spine or among `taken` codes, plus 1 (codes are never reused). */
export function nextGrantCode(text: string, prefix: string, taken: string[] = []): string {
  const re = new RegExp(`(?<![A-Za-z0-9-])${escRe(prefix)}-G(\\d+)(?![0-9])`, "g");
  const ns = [...text.matchAll(re), ...taken.flatMap((c) => [...c.matchAll(re)])].map((m) => Number(m[1]));
  return `${prefix}-G${Math.max(0, ...ns) + 1}`;
}

export interface GrantInput {
  scope: string;
  limits?: string;
  expires?: string;
  context?: string;
}

export function grantLine(code: string, date: string, g: GrantInput, who = ownerName()): string {
  return (
    `- [grant ${code} @${who} since ${date}] ${clean(g.scope)}` +
    (g.limits?.trim() ? ` — limits: ${clean(g.limits)}` : "") +
    ` — expires: ${g.expires?.trim() ? clean(g.expires) : "never"}` +
    (g.context?.trim() ? ` — context: ${clean(g.context)}` : "")
  );
}

/** The grant (or revoked) line of `code` under `## Standing approvals`: index and parsed parts; undefined when absent. */
export function findGrantLine(text: string, code: string) {
  const r = sectionRange(text, APPROVALS);
  if (!r) return undefined;
  const lines = text.split("\n");
  const re = new RegExp(`^(\\s*[-*]\\s+)\\[(grant|revoked)\\s+${escRe(code)}(?![0-9A-Za-z-])([^\\]]*)\\]\\s*(.*?)\\s*$`, "i");
  for (let i = r.head + 1; i < r.end; i++) {
    const cr = lines[i].endsWith("\r") ? "\r" : "";
    const m = re.exec(cr ? lines[i].slice(0, -1) : lines[i]);
    if (!m) continue;
    const [scope, ...parts] = m[4].split(/\s+[—–]\s+/);
    const fields: Record<string, string> = {};
    let last = "";
    let s = scope;
    for (const p of parts) {
      const f = /^(limits|expires|context|why):\s*(.*)$/is.exec(p.trim());
      if (f) fields[(last = f[1].toLowerCase())] = f[2].trim();
      else if (last) fields[last] += " — " + p;
      else s += " — " + p;
    }
    const tag = m[3].trim();
    const who = /@(\S+)/.exec(tag)?.[1];
    const since = /since\s+(\d{4}-\d\d-\d\d)/.exec(tag)?.[1];
    return { index: i, cr, bullet: m[1], kind: m[2].toLowerCase() as "grant" | "revoked", who, since, scope: s.trim(), fields };
  }
  return undefined;
}

/** Insert `line` as the last bullet of `## Standing approvals`, creating the section (after Waiting on / Current State) when absent. */
export function insertGrant(text: string, line: string): string {
  const cr = text.includes("\r\n") ? "\r" : "";
  const raw = text.split("\n");
  const r = sectionRange(text, APPROVALS);
  if (r) {
    let at = r.end;
    while (at > r.head + 1 && raw[at - 1].trim() === "") at--;
    const add = at === r.head + 1 ? [cr, line + cr] : [line + cr];
    raw.splice(at, 0, ...add);
    return raw.join("\n");
  }
  // New section: after `## Waiting on`, else after `## Current State`, else before `## Decisions`, else at the end.
  const after = sectionRange(text, /^waiting on\b/i) ?? sectionRange(text, /^current state\b/i);
  const before = sectionRange(text, DECISIONS);
  let at = after ? after.end : before ? before.head : raw.length;
  while (at > 0 && raw[at - 1].trim() === "") at--;
  const block = [cr, `## Standing approvals${cr}`, cr, line + cr];
  if (at < raw.length && raw[at].trim() !== "") block.push(cr);
  raw.splice(at, 0, ...block);
  return raw.join("\n");
}

/** Append a row to the `## Decisions` table (columns by header name), creating the section/table when absent. */
export function appendDecision(text: string, d: { date: string; decision: string; summary: string; evidence?: string }): string {
  const cr = text.includes("\r\n") ? "\r" : "";
  const raw = text.split("\n");
  const value = (h: string) =>
    /date/i.test(h) ? d.date
    : /outcome/i.test(h) ? "accepted"
    : /decision|attempt/i.test(h) ? cell(d.decision)
    : /summary/i.test(h) ? cell(d.summary)
    : /evidence/i.test(h) ? cell(d.evidence ?? "console commit")
    : /revisit/i.test(h) ? "—"
    : "";
  const r = sectionRange(text, DECISIONS);
  if (r) {
    const lines = proseLines(text);
    let header = -1;
    let lastRow = -1;
    for (let i = r.head + 1; i < r.end; i++) {
      if (!/^\s*\|/.test(lines[i])) continue;
      if (header < 0) header = i;
      lastRow = i;
    }
    if (header >= 0) {
      const heads = lines[header].trim().replace(/^\||\|$/g, "").split("|").map((h) => h.trim());
      raw.splice(lastRow + 1, 0, `| ${heads.map(value).join(" | ")} |${cr}`);
      return raw.join("\n");
    }
  }
  const heads = ["Date", "Outcome", "Decision / Attempt", "Durable Summary", "Evidence", "Revisit When"];
  const table = [`| ${heads.join(" | ")} |${cr}`, `|${heads.map(() => "---").join("|")}|${cr}`, `| ${heads.map(value).join(" | ")} |${cr}`];
  if (r) {
    let at = r.end;
    while (at > r.head + 1 && raw[at - 1].trim() === "") at--;
    raw.splice(at, 0, cr, ...table);
    return raw.join("\n");
  }
  while (raw.length && raw[raw.length - 1].trim() === "") raw.pop();
  raw.push(cr, `## Decisions${cr}`, cr, ...table, "");
  return raw.join("\n");
}

export type GrantEdit = { text: string; code: string; line: string } | { skip: string };

export function addGrant(text: string, o: { prefix: string; taken?: string[]; date: string; grant: GrantInput }): GrantEdit {
  const code = nextGrantCode(text, o.prefix, o.taken);
  const line = grantLine(code, o.date, o.grant);
  const next = appendDecision(insertGrant(text, line), {
    date: o.date,
    decision: `${ownerName()} via console: grant ${code} added`,
    summary: clean(o.grant.scope),
  });
  return { text: next, code, line };
}

/** Rewrite one grant's text, keeping its code, who and since; `(edited <date>)` closes the scope. */
export function editGrant(text: string, code: string, g: GrantInput, date: string): GrantEdit {
  const f = findGrantLine(text, code);
  if (!f) return { skip: `grant ${code} is not under ## Standing approvals any more` };
  if (f.kind === "revoked") return { skip: `grant ${code} is revoked: add a new grant instead` };
  const raw = text.split("\n");
  const scope = `${clean(g.scope).replace(/\s*\(edited \d{4}-\d\d-\d\d\)$/, "")} (edited ${date})`;
  const context = g.context !== undefined ? g.context : f.fields.context;
  const line =
    `${f.bullet}[grant ${code} @${f.who ?? ownerName()} since ${f.since ?? date}] ${scope}` +
    (g.limits?.trim() ? ` — limits: ${clean(g.limits)}` : "") +
    ` — expires: ${g.expires?.trim() ? clean(g.expires) : "never"}` +
    (context?.trim() ? ` — context: ${clean(context)}` : "");
  raw[f.index] = line + f.cr;
  const next = appendDecision(raw.join("\n"), { date, decision: `${ownerName()} via console: grant ${code} edited`, summary: scope });
  return { text: next, code, line };
}

/** Doctrine revoke: `- [revoked <code> <date> @<who>] <scope> — why: <reason>`, plus a Decisions row. */
export function revokeGrant(text: string, code: string, why: string, date: string, who = ownerName()): GrantEdit {
  const f = findGrantLine(text, code);
  if (!f) return { skip: `grant ${code} is not under ## Standing approvals any more` };
  if (f.kind === "revoked") return { skip: `grant ${code} is revoked already` };
  const raw = text.split("\n");
  const reason = clean(why) || `revoked by ${ownerName()}`;
  const line = `${f.bullet}[revoked ${code} ${date} @${who}] ${f.scope} — why: ${reason}`;
  raw[f.index] = line + f.cr;
  const next = appendDecision(raw.join("\n"), { date, decision: `${ownerName()} via console: grant ${code} revoked`, summary: reason });
  return { text: next, code, line };
}

// ---------- input ----------

const EXPIRES = /^(never|\d{4}-\d\d-\d\d)$/;

export function grantIn(raw: unknown, needScope = true): GrantInput | string {
  if (!raw || typeof raw !== "object") return "body must be an object";
  const b = raw as Record<string, unknown>;
  const s = (k: string) => (typeof b[k] === "string" ? (b[k] as string).trim() : b[k] === undefined || b[k] === null ? "" : undefined);
  const scope = s("scope");
  const limits = s("limits");
  const expires = s("expires");
  const context = s("context");
  if (scope === undefined || limits === undefined || expires === undefined || context === undefined) return "scope, limits, expires and context must be strings";
  if (needScope && !scope) return "say what the approval covers (scope)";
  if (scope.length > 600 || limits.length > 400 || context.length > 300) return "keep it short: scope ≤ 600, limits ≤ 400, context ≤ 300 characters";
  if (expires && !EXPIRES.test(expires)) return "expires must be YYYY-MM-DD or never (or empty)";
  if (expires && expires !== "never" && expires < new Date().toISOString().slice(0, 10)) return "expires is in the past";
  return { scope, ...(limits ? { limits } : {}), ...(expires ? { expires } : {}), ...(context ? { context } : {}) };
}

// ---------- routes ----------

export interface ApprovalsOptions {
  store: Store;
  cycle: Cycle;
  spine: SpineWriter;
  /** The milestone's checkout, spine path and spines.py view (softMs: how long to wait for a fresh run). */
  spinesFor: (m: Milestone, softMs?: number) => Promise<{ repoDir?: string; rel?: string; spines?: SpinesJson }>;
  /** Drop the spines.py cache of a checkout after a write. */
  invalidate: (repoDir: string) => void;
  homeThread?: (assignmentId: string) => string | undefined;
}

/**
 * step 5: wake the milestone's Delivery Manager (else its owner) when switched on, so it acts on a change the owner
 * made from the console. A ready Add wakes it the same way. undefined = nobody on (or paused).
 */
export async function wakeDeliveryManager(
  o: { store: Store; cycle: Pick<Cycle, "runNow">; homeThread?: (assignmentId: string) => string | undefined },
  m: Milestone,
  instructions: string,
): Promise<{ runId: string } | { error: string; failedRun?: string } | undefined> {
  const personas = new Map(o.store.listPersonas().map((p) => [p.id, p]));
  const all = o.store.listAssignments({ milestoneId: m.id });
  const dm = all.find((a) => a.enabled && isDm(personas.get(a.personaId)?.name));
  const owner = ownerFor(o.store, m.id, o.homeThread);
  const a = dm ?? (owner.assignmentId ? o.store.getAssignment(owner.assignmentId) : undefined);
  if (!a?.enabled || m.paused) return undefined;
  try {
    const run = await o.cycle.runNow(a.id, { instructions, instructionsBy: ownerName() });
    return { runId: run.id };
  } catch (e) {
    // Already running, cycle off or T3 down: the spine line is the hand-off anyway.
    // the failed run (when one was made) goes with the error, so a caller that retries can point at it.
    const failedRun = e instanceof CycleError ? (e.details as { runId?: string } | undefined)?.runId : undefined;
    return { error: e instanceof CycleError ? e.message : (e as Error).message, ...(failedRun ? { failedRun } : {}) };
  }
}

export function mountApprovals(api: Hono, o: ApprovalsOptions) {
  const err = (c: Context, status: 400 | 404 | 409 | 502 | 503, code: string, message: string) => c.json({ error: { code, message } }, status);

  const view = async (m: Milestone, softMs?: number): Promise<ApprovalsView> => {
    const { repoDir, rel, spines } = await o.spinesFor(m, softMs);
    if (!repoDir || !rel) return { grants: [], note: "the milestone has no spine in a checkout the console reads" };
    if (!spines) return { path: rel, grants: [], note: "spines.py is not available or slow: grants unknown right now" };
    const v = approvalsFor(spines, rel, repoDir);
    const node = spines.nodes.find((n) => n.path === rel);
    let text = "";
    try {
      text = fs.readFileSync(path.join(repoDir, rel), "utf8");
    } catch {
      /* no hint */
    }
    return { ...v, nextCode: nextGrantCode(text, grantPrefix(text, node?.id), v.grants.map((g) => g.code)) };
  };

  const wake = (m: Milestone, what: string) => wakeDeliveryManager(o, m, `${what} Act on the standing approvals as they stand now.`);

  const milestone = (c: Context) => o.store.getMilestone(c.req.param("id")!);
  const json = async (c: Context): Promise<unknown> => {
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  };

  /** Run one edit through the spine writer, then answer with the fresh view and the wake. */
  const write = async (c: Context, m: Milestone, file: string, label: string, edit: (text: string, date: string) => GrantEdit, msg: (code: string) => { msg: string; body: string }, what: (code: string) => string) => {
    const { repoDir } = await o.spinesFor(m, 1_500);
    if (!repoDir) return err(c, 409, "conflict", "no checkout of the milestone's repo under the console's repos root: nothing written");
    let done: { code: string; line: string } | undefined;
    const w: SpineWrite = await o.spine.edit({
      repoDir,
      path: file,
      label,
      edit: (text, date) => {
        const e = edit(text, date);
        if ("skip" in e) return e;
        done = { code: e.code, line: e.line };
        return { text: e.text, ...msg(e.code) };
      },
    });
    if (w.status !== "written" || !done)
      return err(c, w.status === "failed" ? 502 : 409, w.status === "failed" ? "git_failed" : "conflict", `nothing written: ${w.reason ?? w.status}`);
    o.invalidate(repoDir);
    const waking = await wake(m, what(done.code));
    return c.json({ code: done.code, line: done.line, sha: w.sha, path: file, view: await view(m, 30_000), ...(waking ? { wake: waking } : {}) }, 201);
  };

  api.get("/milestones/:id/approvals", async (c) => {
    const m = milestone(c);
    if (!m) return err(c, 404, "not_found", `milestone ${c.req.param("id")} not found`);
    return c.json(await view(m));
  });

  // Add: next free code, written under the milestone spine's ## Standing approvals.
  api.post("/milestones/:id/approvals", async (c) => {
    const m = milestone(c);
    if (!m) return err(c, 404, "not_found", `milestone ${c.req.param("id")} not found`);
    const g = grantIn(await json(c));
    if (typeof g === "string") return err(c, 400, "validation_error", g);
    const { rel, spines } = await o.spinesFor(m, 1_500);
    if (!rel) return err(c, 409, "conflict", "the milestone has no spine file: nothing written");
    const node = spines?.nodes.find((n) => n.path === rel);
    const inherited = ((node as { grants?: { code?: unknown }[] } | undefined)?.grants ?? []).map((x) => String(x.code ?? ""));
    return write(
      c, m, rel, "new grant",
      (text, date) => addGrant(text, { prefix: grantPrefix(text, node?.id), taken: inherited, date, grant: g }),
      (code) => ({ msg: `Standing approval ${code} added (${ownerName()}, via console)`, body: `${clean(g.scope).slice(0, 300)}\n\n${ownerName()} added this grant on the console Approvals tab; agents act inside it without asking and cite \`under ${code}\` in Decisions.` }),
      (code) => `${ownerName()} added standing approval ${code} in the console (${rel}).`,
    );
  });

  // Edit / revoke act on the line where it lives (`source`, the milestone spine or an ancestor in the same checkout).
  const sourceOf = async (m: Milestone, code: string) => {
    const v = await view(m, 4_000);
    return v.grants.find((g) => g.code === code);
  };

  api.put("/milestones/:id/approvals/:code", async (c) => {
    const m = milestone(c);
    if (!m) return err(c, 404, "not_found", `milestone ${c.req.param("id")} not found`);
    const code = c.req.param("code");
    const g = grantIn(await json(c));
    if (typeof g === "string") return err(c, 400, "validation_error", g);
    const at = await sourceOf(m, code);
    if (!at) return err(c, 404, "not_found", `grant ${code} is not in force on this milestone`);
    if (at.state === "revoked") return err(c, 409, "conflict", `grant ${code} is revoked: add a new grant instead`);
    return write(
      c, m, at.source, code,
      (text, date) => editGrant(text, code, g, date),
      () => ({ msg: `Standing approval ${code} edited (${ownerName()}, via console)`, body: `${clean(g.scope).slice(0, 300)}\n\n${ownerName()} rewrote this grant on the console Approvals tab (code kept).` }),
      () => `${ownerName()} edited standing approval ${code} in the console (${at.source}).`,
    );
  });

  api.post("/milestones/:id/approvals/:code/revoke", async (c) => {
    const m = milestone(c);
    if (!m) return err(c, 404, "not_found", `milestone ${c.req.param("id")} not found`);
    const code = c.req.param("code");
    const body = (await json(c)) as { why?: unknown } | undefined;
    const why = typeof body?.why === "string" ? body.why.trim() : "";
    if (why.length > 300) return err(c, 400, "validation_error", "keep the reason under 300 characters");
    const at = await sourceOf(m, code);
    if (!at) return err(c, 404, "not_found", `grant ${code} is not in force on this milestone`);
    if (at.state === "revoked") return err(c, 409, "conflict", `grant ${code} is revoked already`);
    return write(
      c, m, at.source, code,
      (text, date) => revokeGrant(text, code, why, date),
      () => ({ msg: `Standing approval ${code} revoked (${ownerName()}, via console)`, body: `${why || `revoked by ${ownerName()}`}\n\n${ownerName()} revoked this grant on the console Approvals tab; actions it covered are asks again.` }),
      () => `${ownerName()} revoked standing approval ${code} in the console (${at.source}); what it covered is an ask again.`,
    );
  });
}
