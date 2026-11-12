export interface DodItem {
  text: string;
  /** null = untracked criterion (a plain list item, not a checkbox). */
  checked: boolean | null;
  /** Original number of a numbered untracked criterion ("1" for "1...."); absent for bullets and checkboxes. */
  id?: string;
}
export interface Dod {
  done: number;
  total: number;
  items: DodItem[];
  /** true = checkbox items (done/total are real); false = the items are plain list criteria (no checkboxes),
   * so done/total stay 0 and progress is unknown. Absent when there are no criteria at all. */
  tracked?: boolean;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
/** "Definition of Done" / "Acceptance" anywhere in the heading; the newer names only as the heading's start
 * (optionally after one id word, e.g. "M2 Exit criteria"), so "Parked (until the exit test passes)" is not one. */
export const DOD_TITLE = /\b(definition of done|acceptance)\b|^(?:\S+\s+)?(exit test|exit criteria|success criteria|done when)\b/i;
/** Doctrine-2 `## Done means` (console contract): read first; the DoD headings above are the fallback. */
export const DONE_MEANS_TITLE = /^(?:\S+\s+)?done means\b/i;
const CHECKBOX = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.*\S)\s*$/;
/** Top-level (unindented) bullet or numbered item. */
const LIST_ITEM = /^(?:[-*+]|(\d+)[.)])\s+(.*\S)\s*$/;

/**
 * Checklist items under `## Done means` (Doctrine 2) when it has any; else under every "Definition Of Done" / "Acceptance" / "Exit Test" / "Exit criteria" /
 * "Success criteria" / "Done when" heading (any level, e.g. "## Acceptance Criteria"). A section ends at the
 * next heading of the same or higher level; checklists in deeper sub-headings are included. Fenced code is skipped.
 * When no such section has checkboxes, its top-level list items are returned as untracked criteria
 * (checked: null, tracked: false); numbered ones keep their number as `id`. Checkbox items give tracked: true.
 */
export function parseDod(markdown: string): Dod {
  const doneMeans = parseSections(markdown, DONE_MEANS_TITLE);
  return doneMeans.items.length ? doneMeans : parseSections(markdown, DOD_TITLE);
}

function parseSections(markdown: string, title: RegExp): Dod {
  const items: DodItem[] = [];
  const plain: DodItem[] = [];
  let sectionLevel = 0; // 0 = not inside a DoD section
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = HEADING.exec(line);
    if (h) {
      const level = h[1].length;
      if (sectionLevel && level <= sectionLevel) sectionLevel = 0;
      if (!sectionLevel && title.test(h[2])) sectionLevel = level;
      continue;
    }
    if (!sectionLevel) continue;
    const c = CHECKBOX.exec(line);
    if (c) items.push({ text: c[2], checked: c[1] !== " " });
    else {
      const l = LIST_ITEM.exec(line);
      if (l) plain.push(l[1] ? { text: l[2], checked: null, id: l[1] } : { text: l[2], checked: null });
    }
  }
  if (items.length === 0 && plain.length > 0) return { done: 0, total: 0, items: plain, tracked: false };
  if (items.length === 0) return { done: 0, total: 0, items };
  return { done: items.filter((i) => i.checked).length, total: items.length, items, tracked: true };
}
