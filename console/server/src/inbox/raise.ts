import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { inside } from "../adapters/doc.js";
import { proseLines, stripInline } from "../adapters/markdown.js";
import { resolveRepo } from "../adapters/repos.js";
import type { DB } from "../db.js";
import type { Milestone, Store } from "../store.js";
import { DEFAULT_OWNER, ownerOf } from "../tenancy/owner.js";
import { askKindOf, parseAsks } from "./asks.js";
import { addToWaitingField, appendUnderWaiting, dropFromWaitingField, oneLine, replacementIn, sameText, type SpineWrite, type SpineWriter } from "./spineWrite.js";

export { addToWaitingField, dropFromWaitingField };

/**
 * an ask raised through the API (`POST /api/needs-owner`, the credits gate) is
 * written into the asker's spine as a coded `[ask <code>: …]` line under `## Waiting on`, through the one spine writer
 * (commit + push on main), and the inbox reads it from the spine like any other ask. Nothing is stored in console.db as
 * the ask: when the spine write is refused or fails, the caller gets the reason and nothing is recorded.
 */

/** Every ask code in the file, any state (`[ask: …]`, `[answered …]`, `[superseded …]`). */
const CODE_IN_TAG = /^\s*[-*]\s+\[(?:ask|answered|superseded)\s+([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)-A(\d+)\b/i;

/**
 * The next free `<epic code>-A<n>` of a spine: the prefix its asks already use (the most used one), else the code in its
 * H1 (`#: …` → ``, `# E6: …` → `E6`), else `ASK`; n = one more than the highest n of that prefix anywhere
 * in the file (answered and superseded lines too) or in `past`, the ask lines the file had before (a line taken
 * out of the spine keeps its code taken, so a later notice never reuses it).
 */
export function nextAskCode(text: string, past = ""): string {
  const codes = (s: string) => s.split("\n").flatMap((l) => {
    const m = CODE_IN_TAG.exec(l);
    return m ? [{ k: m[1].toUpperCase(), n: Number(m[2]) }] : [];
  });
  const count = new Map<string, number>();
  for (const c of codes(text)) count.set(c.k, (count.get(c.k) ?? 0) + 1);
  const used = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const h1 = proseLines(text).find((l) => /^#\s+/.test(l));
  const fromH1 = h1 ? /^#\s+(?:EPIC\s*:\s*)?([A-Za-z]+-?\d+[A-Za-z]?)\b/i.exec(stripInline(h1))?.[1] : undefined;
  const prefix = used ?? (fromH1 ?? "ASK").toUpperCase();
  const max = Math.max(0, ...[...codes(text), ...codes(past)].filter((c) => c.k === prefix).map((c) => c.n));
  return `${prefix}-A${max + 1}`;
}

/** every ask line `rel` ever had in the checkout's history (added or removed), `""` when git cannot tell. */
export function pastAskLines(repoDir: string, rel: string): string {
  try {
    const out = execFileSync("git", ["-C", repoDir, "log", "--format=", "-p", "-U0", "-G", "[-*] \\[[as]", "--", rel], { encoding: "utf8", timeout: 20_000, maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").filter((l) => /^[-+]/.test(l) && !/^(?:\+\+\+|---) /.test(l)).map((l) => l.slice(1)).join("\n");
  } catch {
    return "";
  }
}

export interface RaisedAsk {
  question: string;
  proposedAction?: string;
  /** Who raised it (persona name, or "the credits gate"); with its run when there is one. */
  askedBy: string;
  runId?: string;
  /** Ledger row the ask blocks, when the caller names one. */
  row?: string;
  /** the kind the caller names (`do`: a step only the owner can do); else read from the text. */
  kind?: "do" | "decide" | "approve" | "provide";
}

/**
 * E948-S155: a caller that writes its fields with " - " ("… - context: … - impact: … - label: urgent") gets them as the
 * line's own fields (" — "), so the card shows each in its place and reads its label; before, the whole card was one question.
 */
const FLAT_FIELD = /\s+-\s+(?=(?:context|details|impact|risks?|recommend(?:ation)?|options?|steps?|unblocks?|effort|label|why\s+[\w ]{1,20}?)\s*:)/gi;
export const fieldsApart = (question: string) => question.replace(FLAT_FIELD, " — ");

/** The ask line (human-asks v6 grammar; `approve` when an action is proposed, else the kind the question says, else `decide`). */
export function askLine(code: string, a: RaisedAsk, date: string, owner: string = DEFAULT_OWNER): string {
  // A proposed action is what the owner approves or denies (the Needs the owner contract); a bare question is read for its kind.
  const k = askKindOf(a.question);
  const kind = a.kind ?? (a.proposedAction?.trim() ? "approve" : k === "unknown" ? "decide" : k);
  const row = a.row && /^[\w.-]+$/.test(a.row) ? ` row ${a.row}` : "";
  const by = `${oneLine(a.askedBy)}${a.runId ? ` (run ${a.runId})` : ""}`;
  return [
    `- [ask ${code}: ${kind} @${owner} since ${date}${row}] ${fieldsApart(oneLine(a.question))}`,
    ...(a.proposedAction?.trim() ? [`recommend: ${oneLine(a.proposedAction)}`] : []),
    `context: raised by ${by} through the console API; the console wrote this line`,
  ].join(" — ");
}

export type RaiseResult =
  | { status: "written"; code: string; repo: string; path: string; line: number; sha?: string; reason?: string }
  | { status: "skipped" | "failed"; reason: string; repo?: string; path?: string };

export interface RaiseDeps {
  db: DB;
  store: Pick<Store, "getMilestone">;
  reposRoot: string;
  writer: SpineWriter;
  /** After a written raise: the checkout's views are recomputed (read model, trees). */
  invalidate?: (dir: string) => void;
}

/**
 * Write the ask into `rel` (default: the milestone's spine) of the milestone's checkout. The code is picked under the
 * writer's lock, from the file as it is on origin/main at that moment. A question already open in that spine is not
 * asked twice: its code comes back (`reason`), nothing is written.
 */
export async function raiseAsk(d: RaiseDeps, m: Milestone, a: RaisedAsk, rel?: string): Promise<RaiseResult> {
  const repo = resolveRepo(d.reposRoot, m.repo);
  const path = (rel ?? m.path ?? "").trim();
  if (!repo) return { status: "skipped", reason: `no checkout of “${m.repo}” under the console's repos root, so the ask has no spine to go in` };
  if (!path) return { status: "skipped", reason: `milestone ${m.id} has no spine file, so the ask has no spine to go in`, repo: repo.name };
  if (!/\.md$/i.test(path) || !inside(repo.path, path)) return { status: "skipped", reason: `${path} is not a spine file inside ${repo.name}`, repo: repo.name, path };
  if (!fs.existsSync(inside(repo.path, path)!)) return { status: "skipped", reason: `${path} is not in the ${repo.name} checkout`, repo: repo.name, path };
  if (!a.question.trim()) return { status: "skipped", reason: "the ask has no question", repo: repo.name, path };
  const owner = ownerOf(d.db, m.id);
  let code = "";
  let line = -1;
  let already: string | undefined;
  const res: SpineWrite = await d.writer.edit({
    repoDir: repo.path,
    path,
    label: "ask",
    edit: (text, date) => {
      const dup = parseAsks(text).find((x) => x.state === "open" && sameText(x.question) === sameText(oneLine(a.question)));
      if (dup) {
        already = dup.code ?? undefined;
        code = dup.code ?? "";
        line = dup.line ?? -1;
        return { text, msg: "", body: "" };
      }
      code = nextAskCode(text, pastAskLines(repo.path, path));
      const put = appendUnderWaiting(text, askLine(code, a, date, owner.handle));
      line = put.line;
      return {
        text: addToWaitingField(put.text, code, owner.name),
        msg: `Ask ${code}: raised by ${oneLine(a.askedBy).slice(0, 60)} (via console API)`,
        body:
          `${oneLine(a.question).slice(0, 300)}\n\nThe agent-team console wrote this ask into ${path} under ## Waiting on (an ask raised through ` +
          `POST /api/needs-owner lives in the spine, not in console.db)${a.runId ? `.\n\nRun: ${a.runId}` : "."}`,
      };
    },
  });
  if (res.status !== "written") return { status: res.status, reason: res.reason ?? res.status, repo: repo.name, path };
  d.invalidate?.(repo.path);
  return { status: "written", code, repo: repo.name, path, line, ...(res.sha ? { sha: res.sha } : {}), ...(already !== undefined ? { reason: "the same question is already open in the spine" } : {}) };
}

/**
 * The ask line of `code` taken out of the spine (and out of Current State's `Waiting on:`), for an ask that became moot
 * before anyone answered it (the credits notice once credits are back). git keeps the line in history.
 */
export async function retireAsk(d: RaiseDeps, m: Milestone, path: string, code: string, why: string, onlyConsoleWritten = false): Promise<SpineWrite> {
  const repo = resolveRepo(d.reposRoot, m.repo);
  if (!repo) return { status: "skipped", reason: `no checkout of “${m.repo}”` };
  const res = await d.writer.edit({
    repoDir: repo.path,
    path,
    label: code,
    edit: (text) => {
      const ask = parseAsks(text).find((x) => x.state === "open" && x.code === code && x.line !== undefined);
      if (!ask) return { skip: `the ask ${code} is not open in ${path} any more` };
      const raw = text.split("\n");
      if (onlyConsoleWritten && !raw[ask.line!].includes("the console wrote this line")) return { skip: `the ask ${code} was not raised through the console API, so only its owner takes it out` };
      // an ask replaced by another keeps one line naming it (`[superseded <code> <date> by <code>]`, the
      // skill's format), so an answer pressed on its card a moment later lands on the ask that replaced it
      const by = replacementIn(why);
      const tag = /^(\s*[-*]\s+)\[ask\b[^\]]*\](.*)$/i.exec(raw[ask.line!]!);
      if (by && by !== code && tag) raw[ask.line!] = `${tag[1]}[superseded ${code} ${new Date().toISOString().slice(0, 10)} by ${by}]${tag[2]}`;
      else raw.splice(ask.line!, 1);
      return { text: dropFromWaitingField(raw.join("\n"), code), msg: `Ask ${code} moot: ${oneLine(why).slice(0, 80)} (console)`, body: `The agent-team console took the open ask ${code} out of ${path}: ${oneLine(why)}.${by && by !== code && tag ? ` Its line now reads superseded by ${by}, so an answer to ${code} lands on ${by}.` : ""}` };
    },
  });
  if (res.status === "written") d.invalidate?.(repo.path);
  return res;
}
