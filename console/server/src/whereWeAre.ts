import fs from "node:fs";
import path from "node:path";
import { SCORECARD_DIR } from "./scorecards.js";

/**
 * Each objective's one where-we-are (part of the kernel the owner said yes to): a file beside its key results,
 * docs/scorecards/<objective id>.md, read first and rewritten last by every worker and wake on the objective
 * (the home repo's scripts/where_we_are.py writes it). Three parts: the answer now, the open questions, what changed.
 * The objective's Context tab opens with it.
 */
export const WHERE_PARTS = ["The answer now", "Open questions", "What changed"] as const;
export type WhereWeAre = {
  path: string;
  present: boolean;
  /** the last rewrite: when, by which run, for which row */
  at?: string;
  by?: string;
  row?: string;
  answer?: string;
  open: string[];
  changed: string[];
};

const STAMP = /^Rewritten (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z) by (\S+) for (\S+)\./m;
const ID = /^[\w-]{1,80}$/;

export const whereRel = (id: string) => `${SCORECARD_DIR}/${id}.md`;

/** the file's parts from its text (mirrors parse() in the script). */
export function parseWhereWeAre(text: string, rel: string): WhereWeAre {
  const parts = new Map<string, string>();
  const re = /^## (.+)\n([\s\S]*?)(?=^## |(?![\s\S]))/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) parts.set(m[1].trim(), m[2].trim());
  const bullets = (s?: string) => (s ?? "").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
  const s = STAMP.exec(text);
  const answer = parts.get(WHERE_PARTS[0]);
  return {
    path: rel,
    present: true,
    ...(s ? { at: s[1], by: s[2], row: s[3] } : {}),
    ...(answer ? { answer } : {}),
    open: bullets(parts.get(WHERE_PARTS[1])),
    changed: bullets(parts.get(WHERE_PARTS[2])),
  };
}

/** an objective's where-we-are from the checkout that holds its key results; undefined for an id that is not one. */
export function readWhereWeAre(dir: string | undefined, id: string): WhereWeAre | undefined {
  if (!ID.test(id)) return undefined;
  const rel = whereRel(id);
  if (!dir) return { path: rel, present: false, open: [], changed: [] };
  try {
    return parseWhereWeAre(fs.readFileSync(path.join(dir, rel), "utf8"), rel);
  } catch {
    return { path: rel, present: false, open: [], changed: [] };
  }
}

/**
 * the wake prompt's section: the objective's where-we-are whole, to read before the wake plans, and the one command
 * that rewrites it as the wake's last step. "" when the milestone sits under no objective.
 */
export function whereWeAreSection(dir: string | undefined, id: string | undefined, name: string | undefined, home: string): string {
  if (!id) return "";
  const v = readWhereWeAre(dir, id);
  if (!v) return "";
  let body = "None written yet: this wake's rewrite starts it.";
  if (v.present && dir) {
    try {
      body = fs.readFileSync(path.join(dir, v.path), "utf8").trim();
    } catch {
      /* read above; gone since */
    }
  }
  return [
    `## Where we are: ${name ?? id} (read first, rewrite last; its Context tab, ${v.path})`,
    body,
    `Last step of this wake, when it moved anything on this objective: \`python3 ~/github/${home}/scripts/where_we_are.py write ${id} --row <the row you moved> --by <run id> --answer "<the answer now>" --open "<each open question>" --changed "<what changed>"\` ` +
      "(a newer word of his overtakes an older line: drop it, never keep both).",
  ].join("\n");
}
