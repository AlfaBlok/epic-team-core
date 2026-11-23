import fs from "node:fs";
import path from "node:path";
import { firstH1, stripInline } from "./adapters/markdown.js";
import { resolveRepo } from "./adapters/repos.js";
import { homeRepo } from "./identity.js";
import { cardFor, repoCards } from "./review/face.js";
import { CLOSED_STATUS, PARKED_STATUS, REVIEW_STATUS, ledgerLines } from "./review/rows.js";

/**
^ * One-offs (the owner's 2026-11-12 20:18Z voice note): "something needs to be delivered, and it doesn't belong
 * to any existing pursuit … it's just like a one-off. But even then, there's maybe going to be some lifecycle management".
 *
 * Where they live: a one-off is a spine ledger row whose title starts `One-off:`. The desk files one in the epic it
 * naturally sits in when there is one (a dispute with a rental host sits in the epic of the browser acts it needs), and in the One-offs spine `docs/spines/one-offs.md` when no epic fits; every row of that spine counts too.
 * So it runs the same lifecycle as every row (dispatch, claim, worker, review card, his answer) and needs no new state:
 * this is a read of the home repo's spines, the repo is the record. Open ones show; a closed one drops off after a week.
 */
export const ONE_OFFS_SPINE = "docs/spines/one-offs.md";
export const ONE_OFF_TITLE = /^\s*one[- ]off\b\s*:?\s*/i;
/** a closed one-off stays on the page this long (as "delivered"), then drops off. */
export const DELIVERED_DAYS = 7;

/** where a one-off is on its way from his voice note to delivered. */
export type OneOffStage = "filed" | "in work" | "stuck" | "your card" | "delivered" | "parked";
export const ONE_OFF_STAGES: OneOffStage[] = ["filed", "in work", "stuck", "your card", "delivered"];

export interface OneOff {
  id: string;
  /** the plain name: the title cell without `One-off:`, up to its first colon. */
  name: string;
  /** the rest of the title cell (what is asked). */
  detail?: string;
  stage: OneOffStage;
  /** the status cell's first word as written (ready, active, review, done …). */
  status: string;
  /** the run holding it, when one is claimed. */
  holder?: string;
  epic: { repo: string; path: string; code?: string; title?: string };
  /** its review card file, when written: the card he answers. */
  card?: { rel: string; title?: string; evidenceUrl?: string };
  /** his voice note it came from (a memory reference in the row) and its link. */
  source?: { ref: string; url?: string };
  next?: string;
  /** the row's Last Verified date. */
  date?: string;
}
export interface OneOffsBody {
  oneOffs: OneOff[];
  counts: Record<OneOffStage, number>;
  /** the spine new one-offs go to when no epic fits. */
  spine: string;
  deliveredDays: number;
}

const MEMORY_REF = /\b((?:Log|Notes)\/\d{4}-\d{2}-\d{2}\.md#\^e-[0-9a-f]{4,})/;
const EPIC_CODE = /^(EPIC-\d+|[A-Z][A-Z0-9]*-?\d+)\s*:/;
/** a row of the One-offs spine that builds the spine itself (titled with its Done-means id, like `E103-1: …`) is no one-off. */
const DONE_MEANS_TITLE = /^\s*[A-Z][A-Z0-9]*\d+-\d+\s*:/;
/** a row folded into another is that other row's job: it never shows on its own. */
const FOLDED_STATUS = /^\s*done\s*\(\s*folded\b/i;
/** a row moved to the one-offs repo leaves a pointer behind: the row itself shows from that repo. */
const MOVED_STATUS = /^\s*moved\b/i;
/** the one-offs repo (the owner's 22 Nov notes): one-offs with no repo of their own live there. */
export const ONE_OFFS_REPO = "one-offs";

export function stageOf(status: string, owner: string): OneOffStage {
  const s = status.trim();
  if (CLOSED_STATUS.test(s)) return "delivered";
  if (REVIEW_STATUS.test(s)) return "your card";
  if (PARKED_STATUS.test(s)) return "parked";
  if (/^(blocked|stuck|failed|needs)\b/i.test(s)) return "stuck";
  if (/^(active|in[ -]progress|doing|claimed|running)\b/i.test(s) || /\bclaimed\b|\blease until\b/i.test(owner)) return "in work";
  return "filed";
}

/** the GitHub base of the memory's notes, read from the voice-notes index (no repo name typed here). */
function memoryBase(repoDir: string): string | undefined {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(repoDir, "docs/voice-notes/index.json"), "utf8"));
    for (const p of Object.values<{ notes?: { url?: string }[] }>(d.products ?? {}))
      for (const n of p.notes ?? []) {
        const m = /^(https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\/)/.exec(n.url ?? "");
        if (m) return m[1];
      }
    for (const n of (d.notes ?? []) as { url?: string }[]) {
      const m = /^(https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[^/]+\/)/.exec(n.url ?? "");
      if (m) return m[1];
    }
  } catch {
    /* no index: the reference shows without a link */
  }
  return undefined;
}

const noteUrl = (base: string | undefined, ref: string) => {
  if (!base) return undefined;
  const [file, anchor] = ref.split("#");
  return `${base}${file}${anchor ? `#${encodeURIComponent(anchor)}` : ""}`;
};

