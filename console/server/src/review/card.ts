import { copyPasteInText } from "../steps/copyPaste.js";
import { untappableProblem } from "../inbox/untappable.js";
import { stripInline } from "../adapters/markdown.js";
import { ownerName } from "../identity.js";
import { hasPlaceLink } from "../inbox/askGate.js";

/**
 * (the owner 2026-11-03, approved mockup docs/status/e48-s26/real-feed-mockup.html; spec docs/status/e48-s26-card-spec.md):
 * the fields of a review card live in the repo (root L-45: the console only reads them). One card file per row, a markdown
 * file whose front matter holds the fields (format: docs/review-cards.md):
 *
 *   ---
 *   row:
 *   title: The review list was fixed so it fits your screen on laptop and phone, with no sideways scrolling.
 *   goal: Every card fits inside the page, so nothing is cut off on the right.
 *   delivered:
 *     - ✓ Team home with all 23 cards fits at laptop and at phone width.
 *     - ✗ Not yet seen in Safari. Please look once on your Mac.
 *   evidence: [Open Team home](the production site
 *   screenshot: e48-s27/after-1280-top.png
 *   name: no sideways scrolling
 *   after: Next the team builds the new card design you see on this page.
 *   next:
 *     - start: Build the health page
 *     - park: Add a phone alert when a part goes red
 *   completes:
 *   confirm: yes
 *   ---
 *
 * The parser is tolerant: keys are case-insensitive (`What you are marking as complete:` reads as `title:`), list items
 * may sit under the key or on its line, ✓ / [x] / yes: and ✗ / [ ] / no: mark delivered lines, values may be quoted.
 */

export interface DeliveredLine {
  ok: boolean;
  text: string;
}

export interface NextStep {
  title: string;
  why?: string;
  recommend: "start" | "park";
  /**
   * the goal this follow-up belongs to (`in:`), when it is not the card's own. Its switch reads On / Off:
   * on writes a `ready` row in that goal quoting the owner's words; off dismisses it with a one-line reason (never proposed again).
   */
  target?: string;
  /** the owner's own words the follow-up answers (`words: "…" 8 Nov`), quoted in the row it becomes. */
  quote?: string;
  /** The target goal's title (filled by the reader, never written in the card). */
  targetName?: string;
  /**
   * `new:` instead of `in:`: the follow-up IS a new goal a proposer persona drafted (the Input
   * reviewer, the Prioritizer). On makes that draft goal ready and wakes the Delivery manager; off parks it for good.
   */
  kind?: "new";
  /** other personas that proposed the same thing (`also: Prioritizer`), so one card names both. */
  also?: string[];
}

/** who sends the card when a persona writes it on its own (the Gap finder), and where that persona lives. */
export interface CardFrom {
  name: string;
  /** The persona's settings in the console (its assignment: `/milestones/<id>?tab=personas`). */
  url?: string;
  /** One line: what it does. */
  line?: string;
  /** Where it runs: its level, the milestone its assignment sits on, its cadence and its repo. */
  runs?: string;
  /** its own page in the console (the list of its runs), e.g. `/gap-finder`. */
  page?: string;
  /** its instructions file (a link). */
  file?: string;
  /** one line, where its findings are stored. */
  stores?: string;
  /** one line, who reads its findings. */
  readers?: string;
}

