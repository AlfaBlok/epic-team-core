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

/** The first screen of a page: from <body> (or the top) until about 180 words of visible text. */
export function firstScreen(markup: string): string {
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
    if (count >= SCREEN_WORDS) return body.slice(0, t.index + t[0].length);
  }
  return body;
}

/** Why the page fails root L-59 (undefined when it opens with a picture). */
export function textWallProblem(markup: string): string | undefined {
  if (!/<\w/.test(markup)) return undefined; // not HTML: nothing to judge here
  if (VISUAL.test(firstScreen(markup))) return undefined;
  return "the evidence page opens with text: put a diagram or boxed summary in its first screen (root L-59, the shared page shell)";
}

export const TEXT_WALL_PREFIX = "the evidence page opens with text";
