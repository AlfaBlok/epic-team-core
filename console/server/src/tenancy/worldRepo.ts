import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type { Hono } from "hono";
import type { DB } from "../db.js";
import { DEFAULT_TENANT } from "../db.js";
import { forTenant } from "../store.js";
import { resetRepoScans, resolveRepo } from "../adapters/repos.js";

/**
 * The owner opens a new account and points it at the repo that already holds the workspace: a customer workspace
 * points at a repo that already holds a workspace (its spines, objectives and key results), instead of the empty starter
 * repo a paid workspace gets.
 *
 * Which repo a workspace may point at is the platform's call, never the customer's alone: the platform makes a one-time
 * connect code for one repo (`console-admin.ts repo-code make <owner/name>`, 7 days, stored as a hash), the workspace's
 * owner types the repo and the code on Home, and the console clones that repo as the workspace's own checkout
 * (`<reposRoot>/<world>`, the one place a world's repo may live, repoScope.ts). One code, one workspace, one repo: a code
 * never connects another repo, a used code never connects again. The starter repo a payment made (one commit, no remote)
 * is moved aside, never deleted.
 *
 * Once connected, the workspace's first project is the repo's root spine (its own title), the "Get set up" starter
 * objective never touches it (firstObjective.ts), and its objectives and key results are the repo's own
 * docs/pursuits.json, read from the workspace's checkout only (`worldRepoDir`): a name in that file that is the same
 * GitHub repo reads the workspace's checkout, any other repo reads nothing.
 */

export const ROOT_SPINE = "docs/spines/root.md";
const CODE_DAYS = 7;
const sha = (s: string) => crypto.createHash("sha256").update(s.trim()).digest("hex");

