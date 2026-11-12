/**
 * Markdown links (`[label](target)`, `![alt](src)`) and bare http(s) URLs in spine text → safe link segments.
 * Only http/https and repo-relative targets get an href; anything else (javascript:, data:, mailto:, `//host`,
 * a path escaping the repo, no remote to resolve against) stays plain text. Callers render segments as React
 * text / <a>, never as HTML, so no markup in the source can inject.
 */

export type LinkSegment = { text: string; href?: undefined } | { text: string; href: string };

export interface LinkBase {
  /** `owner/repo` on GitHub, for repo-relative targets. */
  remote?: string;
  /** Repo path of the spine the text came from; relative targets resolve against its folder, like GitHub does. */
  path?: string;
}

// Targets may hold one level of balanced parens (`wiki/Foo_(bar)`), as GitHub allows.
const MD_LINK = /!?\[([^\]\n]*)\]\(\s*<?((?:[^\s()<>]|\([^\s()<>]*\))*)>?(?:\s+"[^"]*")?\s*\)/g;
const BARE_URL = /https?:\/\/[^\s<>()[\]`"']+/gi;
const TRAILING_PUNCT = /[.,;:!?]+$/;

/** A link target → an href we are willing to open, or undefined. */
export function safeHref(target: string, base: LinkBase = {}): string | undefined {
  const t = target.trim();
  if (!t || /[\s\\\u0000-\u001f\u007f]/.test(t)) return undefined;
  if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t);
      return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
    } catch {
      return undefined;
    }
  }
  // Any other scheme (javascript:, data:, mailto:, vbscript:, file:) or protocol-relative `//host`: refused.
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith("//")) return undefined;
  if (!base.remote || !/^[\w.-]+\/[\w.-]+$/.test(base.remote)) return undefined;
  const hashAt = t.indexOf("#");
  const pathPart = hashAt >= 0 ? t.slice(0, hashAt) : t;
  const hash = hashAt >= 0 ? t.slice(hashAt) : "";
  const spineDir = (base.path ?? "").replace(/^\.\//, "").split("/").slice(0, -1);
  let segs: string[];
  if (!pathPart) {
    // `#anchor` alone: the spine itself.
    if (!base.path) return undefined;
    segs = base.path.replace(/^\.\//, "").split("/");
  } else {
    segs = pathPart.startsWith("/") ? [] : [...spineDir];
    for (const s of pathPart.split("/")) {
      if (s === "" || s === ".") continue;
      if (s === "..") {
        if (!segs.length) return undefined; // escapes the repo
        segs.pop();
      } else segs.push(s);
    }
    if (!segs.length) return undefined;
  }
  return `https://github.com/${base.remote}/blob/HEAD/${segs.map(encodeURIComponent).join("/")}${hash}`;
}

/** Bare URLs inside plain text → segments; trailing sentence punctuation stays text. */
function bareUrls(text: string, out: LinkSegment[]) {
  let last = 0;
  for (const m of text.matchAll(BARE_URL)) {
    const url = m[0].replace(TRAILING_PUNCT, "");
    const at = m.index ?? 0;
    const href = safeHref(url);
    if (!href) continue;
    if (at > last) out.push({ text: text.slice(last, at) });
    out.push({ text: url, href });
    last = at + url.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
}

/** Text → ordered segments; joined `text` equals the source with Markdown link syntax reduced to its label. */
export function linkSegments(text: string, base: LinkBase = {}): LinkSegment[] {
  const out: LinkSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(MD_LINK)) {
    const at = m.index ?? 0;
    if (at > last) bareUrls(text.slice(last, at), out);
    const label = m[1].trim() || m[2];
    const href = safeHref(m[2], base);
    out.push(href ? { text: label, href } : { text: label });
    last = at + m[0].length;
  }
  if (last < text.length) bareUrls(text.slice(last), out);
  // Merge adjacent plain segments.
  return out.reduce<LinkSegment[]>((acc, s) => {
    const prev = acc[acc.length - 1];
    if (prev && !prev.href && !s.href) acc[acc.length - 1] = { text: prev.text + s.text };
    else acc.push(s);
    return acc;
  }, []);
}

/** True when the text holds a Markdown link or a URL that is not the whole text. */
export function hasInlineLinks(text: string): boolean {
  return new RegExp(MD_LINK.source).test(text) || (new RegExp(BARE_URL.source, "i").test(text) && !/^https?:\/\/\S+$/i.test(text.trim()));
}
