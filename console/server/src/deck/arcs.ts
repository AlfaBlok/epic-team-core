import fs from "node:fs";
import path from "node:path";
import type { BookRepo } from "../book/build.js";
import { deckCode, deckHref, findEpic } from "./build.js";

/**
 * arcs: each focus project's three-phase plan, three existing epics in order (now, next, after), so the owner sees
 * which epic the project is on and what comes next. The source is the code repo's `docs/arcs.md` (the repo is the
 * source); the console parses it and shows it on the project's page. Format (one `## <project>` section each):
 *
 *   Spine: <repo>/<path of the project's milestone spine>
 *   Aim: <the whole arc in one line>
 *   - now · · <what this phase achieves>
 *   - next · <repo>/ · <…>
 *   - after · · <…>
 *
 * A bare code is an epic of the Spine's repo.
 */
export const ARCS_FILE = "docs/arcs.md";

export type ArcPlace = "now" | "next" | "after";
const PLACES: readonly ArcPlace[] = ["now", "next", "after"];

export interface ArcPhase {
  place: ArcPlace;
  repo: string;
  code: string;
  line: string;
}

export interface Arc {
  project: string;
  /** `<repo>/<path>` of the milestone spine it belongs to. */
  spine: string;
  aim: string | null;
  phases: ArcPhase[];
}

export interface Arcs {
  file: string;
  /** the file's `Status:` line (e.g. a proposal for the owner to change). */
  status: string | null;
  arcs: Arc[];
}

/** A phase with what the book knows of its epic: title, status and its deck. */
export interface ArcPhaseView extends ArcPhase {
  title: string | null;
  status: string | null;
  goal: string | null;
  href: string | null;
}

export interface ArcView extends Omit<Arc, "phases"> {
  phases: ArcPhaseView[];
  file: string;
  fileStatus: string | null;
}

const field = (lines: string[], label: string): string | null => {
  const re = new RegExp(`^${label}:\\s*(.+)$`, "i");
  for (const l of lines) {
    const m = re.exec(l.trim());
    if (m) return m[1].trim();
  }
  return null;
};

export function parseArcs(text: string, file = ARCS_FILE): Arcs {
  const all = text.split("\n");
  const first = all.findIndex((l) => /^##\s+\S/.test(l));
  const head = first < 0 ? all : all.slice(0, first);
  const arcs: Arc[] = [];
  let cur: { project: string; lines: string[] } | undefined;
  const flush = () => {
    if (!cur) return;
    const spine = field(cur.lines, "Spine");
    const repo = spine?.split("/")[0] ?? "";
    const phases: ArcPhase[] = [];
    for (const l of cur.lines) {
      const m = /^\s*[-*]\s*(now|next|after)\s*[·:|—–-]\s*(?:([\w.-]+)\/)?((?:EPIC-[\w.-]+)|(?:M\d+)|[\w.-]+)\s*[·:|—–-]\s*(.+?)\s*$/i.exec(l);
      if (m) phases.push({ place: m[1].toLowerCase() as ArcPlace, repo: m[2] ?? repo, code: /^(EPIC-|M\d)/i.test(m[3]) ? m[3].toUpperCase() : m[3], line: m[4] });
    }
    phases.sort((a, b) => PLACES.indexOf(a.place) - PLACES.indexOf(b.place));
    if (spine && phases.length) arcs.push({ project: cur.project, spine, aim: field(cur.lines, "Aim"), phases });
  };
  for (const l of first < 0 ? [] : all.slice(first)) {
    const h = /^##\s+(.+?)\s*$/.exec(l);
    if (h) {
      flush();
      cur = { project: h[1], lines: [] };
    } else if (cur) cur.lines.push(l);
  }
  flush();
  return { file, status: field(head, "Status"), arcs };
}

/** The arcs from the code repo checkout; null when the file is not there. */
export function readArcs(repoDir: string | undefined): Arcs | null {
  if (!repoDir) return null;
  try {
    return parseArcs(fs.readFileSync(path.join(repoDir, ARCS_FILE), "utf8"));
  } catch {
    return null;
  }
}

/** The arc of one milestone (its repo name and spine path), each phase with its epic from the book when it has one. */
export function arcFor(arcs: Arcs | null, repoName: string, spinePath: string, repos: BookRepo[] = []): ArcView | null {
  const arc = arcs?.arcs.find((a) => a.spine === `${repoName}/${spinePath}`);
  if (!arc) return null;
  return {
    project: arc.project,
    spine: arc.spine,
    aim: arc.aim,
    file: arcs!.file,
    fileStatus: arcs!.status,
    phases: arc.phases.map((p) => {
      const r = repos.find((x) => x.name === p.repo);
      const e = r && findEpic(r, p.code);
      return {
        ...p,
        title: e ? e.title.replace(/^\s*(EPIC-[\w.-]+|M\d+)\s*[:—–-]\s*/i, "") : null,
        status: e?.status ?? null,
        goal: e?.goal ?? null,
        href: e ? deckHref({ repo: p.repo, code: deckCode(e) }) : null,
      };
    }),
  };
}
