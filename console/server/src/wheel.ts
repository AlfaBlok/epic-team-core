import fs from "node:fs";
import path from "node:path";
import { parsePursuits, PURSUITS_FILE, ranksOf, type PursuitsDoc } from "./pursuits.js";
import { noFalseGreen, parseScorecardFile, SCORECARD_DIR, type ScorecardFile } from "./scorecards.js";
import { productFor, readMaps, sameRepoName, type Grows, type Totem, type TotemMaps } from "./totemMap.js";
import { wheelTrackers, type TrackerTable } from "./trackers.js";
import { turnerOf, type Turner } from "./personaGaps.js";
import { milestoneOfEpic } from "./pursuitRoutes.js";
import type { Assignment, Milestone, Persona } from "./store.js";

/**
 * The wheel as one record (the kernel page's finding "A wheel is one object: no such thing in code").
 * The owner, 17 Nov 19:53Z: "the wheel is an object ... three classes of wheel"; root L-71: one objective and the whole
 * machine that moves it until every key result is green.
 *
 * Its parts stay where they are written (docs/pursuits.json stays the one objectives list); this is the one
 * place that joins them, so every screen, prompt and script reads the same wheel:
 *   objective     docs/pursuits.json (its entry: name, green-when, rank, epics, plan, owner)
 *   key results   docs/scorecards/<id>.json
 *   map           docs/totems/every-product.json (the kernel's boxes) + the product's docs/totems/<product>.json
 *   trackers      the kernel's, the product's and its own (docs/trackers/<id>/tables.json)
 *   plan          its objective's `plan` entry (a campaign spine's `## Plan`)
 *   personas      the console's assignments on the milestones that run its epics (the console's cache of the team repo)
 * Scripts read it at GET /api/wheels and /api/wheels/<id> (scripts/wheel.py), never a second loader.
 */

export const WHEEL_PARTS = ["objective", "keyResults", "map", "trackers", "plan", "personas"] as const;

export interface WheelKeyResult {
  label: string;
  owner?: string;
  doneMeans?: string;
  value?: string;
  target?: string;
  colour?: string;
  evidence?: unknown;
  work: string[];
}
export interface WheelPersona {
  milestoneId: string;
  milestone: string;
  persona: string;
  enabled: boolean;
  parked: boolean;
}
export interface Wheel {
  id: string;
  name: string;
  greenWhen: string;
  /** his order, 1 first; parked: none. */
  rank: number | null;
  parked: boolean;
  /** the persona the idle watch wakes (default the Delivery Manager). */
  owner: string;
  /** the product (class) it belongs to: the map that lists it, else the objective's declared product. */
  product?: { id: string; name: string };
  epics: { repo: string; path: string }[];
  keyResults: WheelKeyResult[];
  /** its key results are shown inside another wheel's (the scorecard's `foldedInto`). */
  foldedInto?: string;
  /** the kernel's boxes every wheel has, then its product's own. */
  map: { kernel: Totem[]; own: Totem[]; grows: Grows[] };
  trackers: TrackerTable[];
  plan?: { repo: string; path: string };
  personas: WheelPersona[];
  /** on: a persona turns it; off: all switched off; none: no persona (personaGaps.ts). */
  turner: Turner;
  /** where each part was read, so a reader can follow it to its file. */
  sources: Record<(typeof WHEEL_PARTS)[number], string>;
}

/** the personas on the milestones that run these epics; injected by the console (its store), empty for a bare read. */
export type PersonasOf = (epics: { repo: string; path: string }[]) => WheelPersona[];

const readText = (p: string) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};

function keyResultsOf(f: ScorecardFile | null): WheelKeyResult[] {
  return (f?.keyResults ?? []).map((k) => {
    const x = k as typeof k & { owner?: unknown };
    return {
      label: k.label,
      ...(typeof x.owner === "string" ? { owner: x.owner } : {}),
      ...(k.doneMeans ? { doneMeans: k.doneMeans } : {}),
      ...(k.value ? { value: k.value } : {}),
      ...(k.target ? { target: k.target } : {}),
      ...(k.colour ? { colour: noFalseGreen(k.colour, k) } : {}),
      ...(k.evidence !== undefined ? { evidence: k.evidence } : {}),
      work: Array.isArray(k.work) ? k.work.filter((w) => typeof w === "string") : [],
    };
  });
}