export interface CardFields {
  row?: string;
  /** The spine file the row sits in, when its code is not unique in the repo. */
  spine?: string;
  title?: string;
  goal?: string;
  delivered: DeliveredLine[];
  /** The evidence link as written: a URL, or `[label](url)`. */
  evidence?: string;
  evidenceUrl?: string;
  evidenceLabel?: string;
  /** Path of the screenshot (repo-relative, or relative to the card file / docs/status). */
  screenshot?: string;
  /** Short name of the task in the tree ("This task: <name>"). */
  name?: string;
  /** What the team does next once it is marked complete (sub-line of the button). */
  after?: string;
  next: NextStep[];
  /** `next: none`: no next steps, whatever the row's followups suggest. */
  nextNone?: boolean;
  /** An explicit Done-means line id, or `goal`. Case C comes only from this (never from title text, the bug). */
  completes?: string;
  confirm?: { yes: boolean; why?: string };
  /** An example made for another row's feature: never its own card (spec decision 8). */
  exampleOf?: string;
  /** The ask this row fed: once that ask is answered, the row closes itself. */
  fed?: string;
  /** `from:` the persona that sent it, with `from settings:`, `from line:` and `runs:`. */
  from?: CardFrom;
  /**
   * `source:` where the card came from, in words the owner knows: his own words with their date and a link to the
   * note or card, or who raised it and why. The card opens with it. Required (a persona card's `from:` counts).
   */
  source?: string;
  /** `decision:` the one decision or ask for the owner, in plain words, with the team's recommendation. The card ends with it. Required. */
  decision?: string;
  /**
   * E948-S69 `options:` a decision card's own buttons, 2 to 4 list lines `<label>: <what happens next>` (`Yes: plan it`,
   * `No: park it`). A next step that starts park, drop, stop or leave parks the next steps; any other starts them.
   */
  options?: string[];
  /** `objective:` read and kept, never shown: a card no longer opens with an objective (the owner 2026-11-14, vn_e751eeeb). */
  objective?: string;
  /**
   * (the owner 2026-11-16, vn_c95c40ad: "something that was time sensitive ... how come that this is not the
   * first thing on my inbox?"): `deadline: <ISO time> — <where it comes from>`, taken from his words or the source (an
   * Airbnb mail's 72 hours), never guessed. A card with one leads the whole inbox with its time left.
   */
  deadline?: CardDeadline;
  /**
   * (the owner 2026-11-16 08:04Z: "email showed in the drafts but i was hping for an email or something in my
   * epicteam inbox notifying - came in too subtly"): `ready: <where the thing is>` with its link, e.g.
   * `ready: [Gmail Drafts, to help@example.com](https://mail.google.com/mail/u/0/#drafts)`. The card leads his inbox
   * as ready for him and the console tells him once by WhatsApp or mail (review/ready.ts).
   */
  ready?: { where: string; url?: string };
}

export interface CardDeadline {
  /** ISO UTC time (`2026-11-17T01:47:00.000Z`). */
  at: string;
  /** where the deadline comes from, in plain words (his words or the source), shown beside the time left. */
  why?: string;
}

/** `2026-11-17T01:47Z — Your words: "22 hours"` → the time (UTC unless it names a zone) and its why; a value with no clear time is dropped. */
export function parseDeadline(v: string): CardDeadline | undefined {
  const m = /^\s*(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?)\s*(Z|UTC|[+-]\d{2}:?\d{2})?\s*(?:(?:—|--|–|:)\s*(.*))?$/i.exec(v);
  if (!m) return undefined;
  const zone = !m[2] || /^(z|utc)$/i.test(m[2]) ? "Z" : m[2].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  const time = m[1].includes(":") ? m[1].replace(" ", "T") : `${m[1]}T00:00`;
  const t = Date.parse(`${time}${zone}`);
  if (!Number.isFinite(t)) return undefined;
  const why = m[3] ? unquote(m[3]) : "";
  return { at: new Date(t).toISOString(), ...(why ? { why } : {}) };
}

const KEYS: [RegExp, keyof CardFields | "skip"][] = [
  [/^(row|card|review card|review-card|code)$/, "row"],
  [/^(spine|epic file|spine file)$/, "spine"],
  [/^(title|what you are marking as complete|what was done|step sentence|done)$/, "title"],
  [/^(goal|the goal of this task|task goal|goal of this task|original goal)$/, "goal"],
  [/^(delivered|what was delivered|what you can see now)$/, "delivered"],
  [/^(evidence|the evidence|evidence url|evidence link|live|open live)$/, "evidence"],
  [/^(screenshot|shot|image|evidence screenshot|picture)$/, "screenshot"],
  [/^(name|tree name|short name|task name)$/, "name"],
  [/^(after|then|next for the team|what happens next|sub ?line)$/, "after"],
  [/^(next|next steps|suggested next steps|follow ?ups)$/, "next"],
  [/^(completes|complete)$/, "completes"],
  [/^(confirm)$/, "confirm"],
  [/^(example of|example for)$/, "exampleOf"],
  [/^(fed|fed ask|feeds|ask)$/, "fed"],
  [/^(source|where it came from|where it comes from|came from|comes from|origin|raised by)$/, "source"],
  [/^(decision|the decision|you decide|your decision|decide|the ask for you|your call)$/, "decision"],
  [/^(options|choices|buttons|decision options)$/, "options"],
  [/^(objective|objectives|serves|serves objective)$/, "objective"],
  [/^(deadline|due|due by|reply by|answer by)$/, "deadline"],
  [/^(ready|ready at|where it is|find it at)$/, "ready"],
];
/** the `from` fields (the persona that sends the card). */
const FROM_KEYS: [RegExp, keyof CardFrom][] = [
  [/^(from|persona|sent by)$/, "name"],
  [/^(from settings|persona settings|settings)$/, "url"],
  [/^(from line|persona line|what it does)$/, "line"],
  [/^(runs|from runs|where it runs|lives)$/, "runs"],
  [/^(from page|its page|persona page)$/, "page"],
  [/^(from file|persona file|instructions)$/, "file"],
  [/^(from findings|findings|stored|stores)$/, "stores"],
  [/^(from readers|read by|readers|who reads)$/, "readers"],
];

