import fs from "node:fs";
import path from "node:path";
import type { DB } from "../db.js";
import type { SpineWriter } from "../inbox/spineWrite.js";
import { materialChange, type DeckMaterial, type DeckRef, type DeckTrendPoint, type EpicDeck } from "./build.js";
import { homeRepo, ownerName } from "../identity.js";

/**
 * a changed epic deck lands in the owner's inbox as one card, not a flood. The repo is the source
 * (L-45, L-46): the console appends one line per material change to `docs/status/deck-updates.md` through the spine writer
 * (one commit per tick for every changed deck), at most one line per deck per UTC day; the Team home shows each deck's
 * newest line that is neither a baseline nor seen as a card ("Epic decks changed"), and Seen writes `· seen <date>` on it.
 * A deck with no line yet gets a baseline line (no card), so the first run does not flood the inbox. The lines are also
 * the deck's trend: goals met and epics done at each change (the "How we measure it" slide).
 */
export const DECK_UPDATES_FILE = "docs/status/deck-updates.md";
/** A card older than this is not shown any more (its deck changed long ago; the deck itself is still there). */
export const CARD_MAX_AGE_DAYS = 14;

export interface DeckUpdateLine {
  /** 0-based line number in the file. */
  line: number;
  raw: string;
  date: string;
  ref: DeckRef;
  fp: string;
  goalsMet: number;
  goalsTotal: number;
  epicsDone: number;
  epicsTotal: number;
  text: string;
  baseline: boolean;
  seen?: string;
}

const LINE = /^- (\d{4}-\d{2}-\d{2}) · ([^/\s]+)\/(\S+) · fp ([0-9a-f]+) · goals (\d+)\/(\d+) · epics (\d+)\/(\d+) · (.*?)( · baseline)?(?: · seen (\d{4}-\d{2}-\d{2}))?\s*$/;

export function parseDeckUpdates(text: string): DeckUpdateLine[] {
  const out: DeckUpdateLine[] = [];
  text.split("\n").forEach((raw, line) => {
    const m = LINE.exec(raw.replace(/\r$/, ""));
    if (!m) return;
    out.push({
      line,
      raw: raw.replace(/\r$/, ""),
      date: m[1],
      ref: { repo: m[2], code: m[3] },
      fp: m[4],
      goalsMet: +m[5],
      goalsTotal: +m[6],
      epicsDone: +m[7],
      epicsTotal: +m[8],
      text: m[9],
      baseline: !!m[10],
      ...(m[11] ? { seen: m[11] } : {}),
    });
  });
  return out;
}

const keyOf = (r: DeckRef) => `${r.repo}/${r.code}`.toLowerCase();
/** Card text never holds the line's separator. */
const clean = (s: string) => s.replace(/\s*·\s*/g, ", ").replace(/\s+/g, " ").trim();

export function deckLine(d: EpicDeck, date: string, text: string, baseline: boolean): string {
  const done = d.measure.epics.done;
  const total = Object.values(d.measure.epics).reduce((a, b) => a + b, 0);
  return `- ${date} · ${d.ref.repo}/${d.ref.code} · fp ${d.fingerprint} · goals ${d.measure.goalsMet}/${d.measure.goalsTotal} · epics ${done}/${total} · ${clean(text) || "The deck changed."}${baseline ? " · baseline" : ""}`;
}

