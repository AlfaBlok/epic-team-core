import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PRIORITIES_FILE, parsePriorities, worldRedLines } from "../inbox/jordiPriority.js";
import type { Store } from "../store.js";
import { computeReviewRows } from "./rows.js";

/**
 * the shared parts a world's repo must feed the same way, read with the console's own code, so
 * EpicTeam's and the social product's worlds are checked by one rule. (1) Finished tasks: every row waiting on review and what the
 * card gate makes of it (a card on his list, or needs rewriting, needs evidence, closes itself). (2) Priority levels: the
 * repo's docs/priorities.json (the Prioritizer's levels and red lines; none means its questions show no level).
 */
export interface WorldParity {
  world: string;
  checkout: string;
  finished: { total: number; cards: number; byKind: Record<string, number>; stopped: { ref: string; kind: string; reason?: string; problems?: string[] }[] };
  priorities: { file: boolean; levels: number; redLines: number };
}

/** The world's milestones as the console would hold them for one checkout: one per spine file under docs/spines. */
function checkoutStore(checkout: string): Pick<Store, "listMilestones"> {
  const dir = path.join(checkout, "docs", "spines");
  const spines = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
  const ms = spines.map((f, i) => ({ id: `ms_parity_${i}`, title: f, repo: path.basename(checkout), path: `docs/spines/${f}`, settledAt: null }));
  return { listMilestones: () => ms } as unknown as Pick<Store, "listMilestones">;
}

export function worldParity(world: string, checkout: string): WorldParity {
  const store = checkoutStore(checkout);
  const reposRoot = path.dirname(checkout);
  const rows = computeReviewRows(store, reposRoot).rows.filter((r) => !r.test);
  const byKind: Record<string, number> = {};
  for (const r of rows) byKind[r.verdict.kind] = (byKind[r.verdict.kind] ?? 0) + 1;
  const stopped = rows
    .filter((r) => r.verdict.kind === "needs-rewriting" || r.verdict.kind === "needs-evidence")
    .map((r) => ({ ref: r.ref, kind: r.verdict.kind, ...(r.verdict.reason ? { reason: r.verdict.reason } : {}), ...(r.verdict.problems?.length ? { problems: r.verdict.problems } : {}) }));
  const file = path.join(checkout, PRIORITIES_FILE);
  const has = existsSync(file);
  return {
    world,
    checkout,
    finished: { total: rows.length, cards: byKind.card ?? 0, byKind, stopped },
    priorities: { file: has, levels: has ? parsePriorities(readFileSync(file, "utf8"), path.basename(checkout)).length : 0, redLines: worldRedLines(store, reposRoot).length },
  };
}

/** A world that does not feed the shared parts like EpicTeam: a finished task the gate stops, or no priority levels. */
export const parityGaps = (p: WorldParity): string[] => [
  ...p.finished.stopped.map((s) => `${s.ref} ${s.kind}${s.reason ? `: ${s.reason}` : ""}`),
  ...(p.priorities.file ? [] : [`no ${PRIORITIES_FILE}: its questions show no level`]),
];

export function formatParity(p: WorldParity): string {
  const kinds = Object.entries(p.finished.byKind).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
  return [
    `${p.world}  (${p.checkout})`,
    `  finished tasks waiting on review: ${p.finished.total}; on his list as cards: ${p.finished.cards}  [${kinds}]`,
    ...p.finished.stopped.map((s) => `    ${s.ref}: ${s.kind}${s.problems?.length ? `: ${s.problems.join("; ")}` : s.reason ? `: ${s.reason}` : ""}`),
    `  priority levels: ${p.priorities.file ? `${PRIORITIES_FILE}, ${p.priorities.levels} levels, ${p.priorities.redLines} red lines` : `no ${PRIORITIES_FILE}: its questions show no level`}`,
  ].join("\n");
}
