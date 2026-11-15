import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import { z } from "zod";
import { resolveRepo } from "./adapters/repos.js";
import { isDeliveryManager } from "./inbox/asks.js";
import { activityWhy, defFor, outcomeDefs, TICKET_WORKER, type PersonaDef } from "./outcomeDefs.js";
import type { SpineWriter } from "./inbox/spineWrite.js";
import type { Run, Store } from "./store.js";

/**
 * The outcome log (the owner's voice note asking each persona to log what it got done): every persona and
 * worker ends its wake by logging what it actually got done, one line per real outcome (delivered, learning added,
 * merged, folded, superseded …), in one table that filters by persona, product, row, kind and day.
 *
 * The repo is the record (root L-45): each outcome is one JSON line in `docs/outcomes/<YYYY-MM-DD>.jsonl` of the run's
 * repo, appended by the console's one spine writer (commit + push). The small call is the run PATCH every wake and
 * worker already sends (`outcomes: [...]`), or `POST /api/outcomes` (a backfill, a run already closed).
 * `GET /api/outcomes` reads the files back from every tracked checkout; nothing lives only in console.db.
 * `goalRow` names the goal-set row the outcome turned green, once goal sets give every row one (fill it when known).
 */
export const OUTCOMES_DIR = "docs/outcomes";
export const OUTCOME_KINDS = ["delivered", "learning", "merged", "folded", "superseded", "released", "fixed", "asked", "other"] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

const ROW = /^[A-Z][A-Z0-9]*-[A-Z0-9-]*\d[A-Za-z0-9-]*$/;
export const outcomeIn = z
  .object({
    kind: z.enum(OUTCOME_KINDS),
    /** one plain line: what is now true. */
    text: z.string().trim().min(3).max(400),
    /** the ledger row it belongs to; defaults to the row code the run's summary starts with. */
    row: z.string().trim().regex(ROW, "row must be a ledger row code like E907-S3").optional(),
    /** the goal-set row it turned green, when known. */
    goalRow: z.string().trim().max(80).optional(),
    /** the live thing, card or commit that shows it. */
    link: z.string().trim().url().max(500).optional(),
    /** product name (from docs/outcomes/products.json); defaults from the run's repo. */
    product: z.string().trim().max(40).optional(),
  })
  .strict();
export type OutcomeIn = z.infer<typeof outcomeIn>;
export const outcomesIn = z.array(outcomeIn).max(20);

export interface Outcome {
  /** ISO UTC when it was logged (a backfill: when its run ended). */
  at: string;
  day: string;
  kind: OutcomeKind;
  text: string;
  row?: string;
  goalRow?: string;
  link?: string;
  product: string;
  persona: string;
  runId?: string;
  milestoneId?: string;
  repo: string;
  /** `run` = written by the run itself at the end of its wake; `backfill` = from its run summary afterwards. */
  source: "run" | "backfill";
}

/**
 * product of a repo: `docs/outcomes/products.json` of that checkout maps checkout names to product names
 * (`{"app": "Acme Team"}`, the repo's own words, never a list in code); else the checkout's name.
 */
export function productOf(repo: string, names: Record<string, string> = {}): string {
  const name = repo.split("/").pop() ?? repo;
  return names[name] ?? names[name.toLowerCase()] ?? name;
}
export function productNames(dir: string): Record<string, string> {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, OUTCOMES_DIR, "products.json"), "utf8")) as unknown;
    return j && typeof j === "object" && !Array.isArray(j) ? Object.fromEntries(Object.entries(j as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string")) : {};
  } catch {
    return {};
  }
}

const TICKET = /^[A-Z][A-Z0-9]*-[A-Z0-9-]*\d[A-Za-z0-9-]*$/;
/** the row code a run's summary starts with (`E907-S3 …`), if any. */
export function rowOfSummary(summary: string | undefined): string | undefined {
  const first = (summary ?? "").trim().split(/\s+/)[0]?.replace(/[:,.;]+$/, "") ?? "";
  return TICKET.test(first) ? first : undefined;
}

export const fileOfDay = (day: string) => `${OUTCOMES_DIR}/${day}.jsonl`;

