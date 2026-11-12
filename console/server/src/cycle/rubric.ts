import fs from "node:fs";
import path from "node:path";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { DB } from "../db.js";
import type { SpineWrite, SpineWriter } from "../inbox/spineWrite.js";
import { setStateField, stateField } from "../repoState/stateField.js";
import type { OpenAsk, RunCheck } from "../store.js";
import { readAskMemory } from "./askMemory.js";
import { opsRepo, ownerName, ownerPattern } from "../identity.js";

/**
 * the Unblocker decides each new or changed ask by a tunable confidence rubric. It scores four factors 0-4
 * (higher = safer to answer without the owner); the console turns them into a 0-100 score with the milestone's weights and
 * lets an answer stand only when the score clears the threshold, no factor is below the minimum, and the ask is outside
 * the hard floor. Threshold, weights, minimum and extra floor items are the owner's settings (global, per-milestone
 * override, default below), kept in the repo (the team repo's state/unblocker-rubric.json and a spine's
 * `Unblocker rubric:` line). Every assessed check carries its scores and the rubric it was judged by, so the per-ask
 * memory holds them for's numbers and for the owner's tuning after a reversal.
 */
export const FACTORS = ["reversal", "options", "impact", "evidence"] as const;
export type Factor = (typeof FACTORS)[number];
export type Scores = Record<Factor, number>;

/** What each factor means and its 0-4 anchors (in the wake prompt and the remit). */
export const FACTOR_ANCHORS: Record<Factor, string> = {
  reversal: "cost of reverting: 4 a one-line revert nobody notices · 3 minutes · 2 real work or a redeploy · 1 costly (migrations, others built on it) · 0 cannot be undone",
  options: "difference between the options: 4 nearly equivalent, or the rules clearly pick one · 2 a real trade-off the rules lean on · 0 very different outcomes and nothing recorded prefers one",
  impact: "how far it reaches: 4 one task or branch · 3 one epic's plan · 2 several epics or a schedule · 1 product behaviour users see · 0 product direction, a Goal or Done means, other people",
  evidence: `goal, grant, precedent: 4 a grant, the Goal/Done means or ${ownerName()}'s past answer settles it · 3 an Operating Learning or the same case decided before · 2 an analogous precedent · 1 only general rules · 0 nothing`,
};

/**
 * The hard floor (row, exactly): left for the owner whatever the score. Never removable by settings; settings may only
 * add items (`floorExtra`).
 */
export const HARD_FLOOR = [
  { id: "jordi_hands", label: `${ownerName()}'s hands: what only he can physically do (his Mac, phone, browser logins, payments, QR scans)` },
  { id: "new_money", label: "new money: spend beyond a recorded limit or grant" },
  { id: "new_public_exposure", label: "new public exposure: publishing, contacting third parties, new public ports or hostnames, outside credentials" },
  { id: "irreversible_loss", label: "irreversible loss: data or work that cannot be restored" },
] as const;

export interface RubricSettings {
  /** 0-100: the weighted score an answer must reach. */
  threshold: number;
  /** Relative weights (normalised when scoring). */
  weights: Scores;
  /** 0-4: a factor scored below this vetoes an answer whatever the total (a one-way door, a Goal change). */
  minFactor: number;
  /** Floor items added on top of the hard floor (labels; their id is `extra:<n>`, 1-based). */
  floorExtra: string[];
}
export const DEFAULT_RUBRIC: RubricSettings = {
  threshold: 75,
  weights: { reversal: 3, options: 1.5, impact: 2, evidence: 3.5 },
  minFactor: 1,
  floorExtra: [],
};

/** The rubric an assessed check was judged by (stamped by the console on the check). */
export interface RubricStamp {
  score: number;
  threshold: number;
  minFactor: number;
  weights: Scores;
  /** score ≥ threshold, every factor ≥ minFactor, no floor item. */
  clears: boolean;
  /** Where the settings came from: the milestone's override, the global settings or the built-in default. */
  from: "milestone" | "global" | "default";
}

// ---------- settings ----------