const keyOf = (raw: string): keyof CardFields | "skip" | undefined => {
  const k = raw.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return KEYS.find(([re]) => re.test(k))?.[1];
};

const unquote = (s: string) => {
  const t = s.trim();
  return /^".*"$|^'.*'$/.test(t) ? t.slice(1, -1).trim() : t;
};

/** The front matter block of a markdown file (between the first two `---` lines at its very top), or undefined. */
export function frontMatter(text: string): string[] | undefined {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l.trim()));
  return end > 0 ? lines.slice(1, end) : undefined;
}

const MD_LINK = /\[([^\]]*)\]\(([^)\s]+)\)/;
const URL_RE = /https?:\/\/[^\s<>()|]+/;

function deliveredOf(item: string): DeliveredLine | undefined {
  const t = unquote(item);
  let m = /^(✓|✔|☑|\[x\]|yes\s*:|ok\s*:|done\s*:|y\s*:)\s*(.*)$/i.exec(t);
  if (m) return m[2].trim() ? { ok: true, text: m[2].trim() } : undefined;
  m = /^(✗|✘|×|☐|\[ \]|no\s*:|not yet\s*:|missing\s*:|n\s*:)\s*(.*)$/i.exec(t);
  if (m) return m[2].trim() ? { ok: false, text: m[2].trim() } : undefined;
  return t ? { ok: true, text: t } : undefined;
}

const WHY = /\s+(?:—|--|–)\s+/;
function nextOf(item: string): NextStep | undefined {
  const t = unquote(item);
  const m = /^(start(?: now)?|park|propose[sd]?|on|off)\s*:?\s+(.+)$/i.exec(t);
  const body = m ? m[2] : t;
  const [title, ...rest] = body.split(WHY);
  if (!title?.trim()) return undefined;
  // `— in:` names the goal it goes to, `— words: "…"` the owner's words it answers
  let target: string | undefined;
  let quote: string | undefined;
  let kind: "new" | undefined;
  const also: string[] = [];
  const why: string[] = [];
  for (const seg of rest) {
    const tg = /^in\s*:\s*(\S+)/i.exec(seg.trim());
    // `— new:` a drafted new goal, `— also: Prioritizer` another persona that proposed it too
    const nw = /^new(?: goal)?\s*:\s*(\S+)/i.exec(seg.trim());
    const al = /^also(?: proposed by)?\s*:\s*(.+)$/i.exec(seg.trim());
    const q = /^(?:words|quote|you said)\s*:\s*(.+)$/i.exec(seg.trim());
    if (tg) target = tg[1].replace(/[.,;]+$/, "");
    else if (nw) {
      target = nw[1].replace(/[.,;]+$/, "");
      kind = "new";
    } else if (al) also.push(...al[1].split(/\s*(?:,|\band\b)\s*/).map((x) => x.trim()).filter(Boolean));
    else if (q) quote = q[1].trim();
    else why.push(seg);
  }
  const w = why.join(" — ").trim();
  return {
    title: title.trim(),
    ...(w ? { why: w } : {}),
    recommend: m && !/^(park|off)$/i.test(m[1]) ? "start" : "park",
    ...(target ? { target } : {}),
    ...(quote ? { quote } : {}),
    ...(kind ? { kind } : {}),
    ...(also.length ? { also } : {}),
  };
}