/** The deck's trend points from its lines, oldest first (one per day: the day's last line). */
export function trendOf(lines: DeckUpdateLine[], ref: DeckRef): DeckTrendPoint[] {
  const byDay = new Map<string, DeckTrendPoint>();
  for (const l of lines.filter((x) => keyOf(x.ref) === keyOf(ref)))
    byDay.set(l.date, { date: l.date, goalsMet: l.goalsMet, goalsTotal: l.goalsTotal, epicsDone: l.epicsDone, epicsTotal: l.epicsTotal });
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Each deck's newest line, when it is a card: not a baseline, not seen, and recent. Newest first. */
export function deckCards(lines: DeckUpdateLine[], today: string, maxAgeDays = CARD_MAX_AGE_DAYS): DeckUpdateLine[] {
  const newest = new Map<string, DeckUpdateLine>();
  for (const l of lines) {
    const k = keyOf(l.ref);
    const was = newest.get(k);
    if (!was || l.date > was.date || (l.date === was.date && l.line > was.line)) newest.set(k, l);
  }
  const oldest = new Date(Date.parse(`${today}T00:00:00Z`) - maxAgeDays * 86_400_000).toISOString().slice(0, 10);
  return [...newest.values()].filter((l) => !l.baseline && !l.seen && l.date >= oldest).sort((a, b) => b.date.localeCompare(a.date) || b.line - a.line);
}

/**
 * The lines one tick appends: a baseline for a deck with none, a change line for a deck whose fingerprint moved since its
 * newest line, unless that line is from today (then it waits for tomorrow: at most one card per deck per day).
 */
export function linesToAdd(decks: EpicDeck[], lines: DeckUpdateLine[], today: string, materialOf: (key: string) => DeckMaterial | undefined): { deck: EpicDeck; line: string; baseline: boolean }[] {
  const out: { deck: EpicDeck; line: string; baseline: boolean }[] = [];
  for (const d of decks) {
    const mine = lines.filter((l) => keyOf(l.ref) === keyOf(d.ref));
    const last = mine.reduce<DeckUpdateLine | undefined>((a, l) => (!a || l.date > a.date || (l.date === a.date && l.line > a.line) ? l : a), undefined);
    if (!last) {
      out.push({ deck: d, line: deckLine(d, today, "First look at this deck.", true), baseline: true });
      continue;
    }
    if (last.fp === d.fingerprint || last.date >= today) continue;
    const said = materialChange(materialOf(keyOf(d.ref)), d.material);
    out.push({ deck: d, line: deckLine(d, today, said.join(" "), false), baseline: false });
  }
  return out;
}

/** Append lines under `## Log` (created when missing). */
export function appendLines(text: string, add: string[]): string {
  const body = text.replace(/\s*$/, "\n");
  if (!/^## Log\s*$/m.test(body)) return `${body}\n## Log\n\n${add.join("\n")}\n`;
  return `${body}${add.join("\n")}\n`;
}

export function migrateDeckNotify(db: DB) {
  db.exec(`CREATE TABLE IF NOT EXISTS deck_material (key TEXT PRIMARY KEY, fp TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL);`);
}

export function createDeckNotify(d: {
  db: DB;
  /** The the code repo checkout (the file lives there). */
  repoDir: () => string | undefined;
  /** The decks that may raise a card (the owner's focus milestones and the big lanes), built from the current book. */
  decks: () => Promise<EpicDeck[]>;
  writer?: SpineWriter;
  now?: () => number;
  log?: (msg: string) => void;
}) {
  migrateDeckNotify(d.db);
  const now = d.now ?? Date.now;
  const log = d.log ?? ((m: string) => console.log(m));
  let running: Promise<{ added: number; status: string }> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const materialOf = (key: string): DeckMaterial | undefined => {
    const r = d.db.prepare("SELECT data FROM deck_material WHERE key = ?").get(key) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as DeckMaterial) : undefined;
  };
  const read = (): DeckUpdateLine[] => {
    const dir = d.repoDir();
    if (!dir) return [];
    try {
      return parseDeckUpdates(fs.readFileSync(path.join(dir, DECK_UPDATES_FILE), "utf8"));
    } catch {
      return [];
    }
  };

  async function once(): Promise<{ added: number; status: string }> {
    const dir = d.repoDir();
    if (!dir || !d.writer) return { added: 0, status: `no ${homeRepo()} checkout or spine writer` };
    const today = new Date(now()).toISOString().slice(0, 10);
    const decks = await d.decks();
    const add = linesToAdd(decks, read(), today, materialOf);
    if (!add.length) return { added: 0, status: "unchanged" };
    const cards = add.filter((a) => !a.baseline);
    const w = await d.writer.edit({
      repoDir: dir,
      path: DECK_UPDATES_FILE,
      label: "epic deck updates",
      edit: (text) => ({
        text: appendLines(text, add.map((a) => a.line)),
        msg: `${cards.length ? `${cards.length} epic ${cards.length === 1 ? "deck" : "decks"} changed` : "epic deck baselines"} (console)`,
        body: `The agent-team console compared each high-level epic deck with its last line in ${DECK_UPDATES_FILE} and appended ${add.length} ${add.length === 1 ? "line" : "lines"}: ${add.map((a) => `${a.deck.ref.repo}/${a.deck.ref.code}${a.baseline ? " (baseline)" : ""}`).join(", ")}. A line that is not a baseline is a card on ${ownerName()}'s Team home until he marks it seen.`,
      }),
    });
    if (w.status !== "written") {
      log(`deck notify: ${add.length} lines not written: ${w.reason ?? w.status}`);
      return { added: 0, status: `${w.status}: ${w.reason ?? ""}` };
    }
    const put = d.db.prepare("INSERT OR REPLACE INTO deck_material (key, fp, data, at) VALUES (?, ?, ?, ?)");
    for (const a of add) put.run(keyOf(a.deck.ref), a.deck.fingerprint, JSON.stringify(a.deck.material), new Date(now()).toISOString());
    log(`deck notify: ${add.length} lines (${cards.length} cards) in ${w.sha}`);
    return { added: add.length, status: `written ${w.sha}` };
  }

  const tick = () => (running ??= once().finally(() => (running = undefined)));

  return {
    tick,
    read,
    /** The cards on the owner's Team home now. */
    cards: () => deckCards(read(), new Date(now()).toISOString().slice(0, 10)),
    trend: (ref: DeckRef) => trendOf(read(), ref),
    /** the owner saw a card: `· seen <date>` on its line, through the spine writer. */
    async seen(ref: DeckRef, date: string) {
      const dir = d.repoDir();
      if (!dir || !d.writer) return { status: "skipped" as const, reason: `no ${homeRepo()} checkout or spine writer` };
      const today = new Date(now()).toISOString().slice(0, 10);
      return d.writer.edit({
        repoDir: dir,
        path: DECK_UPDATES_FILE,
        label: "epic deck seen",
        edit: (text) => {
          const lines = parseDeckUpdates(text).filter((l) => keyOf(l.ref) === keyOf(ref) && l.date === date && !l.seen && !l.baseline);
          if (!lines.length) return { skip: "no unseen line for that deck and date" };
          const all = text.split("\n");
          for (const l of lines) all[l.line] = `${l.raw} · seen ${today}`;
          return { text: all.join("\n"), msg: `${ownerName()} saw the ${ref.repo}/${ref.code} deck (console)`, body: `${ownerName()} marked the deck card of ${date} seen on the Team home; the console wrote · seen ${today} on its line in ${DECK_UPDATES_FILE}.` };
        },
      });
    },
    start(everyMs: number, firstAfterMs = 120_000) {
      if (timer || everyMs <= 0) return;
      setTimeout(() => void tick().catch((e) => log(`deck notify: ${(e as Error).message}`)), firstAfterMs).unref?.();
      timer = setInterval(() => void tick().catch((e) => log(`deck notify: ${(e as Error).message}`)), everyMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

export type DeckNotify = ReturnType<typeof createDeckNotify>;
