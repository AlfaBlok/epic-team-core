import type { DB } from "../db.js";
import type { Milestone, Run, Store } from "../store.js";
import { rubricPatch, setRubric } from "../cycle/rubric.js";
import type { SpineWriter } from "../inbox/spineWrite.js";
import { readPlacement, type Placements } from "../desk/placements.js";
import { datedReport, heldWhat, monitorWhat, writeMonitoring, monitoringCurrent } from "./monitoringLine.js";
import fs from "node:fs";
import path from "node:path";

/**
 * carry-over, once per console (staging first, then production; `dry` says what it would do):
 *  1. rubric_settings rows (the old DB store of the owner's Unblocker rubric) → the team repo file / each spine's
 *     `Unblocker rubric:` line; the table is dropped once every row is written.
 *  2. a milestone whose status showed `monitoring` from its last wake's report (no `Monitoring:` line) gets the line
 *     written from that report, so it keeps reading monitoring now that status reads the spine only.
 *  3. desk_placement's stored `state` / `closed_at` (a sticky copy of the spine): each row's stored state is compared
 *     with what the spine says now (the state every read uses from here on), then both columns are dropped.
 */
export interface CarryLine {
  part: "rubric" | "monitoring" | "placement";
  /** rubric scope ("global" or a milestone id), milestone id, or placement id. */
  key: string;
  action: string;
  detail?: string;
}

export interface CarryDeps {
  db: DB;
  store: Pick<Store, "listMilestones" | "listRuns" | "listAssignments">;
  writer: Pick<SpineWriter, "edit">;
  spineOf: (milestoneId: string) => { dir: string; path: string } | undefined;
  placements: Pick<Placements, "read">;
  invalidate?: (dir: string) => void;
  now?: number;
}

const hasTable = (db: DB, t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const columns = (db: DB, t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
const isTopWake = (r: Run) => !r.parentRunId && r.kind !== "answer_run";

async function carryRubric(d: CarryDeps, dry: boolean): Promise<CarryLine[]> {
  if (!hasTable(d.db, "rubric_settings")) return [];
  const rows = d.db.prepare("SELECT scope, json, updated_by FROM rubric_settings ORDER BY scope").all() as { scope: string; json: string; updated_by: string | null }[];
  const out: CarryLine[] = [];
  let all = true;
  for (const r of rows) {
    const key = r.scope || "global";
    let fields: unknown;
    try {
      fields = JSON.parse(r.json);
    } catch {
      fields = undefined;
    }
    const p = rubricPatch.safeParse({ ...(fields as object), ...(r.updated_by ? { by: r.updated_by } : {}) });
    if (!p.success) {
      out.push({ part: "rubric", key, action: "unreadable", detail: r.json.slice(0, 200) });
      continue; // nothing a reader could use: dropped with the table
    }
    if (dry) {
      out.push({ part: "rubric", key, action: "would write", detail: r.json.slice(0, 200) });
      continue;
    }
    const w = await setRubric(d.db, r.scope, p.data);
    if (w.status !== "written") all = false;
    out.push({ part: "rubric", key, action: w.status === "written" ? "written" : `not written (${w.status})`, detail: w.reason ?? w.sha });
  }
  if (!dry && all) {
    d.db.exec("DROP TABLE rubric_settings");
    out.push({ part: "rubric", key: "rubric_settings", action: "table dropped", detail: `${rows.length} row(s)` });
  }
  return out;
}

async function carryMonitoring(d: CarryDeps, dry: boolean): Promise<CarryLine[]> {
  const now = d.now ?? Date.now();
  const out: CarryLine[] = [];
  for (const m of d.store.listMilestones({ includeSettled: false }) as Milestone[]) {
    if (m.paused || !m.path) continue;
    const mine = new Set(d.store.listAssignments({ milestoneId: m.id }).map((a) => a.id));
    const runs = [...mine].flatMap((id) => d.store.listRuns({ assignmentId: id, limit: 20 }));
    // the run the old status read: the milestone's newest top-level wake
    const last = runs.filter(isTopWake).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    if (!last || last.outcome !== "monitoring") continue;
    const what = last.heldOn ? heldWhat(last.heldOn) : monitorWhat(last.summary);
    const report = datedReport({ what, nextCheckAt: last.nextCheckAt ?? last.retryAt, until: last.until }, now);
    if (!report) continue; // its date passed: the old status no longer showed it either
    const at = d.spineOf(m.id);
    if (!at) {
      out.push({ part: "monitoring", key: m.id, action: "no spine on this host", detail: last.id });
      continue;
    }
    let text = "";
    try {
      text = fs.readFileSync(path.join(at.dir, at.path), "utf8");
    } catch {
      out.push({ part: "monitoring", key: m.id, action: "spine not readable", detail: at.path });
      continue;
    }
    if (monitoringCurrent(text, now)) continue; // the spine already says it (status read the line, not the run)
    if (dry) {
      out.push({ part: "monitoring", key: m.id, action: "would write", detail: `${at.path}: ${report.what} (run ${last.id})` });
      continue;
    }
    const w = await writeMonitoring({ writer: d.writer, dir: at.dir, path: at.path, runId: last.id, now }, report);
    if (w.status === "written" && w.sha) d.invalidate?.(at.dir);
    out.push({ part: "monitoring", key: m.id, action: w.status === "written" ? "written" : `not written (${w.status})`, detail: `${at.path}${w.sha ? ` ${w.sha}` : ""}${w.reason ? `: ${w.reason}` : ""}` });
  }
  return out;
}

function carryPlacements(d: CarryDeps, dry: boolean): CarryLine[] {
  if (!hasTable(d.db, "desk_placement")) return [];
  const cols = columns(d.db, "desk_placement");
  const stale = ["state", "closed_at"].filter((c) => cols.includes(c));
  if (!stale.length) return [];
  const out: CarryLine[] = [];
  const rows = d.db.prepare("SELECT * FROM desk_placement ORDER BY placed_at, rowid").all() as Record<string, string | null>[];
  const tally: Record<string, number> = {};
  for (const r of rows) {
    const text = d.placements.read(r.repo!, r.path!);
    const spine = text === undefined ? "placed (unreadable)" : (() => {
      const p = readPlacement(text, { kind: r.kind as "row", itemId: r.item_id ?? "" });
      return p.closed ?? (p.missing ? "dropped" : "placed");
    })();
    const k = `${r.state} → ${spine}`;
    tally[k] = (tally[k] ?? 0) + 1;
    if (r.state !== spine) out.push({ part: "placement", key: r.id!, action: "state differs", detail: `${k}: ${r.repo}/${r.path} ${r.kind} ${r.item_id ?? ""}`.trim() });
  }
  out.push({ part: "placement", key: "desk_placement", action: dry ? "would drop columns" : "columns dropped", detail: `${stale.join(", ")}; ${rows.length} rows: ${JSON.stringify(tally)}` });
  if (!dry) for (const c of stale) d.db.exec(`ALTER TABLE desk_placement DROP COLUMN ${c}`);
  return out;
}

export async function carryE62s8(d: CarryDeps, o: { dry: boolean }): Promise<CarryLine[]> {
  return [...(await carryRubric(d, o.dry)), ...(await carryMonitoring(d, o.dry)), ...carryPlacements(d, o.dry)];
}
