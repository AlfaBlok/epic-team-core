import { stripInline } from "../adapters/markdown.js";
import { DEFAULT_OWNER } from "../tenancy/owner.js";
import { isJordis, type AskKind } from "./asks.js";
import { applyAnswer, oneLine, type SpineWrite } from "./spineWrite.js";
import type { WaitingItem } from "./waiting.js";
import { sameRepo as sameRepoName } from "../adapters/repoNames.js";
import { anthropicJson } from "../textModel.js";

/**
 * one answer closes many. When the owner answers an ask (the console's answer path, a Team desk or milestone
 * chat registering his words, a review press), every other OPEN ask in the world that the same answer settles is closed
 * with his words quoted and a link to where he said them: `[answered <code> <date> @the owner] … — answer: via <source>: “…”`.
 *
 * Conservative by construction:
 * 1. Exact links first (pure, no model): the same question, a line that names the answered ask as the same step
 *    ("same step as", "answering answers this one too"), the same key target (`secret: app NAME`), the same
 *    row, the same site. No link, no candidate.
 * 2. Then a model check with a strict yes/no and its reason saved (the console's OpenAI key). A yes closes; a no drops a
 *    weak link and turns a strong one into a maybe. Without a model only a strong link closes; a weak one is a maybe.
 * 3. Never by inference: a decline or a feedback answer closes nothing, and an ask about money or permission is never
 *    closed by someone else's answer; both come back as "maybe also settles: <code>" for the next wake to judge.
 * 4. A `do` or `provide` ask (something only his hands can do or give) is never closed by another ask's answer,
 *    model yes or not: a yes to "may we open the sites" never made the sign-in apps (closed). The one
 *    exception is a merged duplicate: its own line says the answered ask is the same step ("answering answers
 *    this one too") and the answered ask is itself a `do` or `provide`, so his done there is this ask's done evidence.
 */

export type AnswerKind = "approve" | "deny" | "answer" | "feedback";

/** What the owner answered, and where. */
export interface SettleSource {
  /** ask = an answer to a coded ask; review = his press on a review card (row done). */
  kind: "ask" | "review";
  /** The waiting item he answered (never a candidate itself). */
  itemId?: string;
  repo?: string;
  path?: string;
  code?: string;
  row?: string;
  /** the answered ask's kind (decide, do, provide, …); a `do` or `provide` candidate closes only on a `do` or `provide` source. */
  ask?: AskKind;
  /** The answered ask's question (or the review row's title). */
  question: string;
  /** Every other text of the answered ask (context, steps, recommend, impact), for the links. */
  detail?: string;
  secret?: { app: string; name: string };
  answerKind: AnswerKind;
  /** His words, quoted on every line this closes. */
  words: string;
  /** Where he said them: `the code repo/`, or `review the code repo/`. */
  label: string;
  /** A link to the line he answered (GitHub at the commit that wrote it). */
  link?: string;
  owner?: string;
}

export type LinkKind = "same-question" | "names-same" | "same-key" | "same-row" | "same-site" | "near-question";
export interface Link {
  kind: LinkKind;
  /** Plain words, saved with the match. */
  why: string;
}
/** A strong link alone is enough when no model can be asked; a weak one only proposes a candidate. */
export const STRONG: ReadonlySet<LinkKind> = new Set(["same-question", "names-same", "same-key"]);

export interface Verdict {
  settles: boolean;
  reason: string;
}
/** The model check: does the source answer settle this candidate ask? Strict yes/no with one sentence of reason. */
export type Judge = (src: SettleSource, cand: WaitingItem, links: Link[]) => Promise<Verdict>;

export interface SettleMatch {
  itemId: string;
  /** `repo/CODE` (or the question, shortened, for an ask with no code). */
  code: string;
  repo?: string;
  path?: string;
  milestoneId?: string;
  links: Link[];
  /** The model's verdict when it was asked. */
  check?: Verdict;
  /** Why it is closed or only a maybe. */
  reason: string;
}

export interface SettleResult {
  close: SettleMatch[];
  maybe: SettleMatch[];
  /** How many candidates the model was asked about. */
  checked: number;
  /** The model failed (no key, refused): only strong links closed. */
  judgeError?: string;
}

