import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { DB } from "../db.js";

/**
 * One request, one ticket row (a part of the kernel; the owner's note of 22 Nov: "We were working on this big ticket,
 * dealing with tickets not getting lost. I think that ticket itself got lost."). A request is one input of the owner's: a line he types in a chat, a voice note. Each has one id, read from
 * the request id the console sent it with (inside the T3 item id), the same rule as the hosted request check `request_id`:
 *   ch_<8 hex>  a typed line (`chat-<uuid>`, `chat-files-<uuid>`)
 *   vn_<8 hex>  a voice note recorded in the console (`voice-note-chat-vn_…`, `voice-spill-vn_…`, `note-touch-vn_…`)
 *   e-<6 hex>   a voice note relayed from the memory service (`<memory>-…-Log-<day>.md-e-…`)
 * Relays between desks, console lines and agents' sends are no request (undefined).
 *
 * Where a request landed is read from the epic files themselves (the repo is the only source, L-45): the ticket rows
 * whose line holds its id, else a Decisions line naming exactly one row of that epic.
 */
export type RequestRow = { code: string; repo: string; path: string; status?: string; title?: string };

const CODES = /(?:\b(?:[Ff]ollow-up of|of|from|see|in|by|on)\s+)?\(?\b(?:E\d+|EPIC-\d+|ROOT|TAX|M\d+|[A-Z]{1,6}\d*)-(?:S|A|T|G)\d+[a-z]?\b\)?/g;
/**
 * The task's name in his words, for the line under his message (the owner, 22 Nov: "I've read this several times and I
 * don't know what you're talking about"): the card's `name`, else its `title`, else the row's title up to its first stop;
 * no row codes, at most about 60 characters.
 */
