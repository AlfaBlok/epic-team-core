/**
 * E948-S129 (the owner, vn_dc4a25de, on a startup-credits card: "one of them has a link to [a server page]
 * ... but I cannot click on it. Why is it that there are links that I cannot click on? ... we should never have a URL that
 * is not clickable, bro."): every http(s) URL the console renders as text is a link, on every card, ask, page and desk
 * message, in both skins. Our own JSX compiles through this runtime (vite.config `jsxImportSource`), so a string child of
 * any host element that holds a URL renders as text + <a> + text: React renders the link itself, nothing patches the
 * DOM. Left as text: inside <a>, pre, form fields, SVG text, a copy box (a select-all code, `data-runs-on`,
 * `data-owner-command`) and any element marked `data-url-plain`.
 * No JSX in this folder: it is the runtime.
 */
import { Fragment, createElement, type MouseEvent, type ReactNode } from "react";
import { safeHref } from "@/lib/mdlinks";

/**
 * A full http(s) URL, or a page address written without its scheme on a known ending, with its path or port
 * (x.com/settings, host1.example.net:9658/; a bare name like example.org or a cookie's reddit.com is a label, not a
 * page, and stays text): the same endings the ask gate counts as a link (server inbox/askGate.ts WEB_LINK), less
 * the ones that are also file names (.sh, .so, .to). Never inside an e-mail address or a path.
 */
export const URL_IN = /https?:\/\/[^\s<>()[\]`"']+|(?<![@\w.\/:+-])(?:[a-z0-9-]+\.)+(?:com|io|dev|app|net|org|ai|eu|co|me|es|mx|tv|ly|link|site|page)(?::\d{2,5}(?:\/[^\s<>()[\]`"']*)?|\/[^\s<>()[\]`"']*)(?![\w@-])/gi;
const TRAILING = /[.,;:!?]+$/;
/** Host elements whose text stays text (pre: a block to copy whole). */
const PLAIN = new Set(["a", "pre", "textarea", "input", "option", "optgroup", "select", "title", "style", "script", "text", "tspan", "desc", "svg"]);
/** Inline code links its URLs too (spines write them in backticks), except a copy box: a command he copies whole. */
const CODE = new Set(["code", "kbd", "samp"]);

/** The href a written address opens: as written, or http(s):// before one written without (http for a tailnet name or a port). */
export function hrefOf(written: string): string | undefined {
  if (/^https?:\/\//i.test(written)) return safeHref(written);
  const host = written.split(/[/?#]/)[0];
  return safeHref(`${/\.ts\.net(?::\d+)?$|:\d+$/i.test(host) ? "http" : "https"}://${written}`);
}

export const LINK_CLASS = "underline decoration-current/40 underline-offset-2 [overflow-wrap:anywhere] hover:decoration-current";

/** A link inside a button or a clickable card row opens itself and never presses what is around it. */
function openOwn(e: MouseEvent<HTMLAnchorElement>) {
  e.stopPropagation();
  const host = e.currentTarget.parentElement?.closest("button, [role=button], summary");
  if (host) {
    e.preventDefault();
    window.open(e.currentTarget.href, "_blank", "noopener,noreferrer");
  }
}

/** The text's URLs as links; the same string back when it has none. */
export function linkUrls(text: string): ReactNode {
  if (!/:\/\/|\.[a-z]{2,4}\b/i.test(text)) return text;
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_IN)) {
    const url = m[0].replace(TRAILING, "");
    const href = hrefOf(url);
    const at = m.index ?? 0;
    if (!href) continue;
    if (at > last) parts.push(text.slice(last, at));
    parts.push(createElement("a", { key: `u${at}`, href, target: "_blank", rel: "noreferrer", className: LINK_CLASS, "data-auto-link": "", onClick: openOwn }, url));
    last = at + url.length;
  }
  if (!parts.length) return text;
  if (last < text.length) parts.push(text.slice(last));
  return createElement(Fragment, null, ...parts);
}

/** A host element's props with its string children's URLs as links (same object when nothing changes). */
export function linkProps<P>(type: unknown, props: P): P {
  // a fragment's text lands in its parent host element without passing through one: linked here too
  if (!(type === Fragment || (typeof type === "string" && !PLAIN.has(type))) || !props || typeof props !== "object") return props;
  const p = props as Record<string, unknown>;
  const kids = p.children;
  if (kids == null || p["data-url-plain"] !== undefined || p["data-owner-command"] !== undefined || p["data-runs-on"] !== undefined || p.dangerouslySetInnerHTML) return props;
  if (typeof type === "string" && CODE.has(type) && /\bselect-all\b/.test(String(p.className ?? ""))) return props;
  if (typeof kids === "string") {
    const out = linkUrls(kids);
    return out === kids ? props : ({ ...p, children: out } as P);
  }
  if (Array.isArray(kids) && kids.some((k) => typeof k === "string" && k.length > 3)) {
    // each string keeps its place in the list, so the siblings around it keep who they are
    const next = kids.map((k, i) => {
      if (typeof k !== "string") return k;
      const out = linkUrls(k);
      return out === k ? k : createElement(Fragment, { key: `url-text-${i}` }, out);
    });
    return { ...p, children: next } as P;
  }
  return props;
}
