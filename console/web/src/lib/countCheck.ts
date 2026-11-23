/**
 * E948-S141 (the owner 18 Nov 04:30Z, his phone: "Done, waiting for your review 4" and the top bar 4 over one Sent row
 * and no open card; "Must have given this feedback more than 20 times"): the check that every inbox pill equals the open
 * cards its section draws, read from the page itself.
 *
 *   section pill  ==  open cards drawn in it ([data-inbox-open], a Sent row is never one)
 *   top bar red   ==  Blocked on you + Decisions waiting on you      top bar green  ==  Done, waiting for your review
 *   (E948-S178: plus every card of the Urgent section, red; a card there toned green is a mismatch)
 *
 *   menu Inbox red/green  ==  top bar red/green (E948-S141 iteration 2: phone and laptop read the same numbers)
 * The same function runs in the unit test (inboxCountsMatchCards.test.tsx) and on his live inbox after each release
 * (hosted/console/scripts/inbox-count-check.mjs calls `window.inboxCountCheck()` on production, read only, at 390 px).
 * A folded section draws no cards, so it is reported `folded` and not compared: the live check opens every section first.
 */
export const COUNTED_SECTIONS = ["inbox-urgent", "waiting-on-you", "inbox-decisions", "waiting-for-review", "inbox-goals-to-set", "inbox-team-cards"] as const;

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
  /** E948-S141 iteration 2: the menu's Inbox pills (the laptop's sidebar; the phone's menu when open), null when not drawn */
  sidebar: { red: number | null; green: number | null } | null;
  mismatches: string[];
}

const pillOf = (root: ParentNode, testId: string): number | null => {
  const el = root.querySelector(`[data-testid="${testId}"]`);
  if (!el) return root.querySelector(`[data-testid="${testId}-loading"]`) ? null : 0;
  const n = Number((el.textContent ?? "").trim());
  return Number.isFinite(n) ? n : null;
};

/** the open cards drawn inside one section: each [data-inbox-open] counts 1, or its number (an ask set of n asks). */
export function openCardsDrawn(section: Element, tone?: "red" | "green"): number {
  let n = 0;
  for (const el of section.querySelectorAll("[data-inbox-open]")) {
    if (el.closest("[data-fold-section]") !== section) continue;
    if (el.querySelector('[data-testid="sent-row"]')) continue;
    // E948-S132: the Urgent section holds both kinds; each card says which top bar number it counts in
    if (tone && el.getAttribute("data-inbox-tone") !== tone) continue;
    const v = el.getAttribute("data-inbox-open");
    n += v ? Number(v) || 1 : 1;
  }
  return n;
}

/**
 * E948-S182 (the owner 22 Nov 23:5xZ: the kernel plan ask showed twice in Urgent and Urgent counted 2): one ask is one card.
 * Each open card carries `data-card-key` (`ask:<repo>/<code>`, `row:<repo>/<row>`); the same key on two open cards of the
 * inbox is a mismatch naming both, so a doubled card never passes as a right count.
 */
export const cardKey = (kind: "ask" | "row", repo: string | null | undefined, code: string | null | undefined) => (code ? `${kind}:${repo ?? ""}/${code.toUpperCase()}` : undefined);
export function duplicateCards(root: ParentNode = document): string[] {
  const seen = new Map<string, string[]>();
  for (const id of COUNTED_SECTIONS) {
    const section = root.querySelector(`[data-fold-section][data-testid="${id}"]`);
    if (!section) continue;
    for (const el of section.querySelectorAll("[data-inbox-open]")) {
      if (el.closest("[data-fold-section]") !== section || el.querySelector('[data-testid="sent-row"]')) continue;
      const key = el.getAttribute("data-card-key") ?? el.querySelector("[data-card-key]")?.getAttribute("data-card-key");
      if (key) seen.set(key, [...(seen.get(key) ?? []), id]);
    }
  }
  return [...seen].filter(([, at]) => at.length > 1).map(([key, at]) => `${key.replace(/^(ask|row):/, "")} shows ${at.length} cards (${at.join(", ")}): one ask is one card`);
}

export function inboxCountCheck(root: ParentNode = document): CountCheck {
  const sections: SectionCount[] = [];
  const mismatches: string[] = [...duplicateCards(root)];
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
    // E948-S178 (the owner 22 Nov 20:57Z, vn_facd277a: "The one in Urgent is a red one ... it's being counted as one of the
    // green ones"): Urgent is a red section, every card in it counts red, never green; green is Done, waiting for your review only
    const urgent = root.querySelector('[data-fold-section][data-testid="inbox-urgent"]');
    const urgentGreen = urgent ? openCardsDrawn(urgent, "green") : 0;
    if (urgentGreen > 0) mismatches.push(`Urgent: ${urgentGreen} card${urgentGreen === 1 ? "" : "s"} counted green, Urgent counts red`);
    const redCards = known("inbox-urgent", "waiting-on-you", "inbox-decisions") ? (by("inbox-urgent")?.cards ?? 0) + (by("waiting-on-you")?.cards ?? 0) + (by("inbox-decisions")?.cards ?? 0) : null;
    const greenCards = known("waiting-for-review") ? (by("waiting-for-review")?.cards ?? 0) : null;
    topbar = { red, green, redCards, greenCards };
    // the sections are on this page only on the Inbox; elsewhere the top bar is not compared
    if (by("waiting-for-review") || by("waiting-on-you")) {
      if (red !== null && redCards !== null && red !== redCards) mismatches.push(`top bar red: ${red}, ${redCards} open cards in Urgent, Blocked on you and Decisions`);
      if (green !== null && greenCards !== null && green !== greenCards) mismatches.push(`top bar green: ${green}, ${greenCards} open cards in Done, waiting for your review`);
    }
  }
  // E948-S141 iteration 2 (the owner 18 Nov 18:30Z: "See counters on phone vs desktop"): the menu's Inbox pills say what
  // the top bar says, which is what the sections draw
  let sidebar: CountCheck["sidebar"] = null;
  if (root.querySelector('[data-testid="nav-inbox"]')) {
    sidebar = { red: pillOf(root, "waiting-count"), green: pillOf(root, "team-review-count") };
    if (topbar) {
      if (sidebar.red !== null && topbar.red !== null && sidebar.red !== topbar.red) mismatches.push(`menu Inbox red: ${sidebar.red}, top bar red ${topbar.red}`);
      if (sidebar.green !== null && topbar.green !== null && sidebar.green !== topbar.green) mismatches.push(`menu Inbox green: ${sidebar.green}, top bar green ${topbar.green}`);
    }
  }
  return { sections, topbar, sidebar, mismatches };
}

declare global {
  interface Window {
    inboxCountCheck?: typeof inboxCountCheck;
  }
}
/** on every page, so the live check reads his inbox the way the test reads the rendered one. Read only. */
if (typeof window !== "undefined") window.inboxCountCheck = inboxCountCheck;
