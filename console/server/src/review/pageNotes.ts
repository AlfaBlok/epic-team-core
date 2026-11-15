/**
 * a note the owner left in a page's own feedback box (a steps-kit step: typed or by voice) shows on the inbox card
 * of the row it is about, so he sees it landed. The steps kit files each note as one `## Decisions` row
 * (steps.ts applyStep): `Step note: <step> on <page> [step-note <page id>/<step>] at 23:49Z, for E907-S3; his words: "…"`
 * with the page's address in the evidence cell. A note belongs to a row when it names the row (`for <row>`) or was left on
 * a page the row's evidence opens (older notes name no row). Read from the spine only (root L-45).
 */
export interface PageNote {
  /** YYYY-MM-DD, from the Decisions row. */
  date: string;
  /** HH:MM (UTC) when the line kept it. */
  time?: string;
  /** his words, as the line keeps them (at most 600 characters, a full-note file named after them). */
  words: string;
  /** the page it was left on. */
  url?: string;
  /** the step's title on that page (`Your feedback on this page`). */
  step?: string;
  /** a Stuck switch with words, not a plain note. */
  stuck?: boolean;
  /** the rows and asks the step names (`for E907-S3 and E907-A4`). */
  refs: string[];
}

const MARK = /\[(step-note|step-stuck) (sp_[\w]+)\/([\w.-]+)\]/;

export function pageNotesOf(text: string): PageNote[] {
  const out: PageNote[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    const m = MARK.exec(t);
    if (!m) continue;
    const cells = t.replace(/^\||\|$/g, "").split(" | ").map((c) => c.trim());
    const cell = cells.find((c) => c.includes('his words: "'));
    const words = cell ? /his words: "(.*)"/.exec(cell)?.[1]?.trim() : undefined;
    if (!words || !cell) continue;
    const date = /^(\d{4}-\d{2}-\d{2})/.exec(cells[0] ?? "")?.[1] ?? "";
    const after = cell.slice(cell.indexOf(m[0]) + m[0].length, cell.indexOf('his words: "'));
    const time = /\bat (\d{2}:\d{2})Z/.exec(after)?.[1];
    const refs = /\bfor ([^;]+)/.exec(after)?.[1].split(/\s+and\s+|,\s*/).map((x) => x.trim()).filter((x) => /^[A-Z][\w-]*\d/.test(x)) ?? [];
    const step = /^Step (?:note|stuck): (.+?) on /.exec(cell)?.[1];
    const url = cells.find((c) => /^https?:\/\/\S+$/.test(c));
    out.push({ date, words, refs, ...(time ? { time } : {}), ...(url ? { url } : {}), ...(step ? { step } : {}), ...(m[1] === "step-stuck" ? { stuck: true } : {}) });
  }
  return out;
}

/** The page a link opens (host with port and path, no trailing slash), to match a note's page to a row's evidence. */
const pageKey = (url: string | undefined): string | undefined => {
  try {
    const u = new URL(url ?? "");
    return `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
};

/** The notes on row `ref`, newest last, at most `max`: those that name it, or (naming no row) left on a page it links. */
export function pageNotesFor(notes: PageNote[], ref: string, urls: (string | undefined)[], max = 3): PageNote[] {
  const pages = new Set(urls.map(pageKey).filter((x): x is string => !!x));
  const mine = notes.filter((n) => (n.refs.length ? n.refs.includes(ref) : !!n.url && pages.has(pageKey(n.url) ?? "")));
  return mine.slice(-max);
}
