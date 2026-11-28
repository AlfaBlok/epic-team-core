import fs from "node:fs";
import path from "node:path";

/**
 * The people the owner calls (the owner, 28 Nov: "you have like one guy, one board manager and nine campaign managers,
 * and this is your team ... you can call each one of them"): each with a name and a face his call screen shows.
 *
 *   docs/personas/managers.json (team repo, the one source)
 *        │
 *        ├─▶ GET /api/managers            the directory: name, role, objective, face, which call (the call directory draws it)
 *        ├─▶ GET /api/managers/:id/face   the face image (docs/personas/face-<id>.webp)
 *        └─▶ switch_to                    "pass me to Sam" finds that objective; the answer carries the name and face
 *
 * A new manager is one entry and one image in the repo: no release.
 */
export type Manager = {
  id: string;
  name: string;
  /** "board" (the Team desk partner, over every objective) or "campaign" (one objective's manager). */
  role: "board" | "campaign";
  /** a campaign manager's objective id in docs/pursuits.json. */
  objective?: string;
  /** the face image, a repo path (docs/personas/face-<id>.webp). */
  face?: string;
  /** the console assignment that wakes it (its persona on its cadence). */
  assignment?: string;
};

export const MANAGERS_FILE = "docs/personas/managers.json";

export function readManagers(homeDir: string | undefined): Manager[] {
  if (!homeDir) return [];
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(homeDir, MANAGERS_FILE), "utf8")) as { managers?: unknown };
    const list = Array.isArray(doc.managers) ? doc.managers : [];
    return list.filter(
      (m): m is Manager =>
        !!m && typeof m === "object" && typeof (m as Manager).id === "string" && /^[a-z0-9-]+$/.test((m as Manager).id) && typeof (m as Manager).name === "string" && ((m as Manager).role === "board" || (m as Manager).role === "campaign"),
    );
  } catch {
    return [];
  }
}

/** the face URL his screen loads, or undefined when the manager has none on disk. */
export const faceUrl = (m: Manager | undefined) => (m?.face ? `/api/managers/${encodeURIComponent(m.id)}/face` : undefined);

/** the face file inside the team repo (never outside docs/personas). */
export function facePath(homeDir: string | undefined, m: Manager | undefined): string | undefined {
  if (!homeDir || !m?.face || !/^docs\/personas\/[a-z0-9-]+\.(webp|png|jpg)$/.test(m.face)) return undefined;
  const p = path.join(homeDir, m.face);
  return fs.existsSync(p) ? p : undefined;
}

export const boardManager = (all: Manager[]) => all.find((m) => m.role === "board");
export const managerOfObjective = (all: Manager[], objective: string | undefined) => (objective ? all.find((m) => m.role === "campaign" && m.objective === objective) : undefined);

/**
 * who "pass me to <words>" names by a person's name ("Sam", "pass me to Sam please", "Lucía"): that manager, or
 * undefined (then the words are an objective's name or number, voice/switchTo.ts).
 */
export function managerByName(all: Manager[], to: string): Manager | undefined {
  const fold = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  const words = new Set(fold(to).split(/[^a-z0-9]+/).filter(Boolean));
  return all.find((m) => words.has(fold(m.name).split(/\s+/)[0]));
}

/**
 * the team every switch_to call knows by name: "Your team, by name: Sam is the board manager (you start as him);
 * Alex is the campaign manager of Acme: Launch Acme; ...". `names` maps an objective id to its name.
 */
export function teamLine(all: Manager[], names: (objective: string) => string | undefined, homeIsBoard: boolean): string {
  if (!all.length) return "";
  const board = boardManager(all);
  const parts = [
    ...(board ? [`${board.name} is the board manager, over all his objectives${homeIsBoard ? " (you start as him)" : ""}`] : []),
    ...all.filter((m) => m.role === "campaign" && m.objective).map((m) => `${m.name} is the campaign manager of ${names(m.objective!) ?? m.objective}`),
  ];
  return `Your team, by name (he may say "pass me to <name>": call switch_to with that name): ${parts.join("; ")}.`;
}
