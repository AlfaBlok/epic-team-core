// Small markdown readers for spines and epic tickets: headings, sections, `Key: value` fields, pipe tables.
// Fenced code blocks are ignored everywhere.

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/** Lines outside fenced code blocks (fence lines and their contents become ""), so line indexes stay stable. */
export function proseLines(markdown: string): string[] {
  let inFence = false;
  return markdown.split(/\r?\n/).map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return "";
    }
    return inFence ? "" : line;
  });
}

export interface Section {
  title: string;
  level: number;
  /** Body lines up to the next heading of the same or higher level (sub-headings included). */
  lines: string[];
}

export function sections(markdown: string): Section[] {
  const lines = proseLines(markdown);
  const heads: { i: number; level: number; title: string }[] = [];
  lines.forEach((line, i) => {
    const h = HEADING.exec(line);
    if (h) heads.push({ i, level: h[1].length, title: h[2] });
  });
  return heads.map((h, k) => {
    const end = heads.slice(k + 1).find((n) => n.level <= h.level)?.i ?? lines.length;
    return { title: h.title, level: h.level, lines: lines.slice(h.i + 1, end) };
  });
}

/** First section whose title matches. */
export function section(markdown: string, title: RegExp): Section | undefined {
  return sections(markdown).find((s) => title.test(s.title));
}

/** Text of the first `# H1`, without markdown emphasis. */
export function firstH1(markdown: string): string | undefined {
  for (const line of proseLines(markdown)) {
    const h = HEADING.exec(line);
    if (h && h[1].length === 1) return stripInline(h[2]);
  }
  return undefined;
}

/** Value of the first `Key: value` line (also `- Key: value`, `**Key:** value`). */
export function field(lines: string[] | string, key: string): string | undefined {
  const list = typeof lines === "string" ? proseLines(lines) : lines;
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*(?:[-*]\\s+)?(?:\\*\\*)?${k}(?::\\*\\*|\\*\\*:|:)\\s*(.*\\S)\\s*$`, "i");
  for (const line of list) {
    const m = re.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/** `[E1](../x.md)` → `E1`, drops `**`/`` ` `` emphasis. */
export function stripInline(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .trim();
}

/** First markdown link target in a cell, if any. */
export function linkTarget(text: string): string | undefined {
  return /\[[^\]]*\]\(([^)\s]+)\)/.exec(text)?.[1];
}

export interface Table {
  headers: string[];
  rows: { cells: string[]; raw: string[] }[];
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim());
}

/** Pipe tables (header row + `---` separator) in the given lines. */
export function tables(lines: string[]): Table[] {
  const out: Table[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].trim().startsWith("|") || !/^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) continue;
    const headers = splitRow(lines[i]).map(stripInline);
    const rows: Table["rows"] = [];
    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith("|"); j++) {
      const raw = splitRow(lines[j]);
      rows.push({ raw, cells: raw.map(stripInline) });
    }
    out.push({ headers, rows });
    i = j - 1;
  }
  return out;
}
