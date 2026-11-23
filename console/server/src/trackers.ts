import fs from "node:fs";
import path from "node:path";
import { csvOf } from "./totemMap.js";
import { parsePursuits, PURSUITS_FILE } from "./pursuits.js";

/**
 * The owner, 2026-11-18: "the wheel object can have several tracker
 * objects inside of it. And the tracker object is just a table with entries and status and whatever quality you can have
 * at columns ... these tables I want them to be accessible at the wheel level ... some tables we pre-load ... we have the
 * influencer table. So it ships empty ... if we need something else, then you ask for it, but you don't improvise it."
 *
 * A wheel is one objective in docs/pursuits.json. Its tables, one source each (scripts/trackers.py writes, this reads):
 * the frame (docs/totems/every-product.json `trackers`), its product's (docs/totems/<product>.json `trackers`), its own
 * asked-for ones (docs/trackers/<wheel>/tables.json, open once `yes` holds his yes). Rows: docs/trackers/<wheel>/<id>.csv.
 */

export const TRACKERS_DIR = "docs/trackers";
export interface TrackerTable {
  id: string;
  name: string;
  for?: string;
  columns: string[];
  statuses: string[];
  /** the columns on an entry's folded line; the rest show when he unfolds it. None: every column. */
  shown?: string[];
  from: "frame" | "product" | "own";
  /** rows may be written (an asked-for table waits for his yes). */
  open: boolean;
  yes?: string;
  rows: string[][];
  /** entries per status, in the table's status order; statuses in `notCounted` are left out. */
  counts: { status: string; n: number }[];
  /** entries kept on the table but left out of its count (the team's own test sign-ups), per status. */
  uncounted?: { status: string; n: number }[];
  /** where the rows come from when they are not in the repo: a source the console fills from its own database. */
  source?: string;
  file: string;
}
export interface WheelTrackers {
  wheel: string;
  name: string;
  product?: string;
  tables: TrackerTable[];
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const strs = (v: unknown) => arr(v).flatMap((x) => (str(x) ? [str(x)!] : []));
const readJson = (p: string): Record<string, unknown> => {
  try {
    return obj(JSON.parse(fs.readFileSync(p, "utf8")));
  } catch {
    return {};
  }
};

type Def = Omit<TrackerTable, "from" | "open" | "rows" | "counts" | "uncounted" | "file"> & { notCounted?: string[] };

/**
 * The owner: "I think the tester applications are a tracker inside the ... objective": a table declared with `source` (scripts/trackers.py) takes its rows from the console's own database,
 * never from a csv in the repo (sign-ups are private: never a repo). The layer that owns the data registers the source;
 * a console without it shows the table empty.
 */
export type TrackerSource = (columns: string[]) => string[][];
const SOURCES = new Map<string, TrackerSource>();
export function registerTrackerSource(id: string, rows: TrackerSource): void {
  SOURCES.set(id, rows);
}
/**
 * The owner, 22 Nov (vn_99680bcb): "the ID of the tester is their email. I want to see the email ... clearly". A table
 * whose rows sit in the repo can still carry a private column the repo never holds: the layer that owns it registers a
 * join for `<wheel>/<table>`, which may add columns (the first one becomes the entry's id) and fill them each time the
 * tab opens. Synchronous: a join reads its own cache and never waits.
 */
export type TrackerJoin = (t: { columns: string[]; shown?: string[] }, rows: string[][]) => { columns: string[]; shown?: string[]; rows: string[][] };
const JOINS = new Map<string, TrackerJoin>();
export function registerTrackerJoin(key: string, join: TrackerJoin): void {
  JOINS.set(key, join);
}
function defs(v: unknown): Def[] {
  return arr(obj(v).tables).flatMap((t) => {
    const o = obj(t);
    const id = str(o.id), name = str(o.name), columns = strs(o.columns);
    if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id) || !name || columns.length < 2) return [];
    const shown = strs(o.shown).filter((c) => columns.includes(c));
    const notCounted = strs(o.notCounted);
    return [{ id, name, columns, statuses: strs(o.statuses), ...(str(o.source) ? { source: str(o.source) } : {}), ...(notCounted.length ? { notCounted } : {}), ...(shown.length ? { shown: [columns[0], ...shown.filter((c) => c !== columns[0])] } : {}), ...(str(o.for) ? { for: str(o.for) } : {}), ...(str(o.yes) ? { yes: str(o.yes) } : {}) }];
  });
}

/** one wheel's tables with their rows; null when no objective has that id. */
export function wheelTrackers(home: string | undefined, wheel: string): WheelTrackers | null {
  if (!home || !/^[\w-]+$/.test(wheel)) return null;
  let pursuit: { id: string; name: string; product?: string } | undefined;
  try {
    pursuit = parsePursuits(fs.readFileSync(path.join(home, PURSUITS_FILE), "utf8")).pursuits.find((p) => p.id === wheel);
  } catch {
    return null;
  }
  if (!pursuit) return null;
  const dir = path.join(home, "docs/totems");
  let frame: Def[] = [], mine: Def[] = [], product = pursuit.product;
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    /* no map: only own tables */
  }
  const maps = files.map((f) => ({ f, d: readJson(path.join(dir, f)) }));
  frame = defs(maps.find((m) => m.f === "every-product.json")?.d.trackers);
  // its product: the map that lists the objective, else the objective's declared product
  const prod = maps.find((m) => m.f !== "every-product.json" && strs(m.d.objectives).includes(wheel)) ?? maps.find((m) => m.f !== "every-product.json" && !!product && str(m.d.product) === product);
  if (prod) {
    product = str(prod.d.product) ?? product;
    mine = defs(prod.d.trackers);
  }
  const own = defs(readJson(path.join(home, TRACKERS_DIR, wheel, "tables.json")));
  const seen = new Set<string>();
  const tables: TrackerTable[] = [];
  for (const [from, list] of [["frame", frame], ["product", mine], ["own", own]] as const)
    for (const t of list) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const { notCounted = [], ...def } = t;
      const file = t.source ? `the console's database (${t.source})` : `${TRACKERS_DIR}/${wheel}/${t.id}.csv`;
      let rows: string[][] = [];
      try {
        rows = t.source ? (SOURCES.get(t.source)?.(t.columns) ?? []) : csvOf(fs.readFileSync(path.join(home, file), "utf8")).rows;
      } catch {
        /* nothing written yet: ships empty */
      }
      const join = JOINS.get(`${wheel}/${t.id}`);
      if (join) {
        try {
          const j = join({ columns: def.columns, ...(def.shown ? { shown: def.shown } : {}) }, rows);
          def.columns = j.columns;
          if (j.shown) def.shown = j.shown;
          rows = j.rows;
        } catch {
          /* a join that fails leaves the repo's rows as they are */
        }
      }
      const si = def.columns.indexOf("Status");
      const by = new Map<string, number>();
      for (const r of rows) by.set(r[si] || "no status", (by.get(r[si] || "no status") ?? 0) + 1);
      const rank = (s: string) => (t.statuses.includes(s) ? t.statuses.indexOf(s) : 99);
      const all = si < 0 ? [] : [...by].map(([status, n]) => ({ status, n })).sort((a, b) => rank(a.status) - rank(b.status));
      const counts = all.filter((c) => !notCounted.includes(c.status));
      const uncounted = all.filter((c) => notCounted.includes(c.status));
      tables.push({ ...def, from, open: from !== "own" || !!t.yes, rows: rows.slice(0, 500), counts, ...(uncounted.length ? { uncounted } : {}), file });
    }
  return { wheel, name: pursuit.name, ...(product ? { product } : {}), tables };
}
