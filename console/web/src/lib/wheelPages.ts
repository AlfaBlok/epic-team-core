import type { PagesBody, PageView } from "@/api/pages-types";
import type { ScorecardNode, ScorecardsBody } from "@/api/pursuit-types";
import { homeOf, repoKey, type ScorecardIndex } from "@/lib/scorecards";
import { sameRepo } from "@/lib/repoNames";

/**
 * Pages live inside the wheel they belong to (the owner, vn_dad96778, 2026-11-15): each objective (and a milestone no
 * objective holds, like the house) has its own Pages tab, and the global Pages list still shows them all together.
 * A page names its row and epic (docs/pages/registry.json); the row's spine sits in an objective's tree, so the page
 * does too. A row no objective holds goes by its epic (the spine whose code it names); else the page is "not placed".
 * When neither sits in an objective's tree (the console's own epics hang off the root), the page's own `objective`
 * (docs/pages/registry.json, written by scripts/pages.py place) names the objective or world it was made for.
 * Pure: one placement for the tab and the list, so they never disagree.
 */

/** "repo:SPINE-CODE" → "repo:path" of that spine (the epic a page names), from the scorecards' spine info. */
function epicSpines(body: ScorecardsBody | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const [k, s] of Object.entries(body?.spineInfo ?? {})) {
    const code = (s as { code?: string }).code;
    if (code) {
      const i = k.indexOf(":");
      const key = `${repoKey(k.slice(0, i))}:${code}`;
      if (!m.has(key)) m.set(key, `${repoKey(k.slice(0, i))}:${k.slice(i + 1).replace(/^\.\//, "")}`);
    }
  }
  return m;
}

export interface PlacedPage extends PageView {
  /** the objective it sits in (the top of his order that holds it), or none: not placed. */
  wheel?: { id: string; name: string; world?: boolean };
}

const nameOf = (n: ScorecardNode) => n.headline ?? n.name;

/** every page with the objective it sits in, in the list's own order. */
export function placePages(pages: PagesBody | undefined, body: ScorecardsBody | undefined, ix: ScorecardIndex): PlacedPage[] {
  if (!pages) return [];
  const epics = epicSpines(body);
  const nodes = body?.nodes ?? [];
  const all = [...(pages.groups ?? []).flatMap((g) => g.pages)];
  return all.map((p) => {
    // the registry's own `objective` wins: a page made for one objective, from a row whose spine hangs
    // in another's tree (check rows that all live in one epic), shows on the objective it was made for.
    const named = byObjective(p, nodes);
    if (named) return { ...p, wheel: named };
    const byRow = p.row ? homeOf(ix, nodes, { repo: p.repo, code: p.row }) : undefined;
    let home = byRow;
    if (!home && p.epic) {
      const spine = epics.get(`${repoKey(p.repo)}:${p.epic}`);
      if (spine) home = homeOf(ix, nodes, { repo: p.repo, path: spine.slice(spine.indexOf(":") + 1) });
    }
    return home ? { ...p, wheel: { id: home.pursuit.id, name: nameOf(home.pursuit) } } : { ...p };
  });
}

/** the objective (or world) a page names itself, when its spine sits in none. */
function byObjective(p: PageView, nodes: ScorecardNode[]): PlacedPage["wheel"] {
  if (!p.objective) return undefined;
  const n = nodes.find((x) => x.id === p.objective);
  if (n) return { id: n.id, name: nameOf(n) };
  return p.objectiveName ? { id: p.objective, name: p.objectiveName, world: true } : undefined;
}

/** whether a page's row (or epic) spine sits in any objective's tree. */
function inAnyTree(spine: string | undefined, ix: ScorecardIndex): boolean {
  if (!spine) return false;
  for (const set of ix.scope.values()) if (set.has(spine)) return true;
  return false;
}

/** "repo:CODE" of every ticket placed under one of the node's key results (their `work` lists). */
function ticketsOf(node: ScorecardNode | undefined): Set<string> {
  const out = new Set<string>();
  for (const kr of node?.keyResults ?? []) for (const w of kr.work ?? []) if (w.kind === "ticket") out.add(`${repoKey(w.repo)}:${w.code}`);
  return out;
}

