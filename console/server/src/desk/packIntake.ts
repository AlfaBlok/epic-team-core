import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ownerName } from "../identity.js";

/**
 * the desk intake rule of a repo's packs. A repo turns a pack on with one AGENTS.md line (`Pack: social`); the pack
 * says which kinds of desk-chat message there are and where each lands (`pack.py <name> --wake-text`, epic-spine skill). The
 * Team desk and a repo desk carry that text in their prompt, so they file each message where the pack says and reply with
 * where it landed (file + link).
 */

// moved unchanged from cycle/totemsWake.ts.
/**
 * how a desk or campaign chat files every message from the owner in a social-pack repo. Carried
 * with the pack's own intake kinds; this rule names the part of the epic each kind lands in.
 */
export const TOTEM_FILING_RULE = [
  `### Where ${ownerName()}'s words land (the four parts of the epic: Brief, Observations, History, Work)`,
  `File every message from ${ownerName()} in exactly one part of the epic it is about (the campaign's spine; the root spine when it is about all; when you cannot tell, ask one line: \"this campaign or all?\"). Never leave it only in this chat: no persona reads a chat transcript.`,
  `- A change of intent (tone, priority, a key message, what we must never do) → **Brief**: the campaign plan part or the \`data/brief.md\` section it changes, in his words (with Undo), plus an **Observations** line \`L-<n> | ${ownerName()} | <his words> | <where it came from> | <date>\` in that spine's \`## Operating Learnings\`.`,
  "- A judgement (\"this works\", \"too technical\") → **Observations**: one `L-<n>` line with his words and where he said it.",
  "- A thing to do (research, a logo, a post, a thread to answer) → **Work**: a task row in that spine's `## Issue Ledger` with an owner (the role whose job it is; `unassigned` for the Delivery manager to place), a status and the outcome to come.",
  "- A yes or no → **History**: a `## Decisions` row.",
  "- Then one **History** line for what you filed (`- HH:MM <your name>: filed <kind> in <part>, <link>`) in that epic's week log page, same commit.",
  "Your reply says first which part it landed in (Brief / Observations / History / Work) and links the file#section, then the line written and who acts next.",
].join("\n");

/** `Pack: social` / `EpicSpine packs: social, sales`, as the skill's pack.py reads it. */
const OPT_IN = /^(?:EpicSpine\s+)?packs?:\s*(.+?)\s*$/gim;

/** Pack names a checkout's AGENTS.md turns on, in order, deduplicated; [] when there is none. */
export function packsOn(repoDir: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(repoDir, "AGENTS.md"), "utf8");
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const m of text.matchAll(OPT_IN))
    for (const n of m[1].replace(/`/g, "").split(/[,\s]+/)) if (n && !names.includes(n.toLowerCase())) names.push(n.toLowerCase());
  return names;
}

/** A pack's wake text, or undefined (no skill, unknown pack, no intake). */
export type IntakeRunner = (pack: string) => Promise<string | undefined>;

/** Runs `python3 <skillDir>/scripts/pack.py <pack> --wake-text`; a good answer is kept (it changes only with a skill update). */
export function packIntakeRunner(skillDir: string, timeoutMs = 15_000): IntakeRunner {
  const script = path.join(skillDir, "scripts", "pack.py");
  const kept = new Map<string, string>();
  return (pack) => {
    if (!/^[a-z0-9_-]+$/.test(pack)) return Promise.resolve(undefined);
    const hit = kept.get(pack);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => {
      execFile("python3", [script, pack, "--wake-text"], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        const text = err ? "" : stdout.trim();
        if (text) kept.set(pack, text);
        resolve(text || undefined);
      });
    });
  };
}

/**
 * The prompt section for one repo: its packs' intake rules (the pack's own heading line replaced by one naming the repo),
 * links as GitHub file URLs when the repo has a remote. Undefined when no pack of the repo has an intake.
 */
export async function intakeSection(repo: { name: string; path: string; remote?: string }, run: IntakeRunner): Promise<string | undefined> {
  const parts: string[] = [];
  for (const pack of packsOn(repo.path)) {
    const text = await run(pack).catch(() => undefined);
    if (!text) continue;
    const body = text.replace(/^#{1,6} .*\n?/, "").trim();
    parts.push(
      [
        `## Desk intake: ${repo.name} (pack ${pack})`,
        `Applies to what ${ownerName()} says here about ${repo.name}. ` +
          (repo.remote
            ? `Links: https://github.com/${repo.remote}/blob/main/<path>#<anchor> (a table row: #L<line>), after the write is pushed.`
            : `Links: the repo path with its #anchor (${repo.name} has no GitHub remote).`),
        "The reply to each message he sends about it states, first, where it landed: the kind, the file and section, the link, the line written; or the one-line question back when the kind is unclear.",
        "",
        body,
        // a social repo's desk files the owner's words in one of the epic's four parts and says where.
        ...(pack === "social" ? ["", TOTEM_FILING_RULE] : []),
      ].join("\n"),
    );
  }
  return parts.length ? parts.join("\n\n") : undefined;
}

/** Every intake section for repos under the checkouts root (the Team desk spans them all). */
export async function intakeSections(repos: { name: string; path: string; remote?: string }[], run: IntakeRunner): Promise<string | undefined> {
  const parts: string[] = [];
  for (const r of repos) {
    const s = await intakeSection(r, run);
    if (s) parts.push(s);
  }
  return parts.length ? parts.join("\n\n") : undefined;
}
