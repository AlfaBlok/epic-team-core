import fs from "node:fs";
import { inside } from "../adapters/doc.js";
import { proseLines, stripInline } from "../adapters/markdown.js";
import { isClosed, type SpinesWait, type Tree, type TreeNode } from "../adapters/tree.js";
import { rowMatches } from "./asks.js";

/**
 * One ask, many references (D19, epicspine-skill human-asks.md §Reference, not ask; interim syntax kept):
 *  - the reference line `- [waits on <code> row <id>] <gloss>` (bare code = this spine's repo) or
 *    `- [waits on <repo>/<code> row <id>] <gloss>`: the row waits on that canonical ask. No fields, never counted,
 *    never a card of its own; `spines.py --json` carries it per node as `waits_on[]` {ref, repo, code, row, state};
 *  - interim, still read: `waits on <repo>/<CODE>` anywhere in a spine line (usually the blocked ledger row);
 *  - on the canonical ask itself, `unblocks:` may name rows of other epics as `<repo>/<row id>`
 *    (e.g. `unblocks: the infra repo/S4, poly-maker/`).
 * The inbox shows one card per canonical code; every referencing milestone is listed on it and gets the answer.
 */
export interface AskReference {
  milestoneId: string;
  milestoneTitle: string;
  /** Spine file and 0-based line of the reference (the `waits on …` line, or the row an `unblocks:` names). */
  path: string;
  line?: number;
  /** Ledger row id the reference sits in, when it sits in a row. */
  row?: string;
  via: "waits_on" | "unblocks";
  /** D19 reference line: the one-line gloss after `[waits on …]`. */
  gloss?: string;
  /** Tree node key of the referencing row/file, for subtree scoping. */
  nodeKey?: string;
  url?: string;
}

/** A `waits on <repo>/<CODE>` found in a spine of a milestone's tree. */
export interface RawRef {
  repo: string;
  code: string;
  path: string;
  line: number;
  row?: string;
  nodeKey?: string;
  /** The row it sits in is done / closed: no longer a live reference (never reported as unresolved). */
  closed: boolean;
  /** D19: the target ask's state as spines.py resolved it (done = consumed: the reference is closed); absent without `waits_on[]`. */
  state?: SpinesWait["state"];
  /** D19 reference line whose `row <id>` matched no ledger row of the file: it covers no row's guessed item. */
  rowUnmatched?: boolean;
  /** D19 reference line: the one-line gloss after the tag. */
  gloss?: string;
}

export interface RowAt {
  path: string;
  line?: number;
  nodeKey: string;
  closed: boolean;
}

export const WAITS_ON = /\bwaits?\s+on\s+`?([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-A\d+)\b`?/gi;
/** D19 reference line: `- [waits on the infra repo/ row 3] gloss` or `- [waits on row 3] gloss`. */
export const WAITS_ON_LINE = /^\s*[-*]\s+\[waits?\s+on\s+`?(?:([A-Za-z0-9][\w.-]*)\/)?([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-A\d+)`?(?:\s+row\s+([^\s\]]+))?\s*\]\s*(.*)$/i;
const AN_ASK_LINE = /^\s*[-*]\s+\[(?:ask|answered)\b/i;
const WAITING_ON_TEXT = /^\s*(?:[-*]\s+)?(?:\*\*)?Waiting on(?::\*\*|\*\*:|:)/i;

/**
 * the `waits_on[]` entries spines.py read from a file's free-text `Waiting on:` line (epicspine-skill ticket-34):
 * the entries no `[waits on …]` reference line of the file accounts for. The console never parses that line for codes itself.
 */
export function waitingOnLineRefs(spinesWaits: SpinesWait[], lines: string[]): SpinesWait[] {
  if (!spinesWaits.length) return [];
  const tagged = new Set<string>();
  for (const l of lines) {
    const m = WAITS_ON_LINE.exec(l);
    if (m) tagged.add(m[2].toLowerCase());
  }
  return spinesWaits.filter((w) => !tagged.has(w.code.toLowerCase()));
}

/** 0-based line of a file's free-text `Waiting on:` (the first after Current State, else the first anywhere), else undefined. */
export function waitingOnTextLine(lines: string[]): number | undefined {
  const cs = lines.findIndex((l) => /^#{1,6}\s+current state\b/i.test(l));
  const i = lines.findIndex((l, n) => n >= Math.max(cs, 0) && WAITING_ON_TEXT.test(l));
  if (i >= 0) return i;
  const j = lines.findIndex((l) => WAITING_ON_TEXT.test(l));
  return j >= 0 ? j : undefined;
}

export const refKey = (repo: string, code: string) => `${repo.toLowerCase()}/${code.toLowerCase()}`;

/** `<repo>/<row id>` tokens in an ask's `unblocks:` text for repos other than the ask's own (known checkout names only). */
export function unblockRefs(unblocks: string | undefined, knownRepos: string[], selfRepo?: string): { repo: string; row: string }[] {
  if (!unblocks) return [];
  const known = new Map(knownRepos.map((r) => [r.toLowerCase(), r]));
  const out: { repo: string; row: string }[] = [];
  for (const m of stripInline(unblocks).matchAll(/(?<![\w.-])([A-Za-z0-9][\w.-]*)\/([A-Za-z][\w.-]*\d[\w.-]*)/g)) {
    const repo = known.get(m[1].toLowerCase());
    const row = m[2].replace(/[.,;:)\]]+$/, "");
    if (repo && repo.toLowerCase() !== selfRepo?.toLowerCase() && row) out.push({ repo, row });
  }
  return out;
}

