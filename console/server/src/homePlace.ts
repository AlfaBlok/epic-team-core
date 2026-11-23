import fs from "node:fs";
import path from "node:path";

/**
 * The objective each homed file was made for, when its row's spine sits in no objective's tree (the owner's ask: "place
 * the older files on their objectives"). Older files come from the console's own epics, which hang off the root, so
 * the tree alone left most of them on none.
 *
 * In order, the first that answers:
 *   kr     a key result lists the row in its `work` (docs/scorecards/<objective id>.json): the objective it moves;
 *   epic   the row's epic (E907-S3 -> EPIC-907 of the same repo) in `objectiveByEpic` of docs/pages/registry.json,
 *          the same map that places the pages (scripts/pages.py place);
 *   path   the longest prefix in `objectiveByPath` of that registry, for a file no row made (a persona's daily notes).
 * A file none of these place is named in `notPlacedByPath` with its reason, or it is a gap scripts/totems.py check names.
 * Only live objectives (docs/pursuits.json) count: a map naming a retired one places nothing.
 * The console still places by the tree first (wheelPages.ts); this is the fallback for what the tree does not hold.
 */

export interface Placement {
  objective?: string;
  placedBy?: "kr" | "epic" | "path";
  notPlaced?: string;
}

export interface PlaceMaps {
  live: Set<string>;
  /** "<repo>:<row>" or "<row>" -> objective ids in his order. */
  kr: Map<string, string[]>;
  /** "<repo>:EPIC-<n>" -> objective id. */
  byEpic: Record<string, string>;
  byPath: Record<string, string>;
  notPlacedByPath: Record<string, string>;
}

const readJson = (f: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return undefined;
  }
};

/** the work lists, the epic and path maps, from the home repo (empty maps when a file is missing). */
export function readPlaceMaps(homeDir: string | undefined): PlaceMaps {
  const empty: PlaceMaps = { live: new Set(), kr: new Map(), byEpic: {}, byPath: {}, notPlacedByPath: {} };
  if (!homeDir) return empty;
  const pursuits = (readJson(path.join(homeDir, "docs/pursuits.json")) as { pursuits?: { id: string }[] } | undefined)?.pursuits ?? [];
  const live = new Set(pursuits.map((p) => p.id));
  const kr = new Map<string, string[]>();
  for (const p of pursuits) {
    const sc = readJson(path.join(homeDir, "docs/scorecards", `${p.id}.json`)) as { keyResults?: { work?: unknown[] }[] } | undefined;
    for (const k of sc?.keyResults ?? [])
      for (const w of k.work ?? []) {
        const key = typeof w === "string" ? w : typeof w === "object" && w ? String((w as { row?: string; code?: string }).row ?? (w as { code?: string }).code ?? "") : "";
        if (!key) continue;
        const was = kr.get(key) ?? [];
        if (!was.includes(p.id)) kr.set(key, [...was, p.id]);
      }
  }
  const reg = (readJson(path.join(homeDir, "docs/pages/registry.json")) ?? {}) as { objectiveByEpic?: Record<string, string>; objectiveByPath?: Record<string, string>; notPlacedByPath?: Record<string, string> };
  return { live, kr, byEpic: reg.objectiveByEpic ?? {}, byPath: reg.objectiveByPath ?? {}, notPlacedByPath: reg.notPlacedByPath ?? {} };
}

const short = (repo: string) => repo.split("/").pop() ?? repo;
const EPIC_OF = /^E(\d+)-/;

/** the objective one file was made for, by its row's key result, its row's epic, or its path. */
export function placeOf(m: PlaceMaps, e: { repo: string; path: string; row?: string }): Placement {
  const repo = short(e.repo);
  const ok = (id: string | undefined) => (id && m.live.has(id) ? id : undefined);
  if (e.row) {
    const ids = m.kr.get(`${repo}:${e.row}`) ?? m.kr.get(e.row);
    const k = ids?.find((x) => m.live.has(x));
    if (k) return { objective: k, placedBy: "kr" };
    const n = EPIC_OF.exec(e.row);
    const ep = n ? ok(m.byEpic[`${repo}:EPIC-${n[1]}`]) : undefined;
    if (ep) return { objective: ep, placedBy: "epic" };
  }
  const longest = (map: Record<string, string>) =>
    Object.keys(map)
      .filter((p) => { const [r, pre] = p.includes(":") ? [p.slice(0, p.indexOf(":")), p.slice(p.indexOf(":") + 1)] : [repo, p]; return short(r) === repo && e.path.startsWith(pre); })
      .sort((a, b) => b.length - a.length)[0];
  const pk = longest(m.byPath);
  const byPath = pk ? ok(m.byPath[pk]) : undefined;
  if (byPath) return { objective: byPath, placedBy: "path" };
  const nk = longest(m.notPlacedByPath);
  return nk ? { notPlaced: m.notPlacedByPath[nk] } : {};
}

/** the maps, read again at most every 30 s (the registry and scorecards change a few times an hour). */
export function createPlacer(homeDir: () => string | undefined, ttlMs = 30_000) {
  let at = 0;
  let maps: PlaceMaps | undefined;
  return <T extends { repo: string; path: string; row?: string }>(entries: T[]): (T & Placement)[] => {
    if (!maps || Date.now() - at > ttlMs) {
      maps = readPlaceMaps(homeDir());
      at = Date.now();
    }
    const m = maps;
    return entries.map((e) => ({ ...e, ...placeOf(m, e) }));
  };
}
