import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_TENANT, type DB } from "../db.js";
import { forTenant, type Milestone, type Store } from "../store.js";
import { underTmp, type SpineWrite, type SpineWriter } from "../inbox/spineWrite.js";
import { TEAM_REPO_DEFAULT } from "./teamState.js";
import { ownerName } from "../identity.js";

/**
 * which spines the console tracks, and the owner's marks on them (the name he
 * gave it, its owner, paused, settled), live in the world's team repo, not in console.db:
 *
 *   state/milestones.json   one entry per tracked milestone (id, repo, path, title, titleSet, owner, paused, settledAt,
 *                           createdAt). the home world's is in the owner's team repo (the team repo); another world's in its own
 *                           checkout (`<reposRoot>/<world>`).
 *
 * A console change (create, rename, owner, pause, settle, unsettle, retire, restore, delete) is written to the file first,
 * through the one spine writer; only a written file changes console.db, and a refused or failed write changes nothing
 * (`RecordError`, no in-memory retry). On every team-state pass the file is applied to console.db (the milestones table is
 * an index of it), so a change on main (another host, by hand) shows, and a lost database is rebuilt from it. The marks
 * stay out of the tracked spines themselves: they are the console's view of another repo's epic (the memory service spine is never
 * edited for it, root L-44). Big-root positions stay in state/big-roots.json. A world with no such checkout
 * (tests, a tester world before its repo exists) keeps its milestones in console.db as before.
 */
export const MILESTONES_FILE = "state/milestones.json";
export const MILESTONES_ABOUT =
  `The spines the agent-team console tracks for this world, with ${ownerName()}'s marks on each: the name he gave it (titleSet), its owner, paused, settled. The console writes this file before it changes anything and reads it back on every pass.`;

export interface MilestoneEntry {
  id: string;
  repo: string;
  path: string;
  title: string;
  /** the owner named it on the console (the name wins over the spine's H1). */
  titleSet: boolean;
  owner: string;
  paused: boolean;
  settledAt: string | null;
  createdAt: string;
  /**
   * a big root's position, for every world but the home world (whose big roots are state/big-roots.json): before,
   * another world's sidebar order lived in console.db only. Absent = not recorded yet (the carry fills it once).
   */
  bigRoot?: number | null;
}

export class RecordError extends Error {
  constructor(
    readonly status: "skipped" | "failed",
    message: string,
  ) {
    super(message);
  }
}

export const entryOf = (m: Milestone, withBigRoot = false): MilestoneEntry => ({
  id: m.id,
  repo: m.repo,
  path: m.path,
  title: m.title,
  titleSet: !!m.titleSetAt,
  owner: m.owner,
  paused: !!m.paused,
  settledAt: m.settledAt ?? null,
  createdAt: m.createdAt,
  ...(withBigRoot ? { bigRoot: m.bigRoot ?? null } : {}),
});
/** The entry as `world`'s file holds it (the home world's big roots are in state/big-roots.json, not here). */
const entryIn = (world: string, m: Milestone) => entryOf(m, world !== DEFAULT_TENANT);

const order = (a: MilestoneEntry, b: MilestoneEntry) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

export function milestonesText(list: MilestoneEntry[]): string {
  return JSON.stringify({ about: MILESTONES_ABOUT, milestones: [...list].sort(order) }, null, 2) + "\n";
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** The file's entries; undefined (and why) when it is not a valid list. */
export function parseMilestones(text: string): { entries: MilestoneEntry[] } | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { error: `not JSON: ${(e as Error).message}` };
  }
  const list = (v as { milestones?: unknown })?.milestones;
  if (!Array.isArray(list)) return { error: "no `milestones` list" };
  const entries: MilestoneEntry[] = [];
  for (const x of list as Record<string, unknown>[]) {
    const id = str(x?.id);
    const repo = str(x?.repo);
    if (!id || !/^ms_[\w-]+$/.test(id) || !repo) return { error: `an entry has no valid id or repo: ${JSON.stringify(x).slice(0, 120)}` };
    entries.push({
      id,
      repo,
      path: str(x.path) ?? "",
      title: str(x.title) ?? "",
      titleSet: x.titleSet === true,
      owner: str(x.owner) ?? "",
      paused: x.paused === true,
      settledAt: str(x.settledAt) ?? null,
      createdAt: str(x.createdAt) ?? "",
      ...(typeof x.bigRoot === "number" || x.bigRoot === null ? { bigRoot: x.bigRoot as number | null } : {}),
    });
  }
  return { entries };
}

