import fs from "node:fs";
import path from "node:path";
import { SCORECARD_DIR } from "./scorecards.js";

/**
 * an EpicTeam objective's Blueprint chapter, the build-out's twin of the social product's message house. His words,
 * 28 Nov 12:47Z (Log/2026-11-28.md#^e-497258): "for Epic Team, in the chapters, we need to have like some hard truths about
 * the project we're building. Know some like basic blueprints, just like we have a messaging pillar for the ...
 * campaigns". One file per objective beside its key results, docs/scorecards/blueprints/<objective id>.md, in two parts:
 * `## Hard truths` (what stays true whatever we build) and `## Blueprint` (the parts of what is being built), each a list.
 */
export const BLUEPRINT_PARTS = ["Hard truths", "Blueprint"] as const;
export type Blueprint = { path: string; present: boolean; what?: string; truths: string[]; parts: string[]; engine?: { path: string; text: string } };
/** the engine's own blueprint, how every app is built, shown under each objective's own (one chapter, one file). */
export const ENGINE_BLUEPRINT = "docs/blueprint/README.md";

const ID = /^[\w-]{1,80}$/;
export const blueprintRel = (id: string) => `${SCORECARD_DIR}/blueprints/${id}.md`;

export function parseBlueprint(text: string, rel: string): Blueprint {
  const parts = new Map<string, string>();
  const re = /^## (.+)\n([\s\S]*?)(?=^## |(?![\s\S]))/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) parts.set(m[1].trim(), m[2].trim());
  const bullets = (s?: string) => (s ?? "").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
  // the line under the title: what is being built, in one sentence
  const what = /^# .+\n+([^#\n-][^\n]*)/m.exec(text)?.[1]?.trim();
  return { path: rel, present: true, ...(what ? { what } : {}), truths: bullets(parts.get(BLUEPRINT_PARTS[0])), parts: bullets(parts.get(BLUEPRINT_PARTS[1])) };
}

/** an objective's blueprint from the checkout that holds its key results; undefined for an id that is not one. */
export function readBlueprint(dir: string | undefined, id: string): Blueprint | undefined {
  if (!ID.test(id)) return undefined;
  const rel = blueprintRel(id);
  if (!dir) return { path: rel, present: false, truths: [], parts: [] };
  let engine: Blueprint["engine"];
  try {
    engine = { path: ENGINE_BLUEPRINT, text: fs.readFileSync(path.join(dir, ENGINE_BLUEPRINT), "utf8") };
  } catch {
    engine = undefined;
  }
  try {
    return { ...parseBlueprint(fs.readFileSync(path.join(dir, rel), "utf8"), rel), ...(engine ? { engine } : {}) };
  } catch {
    return { path: rel, present: false, truths: [], parts: [], ...(engine ? { engine } : {}) };
  }
}
