/**
 * Root L-87 (the owner 18 Nov, vn_5025a4c5: "I want to have a clear rule that you never add anything to the inbox unless I
 * explicitly ask you for it ... The inbox only have sections and cards. Nothing else"). The one list of what the Inbox
 * page may hold: its title, the filters on top (search, Show), its sections (each with its own cards) and the skeleton
 * that holds their place while they load. `inboxExtras()` names everything else that is on screen in the page.
 * Read by the web suite (pages/inboxOnly.test.tsx) and, as `window.inboxOnlyCheck()`, by the live check after every
 * console release (hosted/console/scripts/inbox-load-check.mjs). A new kind of thing on the Inbox needs his explicit
 * ask first, then its selector here, with his words.
 */
export const INBOX_ALLOWED = [
  "h1", // the page's title
  '[data-testid="inbox-search"]', // filter: search
  '[data-testid="inbox-show"]', // filter: Show
  "[data-fold-section]", // a section with its cards
  '[data-testid="inbox-skeleton"]', // the sections' place while they load
] as const;

const LEAF_TAGS = new Set(["IMG", "SVG", "BUTTON", "INPUT", "A", "TEXTAREA", "SELECT", "VIDEO", "CANVAS"]);

/** each visible thing inside `root` (the page's main) that is not inside an allowed part: "tag[testid]: text". */
export function inboxExtras(root: Element | null = document.querySelector("main"), visible: (el: Element) => boolean = shownOnScreen): string[] {
  if (!root) return ["no page"];
  const out: string[] = [];
  const walk = (el: Element) => {
    if (INBOX_ALLOWED.some((s) => el.matches(s))) return;
    if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true" || el.tagName === "SCRIPT" || el.tagName === "STYLE") return;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim());
    if (own || LEAF_TAGS.has(el.tagName.toUpperCase())) {
      if (visible(el)) {
        const id = el.getAttribute("data-testid");
        out.push(`${el.tagName.toLowerCase()}${id ? `[${id}]` : ""}: ${(el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60)}`);
      }
      return;
    }
    [...el.children].forEach(walk);
  };
  [...root.children].forEach(walk);
  return out;
}

function shownOnScreen(el: Element): boolean {
  if (el.closest("[hidden]")) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
}

declare global {
  interface Window {
    inboxOnlyCheck?: () => string[];
  }
}
if (typeof window !== "undefined") window.inboxOnlyCheck = () => inboxExtras();