export function ensureWorldRepos(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS repo_connect_codes (
    code_hash TEXT PRIMARY KEY, repo TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', made_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    used_world TEXT, used_at TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS world_repos (
    world TEXT PRIMARY KEY, repo TEXT NOT NULL, dir TEXT NOT NULL, connected_at TEXT NOT NULL, starter_moved_to TEXT)`);
}

/** `owner/name` of a GitHub repo, lower-cased; undefined when it is not one. */
export function repoSlug(s: string): string | undefined {
  const t = s
    .trim()
    .replace(/^(https?:\/\/|git@)github\.com[/:]/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  return /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(t) && !t.split("/").some((p) => p === "." || p === "..") ? t.toLowerCase() : undefined;
}

/** a one-time code that lets one workspace connect this repo (shown once, stored as a hash). */
export function makeConnectCode(db: DB, repo: string, note = "", now = new Date(), days = CODE_DAYS): string {
  ensureWorldRepos(db);
  const slug = repoSlug(repo);
  if (!slug) throw new Error(`not a GitHub repo: ${repo}`);
  const words = crypto.randomBytes(9).toString("base64url").toUpperCase().replace(/[^A-Z0-9]/g, "X");
  const code = `${words.slice(0, 4)}-${words.slice(4, 8)}-${words.slice(8, 12)}`;
  db.prepare("INSERT INTO repo_connect_codes (code_hash, repo, note, made_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(
    sha(code),
    slug,
    note.slice(0, 200),
    now.toISOString(),
    new Date(now.getTime() + days * 86_400_000).toISOString(),
  );
  return code;
}

export interface WorldRepo {
  world: string;
  repo: string;
  dir: string;
  connectedAt: string;
}

export function connectedRepo(db: DB, world: string | undefined): WorldRepo | undefined {
  if (!world || world === DEFAULT_TENANT) return undefined;
  try {
    const r = db.prepare("SELECT world, repo, dir, connected_at FROM world_repos WHERE world = ?").get(world) as { world: string; repo: string; dir: string; connected_at: string } | undefined;
    return r ? { world: r.world, repo: r.repo, dir: r.dir, connectedAt: r.connected_at } : undefined;
  } catch {
    return undefined; // no table yet: nothing connected
  }
}

const originMemo = new Map<string, string | undefined>();
function originSlug(dir: string): string | undefined {
  if (originMemo.has(dir)) return originMemo.get(dir);
  let v: string | undefined;
  try {
    const cfg = fs.readFileSync(path.join(dir, ".git", "config"), "utf8");
    const m = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(cfg);
    v = m ? repoSlug(m[1]) : undefined;
  } catch {
    v = undefined;
  }
  originMemo.set(dir, v);
  return v;
}
const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a === b;

/**
 * where a connected workspace reads a repo it is named by: its own checkout for its own name and for any name that is
 * the same GitHub repo (a home checkout whose origin is that repo, or the slug itself); nothing for any other repo.
 */
export function worldRepoDir(reposRoot: string, db: DB, world: string): (name: string) => string | undefined {
  const c = connectedRepo(db, world);
  return (name: string) => {
    if (!c || !name) return undefined;
    if (name === world || same(repoSlug(name), c.repo)) return c.dir;
    const local = resolveRepo(reposRoot, name);
    return local && same(originSlug(local.path), c.repo) ? c.dir : undefined;
  };
}

type Git = (cwd: string, args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>;
const defaultGit: Git = (cwd, args, timeoutMs = 600_000) =>
  new Promise((resolve) =>
    execFile("git", args, { cwd, timeout: timeoutMs, maxBuffer: 8 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (e, stdout, stderr) =>
      resolve({ code: e ? (typeof (e as { code?: unknown }).code === "number" ? ((e as { code: number }).code as number) : 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    ),
  );

export class ConnectError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 502,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ConnectDeps {
  db: DB;
  reposRoot: string;
  git?: Git;
  /** where the repo is cloned from (tests: a local bare repo). */
  cloneUrl?: (slug: string) => string;
  now?: () => Date;
}

/** the H1 of a spine, without its `EPIC-n:` code; undefined when none. */
export function spineTitle(text: string): string | undefined {
  const h = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
  return h ? h.replace(/^EPIC-[\w-]+:\s*/i, "").slice(0, 120) : undefined;
}

export async function connectWorldRepo(d: ConnectDeps, world: string, repoIn: string, codeIn: string): Promise<WorldRepo & { project: { id: string; title: string; state: "done" | "exists" }; starterMovedTo?: string }> {
  const { db, reposRoot } = d;
  const git = d.git ?? defaultGit;
  const now = d.now ?? (() => new Date());
  ensureWorldRepos(db);
  if (!world || world === DEFAULT_TENANT || !/^[a-z0-9][a-z0-9-]{1,80}$/.test(world)) throw new ConnectError(400, "not_a_workspace", "only a customer workspace connects a repo");
  const t = db.prepare("SELECT skin FROM tenants WHERE id = ?").get(world) as { skin?: string } | undefined;
  if (!t) throw new ConnectError(404, "not_found", `no workspace ${world}`);
  if (t.skin === "social") throw new ConnectError(400, "not_a_team_workspace", "a campaigns workspace keeps its campaigns; repos connect to team workspaces");
  const slug = repoSlug(repoIn);
  if (!slug) throw new ConnectError(400, "bad_repo", "type the repo as owner/name, like owner/name");
  const had = connectedRepo(db, world);
  if (had) {
    if (same(had.repo, slug)) return { ...had, project: ensureProject(db, world, had.dir), };
    throw new ConnectError(409, "already_connected", `this workspace already points at ${had.repo}`);
  }
  const row = db.prepare("SELECT * FROM repo_connect_codes WHERE code_hash = ?").get(sha(codeIn.toUpperCase())) as
    | { repo: string; expires_at: string; used_world: string | null }
    | undefined;
  if (!row || !same(row.repo, slug)) throw new ConnectError(403, "bad_code", "that code does not open this repo; check both and try again");
  if (row.used_world && row.used_world !== world) throw new ConnectError(403, "code_used", "that code was already used by another workspace");
  if (row.expires_at < now().toISOString()) throw new ConnectError(403, "code_expired", "that code has expired; ask the team for a new one");
  const dir = path.join(reposRoot, world);
  let starterMovedTo: string | undefined;
  if (fs.existsSync(path.join(dir, ".git"))) {
    // only the starter a payment made may be moved aside: one commit, no remote. Anything else is someone's work.
    const n = await git(dir, ["rev-list", "--count", "HEAD"], 30_000);
    const remotes = await git(dir, ["remote"], 30_000);
    if (n.code !== 0 || n.stdout.trim() !== "1" || remotes.stdout.trim()) throw new ConnectError(409, "repo_has_work", "this workspace's repo already holds work; it was not replaced");
    starterMovedTo = path.join(reposRoot, `.${world}-starter-${now().toISOString().replace(/[:.]/g, "").slice(0, 15)}`);
    fs.renameSync(dir, starterMovedTo);
  } else if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new ConnectError(409, "repo_taken", `${dir} exists and is not a checkout`);
  // share objects with a checkout of the same repo already here (copied, not linked: --dissociate), else a plain clone
  const near = fs
    .readdirSync(reposRoot)
    .filter((n) => !n.startsWith("."))
    .map((n) => path.join(reposRoot, n))
    .find((p) => fs.existsSync(path.join(p, ".git", "config")) && same(originSlug(p), slug));
  const url = (d.cloneUrl ?? ((s: string) => `https://github.com/${s}.git`))(slug);
  const args = ["clone", "-q", ...(near ? ["--reference-if-able", near, "--dissociate"] : []), url, dir];
  const cl = await git(reposRoot, args);
  if (cl.code !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    if (starterMovedTo) fs.renameSync(starterMovedTo, dir);
    throw new ConnectError(502, "clone_failed", `the repo could not be read: ${(cl.stderr || cl.stdout).trim().split("\n").pop() || "git clone failed"}`);
  }
  originMemo.delete(dir);
  const at = now().toISOString();
  db.transaction(() => {
    db.prepare("INSERT INTO world_repos (world, repo, dir, connected_at, starter_moved_to) VALUES (?, ?, ?, ?, ?)").run(world, slug, dir, at, starterMovedTo ?? null);
    db.prepare("UPDATE repo_connect_codes SET used_world = ?, used_at = ? WHERE code_hash = ?").run(world, at, sha(codeIn.toUpperCase()));
  })();
  resetRepoScans();
  return { world, repo: slug, dir, connectedAt: at, project: ensureProject(db, world, dir), ...(starterMovedTo ? { starterMovedTo } : {}) };
}

