import fs from "node:fs";
import path from "node:path";
import { DEFAULT_TENANT, type DB } from "../db.js";
import { REFUSED_REPO, resolveRepo, type Repo } from "../adapters/repos.js";

export { REFUSED_REPO };

/**
 * a world's milestone `repo` resolves only inside that world's own repo root.
 *
 * Every world shares the console's repos root (`~/github`), so a world's own root is the set of checkouts there that
 * belong to it alone: the checkout named after the world (a tester world's repo, `<reposRoot>/<world>`) and the checkouts
 * the platform opened for it (its campaign's claim), i.e. checkouts whose milestones are all of that world.
 * the home world (the platform) keeps every repo it names today, absolute paths included; a checkout no world claims is the home world's.
 *
 * A world may name a checkout only by name or `owner/name`: never an absolute path, `~`, `..` or a nested path, never a
 * checkout whose directory is a symlink or lies outside the root, never one the home world or another world claims.
 *  - create / PATCH (`milestoneRepoRefusal` from app.ts) refuse such a repo with 404;
 *  - every read and write path gets its milestones from the store, which hands out a stored world milestone that breaks
 *    the rule with `repo` = `refused:<repo>` (`guardMilestoneRepo`), and `resolveRepo` resolves that to nothing: no spine
 *    read, book, pipeline, answer, commit or push reaches the checkout;
 *  - `repoWorlds` (which checkouts a world may list and read by name) counts only these valid claims.
 */

/** Why a world may not write this repo string (a path, not a checkout name); undefined = a plain name or owner/name. */
export function repoSyntaxRefusal(repo: string): string | undefined {
  const r = repo.trim();
  if (!r) return "an empty repo";
  if (r.startsWith(REFUSED_REPO)) return "a refused repo";
  if (path.isAbsolute(r) || /^[a-z]:/i.test(r) || r.startsWith("~")) return "an absolute path";
  if (/[\\\0]/.test(r)) return "a path";
  const parts = r.replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "").split("/");
  if (parts.some((p) => p === ".." || p === "." || p === "")) return "a relative path";
  if (parts.length > 2) return "a nested path";
  return undefined;
}

/** The checkout is a real directory directly in the repos root (symlinks followed on both sides, none on the checkout). */
export function confinedCheckout(reposRoot: string, repo: Repo): boolean {
  const key = `${reposRoot}\0${repo.path}`;
  const hit = confined.get(key);
  if (hit && SCOPE_MEMO_MS > 0 && Date.now() - hit.at < SCOPE_MEMO_MS) return hit.ok;
  let ok = false;
  try {
    const root = fs.realpathSync(reposRoot);
    const real = fs.realpathSync(repo.path);
    ok = real === path.join(root, path.basename(repo.path)) && path.dirname(real) === root;
  } catch {
    ok = false;
  }
  confined.set(key, { at: Date.now(), ok });
  return ok;
}

/**
 * how long a confinement answer and a claims map are reused. Every store read of a world milestone asked the
 * disk again (two realpaths each, and every milestone's checkout for the claims): 56% of the indexer's own CPU in a
 * 5-minute profile of production's data (23.6 of 42.4 s busy), and the same on the console's request thread. The
 * claims are recomputed at once when a milestone row changes (the rows are its key); a symlink swapped under the root
 * is seen within this many ms. 0 = no reuse (tests).
 */
export let SCOPE_MEMO_MS = 15_000;
export function setScopeMemoMs(ms: number): void {
  SCOPE_MEMO_MS = ms;
  confined.clear();
}
const confined = new Map<string, { at: number; ok: boolean }>();
const claimsMemo = new WeakMap<object, { root: string; sig: string; at: number; out: Map<string, Set<string>> }>();

/** The checkout a world's repo string names, when that string and checkout are allowed for any world at all. */
function worldCheckout(reposRoot: string, repo: string): Repo | undefined {
  if (repoSyntaxRefusal(repo)) return undefined;
  const r = resolveRepo(reposRoot, repo);
  return r && confinedCheckout(reposRoot, r) ? r : undefined;
}

/**
 * The valid claims: checkout path → the worlds whose milestones may use it. the home world's milestones always count. A world's
 * milestone counts only for a confined checkout the home world does not claim; when several worlds claim one checkout (made before
 *), only the world it is named after counts, else the world with the oldest milestone there.
 */
export function worldClaims(db: DB, reposRoot: string): Map<string, Set<string>> {
  const rows = db.prepare("SELECT repo, tenant_id FROM milestones ORDER BY created_at, id").all() as { repo: string; tenant_id: string | null }[];
  const sig = rows.map((r) => `${r.tenant_id ?? ""}\t${r.repo}`).join("\n");
  const memo = claimsMemo.get(db);
  if (memo && memo.root === reposRoot && memo.sig === sig && Date.now() - memo.at < SCOPE_MEMO_MS) return copyClaims(memo.out);
  const out = computeClaims(rows, reposRoot);
  if (SCOPE_MEMO_MS > 0) claimsMemo.set(db, { root: reposRoot, sig, at: Date.now(), out });
  return copyClaims(out);
}