/** At most this many candidates go to the model per answer (each one costs a call). */
export const MAX_CHECKS = 10;
/** At most this many asks one answer closes (a runaway match never empties the inbox). */
export const MAX_CLOSES = 6;

const norm = (s: string | undefined) =>
  stripInline(s ?? "")
    .toLowerCase()
    .replace(/[“”"'`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
const words = (s: string) => new Set(norm(s).split(/[^a-z0-9@.$€-]+/).filter((w) => w.length > 2));
export function overlap(a: string, b: string): number {
  const w1 = words(a);
  const w2 = words(b);
  if (!w1.size || !w2.size) return 0;
  const common = [...w1].filter((w) => w2.has(w)).length;
  return common / (w1.size + w2.size - common);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A line saying it is the same step as `code` ("same step as", "duplicate of", "answering answers this one too"). */
export function namesAsSame(text: string, code: string, repo?: string): boolean {
  const c = `(?:${repo ? `${esc(repo)}/` : ""})?${esc(code)}(?![\\w-])`;
  return (
    new RegExp(`(?:same (?:step|question|ask|thing|decision|sign-?in) as|duplicate of|dup of|merged into|covered by|folded into|superseded by|answering)\\s+${c}`, "i").test(text) ||
    new RegExp(`${c}[^.;]{0,40}\\banswers? this (?:one|ask)? ?too`, "i").test(text)
  );
}

/** Sites an ask is about: `*.x.com` sync targets, "sign in to x.com", and the named services our asks touch. */
const SERVICES: [RegExp, string][] = [
  [/\b(?:x\.com|twitter)\b|\bsign(?:ed)? (?:back )?(?:in|out) (?:to|of) x\b/i, "x.com"],
  [/\bairbnb\b/i, "airbnb.com"],
  [/\binstagram\b/i, "instagram.com"],
  [/\btiktok\b/i, "tiktok.com"],
  [/\blinkedin\b/i, "linkedin.com"],
  [/\breddit\b/i, "reddit.com"],
  [/\bwhatsapp\b/i, "whatsapp.com"],
  [/\bstripe\b/i, "stripe.com"],
];
export function sitesOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const [re, site] of SERVICES) if (re.test(text)) out.add(site);
  return out;
}

const textOf = (i: Pick<WaitingItem, "question" | "contextText" | "impact" | "risk" | "whyYou" | "recommendation" | "steps" | "unblocks" | "detail">) =>
  [i.question, i.contextText, i.impact, i.risk, i.whyYou, i.recommendation, i.steps, i.unblocks, i.detail].filter(Boolean).join(" — ");

/** Strip a leading `CODE:` so two asks that differ only in it read as the same question. */
const bareQuestion = (q: string) => norm(q).replace(/^[a-z0-9/-]+-a\d+\s*:\s*/, "");

/** Step 1: every exact link between the answered ask and a candidate (pure). */
export function exactLinks(src: SettleSource, cand: WaitingItem): Link[] {
  const links: Link[] = [];
  const sameRepo = !src.repo || !cand.repo || sameRepoName(src.repo, cand.repo);
  const sq = bareQuestion(src.question);
  const cq = bareQuestion(cand.question);
  if (sq && sq === cq) links.push({ kind: "same-question", why: "the same question, word for word" });
  else if (overlap(src.question, cand.question) >= 0.85) links.push({ kind: "same-question", why: "nearly the same question" });
  else if (overlap(src.question, cand.question) >= 0.6) links.push({ kind: "near-question", why: "a close question" });
  const ctext = textOf(cand);
  const stext = `${src.question} — ${src.detail ?? ""}`;
  if ((src.code && namesAsSame(ctext, src.code, src.repo) && (sameRepo || ctext.includes(`${src.repo}/${src.code}`))) || (cand.code && namesAsSame(stext, cand.code, cand.repo)))
    links.push({ kind: "names-same", why: `it says it is the same step as ${src.code && namesAsSame(ctext, src.code, src.repo) ? src.code : cand.code}` });
  if (src.secret && cand.secret && src.secret.app === cand.secret.app && src.secret.name === cand.secret.name)
    links.push({ kind: "same-key", why: `the same key ${src.secret.app} ${src.secret.name}` });
  if (src.row && cand.row && sameRepo && src.row === cand.row) links.push({ kind: "same-row", why: `the same row ${src.row}` });
  const s1 = sitesOf(stext);
  const shared = [...sitesOf(ctext)].filter((s) => s1.has(s));
  if (shared.length) links.push({ kind: "same-site", why: `the same site ${shared.join(", ")}` });
  return links;
}

/** Words that make an ask about money: closed only by his own answer to it. */
const MONEY = /\b(stripe|payment|pay|paid|billing|invoice|price|pricing|charge[sd]?|refund|subscription|checkout|buy|purchase|spend|spending|budget|credit card|bank|fees?)\b|[$€£]\s?\d|\d\s?(?:usd|eur|€|\$)/i;
/** Words that make an ask about permission: access, grants, keys, publishing. Closed only by his own answer to it. */
const PERMISSION = /\b(permission|grant(?:s|ed)?|write access|access to|sudo|root|privilege|admin|public (?:port|hostname)|open (?:a )?port|publish|go public|delete|wipe|irreversible|api key|token|secret)\b/i;

const HANDS: ReadonlySet<string> = new Set(["do", "provide"]);
/**
 * why a `do` or `provide` ask stays open under another ask's answer, or undefined. It closes only on its own
 * answer, its done evidence, or a merged duplicate: its own line names `src` as the same step and `src` is a `do` or
 * `provide` too (his done there did this step).
 */
export function handsOnly(src: SettleSource, cand: WaitingItem): string | undefined {
  if (!HANDS.has(cand.ask)) return undefined;
  const merged = !!src.code && !!src.ask && HANDS.has(src.ask) && namesAsSame(textOf(cand), src.code, src.repo);
  if (merged) return undefined;
  return `it is a step only you can ${cand.ask === "provide" ? "give" : "do"}: only your answer to it or its done evidence closes it`;
}

/** Why a candidate is never closed by another answer (money, permission, a `do` or `provide` step), or undefined. */
export function guarded(cand: WaitingItem, src?: SettleSource): string | undefined {
  const t = `${cand.question} ${cand.contextText ?? ""} ${cand.steps ?? ""}`;
  if (MONEY.test(t)) return "it is about money: only your answer to it closes it";
  if (cand.secret || PERMISSION.test(t)) return "it is about a permission or a key: only your answer to it closes it";
  return src ? handsOnly(src, cand) : undefined;
}

const DECLINE = /^\s*(no\b|nope|deny|denied|decline|declined|don'?t\b|do not\b|not now|not yet|stop\b|cancel|reject|rejected|never\b|wait\b|hold\b|later\b|park\b|skip\b)/i;
/** His answer says no (or wants changes): it settles nothing else by inference. */
export function isDecline(kind: AnswerKind, words: string): string | undefined {
  if (kind === "deny") return "your answer was a no";
  if (kind === "feedback") return "your answer asked for changes";
  if (DECLINE.test(stripInline(words))) return "your answer reads as a no or a not yet";
  return undefined;
}

/** `repo/CODE` of a candidate, or its question, shortened, when it has no code. */
export const matchCode = (i: Pick<WaitingItem, "code" | "repo" | "question">) => (i.code ? (i.repo ? `${i.repo}/${i.code}` : i.code) : `“${oneLine(i.question).slice(0, 60)}”`);

/**
 * Steps 1 to 3 over the open asks of the world: what this answer closes and what it may also settle.
 * `open` is every waiting item (the matcher keeps only open asks addressed to the owner).
 */
export async function findSettles(src: SettleSource, open: WaitingItem[], judge?: Judge): Promise<SettleResult> {
  const owner = src.owner ?? DEFAULT_OWNER;
  const decline = isDecline(src.answerKind, src.words);
  const out: SettleResult = { close: [], maybe: [], checked: 0 };
  const seen = new Set<string>();
  const cands = open
    .filter((i) => i.source === "ask" && i.state === "open" && !i.decidedBy && i.gate !== "future" && i.id !== src.itemId)
    .filter((i) => !(src.code && i.code === src.code && (!src.repo || !i.repo || sameRepoName(i.repo, src.repo))))
    .filter((i) => isJordis({ who: i.who ?? "" }, owner))
    .filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)))
    .map((i) => ({ i, links: exactLinks(src, i) }))
    .filter((x) => x.links.length)
    // strongest first, so the model's budget goes where a close is likeliest
    .sort((a, b) => Number(b.links.some((l) => STRONG.has(l.kind))) - Number(a.links.some((l) => STRONG.has(l.kind))) || b.links.length - a.links.length);
  let judgeError: string | undefined;
  for (const { i, links } of cands) {
    const strong = links.some((l) => STRONG.has(l.kind));
    const base: SettleMatch = { itemId: i.id, code: matchCode(i), ...(i.repo ? { repo: i.repo } : {}), ...(i.path ? { path: i.path } : {}), milestoneId: i.milestoneId, links, reason: "" };
    let check: Verdict | undefined;
    if (judge && !judgeError && out.checked < MAX_CHECKS) {
      try {
        out.checked++;
        check = await judge(src, i, links);
        check = { settles: check.settles === true, reason: oneLine(String(check.reason ?? "")).slice(0, 300) };
      } catch (e) {
        judgeError = (e as Error).message.slice(0, 200);
      }
    }
    const linkWhy = links.map((l) => l.why).join(", ");
    const yes = check ? check.settles : strong;
    const stop = decline ?? guarded(i, src);
    const m: SettleMatch = { ...base, ...(check ? { check } : {}), reason: "" };
    if (yes && !stop && out.close.length < MAX_CLOSES) out.close.push({ ...m, reason: check ? check.reason || linkWhy : linkWhy });
    else if (yes && stop) out.maybe.push({ ...m, reason: `${stop} (${check?.reason || linkWhy})` });
    else if (yes) out.maybe.push({ ...m, reason: `over the ${MAX_CLOSES} asks one answer closes (${linkWhy})` });
    else if (check && strong) out.maybe.push({ ...m, reason: `the check said no: ${check.reason || "no reason given"} (${linkWhy})` });
    else if (!check && !strong) out.maybe.push({ ...m, reason: `only ${linkWhy}; not checked` });
  }
  if (judgeError) out.judgeError = judgeError;
  return out;
}

