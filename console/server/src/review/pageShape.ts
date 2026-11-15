/**
 * Diagrams first, in the review gate (root L-59). The owner: "I just want to see boxes and arrows and diagrams."
 * A card whose evidence is a one-off page on the page host (the hosts in docs/pages/registry.json) must open with a picture: a diagram, image, table or boxed summary in its first screen.
 * One that opens with prose goes back to the agents as "needs evidence", like a dead link.
 *
 * The same test as `scripts/text_wall_check.py` (no-visual), on the served HTML: the page from its top until about
 * 180 words of visible text, head, style and script left out. The page server's parent bar is not the page's own
 * picture, so it is cut out first. A page built on the shared page shell (`data-page-shell`) with its diagram slot
 * filled passes by that alone.
 */

export const SCREEN_WORDS = 180;

const VISUAL =
  /<(svg|img|picture|video|canvas|figure|table|iframe)\b|class\s*=\s*["'][^"']*\b(box|boxes|card|cards|callout|tile|tiles|kpi|grid|diagram|wheel|pair|flow|steps|summary|badge|stat|stats|panel)\b|<pre[^>]*class\s*=\s*["'][^"']*mermaid|[┌┐└┘│─╭╮╰╯▶►→⟶]{2,}/i;

const words = (s: string) => (s.match(/[\w’'-]+/g) ?? []).length;

const unescape = (s: string) =>
  s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** The page from its top until `n` words of visible text (head, style, script and the page server's bar left out). */
function upTo(markup: string, n: number, inclusive: boolean): string {
  let body = markup.replace(/<(head|style|script|noscript)\b[\s\S]*?<\/\1>/gi, " ");
  // the page server's bar up to the page's parent is chrome, not the page's own picture
  body = body.replace(/<div\b[^>]*data-page-parent[^>]*>[\s\S]*?<\/div>/i, " ");
  const m = /<body\b[^>]*>/i.exec(body);
  if (m) body = body.slice(m.index + m[0].length);
  let count = 0;
  const re = />([^<]+)</g;
  let t: RegExpExecArray | null;
  while ((t = re.exec(body))) {
    count += words(unescape(t[1]));
    if (count >= n) return body.slice(0, inclusive ? t.index + t[0].length : t.index);
  }
  return body;
}

/** The first screen of a page: from <body> (or the top) until about 180 words of visible text. */
export const firstScreen = (markup: string) => upTo(markup, SCREEN_WORDS, true);

/** Why the page fails root L-59 (undefined when it opens with a picture). */
export function textWallProblem(markup: string): string | undefined {
  if (!/<\w/.test(markup)) return undefined; // not HTML: nothing to judge here
  if (VISUAL.test(firstScreen(markup))) return undefined;
  return "the evidence page opens with text: put a diagram or boxed summary in its first screen (root L-59, the shared page shell)";
}

export const TEXT_WALL_PREFIX = "the evidence page opens with text";

/**
 * A plan opens with a diagram (the owner's voice note vn_c23abab6 on a plan card: "when you tell me a plan, I expect
 * to see a diagram ... the idea is always a diagram. It's not a gigantic paragraph"). Stricter than the page test above:
 * boxes of text, a table or a stats strip are not a diagram. A drawn picture (svg, img, canvas, video, mermaid, box-drawing
 * arrows) or the page shell's diagram figure must come before PLAN_WORDS words of visible text (title and punchline fit).
 */
export const PLAN_WORDS = 80;
const DIAGRAM =
  /<(svg|img|picture|video|canvas)\b|class\s*=\s*["'][^"']*\b(ps-diagram|diagram|wheel|flow)\b|<pre[^>]*class\s*=\s*["'][^"']*mermaid|[┌┐└┘│─╭╮╰╯▶►→⟶]{2,}/i;
/** a card about a plan: its title, task goal or short name says plan, strategy, roadmap or proposal. */
export const PLAN_WORDS_RE = /\b(plans?|strategy|strategies|roadmap|proposals?)\b/i;
export const isPlan = (...texts: (string | undefined)[]) => texts.some((t) => !!t && PLAN_WORDS_RE.test(t));
export const PLAN_DIAGRAM_PREFIX = "a plan opens with a diagram";

/** true when the page shows a drawn diagram before PLAN_WORDS words of text; undefined when it is not HTML. */
export function diagramFirst(markup: string): boolean | undefined {
  if (!/<\w/.test(markup)) return undefined;
  return DIAGRAM.test(upTo(markup, PLAN_WORDS, false));
}

/** most visible words a plan page shows outside a closed details (the same cap as scripts/text_wall_check.py plan-words). */
export const PLAN_MAX_WORDS = 300;

/** the words a reader sees at once: no head, script, the page server's bar, nav, footer, closed details or a drawing's labels. */
export function visibleWords(markup: string): number {
  const body = markup
    .replace(/<(head|style|script|noscript|nav|footer|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<div\b[^>]*data-page-parent[^>]*>[\s\S]*?<\/div>/i, " ")
    .replace(/<details\b(?![^>]*\bopen\b)[\s\S]*?<\/details>/gi, " ");
  return words(unescape(body.replace(/<[^>]+>/g, " ")));
}

/**
 * Why a plan page fails (an empty string when it opens with a drawn diagram and keeps to a few words; undefined when it
 * is not HTML): the owner "cannot read so much", so a plan is a diagram with labels and one sentence, the rest folded.
 */
export function planShapeProblem(markup: string): string | undefined {
  const first = diagramFirst(markup);
  if (first === undefined) return undefined;
  if (!first) return `${PLAN_DIAGRAM_PREFIX}: the plan page's first screen has no drawn diagram before ${PLAN_WORDS} words of text (boxes of words or a table are not one); draw it first (root L-59, the owner's voice note vn_c23abab6)`;
  const n = visibleWords(markup);
  if (n > PLAN_MAX_WORDS) return `${PLAN_DIAGRAM_PREFIX} and few words: the plan page shows ${n} words outside a folded details (at most ${PLAN_MAX_WORDS}); make them labels on the diagram or fold them (the owner's voice note vn_c23abab6)`;
  return "";
}
