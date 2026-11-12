import fs from "node:fs";
import path from "node:path";
import { homeRepo } from "../identity.js";

/**
 * the big rocks, the heavy themes the owner keeps repeating in his voice notes. The board's source is
 * the repo file `docs/big-rocks.md` (L-45: the repo is the source); the console parses it for the /rocks board and for the
 * first slide of every epic deck (deck/build.ts). Format (one `## R<n> · <name>` section per rock):
 *
 *   We want: <sentence>          Weight: heavy | medium
 *   Frequency: <n> notes on <d> days, first <date>, last <date>
 *   Epics:, memory/  (bare codes are the code repo's; `<repo>/<code>` for another repo; or `no epic yet`)
 *   Why it weighs: <sentence>
 *   Evidence:
 *   - <date> [Log/<file>#^e-<id>](<url>): "<quote>"
 */
export const BIG_ROCKS_FILE = "docs/big-rocks.md";
/** Bare epic codes in the board name this repo's epics. */
export const BIG_ROCKS_REPO = homeRepo();

export interface RockEvidence {
  date: string;
  ref: string;
  url?: string;
  quote: string;
}

export interface BigRock {
  /** R1, R2, … in weight order. */
  id: string;
  name: string;
  want: string;
  weight: "heavy" | "medium";
  frequency: { notes: number; days: number; first: string | null; last: string | null; text: string };
  /** `<repo>/<code>`, e.g. the code repo/; empty = no epic yet. */
  epics: string[];
  why: string | null;
  evidence: RockEvidence[];
}

export interface BigRocks {
  /** Repo-relative source file and its repo. */
  file: string;
  repo: string;
  goal: string | null;
  window: string | null;
  read: string | null;
  lastRead: string | null;
  method: string | null;
  note: string | null;
  /** who keeps the board (a persona of the team repo), how often, and where it reads from. */
  keptBy?: string | null;
  refresh?: string | null;
  sources?: string | null;
  rocks: BigRock[];
}

const field = (lines: string[], label: string): string | null => {
  const re = new RegExp(`^${label}:\\s*(.+)$`, "i");
  for (const l of lines) {
    const m = re.exec(l.trim());
    if (m) return m[1].trim();
  }
  return null;
};

/** ", memory/, M6" → ["the code repo/", "memory/", "the code repo/M6"]. */
export function epicRefs(text: string | null, repo = BIG_ROCKS_REPO): string[] {
  if (!text || /^no epic yet/i.test(text.trim())) return [];
  return text
    .split(/[,;]/)
    .map((s) => s.trim().replace(/[`*]/g, ""))
    .map((s) => /^(?:([\w.-]+)\/)?((?:EPIC-\d+)|(?:M\d+))\b/i.exec(s))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => `${m[1] ?? repo}/${m[2].toUpperCase()}`);
}

export function parseBigRocks(text: string, file = BIG_ROCKS_FILE, repo = BIG_ROCKS_REPO): BigRocks {
  const all = text.split("\n");
  const firstRock = all.findIndex((l) => /^##\s+R\d+\b/.test(l));
  const head = firstRock < 0 ? all : all.slice(0, firstRock);
  const rocks: BigRock[] = [];
  let cur: { id: string; name: string; lines: string[] } | undefined;
  const flush = () => {
    if (!cur) return;
    const ls = cur.lines;
    const freq = field(ls, "Frequency") ?? "";
    const num = (re: RegExp) => Number(re.exec(freq)?.[1] ?? 0);
    const date = (re: RegExp) => re.exec(freq)?.[1] ?? null;
    const evidence: RockEvidence[] = [];
    const at = ls.findIndex((l) => /^Evidence:/i.test(l.trim()));
    if (at >= 0)
      for (const l of ls.slice(at + 1)) {
        const m = /^\s*-\s*(\d{4}-\d{2}-\d{2})\s+(?:\[([^\]]+)\]\(([^)]+)\)|(\S+))\s*:?\s*["“]?(.*?)["”]?\s*$/.exec(l);
        if (m) evidence.push({ date: m[1], ref: m[2] ?? m[4], ...(m[3] ? { url: m[3] } : {}), quote: m[5].trim() });
      }
    rocks.push({
      id: cur.id,
      name: cur.name,
      want: field(ls, "We want") ? `We want ${field(ls, "We want")!.replace(/^We want\s+/i, "")}` : "",
      weight: /heavy/i.test(field(ls, "Weight") ?? "") ? "heavy" : "medium",
      frequency: { notes: num(/(\d+)\s+notes?/i), days: num(/(\d+)\s+days?/i), first: date(/first\s+(\d{4}-\d{2}-\d{2})/i), last: date(/last\s+(\d{4}-\d{2}-\d{2})/i), text: freq },
      epics: epicRefs(field(ls, "Epics"), repo),
      why: field(ls, "Why it weighs"),
      evidence,
    });
  };
  for (const l of firstRock < 0 ? [] : all.slice(firstRock)) {
    const h = /^##\s+(R\d+)\s*[·:—–-]\s*(.+?)\s*$/.exec(l);
    if (h) {
      flush();
      cur = { id: h[1], name: h[2], lines: [] };
    } else if (cur) cur.lines.push(l);
  }
  flush();
  return {
    file,
    repo,
    goal: field(head, "Goal sentence"),
    window: field(head, "Window"),
    read: field(head, "Read"),
    lastRead: field(head, "Last read"),
    method: field(head, "Method"),
    note: field(head, "Note"),
    keptBy: field(head, "Kept by"),
    refresh: field(head, "Refresh"),
    sources: field(head, "Sources"),
    rocks,
  };
}

/** The board from the code repo checkout; null when the file is not there yet. */
export function readBigRocks(repoDir: string | undefined): BigRocks | null {
  if (!repoDir) return null;
  try {
    return parseBigRocks(fs.readFileSync(path.join(repoDir, BIG_ROCKS_FILE), "utf8"));
  } catch {
    return null;
  }
}

/** The rocks a deck serves: those naming any epic of its subtree (`<repo>/<code>` refs). */
export function rocksFor(rocks: BigRock[], repo: string, codes: string[]): BigRock[] {
  const mine = new Set(codes.map((c) => `${repo}/${c.toUpperCase()}`));
  return rocks.filter((r) => r.epics.some((e) => mine.has(e)));
}
