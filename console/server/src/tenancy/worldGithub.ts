import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Context, Hono, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { DB } from "../db.js";
import { DEFAULT_TENANT } from "../db.js";
import { resetRepoScans } from "../adapters/repos.js";
import { ConnectError, connectedRepo, connectWorldRepo, defaultGit, ensureWorldRepos, repoSlug, ROOT_SPINE, spineTitle, type Git } from "./worldRepo.js";

/**
 * The owner, 2026-11-18 ("I need to connect it to GitHub, you know, authorize it in GitHub
 * ... I need a button that allows me to say I give permission to this app to read and write on this repo. This is part
 * of the onboarding for creating a workspace ... selecting an existing repo where I have a workspace or creating a new
 * repo in GitHub").
 *
 * A customer workspace's owner presses Connect GitHub (Home, and Settings, Connections). GitHub's own page asks them to
 * allow EpicTeam to read and write their repos (the product's GitHub sign-in app, scope `repo`); back here they pick ONE
 * repo, and the workspace reads and writes only that one:
 *   - a repo they already have: one that already holds a workspace (a root spine) loads its goals and key results as
 *     they are (tenancy/worldRepo.ts, the owner's GitHub grant in place of iteration 5's one-time code);
 *   - a new repo: made private in their GitHub account, the workspace's own starter (its Get set up) pushed into it.
 * GitHub must say this person may write the repo; nothing is connected for them, they press each button.
 *
 * The grant is kept in the console's root-only key store (one key per workspace, never in the database, never shown);
 * the workspace's checkout signs in to GitHub with it (a credential helper in that checkout only). They take it back in
 * GitHub, Settings, Applications.
 *
 *   GET  /api/tenants/:id/github            { available, connected, login?, repo?, made?, startUrl }
 *   GET  /api/tenants/:id/github/start      to GitHub's page (the owner's login only)
 *   GET  /api/access/oauth/github/callback  GitHub's answer (the sign-in app's one callback; ours by its state, else sign-in's)
 *   GET  /api/tenants/:id/github/repos      the repos this person may write, newest first
 *   GET  /api/tenants/:id/github/check?repo=owner/name   { repo, workspace, title? }: does it already hold a workspace
 *   POST /api/tenants/:id/github/repo       { repo }  point the workspace at it (owner only)
 *   POST /api/tenants/:id/github/repo/new   { name }  make it and push the starter (owner only)
 */

const STATE_COOKIE = "gh_connect_state";
const STATE_MS = 10 * 60_000;
const GH = "https://api.github.com";
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
type Row = Record<string, any>;