/** the outcome's identity in its file: a resend (a retried PATCH, a second backfill) adds nothing. */
const keyOf = (o: Pick<Outcome, "runId" | "kind" | "row" | "text">) => `${o.runId ?? ""}\0${o.kind}\0${o.row ?? ""}\0${o.text.replace(/\s+/g, " ").trim().toLowerCase()}`;

/** append `list` to the day file's text (one JSON line each), skipping any already there. */
export function appendLines(text: string, list: Outcome[]): { text: string; added: number } {
  const have = new Set(parseLines(text).map(keyOf));
  const fresh = list.filter((o) => {
    const k = keyOf(o);
    if (have.has(k)) return false;
    have.add(k);
    return true;
  });
  if (!fresh.length) return { text, added: 0 };
  const base = text && !text.endsWith("\n") ? `${text}\n` : text;
  return { text: base + fresh.map((o) => JSON.stringify(o)).join("\n") + "\n", added: fresh.length };
}

export function parseLines(text: string): Outcome[] {
  const out: Outcome[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as Outcome;
      if (o && typeof o.text === "string" && typeof o.kind === "string" && typeof o.at === "string") out.push(o);
    } catch {
      /* a broken line is skipped, never the file */
    }
  }
  return out;
}

/** the outcomes a run reports, stamped with who, where and when. */
export function stamp(list: OutcomeIn[], ctx: { run?: Run; persona: string; repo: string; at: string; source: Outcome["source"]; products?: Record<string, string> }): Outcome[] {
  const row = rowOfSummary(ctx.run?.summary);
  return list.map((o) => ({
    at: ctx.at,
    day: ctx.at.slice(0, 10),
    kind: o.kind,
    text: o.text.replace(/\s+/g, " ").trim(),
    ...(o.row ?? row ? { row: o.row ?? row } : {}),
    ...(o.goalRow ? { goalRow: o.goalRow } : {}),
    ...(o.link ? { link: o.link } : {}),
    product: o.product ?? productOf(ctx.repo, ctx.products),
    persona: ctx.persona,
    ...(ctx.run ? { runId: ctx.run.id } : {}),
    ...(ctx.run?.milestoneId ? { milestoneId: ctx.run.milestoneId } : {}),
    repo: ctx.repo,
    source: ctx.source,
  }));
}

export interface OutcomeFilter {
  persona?: string;
  product?: string;
  row?: string;
  kind?: string;
  day?: string;
  repo?: string;
}

export function filterOutcomes(all: Outcome[], f: OutcomeFilter): Outcome[] {
  const eq = (a: string | undefined, b: string | undefined) => !b || (a ?? "").toLowerCase() === b.toLowerCase();
  return all.filter((o) => eq(o.persona, f.persona) && eq(o.product, f.product) && eq(o.kind, f.kind) && eq(o.day, f.day) && eq(o.repo, f.repo) && (!f.row || (o.row ?? "").toUpperCase() === f.row.toUpperCase() || (o.goalRow ?? "").toUpperCase() === f.row.toUpperCase()));
}

export interface OutcomesBody {
  outcomes: Outcome[];
  /** every value seen (before filtering), for the page's filter menus. */
  facets: { persona: string[]; product: string[]; kind: string[]; day: string[]; repo: string[] };
  /** counts of the filtered list by kind. */
  counts: Record<string, number>;
  kinds: readonly string[];
  /** what counts as an outcome for each persona (docs/outcomes/what-counts.json): the rule, then one per persona seen or defined. */
  definitions: { rule: string; personas: PersonaDef[] };
}

/** the definitions the page shows: every defined persona, then every persona seen in the log without one (the default). */
export function definitionsBody(seen: string[], defs = outcomeDefs()): OutcomesBody["definitions"] {
  const named = defs.personas.map((p) => ({ persona: p.persona, counts: p.counts, doesNot: p.doesNot, examples: p.examples ?? [] }));
  const have = new Set(named.map((p) => p.persona.toLowerCase()));
  const rest = seen.filter((p) => !have.has(p.toLowerCase())).map((p) => ({ ...defFor(p, defs), examples: [] }));
  return { rule: defs.rule, personas: [...named, ...rest] };
}

