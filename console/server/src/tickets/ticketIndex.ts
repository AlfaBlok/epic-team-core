// The ticket index, mounted read-only.
//
// scripts/ticket_index.py builds one SQLite file from every spine (`<home repo>/.tickets/index.db`, out of git): one
// record per ticket (`tickets`) and every ledger line the console's screens read (`ledger`: checkout, file, line, id,
// raw cells, headers; the same rows review/rows.ts `ledgerLines` gives, checked file by file in its test). The Board,
// Key results and Inbox read their tickets from here instead of parsing each spine. Agents still write only the markdown;
// the file is a cache of it, rebuilt by git hooks after every commit, pull and push, and by `refresh` after the
// console's own writes and pulls. The console never writes it: builds run in ticket_index.py's own process.
import Database from "better-sqlite3";
import { execFile } from "../spawnHost.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homeRepo } from "../identity.js";
import { colsOf, type LedgerLine } from "../review/rows.js";

const expand = (p: string) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
const homeRepoDir = () => path.join(expand(process.env.REPOS_ROOT || "~/github"), homeRepo());
export const ticketIndexPath = () => expand(process.env.TICKET_INDEX_DB || path.join(homeRepoDir(), ".tickets", "index.db"));
const scriptPath = () => expand(process.env.TICKET_INDEX_SCRIPT || path.join(homeRepoDir(), "scripts", "ticket_index.py"));

/** one ticket of GET /api/tickets: the `tickets` table's record (kr and his_words as lists). */
export interface Ticket {
  repo: string;
  id: string;
  world: string | null;
  epic: string | null;
  spine: string | null;
  title: string | null;
  state: string | null;
  status: string | null;
  owner: string | null;
  dispatched: number;
  lease_until: string | null;
  kr: string[];
  his_words: string[];
  made: string | null;
  last_moved: string | null;
  link: string | null;
  next: string | null;
  why: string | null;
}

export interface TicketIndex {
  /** the ledger lines of one spine file (absolute path), as the index holds them; [] while its checkout is not built. */
  lines(abs: string): LedgerLine[];
  /** rebuild one checkout now (after the console's own write or pull); resolves when the index holds it. */
  refresh(dir: string): Promise<void>;
  /** changes whenever the index file changes (a kept answer built from it is stale). */
  version(): string;
  /** the tickets, filtered. */
  tickets(q?: { repo?: string; state?: string; world?: string; id?: string; open?: boolean }): Ticket[];
  /** when the index was last built, and how many tickets and ledger lines it holds. */
  stats(): { builtAt?: string; tickets: number; lines: number; checkouts: number } | undefined;
}

const CLOSED = ["done", "dropped", "superseded", "cancelled", "canceled", "closed", "folded", "moved", "dismissed"];

/** the commit a ref names in a checkout, read from the files under .git (no git process on the read path). */
export function refSha(root: string, ref: string): string | undefined {
  let gitDir = path.join(root, ".git");
  try {
    if (fs.statSync(gitDir).isFile()) gitDir = path.resolve(root, fs.readFileSync(gitDir, "utf8").replace(/^gitdir:\s*/, "").trim());
  } catch {
    return undefined;
  }
  let common = gitDir;
  try {
    common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
  } catch {
    /* not a linked worktree */
  }
  const named = (name: string): string | undefined => {
    for (const d of name === "HEAD" ? [gitDir] : [gitDir, common]) {
      try {
        const v = fs.readFileSync(path.join(d, name), "utf8").trim();
        if (v.startsWith("ref: ")) return named(v.slice(5).trim());
        if (/^[0-9a-f]{40}$/.test(v)) return v;
      } catch {
        /* not loose here */
      }
    }
    try {
      for (const l of fs.readFileSync(path.join(common, "packed-refs"), "utf8").split("\n")) {
        const [sha, n] = l.split(" ");
        if (n === name && /^[0-9a-f]{40}$/.test(sha)) return sha;
      }
    } catch {
      /* no packed refs */
    }
    return undefined;
  };
  if (ref === "HEAD") return named("HEAD");
  return named(ref.startsWith("refs/") ? ref : `refs/remotes/${ref}`) ?? named(`refs/heads/${ref}`);
}

/** the checkout a file sits in (the nearest folder holding .git). */
const roots = new Map<string, string | null>();
function rootOf(abs: string): string | undefined {
  const start = path.dirname(abs);
  const hit = roots.get(start);
  if (hit !== undefined) return hit ?? undefined;
  let d = start;
  for (;;) {
    if (fs.existsSync(path.join(d, ".git"))) break;
    const up = path.dirname(d);
    if (up === d) {
      roots.set(start, null);
      return undefined;
    }
    d = up;
  }
  roots.set(start, d);
  return d;
}

