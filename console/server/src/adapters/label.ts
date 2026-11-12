import { stripInline } from "./markdown.js";

/**
 * a tree row reads `<code> <label>`; the label is a short plain phrase of what the node achieves.
 * A spine's `Label:` line wins (readDoc); otherwise it is derived from the title by `deriveLabel`.
 */
export const LABEL_MAX_WORDS = 6;

/** Leading id prefix: `:`, `EPIC:`, `M5 —`, ` -`, `DOD-3:` (the row shows the code already). */
const ID_PREFIX = /^(?:EPIC(?:[- ]?\d+)?|M\d+(?:-\d+)?|[A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)\s*(?::|—|–|\s-)\s*/;
/** Head separators, earliest first: `: `, ` — `, ` – `, ` (`, `; `. */
const SEPARATORS = /:\s|\s[—–]\s|\s\(|;\s/g;

/** Punctuation and an existing ellipsis at the end. */
const TRAILING = /[\s,.;:—–+=&…-]+$/;
/** Words a cut label should not end on ("Reddit MCP tools on the…" → "Reddit MCP tools…"). */
const DANGLING = /^(?:a|an|the|on|of|in|to|for|from|by|at|via|with|and|or|vs|as|when|while|before|after|into|onto|per|that|who|[+=&→—–-])$/i;

const words = (s: string) => s.split(/\s+/).filter(Boolean);

/**
 * Title → label: strip a leading `[repo]` tag and the node's id prefix, take the head before the first separator
 * whose head has at least two words; still too long: the head before a `, ` with at least three words; then cap at
 * LABEL_MAX_WORDS words with an ellipsis, never ending on a dangling little word. Falls back to the title.
 */
/** labels kept by (title, id): every tree rebuild re-derived the same long row titles on the main thread. */
const labelMemo = new Map<string, string>();
const LABEL_MEMO_MAX = 50_000;
export function deriveLabel(title: string, id?: string): string {
  const key = `${id ?? ""}\0${title}`;
  const hit = labelMemo.get(key);
  if (hit !== undefined) return hit;
  const v = computeLabel(title, id);
  if (labelMemo.size >= LABEL_MEMO_MAX) labelMemo.clear();
  labelMemo.set(key, v);
  return v;
}

function computeLabel(title: string, id?: string): string {
  let t = stripInline(title).replace(/\s+/g, " ").trim();
  t = t.replace(/^\[[^\]]*\]\s*/, "");
  if (id) {
    const k = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t.replace(new RegExp(`^${k}\\b\\s*(?::|—|–|\\s-)?\\s*`, "i"), "");
  }
  // "EPIC: M2 — Team console": an id prefix can follow another one.
  for (let i = 0; i < 2; i++) t = t.replace(ID_PREFIX, "");
  for (const m of t.matchAll(SEPARATORS)) {
    const head = t.slice(0, m.index).trim();
    if (words(head).length >= 2) {
      t = head;
      break;
    }
  }
  if (words(t).length > LABEL_MAX_WORDS)
    for (const m of t.matchAll(/,\s/g)) {
      const head = t.slice(0, m.index).trim();
      if (words(head).length >= 3 && (head.match(/\(/g) ?? []).length === (head.match(/\)/g) ?? []).length) {
        t = head;
        break;
      }
    }
  t = t.replace(TRAILING, "");
  const w = words(t);
  if (w.length <= LABEL_MAX_WORDS) return t || stripInline(title).trim();
  const cut = w.slice(0, LABEL_MAX_WORDS);
  while (cut.length > 2 && DANGLING.test(cut[cut.length - 1])) cut.pop();
  return cut.join(" ").replace(TRAILING, "") + "…";
}

/** Leading short code in a spine title: `: …`, `EPIC: M2 — …`, `[repo]: …`. */
const TITLE_CODE = /^(?:\[[^\]]*\]\s*)?(?:EPIC:\s*)?(EPIC-\d+|M\d+)\b/;

/**
 * the short code a tree row shows. A spine's id is its long `Spine ID` slug, so a spine shows the code in
 * its title (M5), `root` for a repo's root spine, else its id; rows and DoD items show their id.
 */
export function codeOf(n: { kind: string; id: string; title: string }, isRepoRoot = false): string {
  if (n.kind !== "spine") return n.id;
  const m = TITLE_CODE.exec(stripInline(n.title));
  if (m) return m[1];
  return isRepoRoot ? "root" : n.id;
}