const weights = z.object(Object.fromEntries(FACTORS.map((f) => [f, z.number().min(0).max(100)])) as Record<Factor, z.ZodNumber>).strict();
export const rubricPatch = z
  .object({
    threshold: z.number().min(0).max(100).optional(),
    weights: weights.optional(),
    minFactor: z.number().int().min(0).max(4).optional(),
    // one line in the spine: a label holds no ` · ` or `; ` (they separate the parts and the labels)
    floorExtra: z.array(z.string().trim().min(3).max(200).refine((x) => !/\s[·;]\s|[\n\r|]/.test(x), "a floor item is one line without ' · ', ' ; ' or '|'")).max(10).optional(),
    by: z.string().trim().max(80).optional(),
  })
  .strict()
  .refine((p) => !p.weights || FACTORS.some((f) => p.weights![f] > 0), "at least one weight must be above 0");
export type RubricPatch = z.infer<typeof rubricPatch>;

const GLOBAL = "";

// ---------- where the settings live (root L-45: the repo, never console.db) ----------

/**
 * The global settings are a file in the owner's team repo (`state/unblocker-rubric.json`, beside big-roots.json); a
 * milestone's override is the `Unblocker rubric:` line in its spine's Current State. Both are read from the checkout on
 * every use and written through the one spine writer (commit + push); a write that does not land changes nothing.
 * No team checkout = no global file (the default applies); no spine = no override.
 */
export const RUBRIC_FILE = "state/unblocker-rubric.json";
export const RUBRIC_FIELD = "Unblocker rubric";
export const RUBRIC_ABOUT =
  `${ownerName()}'s Unblocker rubric: the score an answer must reach, the factor weights, the minimum per factor and extra 'always ask ${ownerName()}' floor items. The console reads this file on every Unblocker wake and writes it when ${ownerName()} changes the settings; a milestone overrides it with an \`Unblocker rubric:\` line in its spine's Current State.`;

export interface RubricRepo {
  /** The team repo checkout (holds RUBRIC_FILE); undefined = none on this host. */
  teamDir(): string | undefined;
  /** A milestone's checkout and repo-relative spine; undefined = none. */
  spineOf(milestoneId: string): { dir: string; path: string } | undefined;
  writer: Pick<SpineWriter, "edit">;
  /** After a written change: the checkout's cached views are recomputed. */
  invalidate?: (dir: string) => void;
}
const repos = new WeakMap<object, RubricRepo>();
/** createApp binds the console's checkouts and writer to its db; an unbound db reads the default and writes nothing. */
export function bindRubricRepo(db: DB, r: RubricRepo): void {
  repos.set(db, r);
}

const readFile = (dir: string, rel: string): string | undefined => {
  try {
    return fs.readFileSync(path.join(dir, rel), "utf8");
  } catch {
    return undefined;
  }
};

/** `threshold 90 · min factor 2 · weights reversal 1, options 1, impact 1, evidence 1 · also ask the owner: a; b` */
export function rubricLine(p: Partial<RubricSettings>): string {
  return [
    ...(p.threshold !== undefined ? [`threshold ${p.threshold}`] : []),
    ...(p.minFactor !== undefined ? [`min factor ${p.minFactor}`] : []),
    ...(p.weights ? [`weights ${FACTORS.map((f) => `${f} ${p.weights![f]}`).join(", ")}`] : []),
    ...(p.floorExtra?.length ? [`also ask ${ownerName()}: ${p.floorExtra.join(" ; ")}`] : []),
  ].join(" · ");
}

/** The `Unblocker rubric:` value read back (parts it cannot read are left out, so the global or default applies). */
export function parseRubricLine(value: string): Partial<RubricSettings> {
  const out: Partial<RubricSettings> = {};
  for (const part of value.split(/\s+·\s+/).map((x) => x.trim())) {
    let m: RegExpExecArray | null;
    if ((m = /^threshold\s+(\d+(?:\.\d+)?)$/i.exec(part)) && Number(m[1]) <= 100) out.threshold = Number(m[1]);
    else if ((m = /^min(?:imum)?\s+factor\s+([0-4])$/i.exec(part))) out.minFactor = Number(m[1]);
    else if ((m = /^weights\s+(.+)$/i.exec(part))) {
      const w = Object.fromEntries(
        m[1].split(/\s*,\s*/).map((x) => /^(\w+)\s+(\d+(?:\.\d+)?)$/.exec(x.trim())).filter((x): x is RegExpExecArray => !!x).map((x) => [x[1].toLowerCase(), Number(x[2])]),
      );
      if (FACTORS.every((f) => typeof w[f] === "number" && w[f] <= 100) && FACTORS.some((f) => w[f] > 0)) out.weights = Object.fromEntries(FACTORS.map((f) => [f, w[f]])) as Scores;
    } else if ((m = new RegExp(String.raw`^also ask ${ownerPattern()}\s*:\s*(.+)$`, "i").exec(part))) out.floorExtra = m[1].split(/\s+;\s+/).map((x) => x.trim()).filter(Boolean).slice(0, 10);
  }
  return out;
}

