/**
 * E948-S141 (the owner 18 Nov 04:30Z, his phone: "Done, waiting for your review 4" and the top bar 4 over one Sent row
 * and no open card; "Must have given this feedback more than 20 times"): the check that every inbox pill equals the open
 * cards its section draws, read from the page itself.
 *
 *   section pill  ==  open cards drawn in it ([data-inbox-open], a Sent row is never one)
 *   top bar red   ==  Blocked on you + Decisions waiting on you      top bar green  ==  Done, waiting for your review
 *
 * The same function runs in the unit test (inboxCountsMatchCards.test.tsx) and on his live inbox after each release
 * (hosted/console/scripts/inbox-count-check.mjs calls `window.inboxCountCheck()` on production, read only, at 390 px).
 * A folded section draws no cards, so it is reported `folded` and not compared: the live check opens every section first.
 */
export const COUNTED_SECTIONS = ["waiting-on-you", "inbox-decisions", "waiting-for-review", "inbox-goals-to-set", "inbox-team-cards"] as const;

export interface SectionCount {
  section: string;
  /** the number on its pill; 0 when no pill is drawn (a zero is hidden), null while it is still counting */
  pill: number | null;
  /** the open cards drawn in it */
  cards: number;
  folded: boolean;
}
export interface CountCheck {
  sections: SectionCount[];
  topbar: { red: number | null; green: number | null; redCards: number | null; greenCards: number | null } | null;
  mismatches: string[];
}

const pillOf = (root: ParentNode, testId: string): number | null => {
  const el = root.querySelector(`[data-testid="${testId}"]`);
  if (!el) return root.querySelector(`[data-testid="${testId}-loading"]`) ? null : 0;
  const n = Number((el.textContent ?? "").trim());
  return Number.isFinite(n) ? n : null;
};

/** the open cards drawn inside one section: each [data-inbox-open] counts 1, or its number (an ask set of n asks). */
export function openCardsDrawn(section: Element): number {
  let n = 0;
  for (const el of section.querySelectorAll("[data-inbox-open]")) {
    if (el.closest("[data-fold-section]") !== section) continue;
    if (el.querySelector('[data-testid="sent-row"]')) continue;
    const v = el.getAttribute("data-inbox-open");
    n += v ? Number(v) || 1 : 1;
  }
  return n;
}

export function inboxCountCheck(root: ParentNode = document): CountCheck {
  const sections: SectionCount[] = [];
  const mismatches: string[] = [];
  for (const id of COUNTED_SECTIONS) {
    const section = root.querySelector(`[data-fold-section][data-testid="${id}"]`);
    if (!section) continue;
    const toggle = section.querySelector(`[data-testid="${id}-toggle"]`);
    const folded = toggle?.getAttribute("aria-expanded") === "false";
    const pill = pillOf(section, `${id}-count`);
    const cards = openCardsDrawn(section);
    sections.push({ section: id, pill, cards, folded });
    if (!folded && pill !== null && pill !== cards) mismatches.push(`${id}: pill ${pill}, ${cards} open card${cards === 1 ? "" : "s"} drawn`);
  }
  let topbar: CountCheck["topbar"] = null;
  if (root.querySelector('[data-testid="topbar-team"]')) {
    const red = pillOf(root, "topbar-needs-you");
    const green = pillOf(root, "topbar-review");
    const by = (id: string) => sections.find((s) => s.section === id);
    const known = (...ids: string[]) => ids.every((id) => !by(id) || !by(id)!.folded);
    const redCards = known("waiting-on-you", "inbox-decisions") ? (by("waiting-on-you")?.cards ?? 0) + (by("inbox-decisions")?.cards ?? 0) : null;
    const greenCards = known("waiting-for-review") ? by("waiting-for-review")?.cards ?? 0 : null;
    topbar = { red, green, redCards, greenCards };
    // the sections are on this page only on the Inbox; elsewhere the top bar is not compared
    if (by("waiting-for-review") || by("waiting-on-you")) {
      if (red !== null && redCards !== null && red !== redCards) mismatches.push(`top bar red: ${red}, ${redCards} open cards in Blocked on you and Decisions`);
      if (green !== null && greenCards !== null && green !== greenCards) mismatches.push(`top bar green: ${green}, ${greenCards} open cards in Done, waiting for your review`);
    }
  }
  return { sections, topbar, mismatches };
}

declare global {
  interface Window {
    inboxCountCheck?: typeof inboxCountCheck;
  }
}
/** on every page, so the live check reads his inbox the way the test reads the rendered one. Read only. */
if (typeof window !== "undefined") window.inboxCountCheck = inboxCountCheck;