const copyClaims = (m: Map<string, Set<string>>) => new Map([...m].map(([k, v]) => [k, new Set(v)]));

function computeClaims(rows: { repo: string; tenant_id: string | null }[], reposRoot: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const others = new Map<string, string[]>();
  for (const m of rows) {
    const t = m.tenant_id ?? DEFAULT_TENANT;
    if (t !== DEFAULT_TENANT) continue;
    const r = resolveRepo(reposRoot, m.repo);
    if (r) out.set(r.path, (out.get(r.path) ?? new Set<string>()).add(t));
  }
  for (const m of rows) {
    const t = m.tenant_id ?? DEFAULT_TENANT;
    if (t === DEFAULT_TENANT) continue;
    const r = worldCheckout(reposRoot, m.repo);
    if (!r || out.has(r.path)) continue;
    const ws = others.get(r.path) ?? [];
    if (!ws.includes(t)) ws.push(t);
    others.set(r.path, ws);
  }
  for (const [p, ws] of others) out.set(p, new Set([ws.find((w) => w === path.basename(p)) ?? ws[0]]));
  return out;
}

/**
 * Why `world` may not set its milestone's repo to `repo` (create / PATCH); undefined = allowed. the home world / unscoped:
 * always allowed. A world: the checkout must be its own (claimed by it alone) or the one named after it that no one claims.
 */
export function milestoneRepoRefusal(db: DB, reposRoot: string, world: string | undefined, repo: string): string | undefined {
  if (world === DEFAULT_TENANT) return homeRepoRefusal(db, reposRoot, repo);
  if (world === undefined) return undefined;
  const syntax = repoSyntaxRefusal(repo);
  if (syntax) return `repo ${repo} is ${syntax}: a world names one of its own checkouts by name`;
  const r = worldCheckout(reposRoot, repo);
  const claim = r && worldClaims(db, reposRoot).get(r.path);
  const own = r && (claim ? claim.size === 1 && claim.has(world) : path.basename(r.path) === world);
  return own ? undefined : `repo ${repo} is not one of ${world}'s checkouts`;
}

/**
 * The home world takes no checkout another world already holds. A home goal there claims the checkout (computeClaims),
 * which turns every goal of that world in it `refused:` at once: the world reads none of its own cards and they show in
 * the home world's inbox instead (the owner: "why am I being offered this call" in the wrong product). A checkout the
 * home world already holds a goal in stays its own, as before.
 */
export function homeRepoRefusal(db: DB, reposRoot: string, repo: string): string | undefined {
  const r = resolveRepo(reposRoot, repo);
  if (!r) return undefined; // not a checkout here: the route's own answer
  const rows = db.prepare("SELECT repo, tenant_id FROM milestones ORDER BY created_at, id").all() as { repo: string; tenant_id: string | null }[];
  const home = rows.some((m) => (m.tenant_id ?? DEFAULT_TENANT) === DEFAULT_TENANT && resolveRepo(reposRoot, m.repo)?.path === r.path);
  if (home) return undefined;
  const holder = rows.find((m) => (m.tenant_id ?? DEFAULT_TENANT) !== DEFAULT_TENANT && worldCheckout(reposRoot, m.repo)?.path === r.path)?.tenant_id;
  return holder ? `repo ${repo} is world ${holder}'s checkout: make the goal in ${holder}, so its cards reach that world's inbox` : undefined;
}

/** Store hook: a stored milestone of `tenant` keeps its repo when allowed, else gets `refused:<repo>`. */
export function guardMilestoneRepo<M extends { repo: string }>(db: DB, tenant: string | null | undefined, m: M, claims: () => Map<string, Set<string>>): M {
  const t = tenant ?? DEFAULT_TENANT;
  const root = scopes.get(db);
  if (t === DEFAULT_TENANT || root === undefined || m.repo.startsWith(REFUSED_REPO)) return m;
  const r = worldCheckout(root, m.repo);
  const claim = r && claims().get(r.path);
  return claim && claim.size === 1 && claim.has(t) ? m : { ...m, repo: `${REFUSED_REPO}${m.repo}` };
}

/** The repos root each db's milestones resolve under (set by createApp and the read-model worker). */
const scopes = new WeakMap<object, string>();
export function configureRepoScope(db: DB, reposRoot: string): void {
  scopes.set(db, reposRoot);
}
export const repoScopeOf = (db: DB): string | undefined => scopes.get(db);
