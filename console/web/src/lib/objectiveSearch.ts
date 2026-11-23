import type { ScorecardNode, ScorecardRow, ScorecardRowState, ScorecardWork } from "@/api/pursuit-types";
import { scorecardHref } from "@/lib/scorecards";

/**
 * The owner 22 Nov 23:12Z (vn_de2da36f): "a search feature that searches across all the objectives and all
 * the key results and all the tickets attached to them ... in the top left section with inbox, chat, runs, messages".
 * Pure: it reads the objectives the sidebar already holds (GET /api/scorecards: his objectives, their key results and the
 * tickets under each), so a search answers on the phone with no new call. Plain words in: every word must appear
 * (any case, accents ignored); results come back in three groups, in his order, each with its state and its link.
 */
export const OBJECTIVE_SEARCH_PATH = "search";
export const OBJECTIVE_SEARCH_MIN = 2;

export interface ObjectiveHit {
  id: string;
  name: string;
  /** the shorter goal line under its name, when it says more. */
  line?: string;
  greens: number;
  total: number;
  state: ScorecardRowState;
  href: string;
}
export interface KeyResultHit {
  key: string;
  label: string;
  state: ScorecardRowState;
  value?: string;
  target?: string;
  objective: string;
  href: string;
}
export interface TicketHit {
  key: string;
  code: string;
  repo: string;
  title?: string;
  status?: string;
  kind: ScorecardWork["kind"];
  state: ScorecardRowState;
  /** where it hangs: its objective and key result ("" when it hangs under none yet). */
  objective: string;
  keyResult?: string;
  href: string;
}
export interface ObjectiveSearchResult {
  q: string;
  objectives: ObjectiveHit[];
  keyResults: KeyResultHit[];
  tickets: TicketHit[];
  total: number;
}

/** lower case, accents dropped ("Condesa" finds "condesá"). */
export const fold = (s: string | null | undefined) =>
  (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** the searched words: two letters or more in all, split on spaces. */
export const wordsOf = (q: string) => fold(q).split(/\s+/).filter(Boolean);

const hasAll = (words: string[], ...texts: (string | null | undefined)[]) => {
  const hay = fold(texts.filter(Boolean).join(" \u0001 "));
  return words.every((w) => hay.includes(w));
};

const CLOSED = /^(done|superseded|cancelled|canceled|moved|dropped|parked)\b/i;
const workState = (w: ScorecardWork): ScorecardRowState => w.state ?? (CLOSED.test(w.status ?? "") ? "green" : w.kind === "unknown" ? "unknown" : "amber");

/** the objective's colour: every key result green is green, any red is red, nothing measured is grey, else amber. */
function objectiveState(krs: ScorecardRow[]): ScorecardRowState {
  if (!krs.length) return "unknown";
  if (krs.every((k) => k.state === "green")) return "green";
  if (krs.some((k) => k.state === "red")) return "red";
  if (krs.every((k) => k.state === "unknown")) return "unknown";
  return "amber";
}

/** a key result's place: its objective's Key results tab with that row open and in view. */
export const keyResultHref = (objectiveId: string, label: string, row?: string) => {
  const q = new URLSearchParams({ kr: label });
  if (row) q.set("row", row);
  return `${scorecardHref(objectiveId)}?${q}`;
};

export function searchObjectives(nodes: readonly ScorecardNode[] | undefined, q: string, keyResultsOf: (n: ScorecardNode) => ScorecardRow[]): ObjectiveSearchResult {
  const words = wordsOf(q);
  const out: ObjectiveSearchResult = { q: q.trim(), objectives: [], keyResults: [], tickets: [], total: 0 };
  if (words.join("").length < OBJECTIVE_SEARCH_MIN) return out;
  const seen = new Set<string>();
  // his objectives, in his order (folded ones last: they show inside another objective).
  const all = [...(nodes ?? [])].sort((a, b) => Number(!!a.foldedInto) - Number(!!b.foldedInto));
  for (const n of all) {
    const krs = keyResultsOf(n);
    const name = n.name;
    const line = n.headline && n.headline !== name ? n.headline : undefined;
    if (hasAll(words, name, n.headline, n.objective, n.code))
      out.objectives.push({ id: n.id, name, line, greens: krs.filter((k) => k.state === "green").length, total: krs.length, state: objectiveState(krs), href: scorecardHref(n.id) });
    for (const r of krs) {
      if (hasAll(words, r.label, r.note, r.doneMeans, r.value, r.target))
        out.keyResults.push({ key: `${n.id}|${r.label}`, label: r.label, state: r.state, value: r.value, target: r.target, objective: name, href: keyResultHref(n.id, r.label) });
      for (const w of r.work ?? []) {
        const key = `${w.repo}:${w.code}`;
        if (seen.has(key) || !hasAll(words, w.code, w.title, w.status, w.epicCode)) continue;
        seen.add(key);
        out.tickets.push({ key, code: w.code, repo: w.repo, title: w.title, status: w.status, kind: w.kind, state: workState(w), objective: name, keyResult: r.label, href: keyResultHref(n.id, r.label, w.code) });
      }
    }
    for (const w of n.unplaced ?? []) {
      const key = `${w.repo}:${w.code}`;
      if (seen.has(key) || !hasAll(words, w.code, w.title, w.status, w.epicCode)) continue;
      seen.add(key);
      out.tickets.push({ key, code: w.code, repo: w.repo, title: w.title, status: w.status, kind: w.kind, state: workState(w), objective: name, href: `${scorecardHref(n.id)}?${new URLSearchParams({ row: w.code })}` });
    }
  }
  // open tickets first, the closed ones after (each group keeps his order).
  out.tickets.sort((a, b) => Number(a.state === "green") - Number(b.state === "green"));
  out.total = out.objectives.length + out.keyResults.length + out.tickets.length;
  return out;
}