const isoDay = (s: string | undefined) => /\d{4}-\d{2}-\d{2}/.exec(s ?? "")?.[0];

/** Every one-off of one repo's spines, newest first within each stage. */
export function readOneOffs(repoDir: string, repo: string, now = new Date()): OneOffsBody {
  const dir = path.join(repoDir, "docs/spines");
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    files = [];
  }
  const cards = repoCards(repoDir);
  const base = memoryBase(repoDir);
  const cutoff = new Date(now.getTime() - DELIVERED_DAYS * 86_400_000).toISOString().slice(0, 10);
  const out: OneOff[] = [];
  for (const f of files.sort()) {
    const rel = `docs/spines/${f}`;
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      continue;
    }
    const inSpine = rel === ONE_OFFS_SPINE;
    if (!inSpine && !/\|\s*one[- ]off\b/i.test(text)) continue;
    const h1 = firstH1(text) ?? "";
    const code = EPIC_CODE.exec(h1)?.[1];
    const epic = { repo, path: rel, code, title: code ? h1.slice(h1.indexOf(":") + 1).trim() : h1 || undefined };
    for (const l of ledgerLines(text)) {
      const titleCell = l.col.title >= 0 ? (l.cells[l.col.title] ?? "") : "";
      const plain = stripInline(titleCell);
      if (!inSpine && !ONE_OFF_TITLE.test(plain)) continue;
      if (inSpine && DONE_MEANS_TITLE.test(plain)) continue;
      const status = l.col.status >= 0 ? stripInline(l.cells[l.col.status] ?? "") : "";
      if (FOLDED_STATUS.test(status) || MOVED_STATUS.test(status)) continue;
      const owner = l.col.owner >= 0 ? (l.cells[l.col.owner] ?? "") : "";
      const stage = stageOf(status, owner);
      const date = isoDay(l.col.verified >= 0 ? l.cells[l.col.verified] : undefined);
      if (stage === "delivered" && (!date || date < cutoff)) continue;
      const body = plain.replace(ONE_OFF_TITLE, "");
      const cut = body.indexOf(": ");
      const name = (cut > 0 ? body.slice(0, cut) : body).trim();
      const detail = cut > 0 ? body.slice(cut + 2).trim() : undefined;
      const ref = MEMORY_REF.exec(l.cells.join(" "))?.[1];
      const card = cardFor(repoDir, rel, l.id, l.cells, cards);
      out.push({
        id: l.id,
        name,
        detail,
        stage,
        status: status.split(/[\s(—,;]/)[0] || status,
        holder: /\brun_[0-9a-f-]{8,}/.exec(owner)?.[0],
        epic,
        card: card ? { rel: card.rel, title: card.fields.title, evidenceUrl: card.fields.evidenceUrl } : undefined,
        source: ref ? { ref, url: noteUrl(base, ref) } : undefined,
        next: l.col.next >= 0 ? stripInline(l.cells[l.col.next] ?? "") || undefined : undefined,
        date,
      });
    }
  }
  const order = (s: OneOffStage) => ["your card", "stuck", "in work", "filed", "parked", "delivered"].indexOf(s);
  out.sort((a, b) => order(a.stage) - order(b.stage) || (b.date ?? "").localeCompare(a.date ?? "") || a.id.localeCompare(b.id));
  const counts = { filed: 0, "in work": 0, stuck: 0, "your card": 0, delivered: 0, parked: 0 } as Record<OneOffStage, number>;
  for (const o of out) counts[o.stage]++;
  return { oneOffs: out, counts, spine: ONE_OFFS_SPINE, deliveredDays: DELIVERED_DAYS };
}

const STAGE_ORDER: OneOffStage[] = ["your card", "stuck", "in work", "filed", "parked", "delivered"];

/** one page from several repos' one-offs (the home repo and the one-offs repo), in the page's order. */
export function mergeOneOffs(bodies: OneOffsBody[]): OneOffsBody {
  const out = bodies.flatMap((b) => b.oneOffs);
  out.sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) || (b.date ?? "").localeCompare(a.date ?? "") || a.id.localeCompare(b.id));
  const counts = { filed: 0, "in work": 0, stuck: 0, "your card": 0, delivered: 0, parked: 0 } as Record<OneOffStage, number>;
  for (const x of out) counts[x.stage]++;
  return { oneOffs: out, counts, spine: ONE_OFFS_SPINE, deliveredDays: DELIVERED_DAYS };
}

/** The home repo's and the one-offs repo's one-offs, read at most every `ttlMs`. */
export function createOneOffs(o: { reposRoot: string; home?: string; oneOffsRepo?: string; ttlMs?: number }) {
  let memo: { at: number; body: OneOffsBody } | undefined;
  const ttl = o.ttlMs ?? 30_000;
  return {
    get(): OneOffsBody {
      if (memo && Date.now() - memo.at < ttl) return memo.body;
      const name = o.home ?? homeRepo();
      const body = mergeOneOffs(
        [name, o.oneOffsRepo ?? ONE_OFFS_REPO].flatMap((r, i, all) => {
          if (all.indexOf(r) !== i) return [];
          const dir = resolveRepo(o.reposRoot, r)?.path;
          return dir ? [readOneOffs(dir, r)] : [];
        }),
      );
      memo = { at: Date.now(), body };
      return body;
    },
    clear: () => (memo = undefined),
  };
}