/** a reported line that only reports activity (docs/outcomes/what-counts.json neverCounts) is refused, never written. */
export function splitActivity<T extends { text: string }>(list: T[], defs = outcomeDefs()): { keep: T[]; refused: { text: string; why: string }[] } {
  const keep: T[] = [];
  const refused: { text: string; why: string }[] = [];
  for (const o of list) {
    const why = activityWhy(o.text, defs);
    if (why) refused.push({ text: o.text, why });
    else keep.push(o);
  }
  return { keep, refused };
}

/** every outcome in every tracked checkout's docs/outcomes/ (newest first). */
export function readOutcomes(dirs: { name: string; path: string }[], days = 60): Outcome[] {
  const out: Outcome[] = [];
  const seen = new Set<string>();
  for (const d of dirs) {
    if (seen.has(d.path)) continue;
    seen.add(d.path);
    const folder = path.join(d.path, OUTCOMES_DIR);
    let files: string[] = [];
    try {
      files = fs.readdirSync(folder).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
    } catch {
      continue;
    }
    for (const f of files.sort().reverse().slice(0, days)) {
      let text = "";
      try {
        text = fs.readFileSync(path.join(folder, f), "utf8");
      } catch {
        continue;
      }
      out.push(...parseLines(text).map((o) => ({ ...o, repo: o.repo || d.name })));
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

export function outcomesBody(all: Outcome[], f: OutcomeFilter): OutcomesBody {
  const uniq = (k: keyof Outcome) => [...new Set(all.map((o) => o[k]).filter((v): v is string => typeof v === "string" && !!v))].sort();
  const list = filterOutcomes(all, f);
  const counts: Record<string, number> = {};
  for (const o of list) counts[o.kind] = (counts[o.kind] ?? 0) + 1;
  return {
    outcomes: list,
    facets: { persona: uniq("persona"), product: uniq("product"), kind: uniq("kind"), day: uniq("day").reverse(), repo: uniq("repo") },
    counts,
    kinds: OUTCOME_KINDS,
    definitions: definitionsBody(uniq("persona")),
  };
}

export interface OutcomeDeps {
  store: Pick<Store, "getRun" | "getAssignment" | "getPersona" | "getMilestone" | "listMilestones">;
  reposRoot: string;
  writer?: SpineWriter;
  /** the checkout and spine of a milestone (the writer's target repo). */
  spineOf: (milestoneId: string) => { dir: string; path: string } | undefined;
  wrote?: (dir: string) => void;
  now?: () => Date;
}

export class OutcomeError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function createOutcomes(d: OutcomeDeps) {
  const personaName = (run: Run) => d.store.getPersona(run.personaId ?? d.store.getAssignment(run.assignmentId)?.personaId ?? "")?.name ?? "unknown";
  /** a Delivery Manager's child run is a Ticket worker doing one row: its outcomes are held to the worker's definition. */
  const personaOf = (run: Run) => {
    const name = personaName(run);
    return run.parentRunId && isDeliveryManager(name) ? TICKET_WORKER : name;
  };
  const milestoneOf = (run: Run) => run.milestoneId ?? d.store.getAssignment(run.assignmentId)?.milestoneId;

  /** write a run's outcomes into its repo's day file (one commit); returns how many were new. */
  async function record(run: Run, reported: OutcomeIn[], o: { at?: string; source?: Outcome["source"] } = {}): Promise<{ added: number; path?: string; sha?: string; refused?: { text: string; why: string }[] }> {
    const { keep: list, refused: r0 } = splitActivity(reported);
    const refused = r0.length ? { refused: r0 } : {};
    if (!list.length) return { added: 0, ...refused };
    if (!d.writer) throw new OutcomeError(503, "no_writer", "this console does not write repos (no spine writer)");
    const mid = milestoneOf(run);
    const at = mid ? d.spineOf(mid) : undefined;
    if (!at) throw new OutcomeError(409, "no_repo", `run ${run.id} has no milestone checkout on this host to log outcomes in`);
    const m = mid ? d.store.getMilestone(mid) : undefined;
    const when = o.at ?? (d.now?.() ?? new Date()).toISOString();
    const lines = stamp(list, { run: { ...run, milestoneId: mid }, persona: personaOf(run), repo: m?.repo ?? path.basename(at.dir), at: when, source: o.source ?? "run", products: productNames(at.dir) });
    const rel = fileOfDay(when.slice(0, 10));
    let added = 0;
    const w = await d.writer.edit({
      repoDir: at.dir,
      path: rel,
      label: `outcomes ${run.id}`,
      group: true,
      edit: (text) => {
        const r = appendLines(text, lines);
        added = r.added;
        if (!r.added) return { skip: "already logged" };
        const rows = [...new Set(lines.map((l) => l.row).filter(Boolean))].join(", ");
        return {
          text: r.text,
          msg: `Outcomes${rows ? ` ${rows}` : ""}: ${r.added} logged by ${lines[0].persona}`,
          body: `${lines.map((l) => `- ${l.kind}: ${l.text}`).join("\n")}\n\nThe outcome log: one line per real outcome, read by the console's Outcomes page.\n\nRun: ${run.id}`,
        };
      },
    });
    if (w.status === "skipped" && w.reason === "already logged") return { added: 0, path: rel, ...refused };
    if (w.status !== "written") throw new OutcomeError(409, "not_written", `outcomes not written to ${rel}: ${w.status} ${w.reason ?? ""}`.trim());
    d.wrote?.(at.dir);
    return { added, path: rel, ...(w.sha ? { sha: w.sha } : {}), ...refused };
  }

  function dirs() {
    const out: { name: string; path: string }[] = [];
    for (const m of d.store.listMilestones({ includeSettled: true })) {
      const r = resolveRepo(d.reposRoot, m.repo);
      if (r) out.push({ name: r.name, path: r.path });
    }
    return out;
  }
  let cache: { at: number; all: Outcome[] } | undefined;
  /** lines logged before the definitions under the Delivery Manager by its child runs read as the Ticket worker's. */
  const childOf = new Map<string, boolean>();
  const asWorker = (o: Outcome): Outcome => {
    if (!o.runId || !isDeliveryManager(o.persona)) return o;
    let child = childOf.get(o.runId);
    if (child === undefined) childOf.set(o.runId, (child = !!d.store.getRun(o.runId)?.parentRunId));
    return child ? { ...o, persona: TICKET_WORKER } : o;
  };
  const all = () => {
    const now = Date.now();
    if (!cache || now - cache.at > 15_000) cache = { at: now, all: readOutcomes(dirs()).map(asWorker) };
    return cache.all;
  };
  return { record, all, clear: () => (cache = undefined), body: (f: OutcomeFilter) => outcomesBody(all(), f) };
}
export type Outcomes = ReturnType<typeof createOutcomes>;

/** GET /api/outcomes (filters persona, product, row, kind, day, repo) and POST /api/outcomes {runId, outcomes, at?, source?}. */
export function mountOutcomes(api: Hono, o: () => Outcomes, store: Pick<Store, "getRun">) {
  api.get("/outcomes", (c) =>
    c.json(
      o().body({
        persona: c.req.query("persona") || undefined,
        product: c.req.query("product") || undefined,
        row: c.req.query("row") || undefined,
        kind: c.req.query("kind") || undefined,
        day: c.req.query("day") || undefined,
        repo: c.req.query("repo") || undefined,
      }),
    ),
  );
  const postIn = z
    .object({ runId: z.string().min(1), outcomes: outcomesIn.min(1), at: z.string().datetime().optional(), source: z.enum(["run", "backfill"]).optional() })
    .strict();
  api.post("/outcomes", async (c) => {
    const p = postIn.safeParse(await c.req.json().catch(() => undefined));
    if (!p.success) return c.json({ error: { code: "validation_error", message: p.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") } }, 400);
    const run = store.getRun(p.data.runId);
    if (!run) return c.json({ error: { code: "not_found", message: `run ${p.data.runId} not found` } }, 404);
    try {
      const r = await o().record(run, p.data.outcomes, { at: p.data.at, source: p.data.source });
      o().clear();
      return c.json(r, r.added ? 201 : 200);
    } catch (e) {
      if (e instanceof OutcomeError) return c.json({ error: { code: e.code, message: e.message } }, e.status);
      throw e;
    }
  });
}
