import { copyPasteInText } from "../steps/copyPaste.js";
import { stripInline } from "../adapters/markdown.js";
import { ownerName } from "../identity.js";

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
  let list: "delivered" | "next" | undefined;
  let any = false;
  for (const raw of fm) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const item = /^\s*[-*]\s+(.*)$/.exec(raw);
    if (item && list) {
      if (list === "delivered") {
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
    add(plainProblem("the title", c.title, 20));
  }
  add(need(c.goal, "the goal of this task"));
  if (c.goal) add(plainProblem("the goal of this task", c.goal, 20));
  if (c.delivered.length < 2 || c.delivered.length > 4) out.push(`it has ${c.delivered.length} delivered lines, it needs 2 to 4`);
  c.delivered.forEach((d, i) => add(plainProblem(`delivered line ${i + 1}`, d.text, 20)));
  add(need(g.project, "the project name"));
  if (g.project) add(plainProblem("the project name", g.project, 8));
  add(need(g.goalSentence, "the goal sentence of the epic"));
  if (g.goalSentence) add(plainProblem("the goal sentence of the epic", g.goalSentence, 20));
  if (c.name) add(plainProblem("the task name", c.name, 12));
  if (c.after) add(plainProblem("the after line", c.after, 25));
  c.next.forEach((n, i) => add(plainProblem(`next step ${i + 1}`, n.title, 20)));
  // the label is the link's own words (it may name the page, memory.dev/connect)
  if (c.evidenceLabel && c.evidence) add(plainProblem("the evidence label", c.evidence, 6));
  // a card never hands the owner terminal lines to copy
  const lines = copyPasteInText([c.title, c.goal, ...c.delivered.map((d) => d.text), c.after ?? "", ...c.next.map((n) => n.title)].join("\n"));
  if (lines.length) out.push(`it gives ${ownerName()} a terminal line to copy (${lines[0].line}): make it a Mac-agent ticket or do it yourself`);
  if (!c.screenshot) out.push("the screenshot is missing");
  else if (g.screenshotFound === false) out.push(`the screenshot ${c.screenshot} is not in the repo`);
  return out;
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