type Scope = Partial<RubricSettings> & { updatedAt?: string; updatedBy?: string; at?: string };
function readScope(db: DB, scope: string): Scope | undefined {
  const r = repos.get(db);
  if (!r) return undefined;
  if (scope === GLOBAL) {
    const dir = r.teamDir();
    const text = dir ? readFile(dir, RUBRIC_FILE) : undefined;
    if (!text) return undefined;
    try {
      const v = JSON.parse(text) as Scope;
      const set = pick(v);
      return Object.keys(set).length ? { ...set, ...(v.updatedAt ? { updatedAt: v.updatedAt } : {}), ...(v.updatedBy ? { updatedBy: v.updatedBy } : {}), at: `${RUBRIC_FILE}` } : undefined;
    } catch {
      return undefined; // a broken file is no setting (the default applies); the file's own history says who broke it
    }
  }
  const s = r.spineOf(scope);
  const text = s ? readFile(s.dir, s.path) : undefined;
  const f = text ? stateField(text, RUBRIC_FIELD) : undefined;
  if (!f || /^(none|-|—)?$/i.test(f.value)) return undefined;
  const set = parseRubricLine(f.value);
  return Object.keys(set).length ? { ...set, at: `${s!.path}:${f.line + 1}` } : undefined;
}
const pick = (p?: Partial<RubricSettings>): Partial<RubricSettings> =>
  p ? Object.fromEntries((["threshold", "weights", "minFactor", "floorExtra"] as const).filter((k) => p[k] !== undefined).map((k) => [k, p[k]])) : {};

/** The settings in force for a milestone: its override over the global settings over the default. */
export function rubricFor(db: DB, milestoneId?: string): RubricSettings & { from: RubricStamp["from"] } {
  const g = readScope(db, GLOBAL);
  const m = milestoneId ? readScope(db, milestoneId) : undefined;
  const from = m ? "milestone" : g ? "global" : "default";
  return { ...DEFAULT_RUBRIC, ...pick(g), ...pick(m), from };
}

const noRepo = (why: string): SpineWrite => ({ status: "skipped", reason: why });

/**
 * Write the global settings (scope "", the team repo file) or a milestone's override (its spine's `Unblocker rubric:`
 * line); only the fields given change. Nothing else records the change: a write that is not `written` changed nothing.
 */
