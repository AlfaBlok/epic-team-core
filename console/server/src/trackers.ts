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
/**
 * The owner 2026-11-18: "it needs to be sortable, and it needs to have clarity for which ones are the target
 * for wave 1 and which are not ... what is the wave 1 message?" and "one clear column, proposed for first message, yes or
 * no". A table may name its `first` column (yes or no); docs/trackers/<wheel>/<id>.wave.json holds that wave's messages.
 */
export interface TrackerMessage {
  name: string;
  for?: string;
  who: string[];
  text: string;
}
export interface TrackerWave {
  name: string;
  state?: string;
  missing: string[];
  fill?: string;
  messages: TrackerMessage[];
}
export interface TrackerTable {
  id: string;
  name: string;
  for?: string;
  columns: string[];
  statuses: string[];
  from: "frame" | "product" | "own";
  /** rows may be written (an asked-for table waits for his yes). */
  open: boolean;
  yes?: string;
  rows: string[][];
  /** the yes or no column whose yes entries go first. */
  first?: string;
  wave?: TrackerWave;
  /** entries per status, in the table's status order. */
  counts: { status: string; n: number }[];
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
function waveOf(p: string): TrackerWave | undefined {
  if (!fs.existsSync(p)) return undefined;
  const o = readJson(p);
  const messages = arr(o.messages).flatMap((m) => {
    const x = obj(m), name = str(x.name), text = typeof x.text === "string" ? x.text.trim() : "";
    return name && text ? [{ name, text, who: strs(x.who), ...(str(x.for) ? { for: str(x.for) } : {}) }] : [];
  });
  if (!messages.length) return undefined;
  return { name: str(o.name) ?? "Wave 1", missing: strs(o.missing), messages, ...(str(o.state) ? { state: str(o.state) } : {}), ...(str(o.fill) ? { fill: str(o.fill) } : {}) };
}
const readJson = (p: string): Record<string, unknown> => {
  try {
    return obj(JSON.parse(fs.readFileSync(p, "utf8")));
  } catch {
    return {};
  }
};

type Def = Omit<TrackerTable, "from" | "open" | "rows" | "counts" | "file" | "wave">;
function defs(v: unknown): Def[] {
  return arr(obj(v).tables).flatMap((t) => {
    const o = obj(t);
    const id = str(o.id), name = str(o.name), columns = strs(o.columns);
    if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id) || !name || columns.length < 2) return [];
    return [{ id, name, columns, statuses: strs(o.statuses), ...(str(o.for) ? { for: str(o.for) } : {}), ...(str(o.yes) ? { yes: str(o.yes) } : {}), ...(str(o.first) && columns.includes(str(o.first)!) ? { first: str(o.first) } : {}) }];
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
      const file = `${TRACKERS_DIR}/${wheel}/${t.id}.csv`;
      let rows: string[][] = [];
      try {
        rows = csvOf(fs.readFileSync(path.join(home, file), "utf8")).rows;
      } catch {
        /* nothing written yet: ships empty */
      }
      const si = t.columns.indexOf("Status");
      const by = new Map<string, number>();
      for (const r of rows) by.set(r[si] || "no status", (by.get(r[si] || "no status") ?? 0) + 1);
      const rank = (s: string) => (t.statuses.includes(s) ? t.statuses.indexOf(s) : 99);
      const counts = si < 0 ? [] : [...by].map(([status, n]) => ({ status, n })).sort((a, b) => rank(a.status) - rank(b.status));
      const wave = t.first ? waveOf(path.join(home, TRACKERS_DIR, wheel, `${t.id}.wave.json`)) : undefined;
      tables.push({ ...t, from, open: from !== "own" || !!t.yes, rows: rows.slice(0, 500), counts, file, ...(wave ? { wave } : {}) });
    }
  return { wheel, name: pursuit.name, ...(product ? { product } : {}), tables };
}