/** The answer text written on each ask this answer closes: his words, where he said them, and why it is the same. */
export function closingAnswer(src: SettleSource, m: SettleMatch): string {
  const quote = oneLine(src.words).slice(0, 600);
  return oneLine(`via ${src.label}: “${quote}”${src.link ? ` [where he said it](${src.link})` : ""}. One answer closes many: ${m.reason}`);
}

/** The one line the owner reads (card, desk, wake message). Empty when nothing was closed or proposed. */
export function settleLine(r: Pick<SettleResult, "close" | "maybe">, label = "your answer"): string {
  const parts: string[] = [];
  if (r.close.length) parts.push(`${label} also closed ${r.close.map((m) => m.code).join(", ")}`);
  if (r.maybe.length) parts.push(`maybe also settles: ${r.maybe.map((m) => m.code).join(", ")}`);
  return parts.join(". ");
}

/** One closed ask as it was written (or why not). */
export interface SettleWrite {
  itemId: string;
  code: string;
  status: SpineWrite["status"];
  sha?: string;
  reason?: string;
}
/** What the answer job stores on the response (jordi_responses.settles) and the card shows. */
export interface Settled {
  at: string;
  closed: (SettleMatch & { write: SettleWrite })[];
  maybe: SettleMatch[];
  checked: number;
  judgeError?: string;
  /** Where he answered (`the code repo/`): the source each closed line names. */
  label: string;
  line: string;
}