/** The card fields of one card file's text (its front matter), or undefined when it has none. */
export function parseCard(text: string): CardFields | undefined {
  const fm = frontMatter(text);
  if (!fm) return undefined;
  const out: CardFields = { delivered: [], next: [] };
  let list: "delivered" | "next" | "options" | undefined;
  let any = false;
  for (const raw of fm) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const item = /^\s*[-*]\s+(.*)$/.exec(raw);
    if (item && list) {
      if (list === "options") {
        const o = unquote(item[1]);
        if (o) (out.options ??= []).push(o);
      } else if (list === "delivered") {
        const d = deliveredOf(item[1]);
        if (d) out.delivered.push(d);
      } else {
        const n = nextOf(item[1]);
        if (n) out.next.push(n);
      }
      continue;
    }
    const kv = /^\s*([A-Za-z][\w '-]*?)\s*:\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const fk = FROM_KEYS.find(([re]) => re.test(kv[1].trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ")))?.[1];
    if (fk) {
      list = undefined;
      const v = unquote(kv[2]);
      if (!v) continue;
      any = true;
      const val = fk === "url" || fk === "page" || fk === "file" ? (MD_LINK.exec(v)?.[2] ?? v).replace(/^<|>$/g, "") : v;
      out.from = { ...(out.from ?? { name: "" }), [fk]: val };
      continue;
    }
    const key = keyOf(kv[1]);
    list = undefined;
    if (!key || key === "skip") continue;
    any = true;
    const v = unquote(kv[2]);
    if (key === "next" && /^none\.?$/i.test(v)) {
      out.nextNone = true;
      continue;
    }
    if (key === "options") {
      list = "options";
      // one line: `options: Yes: plan it · No: park it`
      for (const part of v ? v.split(/\s+·\s+/) : []) if (unquote(part)) (out.options ??= []).push(unquote(part));
      continue;
    }
    if (key === "delivered" || key === "next") {
      list = key;
      // one line: `delivered: ✓ a · ✗ b`
      for (const part of v ? v.split(/\s+·\s+/) : []) {
        if (key === "delivered") {
          const d = deliveredOf(part);
          if (d) out.delivered.push(d);
        } else {
          const n = nextOf(part);
          if (n) out.next.push(n);
        }
      }
      continue;
    }
    if (!v) continue;
    if (key === "confirm") {
      const c = /^(yes|no|true|false)\b\s*(?:(?:—|--|–|:)\s*)?(.*)$/i.exec(v);
      if (c) out.confirm = { yes: /^(yes|true)$/i.test(c[1]), ...(c[2].trim() ? { why: c[2].trim() } : {}) };
      continue;
    }
    if (key === "deadline") {
      const d = parseDeadline(v);
      if (d) out.deadline = d;
      continue;
    }
    if (key === "ready") {
      const l = MD_LINK.exec(v);
      const url = (l?.[2] ?? URL_RE.exec(v)?.[0] ?? "").replace(/[.,;:]+$/, "");
      const where = (l ? v.replace(l[0], l[1]) : url ? v.replace(url, "") : v).replace(/\s*(—|--|–)\s*$/, "").replace(/\s+/g, " ").trim();
      out.ready = { where: unquote(where) || url, ...(url ? { url } : {}) };
      continue;
    }
    if (key === "completes") {
      out.completes = /^(the )?goal\b/i.test(v) ? "goal" : stripInline(v).split(/\s+/)[0];
      continue;
    }
    if (key === "evidence") {
      out.evidence = v;
      const l = MD_LINK.exec(v);
      const url = (l?.[2] ?? URL_RE.exec(v)?.[0] ?? "").replace(/[.,;:]+$/, "");
      if (url) out.evidenceUrl = url;
      if (l?.[1]?.trim()) out.evidenceLabel = l[1].trim();
      continue;
    }
    if (key === "screenshot") {
      out.screenshot = (MD_LINK.exec(v)?.[2] ?? v).replace(/^<|>$/g, "");
      continue;
    }
    if (key === "row" || key === "spine" || key === "exampleOf" || key === "fed") {
      out[key] = stripInline(v).split(/\s+/)[0];
      continue;
    }
    (out as unknown as Record<string, string>)[key] = v;
  }
  return any ? out : undefined;
}

// ---------- the plain-language gate (the owner 2026-11-03, L-48) ----------

/** GitHub in any of its page hosts: an issue, PR, blob or spine is a write-up, never the evidence (L-47). */
export function isGithubUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return /(^|\.)github\.com$|(^|\.)githubusercontent\.com$|(^|\.)github\.io$/.test(h);
  } catch {
    return false;
  }
}

