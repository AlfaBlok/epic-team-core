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
    const byRow = p.row ? homeOf(ix, nodes, { repo: p.repo, code: p.row }) : undefined;
    let home = byRow;
    if (!home && p.epic) {
      const spine = epics.get(`${repoKey(p.repo)}:${p.epic}`);
      if (spine) home = homeOf(ix, nodes, { repo: p.repo, path: spine.slice(spine.indexOf(":") + 1) });
    }
    if (home) return { ...p, wheel: { id: home.pursuit.id, name: nameOf(home.pursuit) } };
    const named = byObjective(p, nodes);
    return named ? { ...p, wheel: named } : { ...p };
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

/** the pages one objective (or a set inside it) holds: its row's spine, or its epic's, is in that subtree. */
export function pagesOfObjective(pages: PagesBody | undefined, body: ScorecardsBody | undefined, ix: ScorecardIndex, nodeId: string): PageView[] {
  if (!pages) return [];
  const scope = ix.scope.get(nodeId);
  if (!scope) return [];
  const epics = epicSpines(body);
  const out: PageView[] = [];
  for (const g of pages.groups ?? [])
    for (const p of g.pages) {
      const rowSpine = p.row ? ix.codes.get(`${repoKey(p.repo)}:${p.row}`) : undefined;
      const spine = rowSpine && scope.has(rowSpine) ? rowSpine : epics.get(`${repoKey(p.repo)}:${p.epic}`);
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
export function wheelCounts(placed: PlacedPage[], nodes: ScorecardNode[]): { id: string; name: string; count: number; world?: boolean }[] {
  const by = new Map<string, number>();
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
