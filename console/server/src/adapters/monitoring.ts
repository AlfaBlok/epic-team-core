import { stripInline } from "./markdown.js";

/**
 * one item of a Current State `Monitoring:` line, a wait on a time or a condition (nothing for the owner to do):
 * `Monitoring: <what> since <date> until <date> · next check <ISO> <what> · then <what happens after>`; several
 * items are separated by `; `. Dates are ISO UTC strings (as parsed); a part that does not parse is left out.
 */
export interface MonitorItem {
  what: string;
  since?: string;
  until?: string;
  nextCheckAt?: string;
  /** What the next check looks at, e.g. "archiver delete proof (DOD-2)". */
  nextCheck?: string;
  then?: string;
}

const NONE = /^(none|n\/a|-+|—|–)?\.?$/i;
/** An ISO date or date-time (T separator, optional seconds, Z or ±hh:mm), as the first token. */
const DATE = /^(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?)\b/i;

/** `2026-10-24T06:53+02:00` → ISO UTC; undefined when it is not a date. */
function isoDate(token: string): string | undefined {
  const m = DATE.exec(token.trim());
  if (!m) return undefined;
  const t = Date.parse(m[1].replace(" ", "T").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function parseItem(raw: string): MonitorItem | undefined {
  const parts = raw.split(/\s+[·•|]\s+/).map((x) => x.trim()).filter((x) => /[\p{L}\p{N}]/u.test(x));
  if (parts.length === 0) return undefined;
  const item: MonitorItem = { what: "" };
  for (const [i, part] of parts.entries()) {
    const next = /^next\s+check(?:\s+(?:at|on))?\s*:?\s*(.*)$/i.exec(part);
    if (next) {
      const at = isoDate(next[1]);
      if (at) item.nextCheckAt = at;
      const what = (at ? next[1].trim().replace(DATE, "") : next[1]).trim().replace(/^[:,-]\s*/, "").trim();
      if (what) item.nextCheck = /^\([^()]*\)$/.test(what) ? what.slice(1, -1) : what;
      continue;
    }
    const then = /^then\s*:?\s*(.+)$/i.exec(part);
    if (then) {
      item.then = then[1].trim();
      continue;
    }
    if (i > 0) continue; // malformed extra part: ignored
    // The first part: `<what> since <date> until <date>` (since/until optional, either order).
    let what = part;
    for (const key of ["since", "until"] as const) {
      const m = new RegExp(`\\s*\\b${key}\\s+(\\S+)`, "i").exec(what);
      if (!m) continue;
      const at = isoDate(m[1]);
      if (!at) continue;
      item[key] = at;
      what = (what.slice(0, m.index) + what.slice(m.index + m[0].length)).trim();
    }
    item.what = what.replace(/[,;:]$/, "").trim();
  }
  if (!item.what && !item.nextCheckAt && !item.until) return undefined;
  return item;
}

/** Items of a `Monitoring:` value (one line or several); absent, `none` or nothing parseable = []. Never throws. */
export function parseMonitoring(text?: string | string[] | null): MonitorItem[] {
  const lines = (Array.isArray(text) ? text : [text ?? ""]).map((t) => stripInline(t ?? "")).filter((t) => t && !NONE.test(t.trim()));
  const out: MonitorItem[] = [];
  for (const line of lines)
    for (const raw of line.split(/\s+;\s+/)) {
      try {
        const item = parseItem(raw);
        if (item) out.push(item);
      } catch {
        /* tolerant: a part we cannot read is skipped */
      }
    }
  return out;
}
