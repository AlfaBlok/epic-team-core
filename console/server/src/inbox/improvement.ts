import fs from "node:fs";
import path from "node:path";
import { stripInline } from "../adapters/markdown.js";
import { DESK_INBOX_DIR, IMPROVEMENT_KIND, readInbox, type DeskNote } from "../desk/inbox.js";
import type { SpineWrite, SpineWriter } from "./spineWrite.js";
import { homeRepo, ownerName, socialProduct } from "../identity.js";

/**
 * the social product never
 * codes: when a campaign needs something built (a site link, an ads account, a tracking line), one of its personas writes
 * an improvement request, the owner approves it on his card, and EpicTeam's desk builds it. Five steps:
 *
 * 1. The persona writes an `approve` ask in its spine's `## Waiting on`, labelled `label: improvement request`, with `to:`
 *    (the world that builds it: a world id, or `EpicTeam` = the paired EpicTeam world), `campaign:`, `unblocks:` and
 *    `done means:` (what it will see once it is live).
 * 2. His card shows it as an improvement request (the console reads these fields; WaitingItem.improvement).
 * 3. On his yes (approve, once the answer is in the spine) the console drops ONE desk note in the builder world's home repo,
 *    `desk/inbox/<date>-<from>-improvement-<code>.md`, frontmatter `kind: improvement-request`, `ask: <repo>/<code>`,
 *    `request: open` (this file, `handImprovement`). Never twice: a note naming the same ask is the hand-off already made.
 * 4. The builder's Delivery Manager reads it on its next wake (desk/inbox.ts), makes a row and answers `request: taken`
 *    with its row code, or `declined` with why (scripts/desk_note.py reply --request …).
 * 5. The asking world's Delivery Manager sees every request it handed and its state on each wake (`improvementsOutSection`)
 *    and keeps the asking row waiting; when the builder closes its row it sends `request: done` with what is live.
 */

export const IMPROVEMENT_LABEL = "improvement request";
export { IMPROVEMENT_KIND };
export type RequestState = "open" | "taken" | "done" | "declined";
export const REQUEST_STATES: RequestState[] = ["open", "taken", "done", "declined"];

/** What an improvement request ask carries besides the ordinary ask fields. */
export interface Improvement {
  /** The world that builds it: a world id (`the home world`), or a product name (`EpicTeam`) resolved through the desk pair. */
  to: string;
  campaign?: string;
  doneMeans?: string;
}

export const isImprovementLabel = (v: string) => /^improvement[\s-]+request$/i.test(stripInline(v).trim());
/** A question written as "Improvement request: …" counts too (the label may be left out). */
export const IMPROVEMENT_QUESTION = /^\W*improvement[\s-]+request\s*:\s*/i;

/** The ask in the note's words: `<repo>/<code>`. */
export const askRef = (repo: string, code: string) => `${repo}/${code}`;

export interface HandInput {
  /** The asking world (its id goes in `from`). */
  fromWorld: string;
  /** The asking repo's `owner/name` (the note's `reply-to`; answers go to its desk/inbox/). */
  replyTo: string;
  /** The asking checkout's name, for `ask:` (with the code). */
  repo: string;
  code: string;
  /** The ask's question (the note's `about`, without an "Improvement request:" lead). */
  question: string;
  improvement: Improvement;
  unblocks?: string;
  context?: string;
  /** His answer as written (APPROVED, or his words). */
  answer?: string;
  /** Day he approved it (YYYY-MM-DD). */
  approvedOn: string;
  /** The world whose desk builds it (resolved `to`). */
  toWorld: string;
  /** the owner's words or ask id the ask cites (the ask gate needs one): goes in the note's `approved:`. */
  cites?: string;
}

