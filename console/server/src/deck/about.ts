import type { Assignment, Milestone, Persona } from "../store.js";
import type { BigRocks } from "./bigRocks.js";

/**
 * each deck and the big rocks board say on screen who keeps them, on which milestone, how often,
 * which repo they come from and where the owner's voice notes come from (the memory service), with a link to that persona's settings.
 * Who is read from the repo, never made up here: the board's `Kept by:` line names a persona of the team repo
 * (state/personas, root L-45), its assignment gives the milestone and the cadence; a deck's workers are the personas on
 * the console milestone that tracks its spine, or the nearest one above it.
 */

export interface PageKeeper {
  name: string;
  personaId?: string;
  milestoneId?: string;
  milestone?: string;
  /** "every day at 13:00 Madrid time", from the assignment. */
  cadence?: string;
  enabled?: boolean;
}

export interface RocksAbout {
  file: string;
  repo: string;
  /** The `Kept by:` line, and the persona it names when the team has it. */
  keptBy: string | null;
  keeper: PageKeeper | null;
  /** The `Refresh:` and `Sources:` lines. */
  refresh: string | null;
  sources: string | null;
  lastRead: string | null;
}

export interface DeckAbout {
  repo: string;
  spinePath: string;
  /** The console milestone whose personas work this epic: its own, or the nearest one above it (`own` false). */
  milestone: { id: string; title: string; own: boolean } | null;
  workers: PageKeeper[];
  /** The console's daily refresh (book/refresh.ts): pulls the repos and rebuilds every deck. No persona runs it. */
  refresh: { at: string; lastOkAt: string | null };
  rocks: RocksAbout | null;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The server's own zone, as people say it ("Madrid time"); fixed_time cadences run in it (cycle/nextRun.ts). */
export function zoneWord(tz = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  if (!tz || tz === "UTC" || tz === "Etc/UTC") return "UTC";
  return `${tz.split("/").pop()!.replace(/_/g, " ")} time`;
}

export function cadenceText(c: Assignment["cadence"], zone = zoneWord()): string {
  if (c.type === "interval") {
    const m = c.everyMinutes;
    if (m % 1440 === 0) return m === 1440 ? "every day" : `every ${m / 1440} days`;
    if (m % 60 === 0) return m === 60 ? "every hour" : `every ${m / 60} hours`;
    return `every ${m} minutes`;
  }
  const days = [...new Set(c.weekdays)].sort();
  const when = days.length === 7 ? "every day" : days.length === 5 && !days.includes(0) && !days.includes(6) ? "every weekday" : `on ${days.map((d) => DAYS[d]).join(", ")}`;
  return `${when} at ${c.timeOfDay} ${zone}`;
}

/** The hour of a UTC clock time in the server's zone ("06:00 Madrid time" for 5 UTC in winter). */
export function utcHourText(hourUtc: number, now = Date.now(), tz = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  const d = new Date(now);
  const at = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hourUtc));
  const hm = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz });
  return `${hm} ${zoneWord(tz)}`;
}

interface Team {
  personas: Persona[];
  assignments: Assignment[];
  milestones: Milestone[];
}

const keeperOf = (t: Team, p: Persona, a?: Assignment): PageKeeper => {
  const m = a && t.milestones.find((x) => x.id === a.milestoneId);
  return {
    name: p.name,
    personaId: p.id,
    ...(m ? { milestoneId: m.id, milestone: m.title } : {}),
    ...(a ? { cadence: cadenceText(a.cadence), enabled: a.enabled } : {}),
  };
};

export function rocksAbout(rocks: BigRocks, t: Team): RocksAbout {
  const keptBy = rocks.keptBy ?? null;
  const name = keptBy?.split(/[(,;·]/)[0].trim().toLowerCase();
  const p = name ? t.personas.find((x) => x.name.toLowerCase() === name) : undefined;
  const a = p && (t.assignments.find((x) => x.personaId === p.id && x.enabled) ?? t.assignments.find((x) => x.personaId === p.id));
  return {
    file: rocks.file,
    repo: rocks.repo,
    keptBy,
    keeper: p ? keeperOf(t, p, a) : keptBy ? { name: keptBy } : null,
    refresh: rocks.refresh ?? null,
    sources: rocks.sources ?? null,
    lastRead: rocks.lastRead,
  };
}

/**
 * Who works a deck's epic: the personas on the milestone that tracks its spine, or on the nearest milestone above it
 * (`chain` is the spine's path, then its parents' paths, nearest first). Each persona once, enabled ones first.
 */
export function deckWorkers(chain: string[], milestoneOf: (path: string) => Milestone | undefined, t: Team): Pick<DeckAbout, "milestone" | "workers"> {
  for (let i = 0; i < chain.length; i++) {
    const m = milestoneOf(chain[i]);
    if (!m) continue;
    const own = t.assignments.filter((a) => a.milestoneId === m.id).sort((a, b) => Number(b.enabled) - Number(a.enabled));
    const seen = new Set<string>();
    const workers = own.flatMap((a) => {
      const p = t.personas.find((x) => x.id === a.personaId);
      if (!p || seen.has(p.id)) return [];
      seen.add(p.id);
      return [keeperOf(t, p, a)];
    });
    return { milestone: { id: m.id, title: m.title, own: i === 0 }, workers };
  }
  return { milestone: null, workers: [] };
}