export interface GithubDeps {
  db: DB;
  reposRoot: string;
  worldOf: () => string | undefined;
  /** the product's GitHub sign-in app (auth/oauth.ts storeCreds) */
  creds: () => Promise<{ clientId: string; clientSecret: string; callbackHost?: string } | undefined>;
  /** keep one key in the console's root-only store; unset = this console keeps no grant (Connect GitHub is not offered) */
  storeKey?: (name: string, value: string, note: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** read one key back by name */
  readKey?: (name: string) => Promise<string | undefined>;
  /** the store file of a key (the checkout's credential helper reads it); unset = no helper is written */
  keyFile?: (name: string) => string;
  fetch?: typeof fetch;
  git?: Git;
  cloneUrl?: (slug: string) => string;
  now?: () => Date;
  /** this request's host and whether it is https (default: the forwarded headers) */
  origin?: (c: Context) => string;
}

export const githubKeyName = (world: string) => `GITHUB_CONNECT_${world.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

export function ensureWorldGithub(db: DB): void {
  ensureWorldRepos(db);
  db.exec(`CREATE TABLE IF NOT EXISTS world_github (world TEXT PRIMARY KEY, login TEXT NOT NULL, at TEXT NOT NULL)`);
}

/** who connected GitHub for this workspace, when; undefined when nobody has. */
export function githubOf(db: DB, world: string | undefined): { login: string; at: string } | undefined {
  if (!world || world === DEFAULT_TENANT) return undefined;
  try {
    return db.prepare("SELECT login, at FROM world_github WHERE world = ?").get(world) as { login: string; at: string } | undefined;
  } catch {
    return undefined;
  }
}

/** git signs in to github.com with this grant for one command (env only: never an argument, never written). */
export const gitEnvFor = (token: string): Record<string, string> => ({
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "credential.helper",
  GIT_CONFIG_VALUE_0: "",
  GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
  GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
});

export function mountWorldGithub(api: Hono, d: GithubDeps) {
  const { db } = d;
  ensureWorldGithub(db);
  const http = d.fetch ?? fetch;
  const git = d.git ?? defaultGit;
  const now = d.now ?? (() => new Date());
  const states = new Map<string, { world: string; host: string; next: string; exp: number }>();
  const origin =
    d.origin ??
    ((c: Context) => {
      const host = (c.req.header("x-forwarded-host") ?? c.req.header("host") ?? "").split(",")[0].trim().toLowerCase();
      const proto = (c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "")).split(",")[0].trim() === "https" ? "https" : "http";
      return `${proto}://${host}`;
    });
  const mine = (id: string) => {
    const w = d.worldOf();
    if (!w || w !== id || w === DEFAULT_TENANT) throw new ConnectError(404, "not_found", `no workspace ${id} here`);
    const t = db.prepare("SELECT skin FROM tenants WHERE id = ?").get(w) as { skin?: string } | undefined;
    if (!t) throw new ConnectError(404, "not_found", `no workspace ${id} here`);
    if (t.skin === "social") throw new ConnectError(400, "not_a_team_workspace", "a campaigns workspace keeps its campaigns; repos connect to team workspaces");
    return w;
  };
  const fail = (c: Context, e: unknown) =>
    e instanceof ConnectError ? c.json({ error: { code: e.code, message: e.message } }, e.status) : c.json({ error: { code: "github_failed", message: (e as Error).message } }, 500);
  const available = async () => !!d.storeKey && !!d.readKey && !!(await d.creds().catch(() => undefined));
  const tokenOf = async (world: string) => {
    const t = githubOf(db, world) ? (await d.readKey?.(githubKeyName(world)).catch(() => undefined))?.trim() : undefined;
    if (!t) throw new ConnectError(409, "github_not_connected", "connect GitHub first");
    return t;
  };
  /** one GitHub API call, its answer always read to the end (an unread body crashed the console once, 18 Nov). */
  const gh = async (token: string, method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> => {
    let r: Response;
    try {
      r = await http(url.startsWith("http") ? url : `${GH}${url}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "epicteam-console", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new ConnectError(502, "github_down", "GitHub did not answer; try again in a minute");
    }
    const text = await r.text().catch(() => "");
    let json: any = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* not JSON: the status says enough */
    }
    if (r.status === 401) throw new ConnectError(409, "github_not_connected", "GitHub no longer accepts this connection; press Connect GitHub again");
    return { status: r.status, json };
  };
  const back = (c: Context, next: string, code: string) => c.redirect(`${next}${next.includes("?") ? "&" : "?"}github=${encodeURIComponent(code)}`, 302);
  const safeNext = (v: string | undefined) => (v === "/connections" ? v : "/");

  api.get("/tenants/:id/github", async (c) => {
    try {
      const w = mine(c.req.param("id")!);
      const g = githubOf(db, w);
      const r = connectedRepo(db, w);
      return c.json({
        available: await available(),
        connected: !!g,
        ...(g ? { login: g.login, at: g.at } : {}),
        ...(r ? { repo: r.repo, repoAt: r.connectedAt, ...(r.made ? { made: true } : {}) } : {}),
        startUrl: `/api/tenants/${encodeURIComponent(w)}/github/start`,
      });
    } catch (e) {
      return fail(c, e);
    }
  });

  api.get("/tenants/:id/github/start", async (c) => {
    const next = safeNext(c.req.query("next"));
    try {
      const w = mine(c.req.param("id")!);
      const k = (await available()) ? await d.creds() : undefined;
      if (!k) return back(c, next, "unavailable");
      for (const [key, v] of states) if (v.exp < now().getTime()) states.delete(key);
      if (states.size > 5000) states.clear();
      const state = crypto.randomBytes(32).toString("base64url");
      const o = origin(c);
      states.set(sha256(state), { world: w, host: o, next, exp: now().getTime() + STATE_MS });
      setCookie(c, STATE_COOKIE, state, { httpOnly: true, sameSite: "Lax", path: "/api/access/oauth", secure: o.startsWith("https:"), maxAge: STATE_MS / 1000 });
      const redirect = `${k.callbackHost ? `https://${k.callbackHost}` : o}/api/access/oauth/github/callback`;
      // `repo`: read and write the person's repos (GitHub's own page says so); the workspace then uses the one they pick
      const q = new URLSearchParams({ client_id: k.clientId, redirect_uri: redirect, scope: "repo", state, allow_signup: "false" });
      return c.redirect(`https://github.com/login/oauth/authorize?${q}`, 302);
    } catch (e) {
      return e instanceof ConnectError ? back(c, next, e.code) : fail(c, e);
    }
  });

  // GitHub's one callback for the sign-in app: ours when the state is one this module made, else sign-in's (auth/oauth.ts)
  api.get("/access/oauth/github/callback", async (c, next: Next) => {
    const state = c.req.query("state") ?? "";
    const st = state ? states.get(sha256(state)) : undefined;
    if (!st) return next();
    states.delete(sha256(state));
    const cookie = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/api/access/oauth" });
    if (st.exp < now().getTime() || cookie !== state || st.host !== origin(c)) return back(c, st.next, "expired");
    const code = c.req.query("code") ?? "";
    if (c.req.query("error") || !code) return back(c, st.next, "cancelled");
    try {
      const k = await d.creds();
      if (!k || !d.storeKey) return back(c, st.next, "unavailable");
      const tr = await http("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "epicteam-console" },
        body: new URLSearchParams({ code, client_id: k.clientId, client_secret: k.clientSecret }),
        signal: AbortSignal.timeout(20_000),
      });
      const tok = (JSON.parse((await tr.text().catch(() => "")) || "{}") ?? {}) as { access_token?: string; scope?: string };
      if (!tok.access_token) return back(c, st.next, "refused");
      if (!String(tok.scope ?? "").split(/[,\s]+/).includes("repo")) return back(c, st.next, "no_repo_permission");
      const u = await gh(tok.access_token, "GET", "/user");
      const login = String(u.json?.login ?? "");
      if (u.status !== 200 || !login) return back(c, st.next, "refused");
      const saved = await d.storeKey(githubKeyName(st.world), tok.access_token, `GitHub connection of workspace ${st.world}, allowed by ${login}`);
      if (!saved.ok) {
        console.error(`github connect ${st.world}: not stored: ${saved.message}`);
        return back(c, st.next, "not_stored");
      }
      db.prepare("INSERT INTO world_github (world, login, at) VALUES (?, ?, ?) ON CONFLICT(world) DO UPDATE SET login = excluded.login, at = excluded.at").run(st.world, login, now().toISOString());
      console.log(`github connect ${st.world}: allowed by ${login} (key name only: ${githubKeyName(st.world)})`);
      return back(c, st.next, "connected");
    } catch (e) {
      console.error(`github connect ${st.world}: ${(e as Error).message}`);
      return back(c, st.next, "github_down");
    }
  });

  api.get("/tenants/:id/github/repos", async (c) => {
    try {
      const w = mine(c.req.param("id")!);
      const token = await tokenOf(w);
      const repos: { repo: string; private: boolean; pushedAt?: string }[] = [];
      for (let page = 1; page <= 3; page++) {
        const r = await gh(token, "GET", `/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=${page}`);
        if (r.status !== 200 || !Array.isArray(r.json)) throw new ConnectError(502, "github_down", "GitHub did not list your repos; try again in a minute");
        for (const x of r.json as Row[]) if (x?.permissions?.push && !x.archived && typeof x.full_name === "string") repos.push({ repo: x.full_name, private: !!x.private, ...(x.pushed_at ? { pushedAt: String(x.pushed_at) } : {}) });
        if (r.json.length < 100) break;
      }
      return c.json({ login: githubOf(db, w)!.login, repos });
    } catch (e) {
      return fail(c, e);
    }
  });

  /** GitHub's word on one repo for this person: it exists for them and they may write it. */
  const writable = async (token: string, repoIn: string) => {
    const slug = repoSlug(repoIn);
    if (!slug) throw new ConnectError(400, "bad_repo", "pick a repo from the list");
    const r = await gh(token, "GET", `/repos/${slug}`);
    if (r.status !== 200) throw new ConnectError(404, "repo_not_found", "GitHub does not show you that repo");
    if (!r.json?.permissions?.push) throw new ConnectError(403, "repo_read_only", "you can read that repo but not write it; pick one you can write");
    return slug;
  };

  api.get("/tenants/:id/github/check", async (c) => {
    try {
      const w = mine(c.req.param("id")!);
      const token = await tokenOf(w);
      const slug = await writable(token, c.req.query("repo") ?? "");
      const f = await gh(token, "GET", `/repos/${slug}/contents/${ROOT_SPINE}`);
      let title: string | undefined;
      if (f.status === 200 && typeof f.json?.content === "string") title = spineTitle(Buffer.from(f.json.content, "base64").toString("utf8"));
      return c.json({ repo: slug, workspace: f.status === 200, ...(title ? { title } : {}) });
    } catch (e) {
      return fail(c, e);
    }
  });

  /** from now on this checkout signs in to GitHub with the workspace's own grant (read from the root-only store each time). */
  const helperInto = async (dir: string, world: string) => {
    if (!d.keyFile) return;
    const file = d.keyFile(githubKeyName(world));
    if (!/^[\w./-]+$/.test(file)) return;
    await git(dir, ["config", "--local", "--replace-all", "credential.https://github.com.helper", ""], 30_000);
    await git(dir, ["config", "--local", "--add", "credential.https://github.com.helper", `!f() { test "$1" = get && printf 'username=x-access-token\\npassword=%s\\n' "$(sudo -n cat ${file})"; }; f`], 30_000);
  };

  api.post("/tenants/:id/github/repo", async (c) => {
    try {
      const w = mine(c.req.param("id")!);
      const b = (await c.req.json().catch(() => ({}))) as { repo?: unknown };
      if (typeof b.repo !== "string") throw new ConnectError(400, "bad_body", "send the repo (owner/name)");
      const token = await tokenOf(w);
      const slug = await writable(token, b.repo);
      const r = await connectWorldRepo({ db, reposRoot: d.reposRoot, git, ...(d.cloneUrl ? { cloneUrl: d.cloneUrl } : {}), now }, w, slug, { github: true, gitEnv: gitEnvFor(token) });
      await helperInto(r.dir, w);
      return c.json({ connected: true, repo: r.repo, connectedAt: r.connectedAt, project: r.project, workspace: fs.existsSync(path.join(r.dir, ROOT_SPINE)) }, 200);
    } catch (e) {
      return fail(c, e);
    }
  });

  api.post("/tenants/:id/github/repo/new", async (c) => {
    try {
      const w = mine(c.req.param("id")!);
      const b = (await c.req.json().catch(() => ({}))) as { name?: unknown };
      const name = typeof b.name === "string" ? b.name.trim() : "";
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,98}$/.test(name) || name.endsWith(".git")) throw new ConnectError(400, "bad_name", "name the repo with letters, numbers, dashes or dots");
      const had = connectedRepo(db, w);
      if (had) throw new ConnectError(409, "already_connected", `this workspace already points at ${had.repo}`);
      const token = await tokenOf(w);
      const dir = path.join(d.reposRoot, w);
      // the workspace's own starter (what its payment made): it becomes the new repo's first commit
      if (!fs.existsSync(path.join(dir, ".git"))) throw new ConnectError(409, "no_starter", "this workspace has no repo of its own yet; pay for it first, or pick a repo you already have");
      if ((await git(dir, ["remote"], 30_000)).stdout.trim()) throw new ConnectError(409, "repo_has_remote", "this workspace's repo already lives somewhere else");
      const made = await gh(token, "POST", "/user/repos", { name, private: true, description: "My EpicTeam workspace: goals, key results and my team's work", auto_init: false });
      if (made.status === 422) throw new ConnectError(409, "name_taken", `you already have a repo called ${name}; pick another name, or pick that repo from the list`);
      const slug = made.status === 201 ? repoSlug(String(made.json?.full_name ?? "")) : undefined;
      if (!slug) throw new ConnectError(502, "create_failed", `GitHub did not make the repo: ${String(made.json?.message ?? made.status).slice(0, 120)}`);
      const url = (d.cloneUrl ?? ((s: string) => `https://github.com/${s}.git`))(slug);
      const add = await git(dir, ["remote", "add", "origin", url], 30_000);
      const push = add.code === 0 ? await git(dir, ["push", "-q", "-u", "origin", "HEAD:refs/heads/main"], 120_000, gitEnvFor(token)) : add;
      if (push.code !== 0) {
        await git(dir, ["remote", "remove", "origin"], 30_000);
        throw new ConnectError(502, "push_failed", `the repo was made (${slug}) but your workspace could not be pushed into it: ${(push.stderr || push.stdout).trim().split("\n").pop() || "git push failed"}. Delete it on GitHub, then try again.`);
      }
      const at = now().toISOString();
      db.prepare("INSERT INTO world_repos (world, repo, dir, connected_at, starter_moved_to, made) VALUES (?, ?, ?, ?, NULL, 1)").run(w, slug, dir, at);
      await helperInto(dir, w);
      resetRepoScans();
      return c.json({ connected: true, repo: slug, connectedAt: at, made: true, url: `https://github.com/${slug}` }, 200);
    } catch (e) {
      return fail(c, e);
    }
  });
}