export interface MilestoneRecordDeps {
  db: DB;
  reposRoot: string;
  /** the owner's team repo name under reposRoot (default `team`). */
  teamRepo?: string;
  writer: Pick<SpineWriter, "edit">;
  log?: (m: string) => void;
  now?: () => Date;
  /** Off (console.db only): the staging console, which refuses every push. */
  off?: boolean;
}

export function createMilestoneRecord(d: MilestoneRecordDeps) {
  const now = () => d.now?.() ?? new Date();
  const log = d.log ?? (() => {});
  /** A checkout with an origin to push to (a local-only checkout holds no shared state: its world stays in console.db). */
  const isRepo = (p: string) => {
    try {
      return /^\s*\[remote "origin"\]/m.test(fs.readFileSync(path.join(p, ".git", "config"), "utf8"));
    } catch {
      return false;
    }
  };
  /** The world's team-repo checkout, or undefined (its milestones stay in console.db). */
  function dirOf(world: string): string | undefined {
    // staging never pushes: its milestones stay in its own console.db, a sandbox
    if (d.off) return undefined;
    const p = path.join(d.reposRoot, world === DEFAULT_TENANT ? d.teamRepo || TEAM_REPO_DEFAULT : world);
    // under the test runner only a temp checkout counts (the default repos root is the real ~/github)
    if ((process.env.VITEST || process.env.NODE_ENV === "test") && !underTmp(p)) return undefined;
    return world && !/[/\\]|^\./.test(world) && isRepo(p) ? p : undefined;
  }
  const worlds = () => (d.db.prepare("SELECT DISTINCT tenant_id AS t FROM milestones").all() as { t: string | null }[]).map((r) => r.t ?? DEFAULT_TENANT);
  const dbEntries = (world: string) => forTenant(d.db, world).listMilestones({ includeSettled: true }).map((m) => entryIn(world, m));
  const readFile = (dir: string) => {
    try {
      return fs.readFileSync(path.join(dir, MILESTONES_FILE), "utf8");
    } catch {
      return undefined;
    }
  };

  /**
   * Write `change` into the world's file (its entries as they are on origin/main; console.db's when the file is new) and
   * push. Nothing to write for a world with no team-repo checkout. Throws RecordError when the write is refused or fails.
   */
  async function write(world: string, why: string, change: (list: MilestoneEntry[]) => MilestoneEntry[]): Promise<SpineWrite | undefined> {
    const dir = dirOf(world);
    if (!dir) return undefined;
    let bad: string | undefined;
    const w = await d.writer.edit({
      repoDir: dir,
      path: MILESTONES_FILE,
      label: "milestones",
      edit: (text) => {
        const parsed = text.trim() ? parseMilestones(text) : { entries: dbEntries(world) };
        if ("error" in parsed) return { skip: (bad = `${MILESTONES_FILE} is not readable (${parsed.error}): fix it by hand first`) };
        return {
          text: milestonesText(change(parsed.entries)),
          msg: `Milestones: ${why} (console)`,
          body: `The agent-team console recorded a change to the milestones it tracks for ${world} before making it.`,
        };
      },
    });
    if (w.status !== "written") throw new RecordError(w.status, `${MILESTONES_FILE} not written (${bad ?? w.reason ?? w.status}); nothing changed`);
    applied.set(world, readFile(dir) ?? "");
    return w;
  }
  const put = (world: string, e: MilestoneEntry, why: string) => write(world, why, (list) => [...list.filter((x) => x.id !== e.id), e]);
  const remove = (world: string, id: string, why: string) => write(world, why, (list) => list.filter((x) => x.id !== id));

  const applied = new Map<string, string>();
  /** File → console.db for every world with a file: entries update or add their milestone. Returns what changed. */
  function apply(): string[] {
    const out: string[] = [];
    const ws = new Set([...worlds(), DEFAULT_TENANT]);
    for (const world of ws) {
      const dir = dirOf(world);
      const text = dir ? readFile(dir) : undefined;
      if (text === undefined || applied.get(world) === text) continue;
      applied.set(world, text);
      const parsed = parseMilestones(text);
      if ("error" in parsed) {
        log(`milestones: ${world} ${MILESTONES_FILE} ignored: ${parsed.error}`);
        continue;
      }
      const s = forTenant(d.db, world);
      for (const e of parsed.entries) {
        const m = s.getMilestone(e.id);
        if (!m) {
          if (d.db.prepare("SELECT 1 FROM milestones WHERE id = ?").get(e.id)) continue; // another world's id: never moved
          s.createMilestone({ id: e.id, title: e.title, repo: e.repo, path: e.path, owner: e.owner, paused: e.paused, createdAt: e.createdAt || now().toISOString(), ...(world !== DEFAULT_TENANT && e.bigRoot != null ? { bigRoot: e.bigRoot } : {}) });
          if (e.titleSet) s.updateMilestone(e.id, { titleSetAt: now().toISOString() });
          if (e.settledAt) s.setSettled(e.id, true, e.settledAt);
          out.push(`${world}: ${e.title} added`);
          continue;
        }
        const was = entryIn(world, m);
        const p: Parameters<Store["updateMilestone"]>[1] = {};
        if (world !== DEFAULT_TENANT && e.bigRoot !== undefined && (was.bigRoot ?? null) !== e.bigRoot) p.bigRoot = e.bigRoot;
        if (was.title !== e.title) p.title = e.title;
        if (was.titleSet !== e.titleSet) p.titleSetAt = e.titleSet ? now().toISOString() : null;
        if (was.repo !== e.repo) p.repo = e.repo;
        if (was.path !== e.path) p.path = e.path;
        if (was.owner !== e.owner) p.owner = e.owner;
        if (was.paused !== e.paused) p.paused = e.paused;
        if (Object.keys(p).length) s.updateMilestone(e.id, p);
        if (!!was.settledAt !== !!e.settledAt) s.setSettled(e.id, !!e.settledAt, e.settledAt ?? undefined);
        if (Object.keys(p).length || !!was.settledAt !== !!e.settledAt) out.push(`${world}: ${e.title} updated`);
      }
    }
    if (out.length) log(`milestones: applied ${out.join("; ")}`);
    return out;
  }

  /** carry-over: each world's console.db milestones written to its file once (`dry` says what it would write). */
  async function carry(o: { dry?: boolean } = {}): Promise<{ world: string; action: string; count: number; reason?: string }[]> {
    const out: { world: string; action: string; count: number; reason?: string }[] = [];
    for (const world of new Set(worlds())) {
      const dir = dirOf(world);
      const mine = dbEntries(world);
      if (!dir) {
        out.push({ world, action: "no team-repo checkout: stays in console.db", count: mine.length });
        continue;
      }
      const text = readFile(dir);
      const have = text ? parseMilestones(text) : { entries: [] as MilestoneEntry[] };
      if ("error" in have) {
        out.push({ world, action: "file unreadable", count: 0, reason: have.error });
        continue;
      }
      const ids = new Set(have.entries.map((e) => e.id));
      const missing = mine.filter((e) => !ids.has(e.id));
      // another world's big roots, carried once into the entries that lack them
      const unpinned = world === DEFAULT_TENANT ? [] : mine.filter((e) => e.bigRoot != null && have.entries.some((x) => x.id === e.id && x.bigRoot === undefined));
      if (unpinned.length) {
        if (o.dry) out.push({ world, action: "would record big roots", count: unpinned.length });
        else
          try {
            await write(world, `carry ${unpinned.length} big-root position(s) from console.db`, (list) => list.map((x) => ({ ...x, ...(unpinned.find((e) => e.id === x.id) ? { bigRoot: unpinned.find((e) => e.id === x.id)!.bigRoot } : {}) })));
            out.push({ world, action: "big roots written", count: unpinned.length });
          } catch (e) {
            out.push({ world, action: "big roots not written", count: unpinned.length, reason: (e as Error).message });
          }
      }
      if (!missing.length && text) {
        out.push({ world, action: "already in the file", count: mine.length });
        continue;
      }
      if (o.dry) {
        out.push({ world, action: "would write", count: missing.length });
        continue;
      }
      try {
        await write(world, `carry ${missing.length} tracked milestone(s) from console.db`, (list) => [...list, ...missing.filter((e) => !list.some((x) => x.id === e.id))]);
        out.push({ world, action: "written", count: missing.length });
      } catch (e) {
        out.push({ world, action: "not written", count: missing.length, reason: (e as Error).message });
      }
    }
    return out;
  }

  /**
   * Store calls that record first: the file carries the change, then console.db does (the same entry). Each throws
   * RecordError when the file is not written, with console.db untouched.
   */
  function recorded(s: Store) {
    const worldOf = (id: string) => s.worldOfMilestone?.(id) ?? s.tenant ?? DEFAULT_TENANT;
    return {
      async createMilestone(input: Parameters<Store["createMilestone"]>[0] & { titleSet?: boolean }): Promise<Milestone> {
        const id = `ms_${randomUUID()}`;
        const createdAt = now().toISOString();
        const world = s.tenant ?? DEFAULT_TENANT;
        await put(world, { id, repo: input.repo, path: input.path, title: input.title, titleSet: !!input.titleSet, owner: input.owner, paused: input.paused, settledAt: null, createdAt, ...(world !== DEFAULT_TENANT ? { bigRoot: input.bigRoot ?? null } : {}) }, `track ${input.title}`);
        const { titleSet, ...rest } = input;
        s.createMilestone({ ...rest, id, createdAt });
        if (titleSet) s.updateMilestone(id, { titleSetAt: createdAt });
        return s.getMilestone(id)!;
      },
      async updateMilestone(id: string, p: Parameters<Store["updateMilestone"]>[1]): Promise<Milestone | undefined> {
        const cur = s.getMilestone(id);
        if (!cur) return undefined;
        const world = worldOf(id);
        const next = entryIn(world, { ...cur, ...p, titleSetAt: p.titleSetAt === undefined ? cur.titleSetAt : (p.titleSetAt ?? undefined), ...(p.bigRoot !== undefined ? { bigRoot: p.bigRoot ?? undefined } : {}) } as Milestone);
        const was = entryIn(world, cur);
        if (JSON.stringify(next) !== JSON.stringify(was)) await put(world, next, `${cur.title}: ${changed(was, next)}`);
        return s.updateMilestone(id, p);
      },
      async setSettled(id: string, settled: boolean): Promise<Milestone | undefined> {
        const cur = s.getMilestone(id);
        if (!cur) return undefined;
        if (settled === !!cur.settledAt) return cur;
        const at = now().toISOString();
        await put(worldOf(id), { ...entryIn(worldOf(id), cur), settledAt: settled ? at : null }, `${settled ? "settle" : "unsettle"} ${cur.title}`);
        return s.setSettled(id, settled, at);
      },
      async deleteMilestone(id: string): Promise<boolean> {
        const cur = s.getMilestone(id);
        if (!cur) return false;
        await remove(worldOf(id), id, `stop tracking ${cur.title}`);
        return !!s.deleteMilestone(id);
      },
    };
  }

  return { dirOf, write, put, remove, apply, carry, recorded };
}

const changed = (a: MilestoneEntry, b: MilestoneEntry) =>
  (Object.keys(b) as (keyof MilestoneEntry)[])
    .filter((k) => a[k] !== b[k])
    .map((k) => (k === "title" ? `renamed ${JSON.stringify(b.title)}` : k === "paused" ? (b.paused ? "paused" : "resumed") : k === "bigRoot" ? (b.bigRoot != null ? `big root ${b.bigRoot}` : "made ordinary") : `${k} changed`))
    .join(", ");

export type MilestoneRecord = ReturnType<typeof createMilestoneRecord>;
export type RecordedStore = ReturnType<MilestoneRecord["recorded"]>;

/** The same calls on console.db only (no team repo wired: tests, a caller without the record). */
export function plainRecorded(s: Store): RecordedStore {
  return {
    createMilestone: async (input) => {
      const { titleSet, ...rest } = input;
      const m = s.createMilestone(rest);
      return titleSet ? s.updateMilestone(m.id, { titleSetAt: new Date().toISOString() })! : m;
    },
    updateMilestone: async (id, p) => s.updateMilestone(id, p),
    setSettled: async (id, settled) => s.setSettled(id, settled),
    deleteMilestone: async (id) => !!s.deleteMilestone(id),
  };
}
