import { paragraphs } from "./postBasics";

/**
 * a post's
 * text and an idea's text split into labelled parts, for the detail views (the post page and the Pipeline's Full screen).
 */

/** One paragraph: its lead words and the " • " items that follow them ("five personas: • Scout … • Writer …"). */
export interface Para {
  lead: string;
  items: string[];
}

/** "a: • one • two" → lead "a:", items ["one", "two"]; a paragraph with fewer than two bullets stays whole. */
export function splitBullets(text: string): Para {
  const bits = text.split(/\s*[•▪]\s+/).map((s) => s.trim());
  if (bits.length < 3) return { lead: text.trim(), items: [] };
  const [lead, ...items] = bits;
  return { lead, items: items.filter(Boolean) };
}

/** One labelled part of a post: its paragraphs, and for an X thread its place ("2/5"). */
export interface TextPart {
  label: "Hook" | "Body" | "Call to action" | "Ending" | "Text";
  /** X thread: "2/5" (the marker taken off the text). */
  n?: string;
  paras: Para[];
}

const MARK = /^\[?(\d{1,2})\s*\/\s*(\d{1,2})\]?\s+/;
const CTA = /\?\s*$|https?:\/\/|\b(apply|sign up|join|reply|comment|dm|tell me|try it|link|form|waitlist|pick|testers?)\b/i;

/**
 * The text's parts: an X thread ("[1/5] … [2/5] …") is one part per post of the thread; any other text is its first
 * paragraph (the hook, unless the title is the hook), the middle (body) and its last paragraph (the call to action when
 * it asks something of the reader, else the ending). A short text (one or two paragraphs) stays one part.
 */
export function textParts(text: string, opts: { titleIsHook?: boolean } = {}): TextPart[] {
  const ps = paragraphs(text);
  if (!ps.length) return [];
  // X thread: a new part at each "[n/m]" marker.
  if (MARK.test(ps[0])) {
    const posts: { n: string; ps: string[] }[] = [];
    for (const p of ps) {
      const m = MARK.exec(p);
      if (m) posts.push({ n: `${m[1]}/${m[2]}`, ps: [p.slice(m[0].length)] });
      else posts[posts.length - 1].ps.push(p);
    }
    return posts.map((t, i) => ({
      label: i === 0 ? "Hook" : i === posts.length - 1 && posts.length > 2 ? (CTA.test(t.ps.join(" ")) ? "Call to action" : "Ending") : "Body",
      n: t.n,
      paras: t.ps.map(splitBullets),
    }));
  }
  if (ps.length < 3)
    return [
      {
        label: opts.titleIsHook ? "Body" : "Text",
        paras: ps.map(splitBullets),
      },
    ];
  const last = ps[ps.length - 1];
  const end: TextPart = {
    label: CTA.test(last) ? "Call to action" : "Ending",
    paras: [splitBullets(last)],
  };
  if (opts.titleIsHook) return [{ label: "Body", paras: ps.slice(0, -1).map(splitBullets) }, end];
  return [{ label: "Hook", paras: [splitBullets(ps[0])] }, { label: "Body", paras: ps.slice(1, -1).map(splitBullets) }, end];
}

/** The sentences of a text (a "." "?" or "!" then a space and a capital, a quote or a bracket). */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.?!]["”)]?)\s+(?=[A-Z"“(]|r\/)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface IdeaParts {
  /** What the post would say (the idea's opening sentences). */
  what: string[];
  /** Why it matters to the reader (its "human stake" sentence), when the idea says it. */
  why: string[];
  /** Who it is for: platform, format, the communities it names, the notes in its opening brackets. */
  audience: string[];
  /** How to write it: the Scout's notes to the Writer, one per line. */
  how: string[];
  /** Where it came from: the thread it was seen on, its message and topic refs. */
  source: string[];
}

const WHY = /^(the human stake|the stake|why\b|because\b|this matters)/i;
const SOURCE = /^(live thread|source\b|seen\b|thread\b|from\b|check the)/i;
const HOW =
  /^(state the purpose|open on|open with|mechanism|say what|end on|end with|keep|no |pain and|our own case|honest|disclose|ask first|lead with|one |use |show |avoid|do not|don't|never|start|close)/i;

/**
 * An idea's text in parts: what (its opening sentences), why (the human stake), audience (platform, format, the
 * communities it names), how to write it (the Scout's notes) and source (the thread, the topic and message refs).
 */
export function ideaParts(text: string, idea: { platform?: string | null; format?: string | null } = {}): IdeaParts {
  let t = text.trim();
  const audience: string[] = [];
  const source: string[] = [];
  // "Reddit discussion (r/ContextEngineering, for M1; ask first, disclose, no link): …" → audience notes.
  const head = /^([^:()]{2,60})\(([^()]{2,160})\):\s+/.exec(t);
  if (head) {
    audience.push(`${head[1].trim()}: ${head[2].trim()}`);
    t = t.slice(head[0].length);
  }
  // A closing "(T-1103-1, T-1103-4, messages 1 and 6)" → source refs.
  const refs = /\s*\(((?:T-\d|messages?\b|L-\d|EPIC|E\d)[^()]*)\)\.?\s*$/.exec(t);
  if (refs) {
    source.push(`Topics and messages: ${refs[1].trim()}`);
    t = t.slice(0, refs.index).trim();
  }
  const what: string[] = [];
  const why: string[] = [];
  const how: string[] = [];
  let started = false;
  for (const s of sentences(t)) {
    if (WHY.test(s)) (why.push(s), (started = true));
    else if (SOURCE.test(s)) (source.unshift(s), (started = true));
    else if (/^r\/\w/.test(s)) (audience.push(s), (started = true));
    else if (HOW.test(s)) (how.push(s), (started = true));
    else if (!started) what.push(s);
    else how.push(s);
  }
  // Semicolon lists inside a note read as one line each.
  const howLines = how.flatMap((s) => (s.length > 160 && s.includes("; ") ? s.split(/;\s+/) : [s]));
  const where = [idea.platform, idea.format].filter(Boolean).join(", ");
  // The communities it names, unless a line of its own already says where it goes.
  const communities = audience.some((a) => /\br\//.test(a)) ? [] : [...new Set(t.match(/\br\/[A-Za-z0-9_]+/g) ?? [])];
  if (where || communities.length) audience.unshift([where, communities.length ? `in ${communities.join(", ")}` : ""].filter(Boolean).join(" · "));
  return {
    what: what.length ? what : [t],
    why,
    audience,
    how: howLines,
    source,
  };
}