/** A row or ask code (C9-15, E10-R2, T901-S1, S1). */
export const ROW_CODE = /\b(?:[A-Z][A-Z0-9]*-[A-Z]{0,3}\d+[a-z]?|S\d+)\b/;
/** A repo file path (docs/status/x.md, core/console/web/src/a.tsx). */
export const FILE_PATH = /(?:[\w.-]+\/)+[\w.-]+\.(?:md|ts|tsx|js|mjs|json|py|sh|ya?ml|html|txt|log|png|jpe?g|css)\b/;

/** Text as read: a markdown link becomes its words, a bare URL goes. */
const withoutLinks = (t: string) => t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, "");
/** Text outside links: what the punctuation, code and path rules apply to (a link's words may hold a slash or a code). */
const outsideLinks = (t: string) => t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, " ").replace(/https?:\/\/\S+/g, " ");

export const words = (t: string) => withoutLinks(t).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

const AUX = /^(is|are|was|were|has|have|had|can|could|will|would|does|do|did|got|gets|became|becomes)$/i;
// past forms that are rarely anything else (no run, set, put, read, cut, left: those are nouns or present tense too)
const IRREGULAR =
  /^(made|built|sent|shown|showed|done|went|ran|found|wrote|written|gave|given|kept|moved|began|begun|brought|bought|caught|chose|chosen|came|drew|drawn|fell|felt|fought|flew|forgot|froze|grew|grown|heard|held|hid|hung|knew|known|laid|lent|lost|meant|paid|rode|rose|said|saw|seen|sold|slept|spent|spoke|stood|stuck|struck|swept|swung|took|taken|taught|thought|threw|thrown|told|understood|woke|wore|added|fixed)$/i;
const NOT_VERB_ED = /^(red|need|speed|feed|seed|bed|shed|hundred|embed|breed|deed|weed|reed|steed|creed|greed|tweed|proceed|exceed|succeed|bleed|sled|shred|bred|wed|sacred|naked|wicked|kindred|rugged|ragged|jagged|beloved|aged|wretched|crooked|learned|blessed)$/i;