/**
 * The write of one closing: the candidate's ask line flipped to `[answered <code> <date> @<owner>] … — answer: via …`
 * (and its code out of Current State's `Waiting on:`), as the answer path's own flip does. Returns the edit for
 * `SpineWriter.edit`, or a skip when the ask is no longer open.
 */
export function closingEdit(src: SettleSource, m: SettleMatch, cand: WaitingItem) {
  const answer = closingAnswer(src, m);
  const owner = src.owner ?? DEFAULT_OWNER;
  return (text: string, date: string) => {
    const e = applyAnswer(
      text,
      { id: cand.id, source: "ask", question: cand.question, ...(cand.row ? { row: cand.row } : {}), ...(cand.code ? { code: cand.code } : {}), ...(cand.line !== undefined ? { line: cand.line } : {}), ...(cand.path ? { path: cand.path } : {}) },
      answer,
      date,
      owner,
    );
    if (e.how !== "flip") return { skip: e.how === "already" ? "already answered in the spine" : "the ask is not in the spine any more" };
    return {
      text: e.text,
      msg: `Answer ${cand.code ?? cand.id}: answered by ${owner}'s answer to ${src.label} (one answer closes many)`,
      body:
        `${stripInline(cand.question).slice(0, 200)}\n\n${owner} answered ${src.label}${src.link ? ` (${src.link})` : ""}: “${oneLine(src.words).slice(0, 500)}”.\n` +
        `The console closed this ask with the same answer: ${m.reason.replace(/[.\s]+$/, "")}.\nLinks: ${m.links.map((l) => l.why).join(", ")}.` +
        (m.check ? `\nModel check: ${m.check.settles ? "yes" : "no"}, ${m.check.reason}` : "\nModel check: none (a strong link alone)"),
    };
  };
}

