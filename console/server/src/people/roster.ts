import { proseLines, sections, stripInline } from "../adapters/markdown.js";

/**
 * a world lists its humans in its root spine, one line a
 * human, under `## People`. The repo is the roster (root L-45): every persona and every host reads the same names; the
 * console keeps only which login is which handle (memberships.handle).
 *
 *   ## People
 *   - @the owner: owner · area: all · alerts: WhatsApp, daily summary 08:00 Mexico City
 *   - @Marta: expert · area: books, tax filings · alerts: email, browser 09:00 to 18:00 Madrid
 *   - @Leo: analyst · area: books · escalates to: @Marta after 24 h · alerts: browser
 *   - @Sofia: made aware · area: tax filings · alerts: weekly email
 *
 * Four roles (the owner's answer, the four owner rules): only the owner approves money, changes a goal or adds people;
 * an outside human sees only the goals they are named on.
 */
export type PersonRole = "owner" | "expert" | "analyst" | "aware";
export const ROLES: readonly PersonRole[] = ["owner", "expert", "analyst", "aware"];

export interface Person {
  /** What asks use (`@Leo` → `Leo`). */
  handle: string;
  role: PersonRole;
  /** The goals they are named on: `all`, an epic code (``, `E90`), a spine file name, or words of a goal's title. */
  area: string[];
  /** Who gets their asks when they press Not sure or wait too long. */
  escalatesTo?: string;
  /** The time limit, in hours (`after 24 h`). */
  escalateAfterHours?: number;
  /** How and when they hear, as written. */
  alerts?: string;
  /** 0-based line in the root spine. */
  line: number;
}

export interface Roster {
  people: Person[];
  /** Lines under `## People` the parser could not read, naming the form. */
  problems: string[];
}

export const PEOPLE_FORM = "`- @<handle> : owner|expert|analyst|made aware · area: <goals> · escalates to: @<handle> after <n> h · alerts: <how>`";
const PERSON = /^\s*[-*]\s+@([A-Za-z0-9][\w.-]*)\s*:\s*(.+)$/;

const roleOf = (s: string): PersonRole | undefined => {
  const t = s.trim().toLowerCase();
  if (t === "owner") return "owner";
  if (t === "expert") return "expert";
  if (t === "analyst") return "analyst";
  if (t === "made aware" || t === "aware") return "aware";
  return undefined;
};

/** The `## People` section of a root spine (no section: an empty roster, the owner alone as today). */
export function parsePeople(markdown: string): Roster {
  const out: Roster = { people: [], problems: [] };
  const sec = sections(markdown).find((s) => /^people\b/i.test(stripInline(s.title)));
  if (!sec) return out;
  const all = proseLines(markdown);
  const start = all.findIndex((l) => /^#{1,6}\s+people\b/i.test(l));
  sec.lines.forEach((raw, k) => {
    const line = raw.trim();
    if (!line || !/^[-*]\s/.test(line)) return;
    const m = PERSON.exec(line);
    if (!m) {
      out.problems.push(`People line '${line.slice(0, 50)}' is not a form the tools read: write ${PEOPLE_FORM}`);
      return;
    }
    const [roleText, ...parts] = m[2].split(/\s+[·|]\s+/);
    const role = roleOf(stripInline(roleText));
    if (!role) {
      out.problems.push(`@${m[1]}: role '${roleText.trim()}' is not one of owner, expert, analyst, made aware`);
      return;
    }
    if (out.people.some((p) => p.handle.toLowerCase() === m[1].toLowerCase())) {
      out.problems.push(`@${m[1]} is listed twice`);
      return;
    }
    const p: Person = { handle: m[1], role, area: [], line: start + 1 + k };
    for (const part of parts) {
      const kv = /^\s*(area|escalates to|alerts)\s*:\s*(.*)$/i.exec(stripInline(part));
      if (!kv) continue;
      const key = kv[1].toLowerCase();
      const val = kv[2].trim();
      if (key === "area") p.area = val.split(/\s*,\s*/).filter(Boolean);
      else if (key === "alerts") p.alerts = val;
      else {
        const e = /@([A-Za-z0-9][\w.-]*)(?:\s+after\s+(\d+(?:\.\d+)?)\s*(h|hours?|d|days?)\b)?/i.exec(val);
        if (e) {
          p.escalatesTo = e[1];
          if (e[2]) p.escalateAfterHours = Number(e[2]) * (/^d/i.test(e[3]) ? 24 : 1);
        }
      }
    }
    if (p.role === "owner" && !p.area.length) p.area = ["all"];
    out.people.push(p);
  });
  for (const p of out.people)
    if (p.escalatesTo && !find(out, p.escalatesTo)) out.problems.push(`@${p.handle} escalates to @${p.escalatesTo}, who is not on the People list`);
  if (out.people.length && !out.people.some((p) => p.role === "owner")) out.problems.push("the People list names no owner");
  return out;
}

/** The person with this handle (any case, `@` optional), or undefined. */
export function find(r: Pick<Roster, "people">, who: string | undefined): Person | undefined {
  const h = (who ?? "").replace(/^@/, "").toLowerCase();
  return h ? r.people.find((p) => p.handle.toLowerCase() === h) : undefined;
}

/** A goal as the area check sees it: its epic code (``), spine path and title. */
export interface Goal {
  code?: string;
  path: string;
  title: string;
}
const short = (code: string) => code.toUpperCase().replace(/^EPIC-(\d+)$/, "E$1");
/** One area word covers a goal: `all`, its epic code (either form), its spine file name, or words of its title. */
export function areaCovers(area: string[], g: Goal): boolean {
  const stem = g.path.replace(/^.*\//, "").replace(/\.md$/i, "").toLowerCase();
  const title = stripInline(g.title).toLowerCase();
  return area.some((raw) => {
    const a = raw.trim().toLowerCase();
    if (!a) return false;
    if (a === "all") return true;
    if (g.code && /^(epic-|e)\d+$/i.test(a) && short(a) === short(g.code)) return true;
    if (a.replace(/\.md$/, "") === stem) return true;
    return a.length >= 3 && title.includes(a);
  });
}