/** True when the sentence has a verb a title needs (past tense, or a helper verb): "were created", "was split", "moved". */
export function hasVerb(text: string): boolean {
  // a hyphenated word ("run-reported") is an adjective, never the sentence's verb
  const tokens = withoutLinks(text)
    .split(/[^\p{L}'-]+/u)
    .filter((w) => w && !w.includes("-"));
  return tokens.some((w) => AUX.test(w) || IRREGULAR.test(w) || (w.length > 3 && /ed$/i.test(w) && !NOT_VERB_ED.test(w)));
}

/**
 * (the owner 2026-11-15 03:16Z, vn_5ef65752: "maybe 50% the amount of text that we have right now"):
 * the card's word limits, about half of what they were (title and goal 20, delivered 2 to 4 lines of 20, source 40,
 * decision 30). One place, so the rule text every brief carries (cardRule.ts) and the gate never disagree.
 */
export const CARD_LIMITS = { title: 12, goal: 12, deliveredMin: 1, deliveredMax: 3, delivered: 12, source: 20, decision: 15, next: 12, after: 12, name: 8 } as const;

/** What is not plain in one card text, or undefined (no `;`, `(`, `/`, `|` outside links; no row code, path or "approve"). */
export function plainProblem(label: string, text: string, max: number): string | undefined {
  const bare = outsideLinks(text);
  if (words(text) > max) return `${label} is longer than ${max} words`;
  if (/[;()|]/.test(bare)) return `${label} has a semicolon, a bracket or a pipe`;
  if (/\//.test(bare)) return `${label} has a slash`;
  if (ROW_CODE.test(bare)) return `${label} names a row code`;
  if (FILE_PATH.test(bare)) return `${label} names a file`;
  if (/approv/i.test(text)) return `${label} says approve`;
  return undefined;
}

/**
 * the source line quotes the owner, so his own words may hold a slash or a bracket: only its length, row codes and
 * file paths outside links count (a link to the note or card carries the code, never the words).
 */
export function sourceProblem(text: string): string | undefined {
  const bare = outsideLinks(text);
  if (words(text) > CARD_LIMITS.source) return `the source is longer than ${CARD_LIMITS.source} words: quote only his key words and link the note`;
  if (ROW_CODE.test(bare)) return "the source names a row code: link the card instead";
  if (FILE_PATH.test(bare)) return "the source names a file";
  return undefined;
}

/**
 * E948-S102 (the owner 2026-11-15, vn_b19ddf2d: cards ask him things he cannot place, a talk he never asked for, a
 * strategy question that could mean many things): the decision opens with the one question he answers, one sentence
 * ending in a question mark, then the team's pick. A statement, two questions or two joined by "and" is held.
 */
export function decisionAskProblem(decision: string): string | undefined {
  const bare = outsideLinks(decision).trim();
  const first = bare.split(/(?<=[.?!])\s+/)[0] ?? "";
  const fix = "open it with the one question he answers, like Is this the forecast you wanted? Then the team's pick";
  if (!first.endsWith("?")) return `the decision does not ask a question: ${fix}`;
  if ((bare.match(/\?/g) ?? []).length > 1 || /,?\s+(?:and|or)\s+(?:is|are|do|does|did|should|shall|can|could|will|would|was|were)\s+\w+/i.test(first))
    return `the decision asks more than one thing: ${fix}`;
  return undefined;
}

/**
 * E948-S102: the source lets him place the card. It quotes his own words (in quotes) or names who raised it and why
 * ("The Gap finder raised it: …"); a card that only says "your voice note of 14 Nov" is held.
 */
export const RAISED_BY = /\b(?:raised|found|spotted|proposed|flagged|noticed|suggested)\b/i;
export function sourceWordsProblem(source: string): string | undefined {
  const bare = outsideLinks(source);
  if (/["“”«»]/.test(bare) || RAISED_BY.test(bare)) return undefined;
  return 'the source does not say where it came from in his words: quote his key words in quotes, or say who raised it and why';
}

export interface GateInput {
  card?: CardFields;
  /** The project's plain name and the goal sentence (the card's top line). */
  project?: string;
  goalSentence?: string;
  /** Whether the screenshot file exists in the repo. */
  screenshotFound?: boolean;
}

/**
 * the gate. A row becomes a card only when every field passes; the problems, in plain words, go to the agents
 * as "card needs rewriting" (the owner never sees them). Missing or GitHub evidence is "needs evidence" (evidenceProblem).
 */
export function gateProblems(g: GateInput): string[] {
  const c = g.card;
  if (!c) return ["it has no card file with the card fields (docs/review-cards.md)"];
  const out: string[] = [];
  const need = (v: string | undefined, label: string) => (v?.trim() ? undefined : `${label} is missing`);
  const add = (p: string | undefined) => p && out.push(p);
  add(need(c.title, "the title"));
  if (c.title) {
    if (!hasVerb(c.title)) out.push("the title has no verb: write one full sentence in the past tense");
    add(plainProblem("the title", c.title, CARD_LIMITS.title));
  }
  add(need(c.goal, "the goal of this task"));
  if (c.goal) add(plainProblem("the goal of this task", c.goal, CARD_LIMITS.goal));
  if (c.delivered.length < CARD_LIMITS.deliveredMin || c.delivered.length > CARD_LIMITS.deliveredMax) out.push(`it has ${c.delivered.length} delivered lines, it needs ${CARD_LIMITS.deliveredMin} to ${CARD_LIMITS.deliveredMax}`);
  c.delivered.forEach((d, i) => add(plainProblem(`delivered line ${i + 1}`, d.text, CARD_LIMITS.delivered)));
  add(need(g.project, "the project name"));
  if (g.project) add(plainProblem("the project name", g.project, 8));
  add(need(g.goalSentence, "the goal sentence of the epic"));
  if (g.goalSentence) add(plainProblem("the goal sentence of the epic", g.goalSentence, 20));
  if (c.name) add(plainProblem("the task name", c.name, CARD_LIMITS.name));
  if (c.after) add(plainProblem("the after line", c.after, CARD_LIMITS.after));
  c.next.forEach((n, i) => add(plainProblem(`next step ${i + 1}`, n.title, CARD_LIMITS.next)));
  // the label is the link's own words (it may name the page, memory.dev/connect)
  if (c.evidenceLabel && c.evidence) add(plainProblem("the evidence label", c.evidence, 6));
  // the card opens with where it came from and ends with the one decision asked: a card with neither is held back
  if (!c.source?.trim() && !c.from?.name) out.push("the source is missing: say where it came from, his words with their date and a link, or who raised it and why");
  if (c.source?.trim()) add(sourceProblem(c.source));
  // E948-S102: the source lets him place it, in his own words, or names who raised it
  if (c.source?.trim() && !c.from?.name) add(sourceWordsProblem(c.source));
  if (!c.decision?.trim()) out.push("the decision is missing: name the one decision asked of him, in plain words, with the team's recommendation");
  else {
    add(plainProblem("the decision", c.decision, CARD_LIMITS.decision));
    // E948-S85: a decision that sends him to act somewhere off the card links that place (his voice note of 12 Nov: "I need to see a link")
    add(decisionLinkProblem(c.decision));
    // E948-S102: the card says plainly what it asks, one question he can answer
    add(decisionAskProblem(c.decision));
  }
  // E948-S69: a decision card's buttons each name what happens next, `<label>: <next step>`
  if (c.options) {
    if (c.options.length < 2 || c.options.length > 4) out.push(`it has ${c.options.length} options, a decision needs 2 to 4`);
    c.options.forEach((o, i) => {
      if (!/^[^:]{1,30}:\s*\S/.test(o)) out.push(`option ${i + 1} does not name its next step: write it as <answer>: <what happens next>, like Yes: plan it`);
      else add(plainProblem(`option ${i + 1}`, o, 10));
    });
  }
  // a card never hands the owner terminal lines to copy
  const lines = copyPasteInText([c.title, c.goal, ...c.delivered.map((d) => d.text), c.after ?? "", ...c.next.map((n) => n.title), c.source ?? "", c.decision ?? ""].join("\n"));
  if (lines.length) out.push(`it gives ${ownerName()} a terminal line to copy (${lines[0].line}): make it a Mac-agent ticket or do it yourself`);
  // E948-S129: every address the card shows is one he can tap
  add(untappableProblem("the card", c.title, c.goal, ...c.delivered.map((d) => d.text), c.after, ...c.next.map((n) => n.title), c.source, c.decision, c.evidence, c.evidenceUrl, ...(c.options ?? [])));
  if (!c.screenshot) out.push("the screenshot is missing");
  else if (g.screenshotFound === false) out.push(`the screenshot ${c.screenshot} is not in the repo`);
  return out;
}

/** A sentence of the decision that starts by sending him to act off the card: sign in, install, upload, scan ("Open …" is the card's own evidence link). */
const ACT_ELSEWHERE = /(?:^|[.!?]\s+)(?:please\s+)?(sign in|sign up|log ?in|install|download|upload|scan|fill in)\b/i;

/**
 * E948-S85: the decision asks him to act somewhere other than the card's own buttons and evidence link, with no link to
 * that place. Undefined when it links it (a web address or a bare site like x.com), or asks nothing off the card.
 */
export function decisionLinkProblem(decision: string): string | undefined {
  const m = ACT_ELSEWHERE.exec(decision);
  if (!m || hasPlaceLink(decision)) return undefined;
  return `the decision asks ${ownerName()} to ${m[1].toLowerCase()} somewhere but does not link the place: put its link in the decision, or ask only what he answers on the card`;
}

/** Why the evidence cannot be judged: none, GitHub only, or a dry run (L-47). Undefined when it is a live, non-GitHub URL. */
export function evidenceProblem(c: CardFields | undefined, rowText = ""): string | undefined {
  if (!c) return undefined;
  if (!c.evidenceUrl) return c.evidence ? "the evidence is not a link" : "the evidence link is missing";
  if (!/^https?:\/\//i.test(c.evidenceUrl)) return "the evidence is not an http link";
  if (isGithubUrl(c.evidenceUrl)) return "the evidence is a GitHub page, it needs the live thing or an evidence page";
  const all = [c.title, c.goal, ...c.delivered.map((d) => d.text), rowText].join(" ");
  if (/\bdry[ -]?run\b/i.test(all)) return "the proof was a dry run, nothing real happened yet";
  return undefined;
}

/** A short label for the evidence link: the card's own, else the page's host and path, never the raw URL. */
export function evidenceLabelOf(c: Pick<CardFields, "evidenceLabel" | "evidenceUrl">): string {
  if (c.evidenceLabel) return c.evidenceLabel;
  try {
    const u = new URL(c.evidenceUrl ?? "");
    const p = u.pathname.replace(/\/$/, "");
    return `Open ${u.hostname.replace(/^www\./, "")}${p && p.length <= 24 ? p : ""}`;
  } catch {
    return "Open the evidence";
  }
}