export function plainTitle(card: string | undefined, rowTitle: string | undefined): string | undefined {
  const fm = card?.startsWith("---") ? card.slice(3, card.indexOf("\n---", 3) > 0 ? card.indexOf("\n---", 3) : undefined) : "";
  const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, "m").exec(fm ?? "")?.[1]?.trim().replace(/^["']|["']$/g, "");
  let t = field("name") || field("title") || (rowTitle ?? "").replace(CODES, "").replace(/^[\s,:;.-]+/, "").split(/ Core: |\. |: | — | \| | \(/)[0];
  t = t.replace(CODES, "").replace(/\s{2,}/g, " ").replace(/^[\s,:;.-]+|[\s,:;.-]+$/g, "").replace(/\.$/, "");
  if (!t) return undefined;
  if (t.length > 60) t = `${t.slice(0, 58).replace(/\s+\S*$/, "")}…`;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const NOT_HIS = /^\s*(?:↔|🗂|\[[a-z][a-z -]*\]|From the E\d+-S\d+ worker|❓ Mac ticket question)/;

export function requestIdOf(itemId: string | undefined, text = ""): string | undefined {
  if (!itemId) return undefined;
  let m = itemId;
  for (let i = 0; i < 2; i++) {
    try {
      m = decodeURIComponent(m);
    } catch {
      break;
    }
  }
  const [before, after] = m.includes("thread-send:") ? [m.slice(0, m.indexOf("thread-send:")), m.slice(m.indexOf("thread-send:") + 12)] : ["", m];
  if (!before.includes("client")) return undefined; // an agent's send, not from his screen
  if (after.startsWith("desk-cross-") || after.startsWith("desk-send-")) return undefined;
  if (NOT_HIS.test(text)) return undefined;
  const vn = /vn_[0-9a-f]{8}/.exec(after);
  if (vn) return vn[0];
  const e = /\.md-(e-[0-9a-f]{6})$/.exec(after);
  if (e) return e[1];
  const ch = /^(?:note-touch-)?chat(?:-files)?-([0-9a-f]{8})/.exec(after);
  if (ch) return `ch_${ch[1]}`;
  return `ch_${createHash("sha1").update(after).digest("hex").slice(0, 8)}`;
}

const REQ_ID = /\b(vn_[0-9a-f]{8}|ch_[0-9a-f]{8})\b|\^?\b(e-[0-9a-f]{6})\b/g;
const ROW_CODE = /\b((?:E\d+|EPIC-\d+|ROOT|TAX|M\d+|[A-Z]{1,6}\d*)-(?:S|A|T|G)\d+[a-z]?)\b/g;
const ROW_CODE_FULL = /^(?:E\d+|EPIC-\d+|ROOT|TAX|M\d+|[A-Z]{1,6}\d*)-(?:S|A|T|G)\d+[a-z]?$/;
const SPINE_DIRS = ["docs/spines", "spines", "docs/epics"];
const STATUS = /^(ready|draft|doing|active|in[ _-]?progress|review|blocked|monitoring|done|parked|superseded|folded|claimed|rework|closed|approved)/i;
const cellsOf = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split(" | ").map((c) => c.trim());

/** every request id held in one epic file: id -> rows (row lines first; a one-row Decisions line only when no row line holds it). */
export function requestRowsIn(text: string, repo: string, rel: string): Map<string, { rows: RequestRow[]; onRow: boolean }> {
  const lines = text.split("\n");
  const ledger = new Map<string, string[]>();
  for (const ln of lines) {
    if (!ln.startsWith("| ") || ln.split(" | ").length < 5) continue;
    const c = cellsOf(ln);
    if (ROW_CODE_FULL.test(c[0])) ledger.set(c[0], c);
  }
  const out = new Map<string, { rows: RequestRow[]; onRow: boolean }>();
  if (!ledger.size) return out;
  for (const ln of lines) {
    if (!ln.startsWith("| ")) continue;
    const ids = [...ln.matchAll(REQ_ID)].map((m) => m[1] ?? m[2]);
    if (!ids.length) continue;
    const c0 = cellsOf(ln)[0];
    let code: string | undefined;
    let onRow = false;
    if (ledger.has(c0)) {
      code = c0;
      onRow = true;
    } else {
      const named = new Set([...ln.matchAll(ROW_CODE)].map((m) => m[1]).filter((c) => ledger.has(c)));
      if (named.size === 1) code = [...named][0];
    }
    if (!code) continue;
    const cells = ledger.get(code)!;
    const status = cells.slice(3, 7).find((c) => STATUS.test(c))?.split(" ")[0];
    const title = plainTitle(undefined, cells[3]);
    for (const id of ids) {
      const cur = out.get(id) ?? { rows: [], onRow: false };
      if (onRow && !cur.onRow) cur.rows = cur.rows.filter(() => false); // a row line beats a Decisions line
      if (onRow || !cur.onRow) {
        if (!cur.rows.some((r) => r.code === code && r.repo === repo)) cur.rows.push({ code, repo, path: rel, ...(status ? { status } : {}), ...(title ? { title } : {}) });
        cur.onRow ||= onRow;
      }
      out.set(id, cur);
    }
  }
  return out;
}

/** the ticket lines of one epic file quoting runs of his words (a row line, or a Decisions line naming exactly one row). */
export function wordsIn(
  text: string,
  repo: string,
  rel: string,
  bySh: Map<string, Set<string>>,
  shRows: Map<string, Set<string>>,
  byWords: Map<string, Map<string, { row: RequestRow; sh: Set<string> }>>,
): void {
  const lines = text.split("\n");
  const ledger = new Map<string, string[]>();
  for (const ln of lines) {
    if (!ln.startsWith("| ") || ln.split(" | ").length < 5) continue;
    const c = cellsOf(ln);
    if (ROW_CODE_FULL.test(c[0])) ledger.set(c[0], c);
  }
  if (!ledger.size) return;
  for (const ln of lines) {
    if (!ln.startsWith("| ")) continue;
    const hits = new Map<string, Set<string>>();
    for (const sh of shinglesOf(normWords(ln))) {
      const ids = bySh.get(sh);
      if (ids) for (const id of ids) (hits.get(id) ?? hits.set(id, new Set()).get(id)!).add(sh);
    }
    if (!hits.size) continue;
    const c0 = cellsOf(ln)[0];
    let code: string | undefined = ledger.has(c0) ? c0 : undefined;
    if (!code) {
      const named = new Set([...ln.matchAll(ROW_CODE)].map((m) => m[1]).filter((c) => ledger.has(c)));
      if (named.size === 1) code = [...named][0];
    }
    if (!code) continue;
    const key = `${repo}/${code}`;
    const cells = ledger.get(code)!;
    const status = cells.slice(3, 7).find((c) => STATUS.test(c))?.split(" ")[0];
    const title = plainTitle(undefined, cells[3]);
    for (const [id, shs] of hits) {
      for (const sh of shs) (shRows.get(sh) ?? shRows.set(sh, new Set()).get(sh)!).add(key);
      const m = byWords.get(id) ?? byWords.set(id, new Map()).get(id)!;
      const x = m.get(key) ?? m.set(key, { row: { code, repo, path: rel, ...(status ? { status } : {}), ...(title ? { title } : {}) }, sh: new Set() }).get(key)!;
      for (const sh of shs) x.sh.add(sh);
    }
  }
}

function spineFiles(repoDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
    }
  };
  for (const d of SPINE_DIRS) walk(path.join(repoDir, d));
  return out;
}

/**
 * His words placed on a row (the same rule as the hosted check scripts/request_rows.py `homes`): a request no row line holds
 * by id still lands where a ticket line quotes 8 of his words in a row, counting only runs of his that sit on at most two
 * rows anywhere (boilerplate is not his). The desk often quotes a typed line without its id; without this the line under
 * his message said "Not picked up yet" while the check counted it placed.
 */
export const SHINGLE = 8;
const NOT_WORDS = /📎 Attachments \(\d+\):[\s\S]*$|Audio: https?:\/\/\S+|\(\d+ parts?\)/g;
const VOICE_HEAD = /^\s*🎙[^\n]*\n/;
export function normWords(s: string): string[] {
  return s.toLowerCase().replace(/[’‘]/g, "'").match(/[a-z0-9']+/g) ?? [];
}
export function shinglesOf(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + SHINGLE <= words.length; i++) out.push(words.slice(i, i + SHINGLE).join(" "));
  return out;
}
/** his own words of a message: the voice note header, the audio link and the attachment notice dropped. */
export function hisWordsOf(text: string): string[] {
  return normWords(text.replace(VOICE_HEAD, "").replace(NOT_WORDS, " "));
}
export type Wanted = { id: string; words: string };

/** the request ids of every epic file under the repos root, kept fresh in the background (a read never waits on a scan). */
export function createRequestRows(o: { reposRoot: () => string | undefined; wanted?: () => Wanted[]; ttlMs?: number; now?: () => number }) {
  const ttl = o.ttlMs ?? 120_000;
  const now = o.now ?? Date.now;
  let index = new Map<string, RequestRow[]>();
  let at = 0;
  let scanning: Promise<void> | undefined;
  const scan = async () => {
    const root = o.reposRoot();
    if (!root) return;
    const next = new Map<string, { rows: RequestRow[]; onRow: boolean }>();
    // his recent requests by runs of 8 of his words, matched against every ticket line (a small index: his words, not the files)
    const bySh = new Map<string, Set<string>>();
    for (const w of o.wanted?.() ?? []) for (const sh of shinglesOf(hisWordsOf(w.words))) (bySh.get(sh) ?? bySh.set(sh, new Set()).get(sh)!).add(w.id);
    const shRows = new Map<string, Set<string>>(); // a run of his words -> the rows it sits on, anywhere
    const byWords = new Map<string, Map<string, { row: RequestRow; sh: Set<string> }>>(); // request -> row key -> the row and its runs
    let dirs: fs.Dirent[] = [];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }
    const real = new Set<string>();
    for (const d of dirs) {
      if (d.name.startsWith(".")) continue;
      const repoDir = path.join(root, d.name);
      // a repo linked in from another disk counts like one checked out here;
      // a worktree (its .git a file) and a second link to the same folder are read once, through the main clone
      try {
        if (!(d.isDirectory() || (d.isSymbolicLink() && fs.statSync(repoDir).isDirectory()))) continue;
        if (fs.lstatSync(path.join(repoDir, ".git"), { throwIfNoEntry: false })?.isFile()) continue;
        const rp = fs.realpathSync(repoDir);
        if (real.has(rp)) continue;
        real.add(rp);
      } catch {
        continue;
      }
      for (const f of spineFiles(repoDir)) {
        let text: string;
        try {
          text = await fs.promises.readFile(f, "utf8");
        } catch {
          continue;
        }
        const rel = path.relative(repoDir, f);
        if (bySh.size) wordsIn(text, d.name, rel, bySh, shRows, byWords);
        if (!/\b(?:vn_[0-9a-f]{8}|ch_[0-9a-f]{8}|e-[0-9a-f]{6})\b/.test(text)) continue;
        for (const [id, got] of requestRowsIn(text, d.name, rel)) {
          const cur = next.get(id);
          if (!cur || (got.onRow && !cur.onRow)) next.set(id, { rows: [...got.rows], onRow: got.onRow });
          else if (got.onRow === cur.onRow) for (const r of got.rows) if (!cur.rows.some((x) => x.code === r.code && x.repo === r.repo)) cur.rows.push(r);
        }
      }
    }
    // no row holds its id: the rows quoting its words, only by runs of his on at most two rows anywhere
    for (const [id, rows] of byWords) {
      if (next.get(id)?.rows.length) continue;
      const got = [...rows.values()].filter((x) => [...x.sh].some((sh) => (shRows.get(sh)?.size ?? 0) <= 2)).map((x) => x.row);
      if (got.length) next.set(id, { rows: got, onRow: false });
    }
    const cards = new Map<string, string | undefined>();
    for (const v of next.values())
      for (const r of v.rows) {
        const k = `${r.repo}/${r.code}`;
        if (!cards.has(k)) {
          let named: string | undefined;
          try {
            named = plainTitle(await fs.promises.readFile(path.join(root, r.repo, "docs/cards", `${r.code}.md`), "utf8"), undefined);
          } catch {
            /* no card yet: the row's own title stays */
          }
          cards.set(k, named);
        }
        const named = cards.get(k);
        if (named) r.title = named;
      }
    index = new Map([...next].map(([k, v]) => [k, v.rows]));
    at = now();
  };
  const refresh = () => {
    if (scanning || now() - at < ttl) return scanning;
    scanning = scan()
      .catch((e) => console.warn("request rows scan:", String((e as Error)?.message ?? e)))
      .finally(() => {
        scanning = undefined;
      });
    return scanning;
  };
  return {
    /** the rows holding this request id now (from the last scan; starts a fresh scan when it is old). */
    rowsOf(id: string | undefined): RequestRow[] | undefined {
      void refresh();
      if (!id || !at) return undefined;
      return index.get(id) ?? [];
    },
    /** wait for a scan (tests, the requests route). */
    ready: async () => {
      await (refresh() ?? Promise.resolve());
    },
    scannedAt: () => (at ? new Date(at).toISOString() : undefined),
  };
}
export type RequestRows = ReturnType<typeof createRequestRows>;

export type RequestItem = { chat: string; request: string; at: string; words: string; rows: RequestRow[] };

/** his messages in every chat's last view (desk_view_cache: the newest messages of each chat), one per chat and request. */
export function hisMessages(db: DB, sinceMs = 0): { chat: string; request: string; at: string; text: string }[] {
  let rows: { desk_key: string; view: string }[] = [];
  try {
    rows = db.prepare("SELECT desk_key, view FROM desk_view_cache").all() as { desk_key: string; view: string }[];
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: { chat: string; request: string; at: string; text: string }[] = [];
  for (const r of rows) {
    let msgs: { id?: string; role?: string; kind?: string; text?: string; at?: string; request?: string }[] = [];
    try {
      msgs = (JSON.parse(r.view) as { messages?: typeof msgs }).messages ?? [];
    } catch {
      continue;
    }
    for (const m of msgs) {
      if (m.role !== "user" || m.kind === "seed") continue;
      const request = m.request ?? requestIdOf(m.id, m.text ?? "");
      const at = Date.parse(m.at ?? "");
      if (!request || !Number.isFinite(at) || at < sinceMs || seen.has(`${r.desk_key}|${request}`)) continue;
      seen.add(`${r.desk_key}|${request}`);
      out.push({ chat: r.desk_key, request, at: new Date(at).toISOString(), text: m.text ?? "" });
    }
  }
  return out;
}

/**
 * his messages in the Team desk's chat copy (`<team repo>/desk/chat/<day>.md`, the console writes it from the chat's thread),
 * so a message older than the chat's cached view still finds the row that quotes it.
 */
export function chatCopyMessages(reposRoot: string | undefined, days = 7, nowMs = Date.now(), teamRepo = process.env.CONSOLE_TEAM_REPO || "team"): Wanted[] {
  if (!reposRoot) return [];
  const out: Wanted[] = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(nowMs - i * 86_400_000).toISOString().slice(0, 10);
    let text: string;
    try {
      text = fs.readFileSync(path.join(reposRoot, teamRepo, "desk", "chat", `${day}.md`), "utf8");
    } catch {
      continue;
    }
    for (const block of text.split(/\n(?=## \d\d:\d\dZ · )/)) {
      const m = /<!-- m:(\S+) -->\n([\s\S]*)$/.exec(block);
      if (!m) continue;
      const words = m[2].trim();
      const id = requestIdOf(m[1], words);
      if (id && words) out.push({ id, words });
    }
  }
  return out;
}

/** his requests since `sinceMs` in every chat's last view, newest last. */
export function requestsIn(db: DB, idx: Pick<RequestRows, "rowsOf">, sinceMs: number): { scannedAt?: string; requests: RequestItem[] } {
  const out = hisMessages(db, sinceMs).map((m) => ({ chat: m.chat, request: m.request, at: m.at, words: m.text.slice(0, 400), rows: idx.rowsOf(m.request) ?? [] }));
  return { requests: out.sort((a, b) => a.at.localeCompare(b.at)) };
}
