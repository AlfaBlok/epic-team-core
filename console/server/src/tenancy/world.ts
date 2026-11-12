import type { Context, Hono } from "hono";
import { DEFAULT_TENANT, type DB } from "../db.js";
import { listRepos, repoForDir } from "../adapters/repos.js";
import { worldClaims } from "./repoScope.js";

/**
 * per-world filtering for the routes left reading the db globally, so that once a social world repo's rows move
 * (scripts/tenant-move.ts) the home world caller sees none of them and a a social world repo caller none of the home world's.
 *
 * The world of a request is the request-scoped store's `tenant` (the caller's world when CONSOLE_AUTH=on,
 *'s CONSOLE_TENANT otherwise; undefined = unscoped, today's behaviour, so auth off/shadow answers exactly as before).
 *
 * Two mechanisms, both no-ops while every row is the home world:
 *  - `ensureWorldStamps`: insert triggers that give rows written outside the scoped store (cycle runs, inbox answers and
 *    messages, milestone chat and ticket sessions, desk placements) their milestone's world instead of the home world default.
 *  - `mountWorldFilters`: list filters for routes whose rows are repos or T3 threads rather than tenant rows (repos,
 *    spines, threads) and for desk placements; inbox, messages, activity and usage filter in their own SQL.
 */
/** The world-move log's table (hosted tenancy/move.ts writes it; it is part of the schema every console boots). */
export function ensureMoveLog(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_moves (
      seq INTEGER PRIMARY KEY, -- no AUTOINCREMENT: an undone move leaves no sqlite_sequence trace
      move_id TEXT NOT NULL,
      tbl TEXT NOT NULL,
      row_key TEXT NOT NULL,
      col TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tenant_moves_move ON tenant_moves(move_id, seq);
  `);
}

export type WorldOf = () => string | undefined;

/** SQL guard: `(? IS NULL OR <col> = ?)`; bind the world twice (null = unscoped). */
export const worldGuard = (col = "tenant_id") => `(? IS NULL OR ${col} = ?)`;
export const worldArgs = (world: string | undefined) => [world ?? null, world ?? null] as const;

/** Copy the milestone's world onto rows inserted with the home world default. Idempotent by name; additive (old code ignores it). */
export function ensureWorldStamps(db: DB): void {
  ensureMoveLog(db); // the move log is part of the schema, so an undone move leaves the db as it found it
  const has = (table: string, col: string) => {
    try {
      return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
    } catch {
      return false;
    }
  };
  const viaMilestone = (table: string, key: string, milestoneExpr: string) =>
    has(table, "tenant_id")
      ? `CREATE TRIGGER IF NOT EXISTS world_stamp_${table} AFTER INSERT ON ${table}
         WHEN (SELECT tenant_id FROM milestones WHERE id = ${milestoneExpr}) IS NOT NULL
          AND (SELECT tenant_id FROM milestones WHERE id = ${milestoneExpr}) <> NEW.tenant_id
         BEGIN UPDATE ${table} SET tenant_id = (SELECT tenant_id FROM milestones WHERE id = ${milestoneExpr}) WHERE ${key} = NEW.${key}; END;`
      : "";
  // A placement names a checkout: it takes the world of the milestones in that repo when they are all of one world.
  const placementWorld = `(SELECT CASE WHEN COUNT(DISTINCT tenant_id) = 1 THEN MAX(tenant_id) END FROM milestones
      WHERE repo = NEW.repo OR repo LIKE '%/' || NEW.repo)`;
  db.exec(
    [
      viaMilestone("runs", "id", "NEW.milestone_id"),
      viaMilestone("needs_jordi", "id", "NEW.milestone_id"),
      viaMilestone("jordi_responses", "id", "NEW.milestone_id"),
      viaMilestone("messages", "id", "NEW.milestone_id"),
      viaMilestone("ticket_session", "seq", "NEW.milestone_id"),
      has("desk_session", "desk_key") ? viaMilestone("desk_session", "seq", "substr(NEW.desk_key, 11)") : "",
      has("desk_placement", "tenant_id")
        ? `CREATE TRIGGER IF NOT EXISTS world_stamp_desk_placement AFTER INSERT ON desk_placement
           WHEN ${placementWorld} IS NOT NULL AND ${placementWorld} <> NEW.tenant_id
           BEGIN UPDATE desk_placement SET tenant_id = ${placementWorld} WHERE id = NEW.id; END;`
        : "",
    ].join("\n"),
  );
}

/**
 * The worlds whose milestones live in each checkout (repo path → worlds). A checkout no milestone names belongs to
 * the home world (the platform's), so the a social world repo checkout leaves the home world's lists only once its milestone has moved.
 * only valid claims count (repoScope.ts): a world's milestone on the home world's or another world's checkout, an absolute
 * path or a symlink out of the root makes nothing visible to that world.
 */
export function repoWorlds(db: DB, reposRoot: string): Map<string, Set<string>> {
  return worldClaims(db, reposRoot);
}

/** A checkout is visible to a world that has a milestone in it; the home world also sees the checkouts no world claims. */
export const repoVisible = (worlds: Map<string, Set<string>>, repoPath: string, world: string | undefined) => {
  if (world === undefined) return true;
  const w = worlds.get(repoPath);
  return w ? w.has(world) : world === DEFAULT_TENANT;
};

async function replaceJson(c: Context, filter: (body: unknown) => unknown | undefined) {
  if (c.res.status !== 200 || !(c.res.headers.get("content-type") ?? "").includes("json")) return;
  const body = await c.res.clone().json().catch(() => undefined);
  if (body === undefined) return;
  const next = filter(body);
  if (next === undefined) return; // nothing removed: the original bytes go out
  const headers = new Headers(c.res.headers);
  headers.delete("content-length");
  c.res = new Response(JSON.stringify(next), { status: 200, headers });
}

/** Registered before the read/spines/desk routes. Unscoped requests pass untouched. */
export function mountWorldFilters(api: Hono, o: { db: DB; reposRoot: string; world: WorldOf }) {
  const visibleName = (name: string, world: string) => {
    const repo = listRepos(o.reposRoot).find((x) => x.name === name);
    return !repo || repoVisible(repoWorlds(o.db, o.reposRoot), repo.path, world); // unknown names: the route's own 404
  };
  const notFound = (c: Context, what: string) => c.json({ error: { code: "not_found", message: `${what} not found` } }, 404);

  api.get("/repos", async (c, next) => {
    await next();
    const world = o.world();
    if (world === undefined) return;
    const worlds = repoWorlds(o.db, o.reposRoot);
    await replaceJson(c, (b) => {
      if (!Array.isArray(b)) return undefined;
      const kept = b.filter((r: { path?: string }) => !r.path || repoVisible(worlds, r.path, world));
      return kept.length === b.length ? undefined : kept;
    });
  });
  api.get("/repos/:name/*", async (c, next) => {
    const world = o.world();
    if (world !== undefined && !visibleName(c.req.param("name") ?? "", world)) return notFound(c, `repo ${c.req.param("name")}`);
    await next();
  });
  api.get("/spine-tree", async (c, next) => {
    const world = o.world();
    if (world !== undefined && !visibleName(c.req.query("repo") ?? "", world)) return notFound(c, `repo ${c.req.query("repo")}`);
    await next();
  });
  api.get("/waiting-on-owner", async (c, next) => {
    // the ad hoc spine view (?repo=&path=) reads any checkout's asks: only the caller's world's checkouts
    const world = o.world();
    const repo = c.req.query("repo");
    if (world !== undefined && repo && !visibleName(repo, world)) return notFound(c, `repo ${repo}`);
    await next();
  });
  api.get("/desk/links", async (c, next) => {
    const world = o.world();
    if (world !== undefined && !visibleName(c.req.query("repo") ?? "", world)) return notFound(c, `repo ${c.req.query("repo")}`);
    await next();
  });
  api.get("/threads", async (c, next) => {
    await next();
    const world = o.world();
    if (world === undefined) return;
    const worlds = repoWorlds(o.db, o.reposRoot);
    const owned = new Set((o.db.prepare(`SELECT id FROM milestones WHERE tenant_id = ?`).all(world) as { id: string }[]).map((r) => r.id));
    await replaceJson(c, (b) => {
      if (!Array.isArray(b)) return undefined;
      const kept = b.filter((t: { milestoneId?: string; workspaceRoot?: string }) => {
        if (t.milestoneId) return owned.has(t.milestoneId);
        const repo = t.workspaceRoot ? repoForDir(o.reposRoot, t.workspaceRoot) : undefined;
        return repo ? repoVisible(worlds, repo.path, world) : world === DEFAULT_TENANT;
      });
      return kept.length === b.length ? undefined : kept;
    });
  });
  api.get("/desk/placements", async (c, next) => {
    await next();
    const world = o.world();
    if (world === undefined) return;
    let mine: Set<string>;
    try {
      mine = new Set((o.db.prepare("SELECT id FROM desk_placement WHERE tenant_id = ?").all(world) as { id: string }[]).map((r) => r.id));
    } catch {
      return;
    }
    await replaceJson(c, (b) => {
      if (!Array.isArray(b)) return undefined;
      const kept = b.filter((p: { id: string }) => mine.has(p.id));
      return kept.length === b.length ? undefined : kept;
    });
  });
}

/** The world a milestone belongs to (the home world when unknown). */
export const milestoneWorld = (db: DB, milestoneId: string): string =>
  (db.prepare("SELECT tenant_id AS t FROM milestones WHERE id = ?").get(milestoneId) as { t: string } | undefined)?.t ?? DEFAULT_TENANT;