export function createTicketIndex(o: { file?: string; script?: string; python?: string; freshMs?: number } = {}): TicketIndex {
  const file = o.file ?? ticketIndexPath();
  const script = o.script ?? scriptPath();
  const freshMs = o.freshMs ?? 2_000;
  let db: Database.Database | undefined;
  let dataVersion = -1;
  let fileStamp = "";
  const kept = new Map<string, LedgerLine[]>();
  const open = (): Database.Database | undefined => {
    if (db) return db;
    try {
      db = new Database(file, { readonly: true, fileMustExist: true });
      return db;
    } catch {
      return undefined;
    }
  };
  /** the kept lines hold while no build wrote the file (data_version moves on every other connection's commit). */
  const current = (): Database.Database | undefined => {
    const d = open();
    if (!d) return undefined;
    try {
      const v = d.pragma("data_version", { simple: true }) as number;
      const st = fs.statSync(file);
      const stamp = `${st.ino}:${st.mtimeMs}`;
      if (v !== dataVersion || stamp !== fileStamp) {
        // the file itself was replaced (deleted and built again): open the new one
        if (fileStamp && stamp.split(":")[0] !== fileStamp.split(":")[0]) {
          d.close();
          db = undefined;
        }
        dataVersion = v;
        fileStamp = stamp;
        kept.clear();
      }
      return db ?? open();
    } catch {
      db?.close();
      db = undefined;
      return undefined;
    }
  };
  // builds: one in flight per checkout, one more queued behind it
  const building = new Map<string, Promise<void>>();
  const again = new Set<string>();
  const run = (dir: string): Promise<void> => {
    const now = building.get(dir);
    if (now) {
      again.add(dir);
      return now;
    }
    const p = new Promise<void>((resolve) => {
      execFile(o.python ?? "python3", [script, "build", "--dir", dir], { timeout: 600_000, env: { ...process.env, TICKET_INDEX_DB: file, TICKET_INDEX_HOOK_RUNNING: "1" } }, (err) => {
        if (err) console.warn(`ticket index build ${path.basename(dir)}: ${err.message.split("\n")[0]}`);
        resolve();
      });
    }).finally(() => {
      building.delete(dir);
      if (again.delete(dir)) void run(dir);
    });
    building.set(dir, p);
    return p;
  };
  const checked = new Map<string, number>();
  /** a checkout whose ref moved since the index read it (or one it never read) is built again in the background. */
  const ensure = (root: string, real: string, d: Database.Database | undefined) => {
    const t = Date.now();
    if (t - (checked.get(real) ?? 0) < freshMs) return;
    checked.set(real, t);
    const row = d?.prepare("SELECT ref, sha FROM ledger_repos WHERE dir = ?").get(real) as { ref: string; sha: string } | undefined;
    if (row && refSha(root, row.ref) === row.sha) return;
    void run(real);
  };
  const realOf = new Map<string, string>();
  const real = (root: string) => {
    let r = realOf.get(root);
    if (!r) {
      try {
        r = fs.realpathSync(root);
      } catch {
        r = root;
      }
      realOf.set(root, r);
    }
    return r;
  };
  return {
    lines(abs) {
      const root = rootOf(abs);
      if (!root) return [];
      const dir = real(root);
      const d = current();
      ensure(root, dir, d);
      if (!d) return [];
      const rel = path.relative(root, abs).split(path.sep).join("/");
      const key = `${dir}\0${rel}`;
      const hit = kept.get(key);
      if (hit) return hit;
      let out: LedgerLine[] = [];
      try {
        out = (d.prepare("SELECT line, id, cells, headers FROM ledger WHERE dir = ? AND path = ? ORDER BY line").all(dir, rel) as { line: number; id: string; cells: string; headers: string }[]).map((r) => {
          const headers = JSON.parse(r.headers) as string[];
          return { line: r.line, id: r.id, cells: JSON.parse(r.cells) as string[], headers, col: colsOf(headers) };
        });
      } catch {
        out = [];
      }
      kept.set(key, out);
      return out;
    },
    refresh(dir) {
      return run(real(dir));
    },
    version() {
      current();
      return `${fileStamp}:${dataVersion}`;
    },
    tickets(q = {}) {
      const d = current();
      if (!d) return [];
      const where: string[] = [];
      const args: string[] = [];
      for (const k of ["repo", "state", "world", "id"] as const)
        if (q[k]) {
          where.push(`${k} = ?`);
          args.push(q[k]!);
        }
      if (q.open) where.push(`state NOT IN (${CLOSED.map((c) => `'${c}'`).join(",")})`);
      const rows = d
        .prepare(`SELECT repo, id, world, epic, spine, title, state, status, owner, dispatched, lease_until, kr, his_words, made, last_moved, link, next, why FROM tickets${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY repo, id`)
        .all(...args) as (Omit<Ticket, "kr" | "his_words"> & { kr: string; his_words: string })[];
      return rows.map((r) => ({ ...r, kr: JSON.parse(r.kr || "[]") as string[], his_words: JSON.parse(r.his_words || "[]") as string[] }));
    },
    stats() {
      const d = current();
      if (!d) return undefined;
      try {
        const built = d.prepare("SELECT value FROM meta WHERE key = 'built_at'").get() as { value: string } | undefined;
        const t = d.prepare("SELECT COUNT(*) n FROM tickets").get() as { n: number };
        const l = d.prepare("SELECT COUNT(*) n, COUNT(DISTINCT dir) c FROM ledger").get() as { n: number; c: number };
        return { ...(built ? { builtAt: built.value } : {}), tickets: t.n, lines: l.n, checkouts: l.c };
      } catch {
        return undefined;
      }
    },
  };
}

/** one index per process (the main thread and the read model's worker each mount their own read-only handle). */
let shared: TicketIndex | undefined;
export function ticketIndex(): TicketIndex {
  shared ??= createTicketIndex();
  return shared;
}
/** tests: mount another file. */
export function setTicketIndex(t: TicketIndex | undefined) {
  shared = t;
}