/** the workspace's first project is the repo's root spine, under its own title (a starter "Get set up" project takes it). */
function ensureProject(db: DB, world: string, dir: string): { id: string; title: string; state: "done" | "exists" } {
  const ts = forTenant(db, world);
  let text = "";
  try {
    text = fs.readFileSync(path.join(dir, ROOT_SPINE), "utf8");
  } catch {
    /* a repo with no root spine: the project still points there, the team writes it */
  }
  const title = spineTitle(text) ?? "Root";
  const m = ts.listMilestones({ includeSettled: true }).find((x) => x.repo === world && x.path === ROOT_SPINE);
  if (m) {
    if (m.title !== title) ts.updateMilestone(m.id, { title });
    return { id: m.id, title, state: "exists" };
  }
  const who = db.prepare("SELECT owner_name, owner_handle FROM tenants WHERE id = ?").get(world) as { owner_name?: string; owner_handle?: string } | undefined;
  const made = ts.createMilestone({ title, repo: world, path: ROOT_SPINE, owner: String(who?.owner_name || who?.owner_handle || ""), paused: false });
  return { id: made.id, title, state: "done" };
}

/**
 *   GET  /api/tenants/:id/repo           { connected: false } | { connected: true, repo, connectedAt }
 *   POST /api/tenants/:id/repo/connect   { repo: "owner/name", code }  the workspace's owner points it at that repo
 * routeScope: both world-safe, the POST owner only (an owner login, never an agent token).
 */
export function mountWorldRepo(api: Hono, d: ConnectDeps & { worldOf: () => string | undefined }) {
  ensureWorldRepos(d.db);
  const mine = (id: string) => {
    const w = d.worldOf();
    if (!w || w !== id) throw new ConnectError(404, "not_found", `no workspace ${id} here`);
    return w;
  };
  const fail = (c: { json: (b: unknown, s: number) => Response }, e: unknown) =>
    e instanceof ConnectError ? c.json({ error: { code: e.code, message: e.message } }, e.status) : c.json({ error: { code: "connect_failed", message: (e as Error).message } }, 500);
  api.get("/tenants/:id/repo", (c) => {
    try {
      const w = mine(c.req.param("id")!);
      const r = connectedRepo(d.db, w);
      return c.json(r ? { connected: true, repo: r.repo, connectedAt: r.connectedAt } : { connected: false });
    } catch (e) {
      return fail(c, e);
    }
  });
  api.post("/tenants/:id/repo/connect", async (c) => {
    try {
      const w = mine(c.req.param("id")!);
      const b = (await c.req.json().catch(() => ({}))) as { repo?: unknown; code?: unknown };
      if (typeof b.repo !== "string" || typeof b.code !== "string" || !b.code.trim()) throw new ConnectError(400, "bad_body", "send the repo (owner/name) and the code");
      const r = await connectWorldRepo(d, w, b.repo, b.code);
      return c.json({ connected: true, repo: r.repo, connectedAt: r.connectedAt, project: r.project }, 200);
    } catch (e) {
      return fail(c, e);
    }
  });
}
