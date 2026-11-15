import fs from "node:fs";
import path from "node:path";
import { stripInline } from "../adapters/markdown.js";
import { PURSUITS_FILE } from "../pursuits.js";
import type { SpineWriter } from "./spineWrite.js";

/**
 * the owner, an accepted rule (vn_cdcf1208): his order of work changes only when he edits his
 * objectives. When one of his notes names a new first thing, the team asks him one line, "Put X first in your
 * objectives?", and "you can make that question also very high up ... because otherwise, if the question reaches me
 * 10 notifications deep, then already we've defeated the purpose".
 *
 * The ask is an ordinary `approve` ask with two extra fields:
 *   - [ask E907-A21: approve @Sam since 2026-11-15 row E907-S3] Put Team browser first in your objectives? — label: priority
 *     — objective: team-browser — context: … — recommend: … — unblocks: …
 * The inbox pins every open priority ask above every section and pressing item; his Yes (approve, or a plain "Yes"
 * answer) moves that objective to the top of docs/pursuits.json, the one objectives file (one commit, the same writer as
 * the objectives screen's arrows); his No closes the ask and changes nothing.
 */

export const PRIORITY_LABEL = "priority";
/**
 * the rule the Team desk (its [his objectives] block) and every wake carry: whoever reads his note raises the ask.
 * Written with the owner's name at call time (identity.ts), so a world's own owner reads his own name.
 */
export const priorityAskRule = (owner: string) =>
  `His order changes only when he edits his objectives: a note of ${owner}'s naming a new first thing gets one \`approve\` ask ` +
  `"Put <objective> first in your objectives?" \`— label: priority — objective: <id in docs/pursuits.json>\`, never a reorder by you.`;
export const isPriorityLabel = (v: string) => /^(?:priority|first thing|order of work)$/i.test(stripInline(v).trim());
/** the ask's `objective: <pursuit id>` field. */
export const OBJECTIVE_SEG = /^\s*objective\s*:\s*(.+?)\s*$/i;

/** his answer reads as yes: the approve button, or a plain answer that starts with Yes. */
export function saysYes(kind: string, text: string): boolean {
  if (kind === "approve") return true;
  if (kind !== "answer") return false;
  return /^\s*(?:yes|yep|ok|okay|sure|go ahead|put it first)\b/i.test(text);
}

/**
 * The pursuits file text with `id` first, the others in their order; `null` when there is no such objective,
 * "same" when it already leads.
 */
export function moveFirstText(text: string, id: string): string | null | "same" {
  const doc = JSON.parse(text) as Record<string, unknown>;
  const list = Array.isArray(doc.pursuits) ? (doc.pursuits as Record<string, unknown>[]) : [];
  const at = list.findIndex((p) => p && typeof p === "object" && p.id === id);
  if (at < 0) return null;
  if (at === 0) return "same";
  doc.pursuits = [list[at], ...list.slice(0, at), ...list.slice(at + 1)];
  return JSON.stringify(doc, null, 2) + "\n";
}

/**
 * Where his Yes writes: the ask's own checkout when it holds an objectives file (a test world's repo keeps its own),
 * else the home world's objectives checkout. Never a second list.
 */
export function pursuitsDirFor(askRepoDir: string | undefined, homeDir: string | undefined): string | undefined {
  if (askRepoDir && fs.existsSync(path.join(askRepoDir, PURSUITS_FILE))) return askRepoDir;
  return homeDir && fs.existsSync(path.join(homeDir, PURSUITS_FILE)) ? homeDir : undefined;
}

export type PriorityMove = { ok: true; note: string } | { ok: false; retry: boolean; error: string };

/** His Yes on a priority ask: one commit that puts the objective first in the objectives file. */
export async function putFirst(
  o: { dir: string | undefined; objective: string; code?: string; by: string; words?: string },
  writer: Pick<SpineWriter, "edit">,
): Promise<PriorityMove> {
  if (!o.dir) return { ok: false, retry: false, error: "no objectives file on this host to put it first in" };
  let missing = false;
  const w = await writer.edit({
    repoDir: o.dir,
    path: PURSUITS_FILE,
    label: "priority ask",
    verify: false,
    fetchFreshMs: 30_000,
    edit: (text) => {
      let out: string | null | "same";
      try {
        out = moveFirstText(text, o.objective);
      } catch {
        out = null;
      }
      if (out === null) {
        missing = true;
        return { skip: "no such objective" };
      }
      if (out === "same") return { skip: "already first" };
      return {
        text: out,
        msg: `${o.by}: ${o.objective} first in the objectives${o.code ? ` (${o.code})` : ""}`,
        body: `${o.by} said yes to ${o.code ?? "the priority ask"} in the inbox: the objective ${o.objective} now leads docs/pursuits.json.${o.words?.trim() ? `\n\nHis words: ${o.words.trim()}` : ""}`,
      };
    },
  });
  if (missing) return { ok: false, retry: false, error: `no objective ${o.objective} in the objectives file` };
  if (w.status === "skipped" && w.reason === "already first") return { ok: true, note: "already first" };
  if (w.status !== "written") return { ok: false, retry: w.status === "failed", error: `not saved: ${w.reason ?? w.status}` };
  return { ok: true, note: w.sha ? `first in ${PURSUITS_FILE} at ${w.sha.slice(0, 9)}` : `first in ${PURSUITS_FILE}` };
}
