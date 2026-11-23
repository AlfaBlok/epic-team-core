import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DB } from "../db.js";
import { sectionRange } from "../approvals.js";
import { proseLines, stripInline } from "../adapters/markdown.js";
import { currentStatus } from "../status/stamp.js";
import { readArchiveOf } from "../adapters/spineArchive.js";

/**
 * what the Team desk placed in the tree, and the one "[delivered]" note per item once it closes. A placement is a row
 * in `desk_placement`, written by `POST /api/desk/placements` (the desk registers what it committed by hand) and by the Add
 * endpoint when the desk is the caller. Closing is read from the spine file itself (the same Status / ledger / Done-means
 * lines the tree reads); the note is sent once (`noted_at`), retried while T3 refuses it.
 *
 * `state` is read from the spine on every read, never stored: a row reopened after delivery reads
 * `placed` again. The table keeps only the placement (what and where, when) and the note's send log (`noted_at`).
 */
export type PlacedKind = "row" | "done_means" | "epic";
export const PLACED_KINDS: readonly PlacedKind[] = ["row", "done_means", "epic"];
export const DELIVERED_MARKER = "[delivered]";

export interface Placement {
  id: string;
  /** Checkout name under the repos root. */
  repo: string;
  /** Repo-relative spine: the epic itself (`epic`) or the spine the row / criterion lives in. */
  path: string;
  kind: PlacedKind;
  /** Ledger row id or Done-means id; empty for an epic. */
  itemId: string;
  title: string;
  placedAt: string;
  /** From the spine now: delivered (its note is due or sent), dropped (superseded / gone), placed (open, or unreadable). */
  state: "placed" | "delivered" | "dropped";
  notedAt?: string;
  noteError?: string;
}