/** The first of the owner's words in quotes (12+ characters) or his voice note / log id in these texts (askGate.ts HIS_WORDS, HIS_ASK_ID). */
export function citeOf(texts: (string | null | undefined)[]): string | undefined {
  const all = texts.filter(Boolean).join(" — ");
  return /["“][^"”]{12,}["”]/.exec(all)?.[0] ?? /\bvn_[0-9a-f]{6,}\b|\^e-[0-9a-f]{6}\b|\bLog\/\d{4}-\d{2}-\d{2}(?:\.md)?(?:#\^e-[0-9a-f]{6})?/i.exec(all)?.[0];
}

const one = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "request";

/** The note's file name and text (frontmatter as desk_note.py renders it). */
export function improvementNote(i: HandInput): { rel: string; text: string } {
  const about = one(i.question.replace(IMPROVEMENT_QUESTION, "")).slice(0, 200);
  const rel = `${DESK_INBOX_DIR}/${i.approvedOn}-${slug(i.fromWorld).slice(0, 30)}-improvement-${slug(i.code)}.md`;
  const fm: [string, string | undefined][] = [
    ["from", i.fromWorld],
    ["about", `Improvement request: ${about}`],
    ["reply-to", i.replyTo],
    ["status", "open"],
    ["kind", IMPROVEMENT_KIND],
    ["ask", askRef(i.repo, i.code)],
    ["to", i.toWorld],
    ["campaign", i.improvement.campaign],
    ["unblocks", i.unblocks],
    ["done-means", i.improvement.doneMeans],
    ["approved", `${ownerName()} ${i.approvedOn} on card ${i.code}${i.cites ? `, citing ${one(i.cites).slice(0, 200)}` : ""}`],
    ["request", "open"],
  ];
  const answer = one(i.answer);
  const words = answer && !/^approved\.?$/i.test(answer) ? answer : "";
  const body = [
    `${ownerName()} approved this improvement request on ${i.approvedOn} on his card ${i.code} (${i.fromWorld}).${words ? ` His words: "${words}"` : ""}`,
    "",
    `What is wanted: ${about}`,
    ...(i.improvement.campaign ? [`For the campaign: ${one(i.improvement.campaign)}`] : []),
    ...(i.unblocks ? [`It unblocks: ${one(i.unblocks)}`] : []),
    ...(i.improvement.doneMeans ? [`Done means: ${one(i.improvement.doneMeans)}`] : []),
    ...(i.context ? [`Context: ${one(i.context)}`] : []),
    "",
    `Answer with \`desk_note.py reply <this note> --request taken --row <your row code>\` (or \`--request declined\` and why); when that row closes, \`desk_note.py done <this note>\` with what is live (${homeRepo()} docs/desk-inbox.md, Improvement requests).`,
  ];
  return { rel, text: `---\n${fm.filter(([, v]) => one(v)).map(([k, v]) => `${k}: ${one(v)}`).join("\n")}\n---\n${body.join("\n")}\n` };
}

/** The note in this checkout's inbox that already carries this ask (the hand-off made), if any. */
export function handedNote(checkoutDir: string, ref: string): DeskNote | undefined {
  return readInbox(checkoutDir).find((n) => n.kind === IMPROVEMENT_KIND && n.ask === ref);
}

export type HandResult = { state: "handed" | "already"; rel: string; sha?: string; checkout: string } | { state: "skipped" | "failed"; reason: string };

/**
 * Step 3: drop the note in the builder world's home checkout through the console's writer (its own clone, commit + push);
 * nothing else in that repo is touched. `already` when a note naming the ask is there.
 */
export async function handImprovement(i: HandInput, target: { checkout: string; policyPath: string }, writer: Pick<SpineWriter, "scaffold">): Promise<HandResult> {
  const ref = askRef(i.repo, i.code);
  const have = handedNote(target.checkout, ref);
  if (have) return { state: "already", rel: have.file, checkout: target.checkout };
  const note = improvementNote(i);
  const w: SpineWrite = await writer.scaffold({
    repoDir: target.checkout,
    path: target.policyPath,
    label: `improvement request ${ref}`,
    scaffold: async (dir) => {
      // the clone may know a note the shared checkout does not yet: never twice
      const there = readInbox(dir).find((n) => n.kind === IMPROVEMENT_KIND && n.ask === ref);
      if (there) return { ok: false, error: `already handed: ${there.file}` };
      const abs = path.join(dir, note.rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, note.text);
      return { ok: true, files: [note.rel] };
    },
    msg: `Desk note from ${i.fromWorld}: improvement request ${i.code} approved by ${ownerName()} (console)`,
    body: `${ownerName()} approved the improvement request ${ref} on his card. The console hands it to this world's desk as one note: ${note.rel}. Its Delivery Manager answers with its row code or why not (${homeRepo()} docs/desk-inbox.md).`,
  });
  if (w.status === "written") return { state: "handed", rel: note.rel, checkout: target.checkout, ...(w.sha ? { sha: w.sha } : {}) };
  if (/already handed: (\S+)/.test(w.reason ?? "")) return { state: "already", rel: /already handed: (\S+)/.exec(w.reason!)![1], checkout: target.checkout };
  return { state: w.status, reason: w.reason ?? w.status };
}

export interface OutRequest {
  /** The builder world and its repo name. */
  world: string;
  repo: string;
  note: DeskNote;
}

const stateOf = (n: DeskNote): RequestState => (REQUEST_STATES.includes(n.request as RequestState) ? (n.request as RequestState) : "open");

/**
 * Step 5: the asking world's Delivery Manager wake section: every improvement request this world handed that is not done
 * or declined yet, and what each builder said; undefined when none is open.
 */
export function improvementsOutSection(world: string, out: OutRequest[]): string | undefined {
  const live = out.filter((o) => o.note.from === world && o.note.kind === IMPROVEMENT_KIND && !["done", "declined"].includes(stateOf(o.note)));
  if (!live.length) return undefined;
  return [
    `## Improvement requests out (${live.length} waiting on another world's desk)`,
    `${ownerName()} approved these improvement requests; the console handed each to the world that builds it. Checked on every wake. For each: keep the row that asked for it \`blocked\` or waiting, naming the request and the builder's row code once it has one; never build it here (this world never codes). When the builder answers \`request: done\` (a note in your desk inbox), carry on the campaign with what is live and mark the ask line \` · done <date>\`; on \`declined\`, tell ${ownerName()} in the row's next action what the builder said.`,
    ...live.map((o) => {
      const s = stateOf(o.note);
      const row = o.note.row ? ` its row ${o.note.row}` : "";
      // a request answered by hand (no `request:` field): its answer note says what the builder did
      const byHand = s === "open" && o.note.status === "answered";
      return `- ${o.note.ask ?? "?"} → ${o.world} (${o.repo}:${o.note.file}): ${o.note.about.replace(/^Improvement request:\s*/i, "")}: **${byHand ? "answered" : s}**${s === "taken" ? `,${row}` : ""}${byHand ? ` (by hand, no request state: read ${o.note.answered ?? "its answer in your desk inbox"}; close the row on what it says)` : s === "open" ? " (not answered yet)" : ""}`;
    }),
  ].join("\n");
}

/** Step 4 follow-through, for the builder: requests this world took and has not closed `done` yet; undefined when none. */
export function improvementsTakenSection(notes: DeskNote[]): string | undefined {
  const taken = notes.filter((n) => n.kind === IMPROVEMENT_KIND && stateOf(n) === "taken");
  if (!taken.length) return undefined;
  return [
    `## Improvement requests taken (${taken.length})`,
    `Another world (${socialProduct()}) is waiting on these rows of yours. When a row closes, tell it what is live: \`python3 <${homeRepo()} checkout>/scripts/desk_note.py done <this checkout>/<note> --to <its reply-to checkout> --from <this world> --reply-to <this repo> --body \"<what is live, links>\"\` (marks the note \`request: done\` and drops the answer in its inbox).`,
    ...taken.map((n) => `- \`${n.file}\` from **${n.from}**: ${n.about.replace(/^Improvement request:\s*/i, "")}: row ${n.row ?? "?"}`),
  ].join("\n");
}

export interface WorldRow {
  id: string;
  skin: string | null;
  plan: string | null;
  owner: string | null;
  paused: number | null;
}

/**
 * Which world builds it: `to:` names a world id, or a product (`EpicTeam`): then the asking world's desk pair (CONSOLE_DESK_PAIRS)
 * when that world is EpicTeam-skinned. Only into a world of the same owner, live, never the asking world itself.
 */
export function resolveImprovementTarget(to: string, fromWorld: string, worlds: WorldRow[], pairs: Map<string, string>): string | { error: string } {
  const want = stripInline(to).trim();
  const from = worlds.find((w) => w.id === fromWorld);
  let target = worlds.find((w) => w.id.toLowerCase() === want.toLowerCase());
  if (!target && /^epic\s*team$/i.test(want)) {
    const pair = pairs.get(fromWorld);
    target = worlds.find((w) => w.id === pair && w.skin !== "social");
    if (!target) return { error: `"${want}": the world ${fromWorld} has no EpicTeam desk paired with it (CONSOLE_DESK_PAIRS); name the world id in to:` };
  }
  if (!target) return { error: `no world "${want}" (the ask's to: field)` };
  if (target.id === fromWorld) return { error: `to: ${want} is the asking world itself` };
  if (target.paused) return { error: `the world ${target.id} is paused` };
  if (!from || (from.owner ?? "") !== (target.owner ?? "")) return { error: `the world ${target.id} is not ${fromWorld}'s owner's: an improvement request only goes between one owner's worlds` };
  return target.id;
}
