/**
 * E948-S129 (the owner, vn_dc4a25de: "Why is it that there are links that I cannot click on?
 * ... we should never have a URL that is not clickable, bro."): the console makes every address in a card's or an ask's
 * words a link (web src/lib/linkjsx: a full http(s) URL, or a site written without https:// like x.com/settings or
 * host1.example.net:9658/). What it cannot make one he can tap is held here, in the ask gate (rule 12) and the review
 * card gate: an address on the server's own loopback (localhost, 127.0.0.1, 0.0.0.0: it opens nothing on his phone), a
 * bare IP or short host name with a port written without http:// (10.0.0.5:8770, host1:9658), and a URL broken by
 * a space after its scheme.
 */

/** A server's own address: never a page he can open. */
const LOOPBACK = /\bhttps?:\/\/(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0)(?::\d+)?[^\s)\]>"'`]*/gi;
/** host:port with no scheme where the host is an IP or a one-word name (the console cannot tell it is a page). */
const NO_SCHEME = /(?<![\w/:.@-])(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|[a-z][a-z0-9-]{1,30})(?::\d{2,5})(?:\/[^\s)\]>"'`]*)?(?![\w:])/gi;
/** "http:// host" or "https: //host": a link cut in two. */
const BROKEN = /\bhttps?:\/\/\s+\S|\bhttps?:\s+\/\/\S/gi;
/** Times and ratios that look like name:number (10:30, E995-A4:2) are not addresses. */
const NOT_ADDRESS = /^(?:\d{1,2}:\d{2}|[A-Z]\d+(?:-[A-Z]?\d+)*:\d+)$/;

/** The addresses in the text he could not tap; empty when every one is a link. */
export function untappableAddresses(text: string | null | undefined): string[] {
  if (!text) return [];
  // markdown links: the label is shown, the target is the link
  const t = text.replace(/!?\[([^\]\n]*)\]\(\s*<?([^)\s>]*)>?[^)]*\)/g, (_m, label: string, target: string) => `${label} ${/^https?:\/\//i.test(target) ? target : ""}`);
  const out = new Set<string>();
  for (const m of t.matchAll(LOOPBACK)) out.add(m[0].replace(/[.,;:!?]+$/, ""));
  for (const m of t.matchAll(NO_SCHEME)) {
    const a = m[0].replace(/[.,;:!?]+$/, "");
    if (!NOT_ADDRESS.test(a)) out.add(a);
  }
  for (const m of t.matchAll(BROKEN)) out.add(m[0].trim());
  return [...out];
}

/** The gate's words for the persona that wrote it; undefined when every address is one he can tap. */
export function untappableProblem(where: string, ...texts: (string | null | undefined)[]): string | undefined {
  const found = [...new Set(texts.flatMap((x) => untappableAddresses(x)))];
  if (!found.length) return undefined;
  return (
    `${where} shows an address he cannot tap (${found.slice(0, 3).join(", ")}): write each page as its full link that opens ` +
    `from his phone, http:// or https:// and a name he reaches (a page on a server is http://host1.example.net:<port>/), never ` +
    `localhost or a server's own address (E948-S129, his note of 17 Nov: "we should never have a URL that is not clickable")`
  );
}