export function migratePlacements(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS desk_placement (
      id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      path TEXT NOT NULL,
      kind TEXT NOT NULL,
      item_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      placed_at TEXT NOT NULL,
      noted_at TEXT,
      note_error TEXT,
      UNIQUE (repo, path, kind, item_id)
    );
  `);
}

const toPlacement = (r: any, state: Placement["state"]): Placement => ({
  id: r.id,
  repo: r.repo,
  path: r.path,
  kind: r.kind,
  itemId: r.item_id,
  title: r.title,
  placedAt: r.placed_at,
  state,
  ...(r.noted_at ? { notedAt: r.noted_at } : {}),
  ...(r.note_error ? { noteError: r.note_error } : {}),
});

// ---------- reading the spine ----------

const splitCells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
const DELIVERED = /^(done|merged|deployed|shipped|accepted|closed|complete|completed|live)\b/i;
const DROPPED = /^(superseded|cancel+ed|withdrawn|dropped|retired|won'?t ?fix)\b/i;
const verdictOf = (raw: string | undefined, review: boolean): "delivered" | "dropped" | undefined => {
  const w = stripInline(raw ?? "").trim();
  if (DELIVERED.test(w) || (review && /^review\b/i.test(w))) return "delivered";
  return DROPPED.test(w) ? "dropped" : undefined;
};

type LedgerCell = { title: string; status?: string };
/** Every ledger row of a spine by id (the first row of an id wins), parsed in one pass. */
export function ledgerRows(text: string): Map<string, LedgerCell> {
  const out = new Map<string, LedgerCell>();
  const r = sectionRange(text, /^(issue ledger|ledger)\b/i);
  if (!r) return out;
  const lines = proseLines(text);
  let heads: string[] | undefined;
  let status = -1;
  let title = -1;
  for (let k = r.head + 1; k < r.end; k++) {
    if (!/^\s*\|/.test(lines[k]) || /^\s*\|[\s:|-]+\|?\s*$/.test(lines[k])) continue;
    const cells = splitCells(lines[k]);
    if (!heads) {
      heads = cells.map((h) => stripInline(h).toLowerCase());
      status = heads.findIndex((h) => /^status/.test(h));
      title = heads.findIndex((h) => /title/.test(h));
      continue;
    }
    const id = stripInline(cells[0] ?? "");
    if (out.has(id)) continue;
    out.set(id, { title: stripInline(cells[title >= 0 ? title : 1] ?? ""), ...(status >= 0 ? { status: cells[status] } : {}) });
  }
  return out;
}

/** a spine's ledger rows plus its archive's: a finished row moved to the archive still reads delivered. */
export function withArchiveRows(rows: Map<string, LedgerCell>, archive: string | undefined): Map<string, LedgerCell> {
  if (archive) for (const [id, c] of ledgerRows(archive)) if (!rows.has(id)) rows.set(id, c);
  return rows;
}

/** The ledger row `id`: its title and Status cell (by header), or undefined when the row is gone. */
export function ledgerRow(text: string, id: string): LedgerCell | undefined {
  return ledgerRows(text).get(id);
}

/** The `## Done means` line `id`: its text and whether it is ticked. */
export function doneMeansLine(text: string, id: string): { text: string; done: boolean } | undefined {
  const r = sectionRange(text, /^done means\b/i);
  if (!r) return undefined;
  for (const l of proseLines(text).slice(r.head + 1, r.end)) {
    const m = /^\s*[-*]\s+\[([ xX])\]\s+(\S+)\s*(.*)$/.exec(l.replace(/\r$/, ""));
    if (m && m[2] === id) return { text: stripInline(m[3]), done: m[1] !== " " };
  }
  return undefined;
}

const h1 = (text: string) => /^#\s+(.+?)\s*$/m.exec(text)?.[1];

/** What the spine says now about a placement: its title (when readable) and whether it closed. */
export function readPlacement(
  text: string,
  p: Pick<Placement, "kind" | "itemId">,
  rows?: () => Map<string, LedgerCell>,
): { title?: string; closed?: "delivered" | "dropped"; missing?: boolean } {
  if (p.kind === "epic") return { title: h1(text), closed: verdictOf(currentStatus(text), true) };
  if (p.kind === "row") {
    const row = rows ? rows().get(p.itemId) : ledgerRow(text, p.itemId);
    return row ? { title: row.title, closed: verdictOf(row.status, false) } : { missing: true };
  }
  const dm = doneMeansLine(text, p.itemId);
  return dm ? { title: dm.text, closed: dm.done ? "delivered" : undefined } : { missing: true };
}

// ---------- the store ----------

export interface PlacementDeps {
  db: DB;
  /** Checkouts root (~/github). */
  reposRoot: string;
  now?: () => number;
}

export interface PlaceInput {
  repo: string;
  path: string;
  kind: PlacedKind;
  itemId?: string;
  title?: string;
}

export class PlacementError extends Error {
  constructor(
    readonly status: 400 | 404,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function createPlacements(d: PlacementDeps) {
  const iso = () => new Date((d.now ?? Date.now)()).toISOString();
  const fileOf = (repo: string, rel: string) => {
    const root = path.resolve(d.reposRoot, repo);
    const file = path.resolve(root, rel);
    return file.startsWith(root + path.sep) ? file : undefined;
  };
  const read = (repo: string, rel: string): string | undefined => {
    const f = fileOf(repo, rel);
    try {
      return f ? fs.readFileSync(f, "utf8") : undefined;
    } catch {
      return undefined;
    }
  };
  /** What the spine says now: closed (delivered / dropped, a missing item = dropped), else placed. */
  // 22 Nov: the desk tick read and parsed every placement's spine each minute (545 of them, 1.4 s of blocked event loop
  // a minute); a state is kept until its file's mtime or size changes
  const states = new Map<string, { sig: string; state: Placement["state"] }>();
  const docs = new Map<string, { sig: string; text: string; rows?: Map<string, LedgerCell> }>();
  const stateOf = (r: any): Placement["state"] => {
    const f = fileOf(r.repo, r.path);
    let sig: string;
    try {
      if (!f) return "placed";
      const st = fs.statSync(f);
      sig = `${st.mtimeMs}:${st.size}`;
    } catch {
      return "placed"; // checkout not readable right now: nothing closed that we can see
    }
    const k = `${f}\n${r.kind}\n${r.item_id}`;
    const hit = states.get(k);
    if (hit && hit.sig === sig) return hit.state;
    // many placements share one spine (one epic can hold hundreds of rows); after it changes, read and parse it once
    // for all of them, not once each (1.4 s of one blocked event loop on 22 Nov)
    let doc = docs.get(f);
    if (!doc || doc.sig !== sig) {
      const text = read(r.repo, r.path);
      if (text === undefined) return "placed";
      doc = { sig, text };
      docs.set(f, doc);
    }
    const d0 = doc;
    const now = readPlacement(d0.text, { kind: r.kind, itemId: r.item_id }, () => (d0.rows ??= withArchiveRows(ledgerRows(d0.text), readArchiveOf(f))));
    const state = now.closed ?? (now.missing ? "dropped" : "placed");
    states.set(k, { sig, state });
    return state;
  };
  const row = (r: any) => toPlacement(r, stateOf(r));
  const list = (): Placement[] => (d.db.prepare("SELECT * FROM desk_placement ORDER BY placed_at, rowid").all() as any[]).map(row);

  return {
    list,
    read,

    /**
     * Register an item the desk put in the tree (idempotent per repo/path/kind/item). The item must exist in the spine now
     * (a row id, a Done-means id, or the epic file), so a typo cannot create a placement that never closes.
     */
    place(i: PlaceInput): Placement {
      if (!PLACED_KINDS.includes(i.kind)) throw new PlacementError(400, "validation_error", `kind must be one of ${PLACED_KINDS.join(", ")}`);
      if (!i.repo?.trim() || !i.path?.trim()) throw new PlacementError(400, "validation_error", "repo (a checkout name) and path (the repo-relative spine) are required");
      const itemId = i.kind === "epic" ? "" : (i.itemId ?? "").trim();
      if (i.kind !== "epic" && !itemId) throw new PlacementError(400, "validation_error", `${i.kind === "row" ? "a row" : "a Done-means"} placement needs itemId`);
      const repo = i.repo.trim();
      const rel = i.path.trim().replace(/^\.\//, "");
      const text = read(repo, rel);
      if (text === undefined) throw new PlacementError(404, "not_found", `${repo}/${rel} is not a file in the console's checkout (commit and push it first, then register it)`);
      const file = fileOf(repo, rel);
      const now = readPlacement(text, { kind: i.kind, itemId }, () => withArchiveRows(ledgerRows(text), file ? readArchiveOf(file) : undefined));
      if (now.missing) throw new PlacementError(404, "not_found", `${itemId} is not in ${rel}`);
      const have = d.db.prepare("SELECT * FROM desk_placement WHERE repo = ? AND path = ? AND kind = ? AND item_id = ?").get(repo, rel, i.kind, itemId);
      if (have) return row(have);
      const title = (i.title?.trim() || now.title || itemId || rel).replace(/\s+/g, " ").slice(0, 200);
      const id = `pl_${randomUUID()}`;
      d.db.prepare("INSERT INTO desk_placement (id, repo, path, kind, item_id, title, placed_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, repo, rel, i.kind, itemId, title, iso());
      return row(d.db.prepare("SELECT * FROM desk_placement WHERE id = ?").get(id));
    },

    /**
     * put back placements a copy holds (the team repo's desk/placements.json) that this database lacks, as they were
     * (same id, times and note). A row already here (same id, or same repo/path/kind/item) is left alone. Its state is the
     * spine's, read on every list, so the copy's is ignored. Returns how many came back.
     */
    restore(rows: Placement[]): number {
      let n = 0;
      const ins = d.db.prepare("INSERT OR IGNORE INTO desk_placement (id, repo, path, kind, item_id, title, placed_at, noted_at, note_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const r of rows) {
        if (!r || typeof r.id !== "string" || !r.repo || !r.path || !PLACED_KINDS.includes(r.kind) || !r.placedAt) continue;
        n += ins.run(r.id, r.repo, r.path, r.kind, r.itemId ?? "", String(r.title ?? r.itemId ?? r.path).slice(0, 200), r.placedAt, r.notedAt ?? null, r.noteError ?? null).changes;
      }
      return n;
    },

    /**
     * One pass: every placement the spine now reads delivered and whose note is not sent yet goes to `note` (which returns
     * true once the desk thread took it). A note is sent once: `noted_at` is set only after `note` succeeded, and a
     * placement whose note failed is retried on the next pass. `delivered` counts the notes due this pass.
     */
    async sweep(note: (p: Placement) => Promise<true | string>): Promise<{ delivered: number; noted: number }> {
      let delivered = 0;
      let noted = 0;
      const due = (d.db.prepare("SELECT * FROM desk_placement WHERE noted_at IS NULL ORDER BY placed_at, rowid").all() as any[]).map(row);
      for (const p of due.filter((x) => x.state === "delivered")) {
        delivered++;
        const res = await note(p);
        if (res === true) {
          d.db.prepare("UPDATE desk_placement SET noted_at = ?, note_error = NULL WHERE id = ? AND noted_at IS NULL").run(iso(), p.id);
          noted++;
        } else d.db.prepare("UPDATE desk_placement SET note_error = ? WHERE id = ?").run(res.slice(0, 300), p.id);
      }
      return { delivered, noted };
    },
  };
}

export type Placements = ReturnType<typeof createPlacements>;