/** OpenAI's strict JSON check, the console's own key (the same key voice notes use). */
export const JUDGE_MODEL = "gpt-4o-mini";
const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["settles", "reason"],
  properties: {
    settles: { type: "boolean", description: "true only when the answer fully settles the second question, so asking it again would repeat a question already answered." },
    reason: { type: "string", description: "One plain sentence: why it does or does not." },
  },
};
const askText = (label: string, q: string, more?: string) => `${label}: ${oneLine(q).slice(0, 1200)}${more ? `\nMore: ${oneLine(more).slice(0, 1500)}` : ""}`;

const JUDGE_SYSTEM =
  "A product owner answered one question from his agents. You decide whether that same answer also settles a second open question, so the agents must not ask him again. " +
  "Say yes only when the second question asks for the same thing or the same decision (the same step, account, site, key or choice) and his answer covers it fully as given. " +
  "Say no when in doubt, when the second question needs anything his answer does not give (another account, site, amount, option or step), or when his answer is a no, a not yet or a request for changes. " +
  "Answer in one plain sentence.";
const judgeUser = (src: SettleSource, cand: WaitingItem, links: Link[]) =>
  [
    askText(`Question he answered (${src.label})`, src.question, src.detail),
    `His answer: ${oneLine(src.words).slice(0, 1500)}`,
    askText(`Open question (${matchCode(cand)})`, cand.question, textOf({ ...cand, question: "" })),
    `What links them: ${links.map((l) => l.why).join(", ")}.`,
  ].join("\n\n");

export function openAiJudge(key: () => Promise<string | undefined>, f: typeof fetch = fetch): Judge {
  return async (src, cand, links) => {
    const k = await key();
    if (!k) throw new Error("the console has no OPENAI_API_KEY");
    const body = {
      model: JUDGE_MODEL,
      temperature: 0,
      response_format: { type: "json_schema", json_schema: { name: "settles", strict: true, schema: JUDGE_SCHEMA } },
      messages: [
        { role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: judgeUser(src, cand, links) },
      ],
    };
    const r = await f("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${k}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const j = (await r.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
    const text = j?.choices?.[0]?.message?.content;
    if (!r.ok || typeof text !== "string") throw new Error(`the model check failed (${r.status}): ${String(j?.error?.message ?? "no message").slice(0, 160)}`);
    const v = JSON.parse(text) as Verdict;
    return { settles: v.settles === true, reason: String(v.reason ?? "") };
  };
}

/** The same check on Claude Haiku 5.5, the credit account (`CONSOLE_TEXT_MODEL_PROVIDER=anthropic`). */
export function anthropicJudge(key: () => Promise<string | undefined>, f: typeof fetch = fetch): Judge {
  return async (src, cand, links) => {
    const { value: v } = await anthropicJson<Verdict>(key, f, { system: JUDGE_SYSTEM, user: judgeUser(src, cand, links), schema: JUDGE_SCHEMA, maxTokens: 2000, timeoutMs: 30_000 });
    return { settles: v.settles === true, reason: String(v.reason ?? "") };
  };
}
