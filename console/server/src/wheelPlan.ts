import fs from "node:fs";
import path from "node:path";
import { PURSUITS_FILE, parsePursuits } from "./pursuits.js";
import { SCORECARD_DIR } from "./scorecards.js";

/**
 * An objective's Plan tab: the plan of its wheel, for each key result HOW we get it to green. The owner (vn_9c02d869,
 * 23 Nov): "The plan is the plan ... we need to have the plan for each of them, man. So that when an agent reads this,
 * he gets the plan ... Don't rewrite what is already in other places." So it never restates the key results' numbers,
 * the ticket list or where we are (the Key results, Board and Context tabs hold those): per key result it holds the
 * approach, the steps in order (what each changes, who, by when), what proves it green and what we do if it stalls.
 *
 * One source: the `plan` block of the objective's key results file, docs/scorecards/<id>.json in the home repo:
 *   "plan": { "line": "...", "by": "2026-12-05", "writtenBy": "...", "at": "...",
 *             "keyResults": [{ "kr": 1, "how": "the approach",
 *                              "steps": [{ "do": "...", "changes": "what it changes", "owner": "...", "by": "2026-11-25", "row": "E907-S3", "done": false }],
 *                              "greenWhen": "what proves it green", "ifStuck": "what we do if it fails" }] }
 * `kr` is the key result's place (1 = the first in the file). An older plan (a flat `steps` list with `kr` and `step`)
 * still reads, each key result with no approach: scripts/plan_check.py flags it until it is rewritten.
 */
export interface WheelStep {
  /** what we do. */
  do: string;
  /** what it changes on the way to green. */
  changes?: string;
  owner?: string;
  by?: string;
  row?: string;
  done?: boolean;
}
export interface KeyResultPlan {
  kr: number;
  how?: string;
  steps: WheelStep[];
  greenWhen?: string;
  ifStuck?: string;
}
export interface WheelPlan {
  id: string;
  /** the file it lives in, beside the key results. */
  path: string;
  present: boolean;
  line?: string;
  by?: string;
  writtenBy?: string;
  at?: string;
  keyResults: KeyResultPlan[];
  /** an objective carried by a campaign: where that campaign's own marketing plan lives (never shown here). */
  campaign?: { repo: string; path: string };
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ROW = /^([\w.-]+:)?[A-Z][A-Z0-9]*-[A-Z]?\d+$/;
const str = (v: unknown, max = 600) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const krNo = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined);

function step(o: Record<string, unknown>): WheelStep | undefined {
  const what = str(o.do) ?? str(o.step);
  if (!what) return undefined;
  const row = str(o.row, 60);
  const owner = str(o.owner, 80), by = str(o.by, 20), changes = str(o.changes);
  return { do: what, ...(changes ? { changes } : {}), ...(owner ? { owner } : {}), ...(by ? { by } : {}), ...(row && ROW.test(row) ? { row } : {}), ...(o.done === true ? { done: true } : {}) };
}
const objs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);

export function parseWheelPlan(id: string, scorecardText: string | null): WheelPlan {
  const rel = `${SCORECARD_DIR}/${id}.json`;
  let raw: unknown;
  try {
    raw = scorecardText ? (JSON.parse(scorecardText) as { plan?: unknown }).plan : undefined;
  } catch {
    raw = undefined;
  }
  const p = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
  const byKr = new Map<number, KeyResultPlan>();
  for (const k of objs(p?.keyResults)) {
    const kr = krNo(k.kr);
    if (!kr || byKr.has(kr)) continue;
    const how = str(k.how, 1200), greenWhen = str(k.greenWhen), ifStuck = str(k.ifStuck);
    byKr.set(kr, { kr, ...(how ? { how } : {}), steps: objs(k.steps).flatMap((s) => step(s) ?? []), ...(greenWhen ? { greenWhen } : {}), ...(ifStuck ? { ifStuck } : {}) });
  }
  // an older plan: one flat list of steps, each naming its key result.
  for (const s of objs(p?.steps)) {
    const kr = krNo(s.kr), st = step(s);
    if (!kr || !st) continue;
    if (!byKr.has(kr)) byKr.set(kr, { kr, steps: [] });
    byKr.get(kr)!.steps.push(st);
  }
  const keyResults = [...byKr.values()].sort((a, b) => a.kr - b.kr);
  const line = str(p?.line);
  return {
    id,
    path: rel,
    present: !!line || keyResults.length > 0,
    ...(line ? { line } : {}),
    ...(str(p?.by, 20) ? { by: str(p?.by, 20) } : {}),
    ...(str(p?.writtenBy, 120) ? { writtenBy: str(p?.writtenBy, 120) } : {}),
    ...(str(p?.at, 40) ? { at: str(p?.at, 40) } : {}),
    keyResults,
  };
}

