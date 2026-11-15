/**
 * A pinned page has a short plain name a person understands ("Scorecard"), never an epic or
 * row code. The same rules as the server (server/src/pagePins.ts) and scripts/pages.py, so the pin box can say why
 * before it sends.
 */
export const CODE_RE = /\b(?:EPIC-\d+|E\d+-[A-Z]+\d+|[A-Z]{1,4}\d*-[A-Z]?\d+|L\d+|vn_\w+|run_\w+)\b/g;
export const NAME_MAX = 40;

/** why `name` cannot be a pinned page's name, or "" when it can. */
export function nameProblem(name: string): string {
  const n = name.trim();
  if (!n) return "Give it a name";
  if (n.length > NAME_MAX) return `Keep it short: ${NAME_MAX} characters at most`;
  if (new RegExp(CODE_RE.source).test(n)) return "Plain words, no epic or row code";
  return "";
}

/** a first plain name from a page's title: codes, brackets and a "Pinned:" lead dropped, the first clause kept. */
export function proposeName(title: string | undefined): string {
  let t = (title ?? "").replace(/\([^)]*\)/g, " ").replace(/^\s*pinned\s*:\s*/i, "").replace(CODE_RE, " ");
  t = t.split(/\s[-–—]\s|[:;,.|]/)[0];
  t = t.replace(/^\s*(the|a|an|our|your)\s+/i, "").replace(/\s+/g, " ").trim().replace(/^[-–—\s]+|[-–—\s]+$/g, "");
  const words = t.split(" ");
  while (words.join(" ").length > NAME_MAX && words.length > 1) words.pop();
  t = words.join(" ");
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}
