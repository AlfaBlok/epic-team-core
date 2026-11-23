import fs from "node:fs";
import path from "node:path";
import { homeRepo } from "../identity.js";
import { newestWordsSection, readHisWords } from "../desk/hisObjectives.js";

/**
 * Context to read first: the desk's new-or-existing lookup, kept on the ticket when it is filed (the home repo's
 * scripts/ticket_context.py writes docs/context/<row>.md in the row's repo: the top hits with a score and a link each).
 * Every worker brief opens with it. The owner: "when we create a ticket ... why shouldn't we include in the ticket
 * itself, Hey, make sure that you understand this context before attacking the problem".
 */
export const CONTEXT_HEAD = "Context to read first";
export const contextRel = (row: string) => `docs/context/${row}.md`;
const ROW = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;

/** the brief's opening section from a sidecar's text: its numbered list under one heading (mirrors section() in the script). */
export function contextSection(text: string, rel: string): string {
  const lines = text.split("\n");
  const list = lines.filter((l) => /^(\d+\.|- )/.test(l));
  const built = (lines.find((l) => l.startsWith("Built ")) ?? "").split(" by ")[0];
  return [`## ${CONTEXT_HEAD} (${rel})`, `${built || "Kept"} when the ticket was filed. Read each before you plan.`, ...list].join("\n") + "\n";
}

/** how a brief gets the section when the row has none yet: the script builds it, writes it and commits it. */
export const contextMissing = (row: string, repo?: string): string =>
  `## ${CONTEXT_HEAD} (${contextRel(row)})\nNone kept for ${row} yet: run \`python3 ~/github/${homeRepo()}/scripts/ticket_context.py brief ${row} --repo ~/github/${repo || homeRepo()}\` ` +
  "(it builds the lookup, writes and commits the file) and open the brief with what it prints.\n";

/** the section for one row of a checkout, or undefined when the row has no sidecar (or the row id is not one). */
export function readTicketContext(repoDir: string | undefined, row: string): string | undefined {
  if (!repoDir || !ROW.test(row)) return undefined;
  try {
    return contextSection(fs.readFileSync(path.join(repoDir, contextRel(row)), "utf8"), contextRel(row));
  } catch {
    return undefined;
  }
}

/**
 * his newest words on the objectives a worker brief names: read from the home repo's his words file beside the
 * row's checkout; "" when none is named or the file is missing.
 */
export function briefNewestWords(repoDir: string | undefined, brief: string): string {
  if (!repoDir) return "";
  return newestWordsSection(readHisWords(path.dirname(repoDir), homeRepo()), brief);
}