const firstCell = (l: string) => stripInline(l.trim().replace(/^\|/, "").split(/(?<!\\)\|/)[0] ?? "");

interface Visit {
  node: TreeNode;
  rowFile?: string;
}
function walk(root: TreeNode): Visit[] {
  const out: Visit[] = [];
  const go = (n: TreeNode, parentPath?: string) => {
    if (n.flags.includes("cycle") || n.flags.includes("repeat")) return;
    out.push({ node: n, rowFile: parentPath });
    for (const c of n.children) go(c, n.path ?? parentPath);
  };
  go(root);
  return out;
}

/**
 * Every `waits on <repo>/<CODE>` in the files of one milestone's tree, and where each ledger row of the tree sits
 * (lower-cased row id → file, line, node), so a canonical ask's `unblocks:` can be matched to rows.
 */
export function scanTree(tree: Tree, repoDir: string, repoName = ""): { waits: RawRef[]; rows: Map<string, RowAt> } {
  // one scan per built tree object (the tree memo keeps the object while its files are unchanged).
  const key = `${repoDir}\0${repoName}`;
  const hit = scans.get(tree)?.get(key);
  if (hit) return { waits: hit.waits.map((w) => ({ ...w })), rows: new Map(hit.rows) };
  const out = scanTreeNow(tree, repoDir, repoName);
  scans.set(tree, (scans.get(tree) ?? new Map()).set(key, { waits: out.waits.map((w) => ({ ...w })), rows: new Map(out.rows) }));
  return out;
}

const scans = new WeakMap<Tree, Map<string, { waits: RawRef[]; rows: Map<string, RowAt> }>>();

function scanTreeNow(tree: Tree, repoDir: string, repoName: string): { waits: RawRef[]; rows: Map<string, RowAt> } {
  const visits = walk(tree.root);
  const files = new Map<string, Visit>();
  for (const v of visits) if (v.node.path && v.node.kind !== "dod" && !files.has(v.node.path)) files.set(v.node.path, v);
  const waits: RawRef[] = [];
  const rows = new Map<string, RowAt>();
  for (const [rel, v] of files) {
    const abs = inside(repoDir, rel);
    let lines: string[];
    try {
      lines = abs ? proseLines(fs.readFileSync(abs, "utf8")) : [];
    } catch {
      continue;
    }
    const rowNodes = visits.filter((x) => x.rowFile === rel && x.node.kind !== "dod");
    const byId = new Map<string, Visit>();
    for (const x of rowNodes) {
      const id = stripInline(x.node.id).toLowerCase();
      if (!byId.has(id)) byId.set(id, x);
    }
    const rowOf = (cell: string) => byId.get(cell.toLowerCase());
    const spinesWaits = tree.waits?.[rel] ?? [];
    lines.forEach((l, i) => {
      const ref = WAITS_ON_LINE.exec(l);
      if (ref) {
        const [, repo, code, row, gloss] = ref;
        const rn = row ? rowNodes.find((x) => rowMatches(row, x.node)) : undefined;
        const sw = spinesWaits.find((w) => w.code.toLowerCase() === code.toLowerCase() && (!row || !w.row || w.row.toLowerCase() === row.toLowerCase()));
        waits.push({
          repo: repo ?? repoName,
          code,
          path: rel,
          line: i,
          ...(row ? { row } : {}),
          nodeKey: (rn ?? v).node.key,
          closed: !!rn && (isClosed(rn.node) || rn.node.color === "green"),
          ...(row && !rn ? { rowUnmatched: true } : {}),
          ...(sw ? { state: sw.state } : {}),
          ...(gloss.trim() ? { gloss: stripInline(gloss) } : {}),
        });
        return;
      }
      if (l.trim().startsWith("|")) {
        const cell = firstCell(l);
        const rn = rowOf(cell);
        if (rn && !rows.has(cell.toLowerCase())) rows.set(cell.toLowerCase(), { path: rel, line: i, nodeKey: rn.node.key, closed: isClosed(rn.node) || rn.node.color === "green" });
      }
      if (AN_ASK_LINE.test(l)) return;
      for (const m of l.matchAll(WAITS_ON)) {
        const rn = l.trim().startsWith("|") ? rowOf(firstCell(l)) : undefined;
        waits.push({
          repo: m[1],
          code: m[2],
          path: rel,
          line: i,
          ...(rn ? { row: stripInline(rn.node.id) } : {}),
          nodeKey: (rn ?? v).node.key,
          closed: !!rn && (isClosed(rn.node) || rn.node.color === "green"),
        });
      }
    });
    // codes spines.py read from the free-text `Waiting on:` line: references on the file itself (no row).
    const at = waitingOnTextLine(lines);
    for (const w of waitingOnLineRefs(spinesWaits, lines))
      waits.push({
        repo: w.repo ?? repoName,
        code: w.code,
        path: rel,
        line: at ?? 0,
        nodeKey: v.node.key,
        closed: false,
        state: w.state,
      });
  }
  return { waits, rows };
}