/** One read of the home repo's part files, for many wheels at once. */
export function wheelReader(home: string | undefined, personasOf: PersonasOf = () => []) {
  const doc: PursuitsDoc = parsePursuits((home && readText(path.join(home, PURSUITS_FILE))) ?? "");
  const maps: TotemMaps = readMaps(home);
  const ranks = ranksOf(doc);
  const one = (id: string): Wheel | null => {
    const p = doc.pursuits.find((x) => x.id === id);
    if (!p || !home) return null;
    const pm = productFor(maps, { objective: p.id }) ?? (p.product ? maps.products.find((m) => m.product === p.product) : undefined);
    const scFile = `${SCORECARD_DIR}/${p.id}.json`;
    const sc = parseScorecardFile(readText(path.join(home, scFile)) ?? "");
    const personas = personasOf(p.epics);
    return {
      id: p.id,
      name: p.name,
      greenWhen: p.greenWhen,
      rank: ranks.get(p.id) ?? null,
      parked: p.parked,
      owner: p.owner ?? "Delivery Manager",
      ...(pm ? { product: { id: pm.product, name: pm.name } } : p.product ? { product: { id: p.product, name: p.product } } : {}),
      epics: p.epics,
      keyResults: keyResultsOf(sc),
      ...(sc?.foldedInto ? { foldedInto: sc.foldedInto } : {}),
      map: { kernel: maps.every.totems, own: pm?.totems ?? [], grows: [...maps.every.grows, ...(pm?.grows ?? [])] },
      trackers: wheelTrackers(home, p.id)?.tables ?? [],
      ...(p.plan ? { plan: p.plan } : {}),
      personas,
      turner: turnerOf(personas.map((x) => ({ persona: x.persona, enabled: x.enabled, parked: x.parked }))),
      sources: {
        objective: `${PURSUITS_FILE} #${p.id}`,
        keyResults: sc ? scFile : `${scFile} (none yet)`,
        map: `docs/totems/every-product.json + ${pm ? `docs/totems/${pm.product}.json` : "no product map lists it"}`,
        trackers: `docs/totems/ trackers + docs/trackers/${p.id}/`,
        plan: p.plan ? `${p.plan.repo} ${p.plan.path} § Plan` : `${PURSUITS_FILE} #${p.id} has no plan entry`,
        personas: "the console's assignments on the milestones that run its epics",
      },
    };
  };
  return {
    ids: () => doc.pursuits.map((p) => p.id),
    one,
    all: () => doc.pursuits.map((p) => one(p.id)).filter((w): w is Wheel => !!w),
    /** the wheel whose epics (or plan) hold this spine: how a milestone finds its wheel. */
    ofSpine: (repo: string | undefined, spine: string): string | undefined =>
      !repo
        ? undefined
        : doc.pursuits.find((p) => p.epics.some((e) => sameRepoName(e.repo, repo) && e.path === spine) || (!!p.plan && sameRepoName(p.plan.repo, repo) && p.plan.path === spine))?.id,
  };
}

/** the console's personas of a wheel: every live milestone that runs one of its epics, each assignment on it. */
export function storePersonas(s: { listMilestones: () => Milestone[]; listAssignments: (f: { milestoneId: string }) => Assignment[]; getPersona: (id: string) => Persona | undefined }): PersonasOf {
  return (epics) => {
    const live = s.listMilestones().filter((m) => !m.settledAt);
    const ms = [...new Map(epics.map((e) => milestoneOfEpic(live, e.repo, e.path)?.m).filter((m): m is Milestone => !!m).map((m) => [m.id, m])).values()];
    return ms.flatMap((m) =>
      s.listAssignments({ milestoneId: m.id }).map((a) => ({ milestoneId: m.id, milestone: m.title, persona: s.getPersona(a.personaId)?.name ?? "", enabled: a.enabled, parked: !!a.parkedAt && a.parkedReason !== "settled" })),
    );
  };
}

/** a single wheel, read fresh. */
export const readWheel = (home: string | undefined, id: string, personasOf?: PersonasOf) => wheelReader(home, personasOf).one(id);