/** the pages one objective (or a set inside it) holds: its row's spine, or its epic's, is in that subtree. */
export function pagesOfObjective(pages: PagesBody | undefined, body: ScorecardsBody | undefined, ix: ScorecardIndex, nodeId: string): PageView[] {
  if (!pages) return [];
  const scope = ix.scope.get(nodeId);
  if (!scope) return [];
  const epics = epicSpines(body);
  const tickets = ticketsOf(ix.byId.get(nodeId));
  const out: PageView[] = [];
  for (const g of pages.groups ?? [])
    for (const p of g.pages) {
      // pages follow their tickets: a row placed under one of this objective's key results brings its
      // pages here too, wherever else they sit (an item may sit in two chapters), so an objective made from existing
      // work shows that work's pages from its birth.
      if (p.row && tickets.has(`${repoKey(p.repo)}:${p.row}`)) {
        out.push(p);
        continue;
      }
      const rowSpine = p.row ? ix.codes.get(`${repoKey(p.repo)}:${p.row}`) : undefined;
      const spine = rowSpine && scope.has(rowSpine) ? rowSpine : epics.get(`${repoKey(p.repo)}:${p.epic}`);
      // a page that names a known objective sits only there: on that objective's tab, or a set inside it that holds its spine.
      const named = p.objective ? ix.byId.get(p.objective) : undefined;
      if (named) {
        const top = ix.pursuitOf.get(nodeId)?.id ?? nodeId;
        if (p.objective === nodeId || (top === p.objective && spine && scope.has(spine))) out.push(p);
        continue;
      }
      if (spine && scope.has(spine)) out.push(p);
      // a page no tree holds goes where it names itself (the objective's own tab, not its sets).
      else if (p.objective === nodeId && !inAnyTree(rowSpine, ix) && !inAnyTree(spine, ix)) out.push(p);
    }
  return out;
}

const lastPart = (r: string) => r.split("/").pop() ?? r;

/** the pages of a milestone no objective holds (its repo is its wheel: the house's pages are house_decision's). */
export function pagesOfMilestone(pages: PagesBody | undefined, repo: string | undefined): PageView[] {
  if (!pages || !repo) return [];
  return (pages.groups ?? []).flatMap((g) => g.pages).filter((p) => sameRepo(p.repo, repo) || sameRepo(lastPart(p.repo), lastPart(repo)));
}

/** the global list's view by wheel: each objective in his order with its page count, then the pages not placed. */
export function wheelCounts(placed: PlacedPage[], nodes: ScorecardNode[], files?: Map<string, unknown[]>): { id: string; name: string; count: number; world?: boolean }[] {
  const by = new Map<string, number>();
  // the pages and notes kept in the repo count on their objective too: each line opens a tab that lists both.
  for (const [id, es] of files ?? []) by.set(id, (by.get(id) ?? 0) + es.length);
  const worlds = new Map<string, string>();
  for (const p of placed)
    if (p.wheel) {
      by.set(p.wheel.id, (by.get(p.wheel.id) ?? 0) + 1);
      if (p.wheel.world) worlds.set(p.wheel.id, p.wheel.name);
    }
  return [
    ...nodes.filter((n) => by.has(n.id)).map((n) => ({ id: n.id, name: nameOf(n), count: by.get(n.id)! })),
    // a world beside the objectives (the house) after them.
    ...[...worlds].map(([id, name]) => ({ id, name, count: by.get(id)!, world: true })),
  ];
}

/**
 * The files a wheel tab homes, placed like its pages. An entry names the row that made it (its folder or the
 * commit that added it) and, for a weekly log, its spine; the objective whose tree holds that spine shows it. Every
 * entry no objective holds is returned as `notPlaced`, so the global list shows it and none is missing anywhere.
 */
type Homed = { repo: string; row?: string; spine?: string; objective?: string };
const spineOfHome = (e: Homed, ix: ScorecardIndex) => (e.spine ? `${repoKey(e.repo)}:${e.spine}` : e.row ? ix.codes.get(`${repoKey(e.repo)}:${e.row}`) : undefined);
/** the objective a file names itself (its row's key result, its row's epic, its path: homePlace.ts), when no tree holds its spine. */
const namedTop = (e: Homed, ix: ScorecardIndex, spine: string | undefined) =>
  e.objective && ix.pursuitOf.get(e.objective)?.id === e.objective && !inAnyTree(spine, ix) ? e.objective : undefined;

export function placeHomeFiles<T extends Homed>(entries: T[] | undefined, ix: ScorecardIndex): { by: Map<string, T[]>; notPlaced: T[] } {
  const by = new Map<string, T[]>();
  const notPlaced: T[] = [];
  const tops = [...ix.scope.keys()].filter((id) => ix.pursuitOf.get(id)?.id === id);
  for (const e of entries ?? []) {
    const spine = spineOfHome(e, ix);
    const home = (spine ? tops.find((id) => ix.scope.get(id)!.has(spine)) : undefined) ?? namedTop(e, ix, spine);
    if (!home) notPlaced.push(e);
    else by.set(home, [...(by.get(home) ?? []), e]);
  }
  return { by, notPlaced };
}

/** the files one objective (or a set inside it) holds: their row's spine, or their log's spine, is in its subtree. */
export function homeFilesOf<T extends Homed>(entries: T[] | undefined, ix: ScorecardIndex, nodeId: string): T[] {
  const scope = ix.scope.get(nodeId);
  if (!scope || !entries) return [];
  return entries.filter((e) => {
    const spine = spineOfHome(e, ix);
    // its spine in this subtree; or, no tree holding it, the objective it names (the objective's own tab, not its sets).
    return (!!spine && scope.has(spine)) || namedTop(e, ix, spine) === nodeId;
  });
}

/** where a homed file opens: read-only, through the console (its pages sandboxed). */
export const homeFileUrl = (e: { repo: string; open: string }) => `/api/homes/file/${encodeURIComponent(e.repo)}/${e.open.split("/").map(encodeURIComponent).join("/")}`;
