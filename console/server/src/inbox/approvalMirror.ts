import path from "node:path";
import { resolveRepo } from "../adapters/repos.js";
import type { SpineWrite, SpineWriter } from "./spineWrite.js";
import { deployerName, opsRepo, ownerName } from "../identity.js";

/**
 * since the root half of
 * `secret put --the app platform` runs with a pinned environment, so it reads approvals only from the infra repo's own `docs/*.md`
 * (`~/github/the infra repo/docs` on the main server), never from the caller's SECRET_DOCS_DIR. A key ask answered in
 * another repo's spine was therefore refused ("--approved is not one") although its `[answered …]` line was
 * written and pushed first. The key card now mirrors that answered line into the infra repo's
 * `docs/secret-approvals-from-other-repos.md` (the file agents filled by hand for) before the put, and
 * takes it out again when the key is not stored. The tool's guard is unchanged: only a line for an ask the owner answered
 * by pasting the key on its card is written, naming that ask's keys and its source.
 */
/** the ops repo: its docs hold the approvals the root `secret` reads */
export const approvalsRepoName = (): string => opsRepo();
export const APPROVALS_FILE = "docs/secret-approvals-from-other-repos.md";

/** The the infra repo checkout the root `secret` reads (CONSOLE_SECRET_APPROVALS_REPO overrides; undefined: none here). */
export function approvalsRepo(reposRoot: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return resolveRepo(reposRoot, env.CONSOLE_SECRET_APPROVALS_REPO || approvalsRepoName())?.path;
}

/** A source text never opens a bracket, so it cannot carry a second `[answered CODE …]` the tool would honour. */
const noBrackets = (s: string) => s.replace(/\[/g, "(").replace(/\]/g, ")");

export interface MirrorAsk {
  code: string;
  question: string;
  app: string;
  name: string;
  /** The ask's repo as the milestone names it (`memory-ai/memory` or `memory`) and its spine path in that repo. */
  repo: string;
  path: string;
}

export const mirrorLine = (a: MirrorAsk, date: string) => {
  const q = noBrackets(a.question.replace(/\s+/g, " ").trim()).slice(0, 200);
  const where = `${a.repo.split("/").pop()} ${a.path}`;
  const src = a.repo.includes("/") ? `[${where}](https://github.com/${a.repo}/blob/main/${a.path})` : where;
  return `- [answered ${a.code} ${date} @${ownerName()}] ${noBrackets(where)}: ${q} — keys: ${a.app} ${a.name} — source: ${src} (${ownerName()} pasted the key on the console key card; mirrored by the console)`;
};

const appendLine = (text: string, line: string) => (text && !text.endsWith("\n") ? `${text}\n` : text) + `${line}\n`;
const dropLine = (text: string, line: string) => {
  const raw = text.split("\n");
  const at = raw.findIndex((l) => l.replace(/\r$/, "") === line);
  if (at < 0) return undefined;
  raw.splice(at, 1);
  return raw.join("\n");
};
/** The file already approves this code for this key (an earlier mirror, or one an agent wrote by hand). */
const hasLine = (text: string, a: MirrorAsk) =>
  text.split("\n").some((l) => new RegExp(`\\[answered ${a.code.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}\\b`).test(l) && l.includes(a.name));

export type Mirror =
  /** `line` set: written now (take it back on failure); unset: nothing to do (no checkout, same repo, already there). */
  | { ok: true; line?: string; repoDir?: string; note?: string }
  | { ok: false; reason: string };

/**
 * Write the mirror line (commit + push to the infra repo main, docs only: main-direct, no deploy gate). Skipped when there is
 * no the infra repo checkout, the ask lives in the infra repo's own docs, or the line is there already.
 */
export async function mirrorApproval(o: { spine: SpineWriter; reposRoot: string; askRepoDir: string; ask: MirrorAsk }): Promise<Mirror> {
  const repoDir = approvalsRepo(o.reposRoot);
  if (!repoDir) return { ok: true, note: `no ${opsRepo()} checkout` };
  if (path.resolve(repoDir) === path.resolve(o.askRepoDir) && path.posix.dirname(o.ask.path) === "docs") return { ok: true, note: `the ask is in ${opsRepo()} docs` };
  let line = "";
  const w: SpineWrite = await o.spine.edit({
    repoDir,
    path: APPROVALS_FILE,
    label: o.ask.code,
    edit: (text, date) => {
      if (hasLine(text, o.ask)) return { skip: `${o.ask.code} is mirrored already` };
      line = mirrorLine(o.ask, date);
      return {
        text: appendLine(text, line),
        msg: `Secrets: mirror answered ${o.ask.code} for ${o.ask.app} ${o.ask.name} (${ownerName()}, via console key card)`,
        body: `${ownerName()} pasted ${o.ask.app} ${o.ask.name} on the console card of ask ${o.ask.code} (${o.ask.repo} ${o.ask.path}). The root half of secret put --${deployerName().toLowerCase()} reads approvals only from this repo's docs, so the console mirrors his answered line here before the put. Names only; the value goes to secret put on stdin.`,
      };
    },
  });
  if (w.status === "written") return { ok: true, line, repoDir };
  if (w.status === "skipped" && /mirrored already/.test(w.reason ?? "")) return { ok: true, note: w.reason };
  return { ok: false, reason: w.reason ?? w.status };
}

/** Take a mirror line back out (the key was not stored, so the approval must not linger for another caller). */
export async function dropMirror(o: { spine: SpineWriter; repoDir: string; line: string; code: string; why: string }): Promise<SpineWrite> {
  return o.spine.edit({
    repoDir: o.repoDir,
    path: APPROVALS_FILE,
    label: o.code,
    edit: (text) => {
      const t = dropLine(text, o.line);
      return t === undefined
        ? { skip: `the ${o.code} mirror line changed since it was written; nothing taken back` }
        : { text: t, msg: `Secrets: mirror of ${o.code} taken back: key not stored (console)`, body: `secret put failed, so the mirrored ${o.code} line is removed.\n\nReason: ${o.why}` };
    },
  });
}