/** one key result's plan as an agent reads it in a brief or a wake prompt: the approach, the steps, green when, if stuck. */
export function keyResultPlanText(k: KeyResultPlan | undefined): string {
  if (!k || (!k.how && !k.steps.length)) return "No plan written for this key result yet: write it on the objective's Plan tab (its `plan.keyResults` entry) before you build.";
  const steps = k.steps.map((s, i) => `  ${s.done ? "✓" : `${i + 1}.`} ${s.do}${s.changes ? ` (changes: ${s.changes})` : ""}${s.owner ? `, ${s.owner}` : ""}${s.by ? `, by ${s.by}` : ""}${s.row ? `, ${s.row}` : ""}`);
  return [
    k.how ? `How: ${k.how}` : "How: not written yet (only steps): add the approach.",
    ...(steps.length ? ["Steps:", ...steps] : []),
    ...(k.greenWhen ? [`Green when: ${k.greenWhen}`] : []),
    ...(k.ifStuck ? [`If it stalls: ${k.ifStuck}`] : []),
  ].join("\n");
}

/**
 * the wake prompt's section: the objective's plan whole, per key result, to work from (its Plan tab). "" when the
 * milestone sits under no objective.
 */
export function planSection(dir: string | undefined, id: string | undefined, name: string | undefined): string {
  if (!id) return "";
  const v = readWheelPlan(dir, id);
  if (!v) return "";
  const labels = keyResultLabels(dir, id);
  const head = `## The plan: ${name ?? id} (work from it; its Plan tab, ${v.path} \`plan\`)`;
  if (!v.present) return `${head}\nNo plan written yet: write it per key result (how it gets to green, the steps, green when, if it stalls) before you dispatch.`;
  const n = Math.max(labels.length, ...v.keyResults.map((k) => k.kr), 0);
  const parts = Array.from({ length: n }, (_, i) => `### ${labels[i] ?? `Key result ${i + 1}`}\n${keyResultPlanText(v.keyResults.find((k) => k.kr === i + 1))}`);
  return [head, ...(v.line ? [v.line] : []), ...parts].join("\n");
}

/** the key results' names in file order (the plan's headings: the names only, their numbers stay on the Key results tab). */
export function keyResultLabels(dir: string | undefined, id: string): string[] {
  if (!dir || !ID.test(id)) return [];
  try {
    const d = JSON.parse(fs.readFileSync(path.join(dir, `${SCORECARD_DIR}/${id}.json`), "utf8")) as { keyResults?: { label?: unknown }[] };
    return (d.keyResults ?? []).map((k, i) => str(k?.label, 200) ?? `Key result ${i + 1}`);
  } catch {
    return [];
  }
}

/** the objective's wheel plan from the home repo; undefined for an id that is not an objective. */
export function readWheelPlan(homeDir: string | undefined, id: string): WheelPlan | undefined {
  if (!ID.test(id)) return undefined;
  const read = (rel: string) => {
    try {
      return homeDir ? fs.readFileSync(path.join(homeDir, rel), "utf8") : null;
    } catch {
      return null;
    }
  };
  const pursuitsText = read(PURSUITS_FILE);
  const d = pursuitsText ? parsePursuits(pursuitsText).pursuits.find((p) => p.id === id) : undefined;
  if (pursuitsText && !d) return undefined;
  const plan = parseWheelPlan(id, read(`${SCORECARD_DIR}/${id}.json`));
  return d?.plan ? { ...plan, campaign: d.plan } : plan;
}