export async function setRubric(db: DB, scope: string, patch: RubricPatch, at = new Date().toISOString()): Promise<SpineWrite> {
  const r = repos.get(db);
  if (!r) return noRepo("the console has no checkouts bound for the rubric");
  const { by, ...fields } = patch;
  const who = by?.trim() || ownerName();
  if (scope === GLOBAL) {
    const dir = r.teamDir();
    if (!dir) return noRepo(`no team repo checkout on this host for ${RUBRIC_FILE}`);
    const res = await r.writer.edit({
      repoDir: dir,
      path: RUBRIC_FILE,
      label: "Unblocker rubric",
      edit: (text) => {
        let was: Scope = {};
        try {
          was = text.trim() ? (JSON.parse(text) as Scope) : {};
        } catch {
          /* a broken file is replaced */
        }
        const merged = { ...pick(was), ...pick(fields) };
        if (JSON.stringify(pick(was)) === JSON.stringify(merged) && text.trim()) return { text, msg: "", body: "" };
        return {
          text: `${JSON.stringify({ about: RUBRIC_ABOUT, ...merged, updatedAt: at, updatedBy: who }, null, 2)}\n`,
          msg: `Unblocker rubric: ${rubricLine(pick(fields)) || "settings"} (${who}, via console)`.slice(0, 120),
          body: `The agent-team console wrote ${who}'s Unblocker rubric settings (the settings live in this file, not in console.db).\n\nNow: ${rubricLine(merged) || "the default"}.`,
        };
      },
    });
    if (res.status === "written") r.invalidate?.(dir);
    return res;
  }
  const s = r.spineOf(scope);
  if (!s) return noRepo(`milestone ${scope} has no spine in a checkout on this host, so its override has no line to go in`);
  const res = await r.writer.edit({
    repoDir: s.dir,
    path: s.path,
    label: "Unblocker rubric",
    edit: (text) => {
      if (!stateField(text, "Status") && !/^#{1,6}\s+current state\b/im.test(text)) return { skip: `${s.path} has no Current State to hold the ${RUBRIC_FIELD} line` };
      const f = stateField(text, RUBRIC_FIELD);
      const merged = { ...(f ? parseRubricLine(f.value) : {}), ...pick(fields) };
      const next = setStateField(text, RUBRIC_FIELD, rubricLine(merged), ["Monitoring", "Waiting on", "Next action"]);
      return {
        text: next,
        msg: `Unblocker rubric for this epic: ${rubricLine(pick(fields)) || "settings"} (${who}, via console)`.slice(0, 120),
        body: `The agent-team console wrote ${who}'s Unblocker rubric override into Current State (the override lives in the spine, not in console.db).`,
      };
    },
  });
  if (res.status === "written") r.invalidate?.(s.dir);
  return res;
}

/** Take a milestone's override out of its spine (the global or default applies again). */
export async function clearRubric(db: DB, scope: string): Promise<SpineWrite> {
  const r = repos.get(db);
  const s = r?.spineOf(scope);
  if (!r || !s) return noRepo(`milestone ${scope} has no spine in a checkout on this host`);
  const res = await r.writer.edit({
    repoDir: s.dir,
    path: s.path,
    label: "Unblocker rubric",
    edit: (text) =>
      stateField(text, RUBRIC_FIELD)
        ? { text: setStateField(text, RUBRIC_FIELD, undefined), msg: "Unblocker rubric override removed (via console)", body: "The agent-team console took this epic's Unblocker rubric override out of Current State; the global settings apply." }
        : { text, msg: "", body: "" },
  });
  if (res.status === "written") r.invalidate?.(s.dir);
  return res;
}

/** The per-run log table (ops: the rubric a run was judged by). Created on first use. */
const ensured = new WeakSet<object>();
export function ensureRubric(db: DB): void {
  if (ensured.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS rubric_wake (
      run_id TEXT PRIMARY KEY,
      json TEXT NOT NULL
    );
  `);
  ensured.add(db);
}

/** The settings a wake prompt showed, kept per run so its finishing PATCH is judged by the same numbers. */
export function snapshotRubric(db: DB, runId: string, milestoneId?: string): RubricSettings & { from: RubricStamp["from"] } {
  ensureRubric(db);
  const s = rubricFor(db, milestoneId);
  db.prepare("INSERT OR REPLACE INTO rubric_wake (run_id, json) VALUES (?, ?)").run(runId, JSON.stringify(s));
  return s;
}
export function rubricOfRun(db: DB, runId: string, milestoneId?: string): RubricSettings & { from: RubricStamp["from"] } {
  ensureRubric(db);
  const r = db.prepare("SELECT json FROM rubric_wake WHERE run_id = ?").get(runId) as { json: string } | undefined;
  return r ? (JSON.parse(r.json) as RubricSettings & { from: RubricStamp["from"] }) : rubricFor(db, milestoneId);
}

/** Every floor item in force: the hard floor plus the settings' extras. */
export const floorItems = (s: Pick<RubricSettings, "floorExtra">) => [
  ...HARD_FLOOR.map((x) => ({ ...x })),
  ...s.floorExtra.map((label, i) => ({ id: `extra:${i + 1}`, label })),
];

// ---------- scoring ----------

/** Weighted mean of the 0-4 factor scores, as 0-100 (rounded). */
export function rubricScore(scores: Scores, w: Scores): number {
  const total = FACTORS.reduce((n, f) => n + w[f], 0);
  if (total <= 0) return 0;
  return Math.round((FACTORS.reduce((n, f) => n + w[f] * scores[f], 0) / total) * 25);
}

export function judge(scores: Scores, floor: string[] | undefined, s: RubricSettings & { from?: RubricStamp["from"] }): RubricStamp {
  const score = rubricScore(scores, s.weights);
  const clears = score >= s.threshold && FACTORS.every((f) => scores[f] >= s.minFactor) && !(floor ?? []).length;
  return { score, threshold: s.threshold, minFactor: s.minFactor, weights: s.weights, clears, from: s.from ?? "default" };
}

const bareCode = (c: string) => c.trim().replace(/^.*\//, "").toUpperCase();
const validScores = (x: unknown): x is Scores =>
  !!x && typeof x === "object" && FACTORS.every((f) => Number.isInteger((x as Scores)[f]) && (x as Scores)[f] >= 0 && (x as Scores)[f] <= 4);

/**
 * The finishing PATCH's assessed checks against the rubric: each carries `scores` (four factors 0-4) and `floor` ids
 * when it touches the floor; an answered or split check (the part answered) must clear the rubric. Undefined = fine.
 */
export function rubricProblem(assessed: OpenAsk[], checks: RunCheck[] | null | undefined, s: RubricSettings): string | undefined {
  const codes = new Set(assessed.map((a) => bareCode(a.code)));
  const mine = (checks ?? []).filter((c) => codes.has(bareCode(c.code)) && !c.carriedFrom && !c.skipped);
  const unscored = mine.filter((c) => !validScores(c.scores)).map((c) => c.code);
  if (unscored.length)
    return `every assessed ask carries \`scores\` (${FACTORS.join(", ")}: integers 0-4, the confidence rubric): missing or invalid for ${unscored.join(", ")}. ` +
      "Score each, then resend the PATCH.";
  const known = new Set(floorItems(s).map((x) => x.id));
  const badFloor = mine.flatMap((c) => (c.floor ?? []).filter((id) => !known.has(id)).map((id) => `${c.code}: ${id}`));
  if (badFloor.length) return `unknown floor ids (${badFloor.join(", ")}); use ${[...known].join(", ")}.`;
  const broken = mine
    .filter((c) => c.decision !== "left")
    .map((c) => ({ c, j: judge(c.scores!, c.floor, s) }))
    .filter((x) => !x.j.clears)
    .map(({ c, j }) =>
      c.floor?.length
        ? `${c.code} is in the floor (${c.floor.join(", ")})`
        : j.score < s.threshold
          ? `${c.code} scores ${j.score} < threshold ${s.threshold}`
          : `${c.code} has a factor below ${s.minFactor} (${FACTORS.filter((f) => c.scores![f] < s.minFactor).join(", ")})`,
    );
  if (broken.length)
    return `the rubric does not let these answers stand: ${broken.join("; ")}. Undo each in the spine (restore its \`[ask …]\` line, remove its ` +
      "Decisions row, commit and push), then resend the PATCH with decision left and why (the floor item, or the factors that fall short).";
  return undefined;
}

/** Stamp each assessed check with the rubric it was judged by (carried and skipped checks keep theirs). */
export function stampRubric(checks: RunCheck[], s: RubricSettings & { from?: RubricStamp["from"] }): RunCheck[] {
  return checks.map((c) => {
    if (c.carriedFrom || c.skipped) return c;
    const { rubric: _sent, ...rest } = c;
    return validScores(c.scores) ? { ...rest, rubric: judge(c.scores, c.floor, s) } : rest;
  });
}

/** "score 82/75 · reversal 4 · options 3 · impact 3 · evidence 4" (summaries, Activity, the FYI card). */
export function rubricWords(c: Pick<RunCheck, "scores" | "rubric" | "floor">): string | undefined {
  if (!c.rubric || !c.scores) return undefined;
  return [
    `score ${c.rubric.score}/${c.rubric.threshold}`,
    ...FACTORS.map((f) => `${f} ${c.scores![f]}`),
    ...(c.floor?.length ? [`floor: ${c.floor.join(", ")}`] : []),
  ].join(" · ");
}

// ---------- the wake prompt ----------

/** Section U step 2's decision rule, from the settings in force at this wake. */
export function rubricRules(s: RubricSettings & { from?: RubricStamp["from"] }): string[] {
  const floor = floorItems(s);
  return [
    `      Decide by the confidence rubric. Score each of these 0-4 (higher = safer to answer without ${ownerName()}), from the ask, its links, the grants and the record:`,
    ...FACTORS.map((f) => `        - ${f}: ${FACTOR_ANCHORS[f]}.`),
    `      The console scores them 0-100 with weights ${FACTORS.map((f) => `${f} ${s.weights[f]}`).join(", ")} (settings: ${s.from ?? "default"}).`,
    `      ANSWER when the score is at least ${s.threshold}, no factor is below ${s.minFactor}, and the ask is outside the hard floor; otherwise LEAVE.`,
    `      Hard floor (always ${ownerName()}'s, whatever the score; name each that applies in the check's \`floor\`):`,
    ...floor.map((x) => `        - ${x.id}: ${x.label}.`),
    `      Cite a source for every answer: the epic's Goal / Done means / Non-Goals, a standing approval, a past answer of ${ownerName()}'s`,
    `      (Decisions rows, \`[answered … @${ownerName()}]\` lines), an Operating Learning, or infra guidance (${opsRepo()} docs). Prefer the narrower, reversible answer.`,
    `      Never change the rubric settings yourself: ${ownerName()} tunes them.`,
  ];
}

// ---------- the FYI card ----------

/** an FYI card ("decided by Unblocker") shows the scores its verdict was judged by (from the per-ask memory). */
export function withRubric<T extends { code?: string; milestoneId?: string; decidedBy?: string }>(db: DB, items: T[]): (T & { rubric?: string })[] {
  const want = items.filter((i) => i.decidedBy && i.code && i.milestoneId);
  if (!want.length) return items;
  const byMilestone = new Map<string, Map<string, RunCheck>>();
  for (const id of new Set(want.map((i) => i.milestoneId!)))
    byMilestone.set(id, new Map(readAskMemory(db, id).filter((m) => m.verdict !== "left").map((m) => [bareCode(m.code), m.check])));
  return items.map((i) => {
    if (!i.decidedBy || !i.code || !i.milestoneId) return i;
    const c = byMilestone.get(i.milestoneId)?.get(bareCode(i.code));
    const words = c && rubricWords(c);
    return words ? { ...i, rubric: words } : i;
  });
}

// ---------- routes ----------

/**
 * GET /api/rubric-settings[?milestoneId=]: the settings in force (+ the global and override, where each lives, the hard
 * floor); PUT /api/rubric-settings (global: the team repo file) or /api/rubric-settings/:milestoneId (override: the
 * spine's `Unblocker rubric:` line; only the fields given change); DELETE /api/rubric-settings/:milestoneId takes the
 * override out. Each change is a commit through the spine writer; a write that does not land answers 409
 * `spine_write_refused` with the reason and nothing changed.
 */
export function mountRubric(api: Hono, db: DB, milestoneExists: (id: string) => boolean): void {
  const fail = (c: Context, status: 400 | 404 | 409, code: string, message: string) => c.json({ error: { code, message } }, status);
  const body = async (c: Context) => rubricPatch.safeParse(await c.req.json().catch(() => undefined));
  const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
  const view = (milestoneId?: string) => {
    const s = rubricFor(db, milestoneId);
    return {
      ...s,
      factors: FACTOR_ANCHORS,
      floor: floorItems(s),
      hardFloor: HARD_FLOOR.map((x) => x.id),
      default: DEFAULT_RUBRIC,
      global: readScope(db, GLOBAL) ?? null,
      ...(milestoneId ? { milestoneId, override: readScope(db, milestoneId) ?? null } : {}),
    };
  };
  const done = (c: Context, w: SpineWrite, milestoneId?: string) =>
    w.status === "written" ? c.json({ ...view(milestoneId), write: { ...(w.sha ? { sha: w.sha } : {}), ...(w.path ? { path: w.path } : {}) } }) : fail(c, 409, "spine_write_refused", `the rubric was not changed: ${w.reason ?? w.status}`);
  const missing = (c: Context, id: string) => fail(c, 404, "not_found", `milestone ${id} not found`);
  api.get("/rubric-settings", (c) => {
    const id = c.req.query("milestoneId") || undefined;
    if (id && !milestoneExists(id)) return missing(c, id);
    return c.json(view(id));
  });
  api.put("/rubric-settings", async (c) => {
    const p = await body(c);
    if (!p.success) return fail(c, 400, "validation_error", issues(p.error));
    return done(c, await setRubric(db, GLOBAL, p.data));
  });
  api.put("/rubric-settings/:milestoneId", async (c) => {
    const id = c.req.param("milestoneId");
    if (!milestoneExists(id)) return missing(c, id);
    const p = await body(c);
    if (!p.success) return fail(c, 400, "validation_error", issues(p.error));
    return done(c, await setRubric(db, id, p.data), id);
  });
  api.delete("/rubric-settings/:milestoneId", async (c) => {
    const id = c.req.param("milestoneId");
    if (!milestoneExists(id)) return missing(c, id);
    return done(c, await clearRubric(db, id), id);
  });
}
