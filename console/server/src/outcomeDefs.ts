import fs from "node:fs";
import path from "node:path";
import { homeRepo, hostReposRoot } from "./identity.js";

/**
 * What counts as an outcome, per persona: one file in the home repo,
 * `docs/outcomes/what-counts.json` (the repo is the source, root L-45), read here for three uses:
 * every wake prompt and worker brief carries its persona's definition, the Outcomes page shows it beside each
 * persona, and a reported outcome line that matches a `neverCounts` pattern (a check, a restamp, a wake that ran)
 * is refused, never written.
 */
export const DEFS_FILE = "docs/outcomes/what-counts.json";
/** the name worker runs log under: a Delivery Manager's child run does a row, it is not the manager's wake. */
export const TICKET_WORKER = "Ticket worker";

export interface PersonaDef {
  persona: string;
  counts: string;
  doesNot: string;
  examples?: string[];
}
export interface OutcomeDefs {
  rule: string;
  neverCounts: { pattern: string; why: string }[];
  default: { counts: string; doesNot: string };
  personas: PersonaDef[];
}

/** used when the file is not in the checkout (a fresh tenant): the rule alone. */
export const FALLBACK_DEFS: OutcomeDefs = {
  rule: "An outcome is something that is now true and was not before. Doing the work (checking, reading, a wake that ran, a restamp) is activity: log nothing for it.",
  neverCounts: [],
  default: { counts: "Something now true that the owner can open or that changed a row, a rule or an ask.", doesNot: "Checking, reading, a wake that ran, a restamp, a claim, work started." },
  personas: [],
};

let dirOverride: string | undefined;
/** where the file is read from (the home repo checkout); tests and the server entry set it. */
export function setOutcomeDefsDir(dir: string | undefined): void {
  dirOverride = dir;
  cache = undefined;
}
const defsPath = () => path.join(dirOverride ?? path.join(hostReposRoot(), homeRepo()), DEFS_FILE);

let cache: { file: string; mtime: number; defs: OutcomeDefs } | undefined;

export function parseDefs(text: string): OutcomeDefs {
  const j = JSON.parse(text) as Partial<OutcomeDefs>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return {
    rule: str(j.rule) || FALLBACK_DEFS.rule,
    neverCounts: (Array.isArray(j.neverCounts) ? j.neverCounts : []).filter((n) => {
      if (!n || !str(n.pattern)) return false;
      try {
        new RegExp(n.pattern, "i");
        return true;
      } catch {
        return false;
      }
    }),
    default: { counts: str(j.default?.counts) || FALLBACK_DEFS.default.counts, doesNot: str(j.default?.doesNot) || FALLBACK_DEFS.default.doesNot },
    personas: (Array.isArray(j.personas) ? j.personas : []).filter((p) => p && str(p.persona) && str(p.counts)),
  };
}

/** the definitions in force (re-read when the file changes). */
export function outcomeDefs(): OutcomeDefs {
  const file = defsPath();
  try {
    const mtime = fs.statSync(file).mtimeMs;
    if (cache && cache.file === file && cache.mtime === mtime) return cache.defs;
    const defs = parseDefs(fs.readFileSync(file, "utf8"));
    cache = { file, mtime, defs };
    return defs;
  } catch {
    return FALLBACK_DEFS;
  }
}

/** a persona's own definition (matched by name, any case), else the default. */
export function defFor(persona: string, defs = outcomeDefs()): PersonaDef {
  const p = defs.personas.find((d) => d.persona.toLowerCase() === persona.trim().toLowerCase());
  return p ?? { persona, ...defs.default };
}

/** the line every wake prompt and worker brief carries after the outcome log rule. */
export function outcomeDefLine(persona: string, defs = outcomeDefs()): string {
  const d = defFor(persona, defs);
  const ex = d.examples?.[0];
  return (
    `What counts as an outcome for you (${persona}): ${d.counts} Does not count: ${d.doesNot}${ex ? ` Example: "${ex}".` : ""} ` +
    `${defs.rule} The console refuses a line that only reports activity (it starts "Checked", "Started", "Claimed", says "duty done", "restamped", "nothing new"). ` +
    `All personas' definitions: ${DEFS_FILE} in ${homeRepo()}.`
  );
}

/** why a reported line is activity, not an outcome (undefined = it counts). */
export function activityWhy(text: string, defs = outcomeDefs()): string | undefined {
  for (const n of defs.neverCounts) if (new RegExp(n.pattern, "i").test(text)) return n.why;
  return undefined;
}
