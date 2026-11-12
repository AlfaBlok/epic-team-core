import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Context, Hono } from "hono";
import { resolveRepo } from "./adapters/repos.js";
import type { SpineWriter } from "./inbox/spineWrite.js";
import { currentAuth } from "./auth/identity.js";
import { DEFAULT_TENANT } from "./db.js";
import { hasOwnerPower } from "./auth/owner.js";
import { notJordi } from "./status/mark.js";
import { gitRunner, pushCheckout, type GitRunner, type PushResult } from "./gitPush.js";
import type { Milestone, Persona } from "./store.js";
import { type HostId, homeOrg, homeRepo, homeWorld, mainHost, ownerName, workerHost } from "./identity.js";

/**
 * the team skills library in the console. The source of truth is the code repo
 * `skills/team-skills.json`; `skills/team-skills.py` installs it on every seat (`sync`, a 10-min timer on the main server
 * and the worker server) and reports drift (`check`). The console:
 *  - lists the library with who uses each skill (GET /api/team-skills; world-scoped used-by, TENANT_SAFE);
 *  - adds one by GitHub URL, pinned to its current commit, after a preview (`add --dry-run`), and removes one (only the owner:
 *    status/mark.ts notJordi; the home world only). The manifest edit is committed and pushed on the code repo main through the spine
 *    writer (same guards and lock as answers), then `sync` runs on the main server (the console host) and on the worker server over ssh;
 *  - feeds the wake: `## Skills` lines with each skill's use_when, and the wake check (a declared skill missing from the
 *    library, or not linked in every config dir of the persona's host, fails the wake with the reason).
 * skills per world. The team library is the base every world gets (read-only to a world other than
 * the home world: its personas attach or detach them). A world's owner adds its own skills (same preview, pinned) and removes them;
 * they live in the world's own repo, `skills/world-skills.json` (committed there, pushed per its Integration policy), never
 * in the team manifest. They reach only that world's wakes: at the wake the console runs `team-skills.py world-link` on the
 * persona's host, which links them into the checkout the wake runs in (`.claude/skills`, `.agents/skills`, git-excluded),
 * from a per-world cache; no shared seat dir is touched. A declared world skill that is not linked fails the wake check.
 */
export const MANIFEST = "skills/team-skills.json";
/** a world's own skills, in the world's repo. */
export const WORLD_MANIFEST = "skills/world-skills.json";
export const WORLD_SYNC_NOTE =
  "A skill you add lives in this world's repo (skills/world-skills.json) and only this world's personas get it: at each wake it is linked into the checkout they work in.";
export const CLI = "skills/team-skills.py";
/** What the screen says about seats once a change is pushed. */
export const syncNote = (): string =>
  `Adding or removing commits skills/team-skills.json on ${homeRepo()} main and syncs every seat on ${mainHost()} at once; ${workerHost()} syncs now when it is up, ` +
  "else its team-skills timer picks it up within 10 min of the repo sync.";

export interface SkillSource {
  type: "local" | "github";
  path?: string;
  repo?: string;
  commit?: string;
}
export interface TeamSkill {
  name: string;
  use_when: string;
  source: SkillSource;
}
export interface Manifest {
  version?: number;
  skills: TeamSkill[];
}

/** The the code repo checkout whose manifest the console reads and writes. */
export function libraryRepo(reposRoot: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.CONSOLE_TEAM_SKILLS_REPO || resolveRepo(reposRoot, homeRepo())?.path;
}

export function parseManifest(text: string): Manifest {
  const m = JSON.parse(text) as Manifest;
  if (!m || !Array.isArray(m.skills)) throw new Error("manifest has no skills list");
  return m;
}

/** The library, or throws with why it cannot be read. */
export function readLibrary(repoDir: string | undefined): TeamSkill[] {
  if (!repoDir) throw new Error(`no ${homeRepo()} checkout under the console's repos root`);
  let text: string;
  try {
    text = fs.readFileSync(path.join(repoDir, MANIFEST), "utf8");
  } catch {
    throw new Error(`${MANIFEST} not found in ${repoDir}`);
  }
  return parseManifest(text).skills;
}

/** the world's own skills ([] when it has none yet), or throws when the file is there but unreadable. */
export function readWorldSkills(repoDir: string | undefined): TeamSkill[] {
  if (!repoDir) return [];
  let text: string;
  try {
    text = fs.readFileSync(path.join(repoDir, WORLD_MANIFEST), "utf8");
  } catch {
    return [];
  }
  return parseManifest(text).skills;
}

/** Python's `json.dumps(m, indent=2)` (ensure_ascii), so a console write and a CLI write give the same bytes. */
export function serializeManifest(m: Manifest): string {
  const sorted = { ...m, skills: [...m.skills].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) };
  return JSON.stringify(sorted, null, 2).replace(/[\u0080-￿]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`) + "\n";
}

/** The manifest text with `entry` added (or replacing a same-name entry). */
export function addToManifest(text: string, entry: TeamSkill): string {
  const m = parseManifest(text);
  return serializeManifest({ ...m, skills: [...m.skills.filter((s) => s.name !== entry.name), entry] });
}

/** The manifest text without `name`, or undefined when it is not there. */
export function removeFromManifest(text: string, name: string): string | undefined {
  const m = parseManifest(text);
  if (!m.skills.some((s) => s.name === name)) return undefined;
  return serializeManifest({ ...m, skills: m.skills.filter((s) => s.name !== name) });
}

/** Where to read a skill: the pinned tree on GitHub, or ours in the code repo. */
export function sourceUrl(s: SkillSource, ownRepo = `${homeOrg()}/${homeRepo()}`): string | undefined {
  if (s.type === "github" && s.repo) return `https://github.com/${s.repo}/tree/${s.commit ?? "HEAD"}${s.path ? `/${s.path}` : ""}`;
  if (s.type === "local" && s.path) return `https://github.com/${ownRepo}/tree/main/${s.path}`;
  return undefined;
}

// ---------- the CLI ----------

export interface CliResult {
  code: number;
  json?: any;
  err?: string;
}
/** Runs `team-skills.py <args> --json` on a host (the main server = here, the console host; the worker server over ssh, its own checkout). */
export type CliRun = (host: HostId, args: string[]) => Promise<CliResult>;

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function cliRunner(o: { repoDir?: string; python?: string; worker?: { ssh: string; sshKey?: string; knownHosts: string }; remoteRepo?: string; timeoutMs?: number } = {}): CliRun {
  const timeout = o.timeoutMs ?? 120_000;
  const python = o.python ?? "python3";
  return (host, args) =>
    new Promise((resolve) => {
      const done = (e: (Error & { code?: unknown }) | null, stdout: string, stderr: string) => {
        let json: any;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* not JSON: err below */
        }
        const code = e ? (typeof e.code === "number" ? e.code : 2) : 0;
        const err = json?.error ?? (json ? undefined : (String(stderr).trim().split("\n").pop() || e?.message || "no output").slice(0, 300));
        resolve({ code, json, ...(err ? { err: String(err) } : {}) });
      };
      if (host === mainHost()) {
        if (!o.repoDir) return resolve({ code: 2, err: `no ${homeRepo()} checkout under the console's repos root` });
        execFile(python, [path.join(o.repoDir, CLI), ...args, "--json"], { timeout, maxBuffer: 4 << 20, encoding: "utf8", env: { ...process.env, TEAM_SKILLS_REPO: o.repoDir } }, done);
        return;
      }
      if (!o.worker) return resolve({ code: 2, err: `${workerHost()} ssh not configured (CONSOLE_VPS3_SSH unset)` });
      const repo = o.remoteRepo ?? `~/github/${homeRepo()}`;
      const cmd = args[0] === "sync" || args[0] === "world-link" ? `git -C ${repo} pull -q --ff-only >/dev/null 2>&1; ` : "";
      const sshArgs = [
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", `UserKnownHostsFile=${o.worker.knownHosts}`,
        ...(o.worker.sshKey ? ["-i", o.worker.sshKey] : []),
        o.worker.ssh,
        `${cmd}${python} ${repo}/${CLI} ${[...args, "--json"].map(shq).join(" ")}`,
      ];
      execFile("ssh", sshArgs, { timeout, maxBuffer: 4 << 20, encoding: "utf8" }, done);
    });
}

// ---------- the wake ----------

/** One `team-skills.py check --json` dir entry. */
interface CheckDir {
  dir: string;
  ok?: string[];
  missing?: string[];
  stale?: string[];
  conflict?: string[];
}

/**
 * Why the persona's declared skills do not hold on its host, or undefined when they do. A skill must be in the library
 * and present (ours, stale or someone else's entry with that name: not `missing`) in every config dir the check lists.
 * `check` undefined = the host check could not run: only the library is judged (the caller notes it).
 */
export function skillProblems(skills: string[], library: string[], check?: { dirs?: CheckDir[] }, host = "the host"): string | undefined {
  const lib = new Set(library);
  const notInLib = skills.filter((s) => !lib.has(s));
  const missing = new Map<string, string[]>();
  for (const d of check?.dirs ?? []) for (const s of d.missing ?? []) if (skills.includes(s)) missing.set(s, [...(missing.get(s) ?? []), d.dir]);
  const parts = [
    ...(notInLib.length ? [`${notInLib.join(", ")} ${notInLib.length > 1 ? "are" : "is"} not in the team skills library (add ${notInLib.length > 1 ? "them" : "it"} on Team skills, or take ${notInLib.length > 1 ? "them" : "it"} off the persona)`] : []),
    ...[...missing].map(([s, dirs]) => `${s} is not installed on ${host} (missing in ${dirs.join(", ")}; team-skills sync has not linked it yet)`),
  ];
  return parts.length ? parts.join("; ") : undefined;
}

export type WakeSkills =
  | { ok: true; use: Record<string, string>; note?: string; /** the declared skills that are the world's own */ world?: string[] }
  | { ok: false; reason: string };

/** the world of a milestone and its own skills (undefined for the home world, whose additions are the team library). */
export type WorldSkillsOf = (m: Milestone) => { world: string; skills: TeamSkill[]; error?: string } | undefined;
/** where the wake links the world's skills: the host the persona runs on and its checkout of the milestone repo. */
export interface WakeLink {
  host: HostId;
  checkout: () => Promise<string | undefined>;
}

/** `team-skills.py world-link` of one world into one checkout; undefined = linked, else why not. */
export async function linkWorld(cli: CliRun, host: HostId, world: string, dir: string, skills: TeamSkill[], need: string[] = skills.map((s) => s.name)): Promise<string | undefined> {
  const r = await cli(host, ["world-link", "--world", world, "--dest", dir, "--manifest-json", JSON.stringify({ version: 1, skills })]);
  if (!r.json?.ok) return `world-link on ${host} failed (${r.err ?? "no report"})`;
  const linked = new Set<string>(r.json.linked ?? []);
  const probs = new Map<string, string>(((r.json.problems ?? []) as { name: string; problem: string }[]).map((x) => [x.name, x.problem]));
  const off = need.filter((n) => !linked.has(n));
  return off.length ? off.map((n) => `${n} is not linked in ${dir} on ${host} (${probs.get(n) ?? "not linked"})`).join("; ") : undefined;
}

/**
 * The wake check of a persona with skills: library from the checkout, install state from `check --json` on its host
 * (cached `ttlMs` per host; exit 0 and 1 both carry the report). A host check that cannot run lets the wake go with a note.
 * a skill of the milestone's world counts as known; with `link` (the wake itself, its host up) the world's skills
 * are linked into the persona's checkout there first, and a declared one that could not be linked fails the wake.
 */
export function wakeSkillCheck(o: { repoDir?: string; cli: CliRun; ttlMs?: number; now?: () => number; worldSkills?: WorldSkillsOf }) {
  const ttl = o.ttlMs ?? 60_000;
  const now = o.now ?? Date.now;
  const cache = new Map<string, { at: number; r: CliResult }>();
  const hostCheck = async (host: HostId) => {
    const hit = cache.get(host);
    if (hit && now() - hit.at < ttl) return hit.r;
    const r = await o.cli(host, ["check"]);
    if (r.json?.ok) cache.set(host, { at: now(), r });
    return r;
  };
  return async (p: Pick<Persona, "name" | "skills" | "host">, w?: { milestone?: Milestone; link?: WakeLink }): Promise<WakeSkills> => {
    if (!p.skills.length) return { ok: true, use: {} };
    let lib: TeamSkill[];
    try {
      lib = readLibrary(o.repoDir);
    } catch (e) {
      return { ok: false, reason: `skill check: ${p.name} declares ${p.skills.join(", ")} but the team skills library cannot be read (${(e as Error).message})` };
    }
    const ws = w?.milestone ? o.worldSkills?.(w.milestone) : undefined;
    if (ws?.error) return { ok: false, reason: `skill check: ${ws.world}'s own skills cannot be read (${ws.error})` };
    const baseNames = new Set(lib.map((s) => s.name));
    const own = (ws?.skills ?? []).filter((s) => !baseNames.has(s.name));
    const mine = p.skills.filter((s) => own.some((x) => x.name === s));
    const r = await hostCheck(p.host);
    const check = r.json?.ok ? (r.json as { dirs?: CheckDir[] }) : undefined;
    const why = skillProblems(p.skills, [...baseNames, ...own.map((s) => s.name)], check, p.host);
    if (why) return { ok: false, reason: `skill check: ${why}` };
    if (mine.length && w?.link) {
      const dir = await w.link.checkout().catch(() => undefined);
      if (!dir) return { ok: false, reason: `skill check: ${mine.join(", ")} ${mine.length > 1 ? "are" : "is"} ${ws!.world}'s own and ${w.milestone!.repo} has no checkout on ${w.link.host} to link ${mine.length > 1 ? "them" : "it"} into` };
      const off = await linkWorld(o.cli, w.link.host, ws!.world, dir, own, mine);
      if (off) return { ok: false, reason: `skill check: ${off}` };
    }
    const use = Object.fromEntries([...lib, ...own].filter((s) => p.skills.includes(s.name)).map((s) => [s.name, s.use_when]));
    return {
      ok: true,
      use,
      ...(mine.length ? { world: mine } : {}),
      ...(check ? {} : { note: `could not check skills installed on ${p.host} (${r.err ?? "no report"}); the library has them` }),
    };
  };
}

// ---------- routes ----------

export interface TeamSkillsOptions {
  repoDir?: string;
  cli: CliRun;
  spine: SpineWriter;
  /** The caller's world's personas (used-by on the screen). */
  personas: () => Persona[];
  /** Every world's personas (remove: who still attaches it), and how to take a skill off one. */
  allPersonas: () => Persona[];
  /** through the persona's file first (async). */
  detach: (personaId: string, skills: string[]) => void | Promise<unknown>;
  /** Hosts `sync` runs on after a change (default the main server, the worker server). */
  syncHosts?: (HostId)[];
  /** the repo a world keeps its own skills in (its checkout on this host), and every checkout of its milestones here. */
  worldRepo?: (world: string) => string | undefined;
  worldCheckouts?: (world: string) => string[];
  git?: GitRunner;
}

/** the world of this request when it is not the home world (a world's login or token); undefined = the platform. */
export function callerWorld(): string | undefined {
  const i = currentAuth()?.identity;
  return i && "tenant" in i && i.tenant !== DEFAULT_TENANT ? i.tenant : undefined;
}

type WorldWrite = { status: "written"; sha: string; push: PushResult } | { status: "skipped" | "failed"; reason: string };

/** commit one edit of the world's skills/world-skills.json in its repo (one at a time per checkout), then push it. */
export function worldManifestWriter(git: GitRunner = gitRunner) {
  const locks = new Map<string, Promise<unknown>>();
  const serial = <T>(dir: string, fn: () => Promise<T>): Promise<T> => {
    const next = (locks.get(dir) ?? Promise.resolve()).then(fn, fn);
    const tail = next.catch(() => undefined);
    locks.set(dir, tail);
    return next;
  };
  const tail = (r: { stderr: string; stdout: string }) => (r.stderr || r.stdout).trim().split("\n").pop() ?? "";
  return (dir: string, make: (text: string | undefined) => { text: string; msg: string; body: string } | { skip: string }): Promise<WorldWrite> =>
    serial(dir, async () => {
      const abs = path.join(dir, WORLD_MANIFEST);
      const dirty = await git(dir, ["status", "--porcelain", "--", WORLD_MANIFEST]);
      if (dirty.code !== 0) return { status: "failed", reason: `git status: ${tail(dirty)}` };
      if (dirty.stdout.trim()) return { status: "skipped", reason: `${WORLD_MANIFEST} has uncommitted changes (a persona is writing it); try again in a moment` };
      const cur = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : undefined;
      const e = make(cur);
      if ("skip" in e) return { status: "skipped", reason: e.skip };
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, e.text);
      const env = { EPICSPINE_PERSONA: ownerName() };
      const add = await git(dir, ["add", "--", WORLD_MANIFEST]);
      const c = add.code === 0 ? await git(dir, ["commit", "-q", "-m", e.msg, "-m", e.body, "-m", `Persona: ${ownerName()}`, "--", WORLD_MANIFEST], env) : add;
      if (c.code !== 0) {
        await git(dir, ["reset", "-q", "--", WORLD_MANIFEST]);
        if (cur === undefined) fs.rmSync(abs, { force: true });
        else fs.writeFileSync(abs, cur);
        return { status: "failed", reason: `git ${add.code === 0 ? "commit" : "add"}: ${tail(c)}` };
      }
      const push = await pushCheckout(git, dir);
      const sha = (await git(dir, ["rev-parse", "--short=12", "HEAD"])).stdout.trim();
      return { status: "written", sha, push };
    });
}

const URL_OK = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\/.*)?$/;
const NAME_OK = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function mountTeamSkills(api: Hono, o: TeamSkillsOptions) {
  const err = (c: Context, status: 400 | 403 | 404 | 409 | 502 | 503, code: string, message: string, extra: Record<string, unknown> = {}) =>
    c.json({ error: { code, message, ...extra } }, status);
  /** Why this caller may not change the library: not the owner (mark.ts), or a login of another world (the library is the platform's). */
  const worldRefusal = () => {
    const i = currentAuth()?.identity;
    return i && "tenant" in i && i.tenant !== DEFAULT_TENANT ? `the library belongs to the platform (${homeWorld()})` : undefined;
  };
  const whyNot = (c: Context) => worldRefusal() ?? notJordi((n) => c.req.header(n));
  const refusal = (c: Context) => {
    const why = whyNot(c);
    return why ? err(c, 403, "jordi_only", `only ${ownerName()} adds or removes team skills, from the console page (${why})`) : undefined;
  };
  const usedBy = (ps: Persona[], name: string) => ps.filter((p) => p.skills.includes(name)).map((p) => ({ id: p.id, name: p.name }));
  const agentCall = (c: Context) => !!(c.req.header("authorization") || c.req.header("x-console-run") || c.req.header("x-run-id"));
  /** why this caller may not change its world's own skills (the world's owner, logged in; never an agent). */
  const worldOwnerRefusal = (c: Context, world: string) => {
    const a = currentAuth();
    if (agentCall(c) || (a && a.identity.kind === "token")) return "an agent cannot change the world's skills";
    if (a && !hasOwnerPower(a.identity, a.mode)) return "only the world's owner adds or removes its skills";
    if (!o.worldRepo?.(world)) return `${world} has no repo on the console host to keep its skills in`;
    return undefined;
  };
  const writeWorld = worldManifestWriter(o.git);
  /** link the world's skills again in its checkouts on the console host (other hosts: at the persona's next wake). */
  const relinkWorld = async (world: string) => {
    const skills = readWorldSkills(o.worldRepo?.(world));
    const dirs = o.worldCheckouts?.(world) ?? [];
    const out = await Promise.all(dirs.map(async (d) => ({ d, why: await linkWorld(o.cli, mainHost(), world, d, skills) })));
    const bad = out.filter((x) => x.why);
    return [
      bad.length
        ? { host: mainHost(), ok: false, note: bad.map((x) => x.why).join("; ") }
        : { host: mainHost(), ok: true, note: `linked in ${dirs.length} checkout${dirs.length === 1 ? "" : "s"} of this world` },
      { host: workerHost(), ok: true, note: "linked at the persona's next wake there" },
    ];
  };

  api.get("/team-skills", (c) => {
    const ps = o.personas();
    const world = callerWorld();
    let lib: TeamSkill[] = [];
    let own: TeamSkill[] = [];
    let error: string | undefined;
    try {
      lib = readLibrary(o.repoDir);
    } catch (e) {
      error = (e as Error).message;
    }
    if (world)
      try {
        own = readWorldSkills(o.worldRepo?.(world)).filter((s) => !lib.some((b) => b.name === s.name));
      } catch (e) {
        error ??= `${WORLD_MANIFEST} of ${world}: ${(e as Error).message}`;
      }
    const names = new Set([...lib, ...own].map((s) => s.name));
    // A GET carries no Origin and, over plain http (the tailnet URL), no Sec-Fetch-*: show the buttons to any non-agent caller;
    // the writes themselves are judged strictly (whyNot / worldOwnerRefusal).
    const editBase = !world && !agentCall(c);
    const editWorld = !!world && !worldOwnerRefusal(c, world);
    const row = (s: TeamSkill, scope: "base" | "world") => ({
      name: s.name,
      useWhen: s.use_when,
      source: s.source,
      url: sourceUrl(s.source),
      usedBy: usedBy(ps, s.name),
      scope,
      removable: scope === "base" ? editBase : editWorld,
    });
    const repoDir = world ? o.worldRepo?.(world) : undefined;
    return c.json({
      skills: [...lib.map((s) => row(s, "base")), ...own.map((s) => row(s, "world"))],
      // Skills a persona holds that the library does not have (free text from before): flagged, never dropped.
      unknown: error ? [] : ps.flatMap((p) => p.skills.filter((s) => !names.has(s)).map((skill) => ({ skill, persona: { id: p.id, name: p.name } }))),
      canEdit: world ? editWorld : editBase,
      syncNote: world ? WORLD_SYNC_NOTE : syncNote(),
      ...(world ? { world: { id: world, repo: repoDir ? path.basename(repoDir) : null } } : {}),
      ...(error ? { error } : {}),
    });
  });

  const addInput = async (c: Context) => {
    let b: any;
    try {
      b = await c.req.json();
    } catch {
      return "request body must be valid JSON";
    }
    const url = typeof b?.url === "string" ? b.url.trim() : "";
    if (!URL_OK.test(url)) return "url: a GitHub URL, https://github.com/<owner>/<repo>[/tree/<ref>/<path>]";
    const name = typeof b?.name === "string" && b.name.trim() ? b.name.trim().toLowerCase() : undefined;
    if (name && !NAME_OK.test(name)) return "name: lower-case letters, digits, . _ -";
    const useWhen = typeof b?.useWhen === "string" && b.useWhen.trim() ? b.useWhen.trim().replace(/\s+/g, " ").slice(0, 300) : undefined;
    const commit = typeof b?.commit === "string" && b.commit.trim() ? b.commit.trim() : undefined;
    return { url, name, useWhen, commit };
  };
  /** `world`: dry-run against the world's own manifest, else the team library. */
  const preview = (i: { url: string; name?: string; useWhen?: string }, world?: string) =>
    o.cli(mainHost(), [
      "add",
      i.url,
      "--dry-run",
      "--no-sync",
      ...(i.name ? ["--name", i.name] : []),
      ...(i.useWhen ? ["--use-when", i.useWhen] : []),
      ...(world ? ["--manifest", path.join(o.worldRepo!(world)!, WORLD_MANIFEST)] : []),
    ]);
  /** a world's refusal (not its owner) or a base skill's name (the world attaches that one, it does not add it). */
  const worldGate = (c: Context, world: string) => {
    const why = worldOwnerRefusal(c, world);
    return why ? err(c, 403, "owner_only", `only the world's owner adds or removes its own skills (${why})`) : undefined;
  };
  const baseClash = (c: Context, name: string) => {
    try {
      if (readLibrary(o.repoDir).some((s) => s.name === name))
        return err(c, 409, "base_skill", `${name} is already one of the team skills every world has: tick it on a persona instead`);
    } catch {
      /* no library: nothing to clash with */
    }
    return undefined;
  };

  api.post("/team-skills/preview", async (c) => {
    const world = callerWorld();
    const no = world ? worldGate(c, world) : refusal(c);
    if (no) return no;
    const i = await addInput(c);
    if (typeof i === "string") return err(c, 400, "validation_error", i);
    const r = await preview(i, world);
    if (world && r.json?.skill) {
      const clash = baseClash(c, (r.json.skill as TeamSkill).name);
      if (clash) return clash;
    }
    if (r.code !== 0 || !r.json?.skill) return err(c, r.code === 2 && r.json ? 400 : 502, "preview_failed", r.err ?? "team-skills add --dry-run gave no skill");
    const skill = r.json.skill as TeamSkill;
    return c.json({ skill, url: sourceUrl(skill.source), description: r.json.description ?? "", action: r.json.action, skillMdName: r.json.skill_md_name ?? null });
  });

  const syncAll = async () =>
    Promise.all(
      (o.syncHosts ?? [mainHost(), workerHost()]).map(async (host) => {
        const r = await o.cli(host, ["sync"]);
        return r.json?.ok
          ? { host, ok: true, note: r.json.green === false ? "synced with drift left (see team-skills check)" : "synced" }
          : { host, ok: false, note: host === workerHost() ? `not synced now (${r.err ?? "unreachable"}); its timer syncs it within 10 min` : `sync failed: ${r.err ?? "no report"}` };
      }),
    );

  api.post("/team-skills", async (c) => {
    const world = callerWorld();
    if (world) return addWorld(c, world);
    const no = refusal(c);
    if (no) return no;
    const i = await addInput(c);
    if (typeof i === "string") return err(c, 400, "validation_error", i);
    if (!o.repoDir) return err(c, 503, "unavailable", `no ${homeRepo()} checkout under the console's repos root: nothing added`);
    const r = await preview(i);
    if (r.code !== 0 || !r.json?.skill) return err(c, r.code === 2 && r.json ? 400 : 502, "add_failed", r.err ?? "team-skills add --dry-run gave no skill");
    const entry = r.json.skill as TeamSkill;
    if (i.commit && entry.source.commit && entry.source.commit !== i.commit)
      return err(c, 409, "moved", `the repo moved since the preview (${i.commit.slice(0, 12)} → ${entry.source.commit.slice(0, 12)}): preview again`);
    if (r.json.action === "unchanged") return c.json({ action: "unchanged", skill: entry });
    const w = await o.spine.edit({
      repoDir: o.repoDir,
      path: MANIFEST,
      label: `team skill ${entry.name}`,
      edit: (text) => {
        try {
          return {
            text: addToManifest(text, entry),
            msg: `Team skills: ${r.json.action === "repinned" ? "repin" : "add"} ${entry.name} @ ${(entry.source.commit ?? "").slice(0, 12)} (${ownerName()}, via console)`,
            body: `${ownerName()} ${r.json.action === "repinned" ? "repinned" : "added"} ${entry.name} on the console Team skills screen: ${entry.source.repo}${entry.source.path ? `/${entry.source.path}` : ""} pinned to ${entry.source.commit}.\n\nUse when: ${entry.use_when}`,
          };
        } catch (e) {
          return { skip: `${MANIFEST} is not readable: ${(e as Error).message}` };
        }
      },
    });
    if (w.status !== "written") return err(c, w.status === "failed" ? 502 : 409, w.status === "failed" ? "git_failed" : "conflict", `nothing added: ${w.reason ?? "the manifest could not be written"}`);
    return c.json({ action: r.json.action, skill: entry, sha: w.sha, sync: await syncAll(), syncNote: syncNote() }, 201);
  });

  /** a world's owner adds a skill to the world's own repo (pinned as previewed), then it is linked here. */
  const addWorld = async (c: Context, world: string) => {
    const no = worldGate(c, world);
    if (no) return no;
    const i = await addInput(c);
    if (typeof i === "string") return err(c, 400, "validation_error", i);
    const r = await preview(i, world);
    if (r.code !== 0 || !r.json?.skill) return err(c, r.code === 2 && r.json ? 400 : 502, "add_failed", r.err ?? "team-skills add --dry-run gave no skill");
    const entry = r.json.skill as TeamSkill;
    const clash = baseClash(c, entry.name);
    if (clash) return clash;
    if (i.commit && entry.source.commit && entry.source.commit !== i.commit)
      return err(c, 409, "moved", `the repo moved since the preview (${i.commit.slice(0, 12)} → ${entry.source.commit.slice(0, 12)}): preview again`);
    if (r.json.action === "unchanged") return c.json({ action: "unchanged", skill: entry });
    const dir = o.worldRepo!(world)!;
    const w = await writeWorld(dir, (text) => {
      try {
        return {
          text: addToManifest(text ?? serializeManifest({ version: 1, skills: [] }), entry),
          msg: `World skills: ${r.json.action === "repinned" ? "repin" : "add"} ${entry.name} @ ${(entry.source.commit ?? "").slice(0, 12)} (owner, via console)`,
          body: `The world's owner ${r.json.action === "repinned" ? "repinned" : "added"} ${entry.name} on the Team skills screen: ${entry.source.repo}${entry.source.path ? `/${entry.source.path}` : ""} pinned to ${entry.source.commit}. Only ${world}'s wakes get it.\n\nUse when: ${entry.use_when}`,
        };
      } catch (e) {
        return { skip: `${WORLD_MANIFEST} is not readable: ${(e as Error).message}` };
      }
    });
    if (w.status !== "written") return err(c, w.status === "failed" ? 502 : 409, w.status === "failed" ? "git_failed" : "conflict", `nothing added: ${w.reason}`);
    return c.json({ action: r.json.action, skill: entry, sha: w.sha, push: w.push.state, sync: await relinkWorld(world), syncNote: WORLD_SYNC_NOTE }, 201);
  };

  /** a world's owner removes one of its own skills (a base skill is only unticked on personas). */
  const removeWorld = async (c: Context, world: string, name: string) => {
    const no = worldGate(c, world);
    if (no) return no;
    const dir = o.worldRepo!(world)!;
    let own: TeamSkill[];
    try {
      own = readWorldSkills(dir);
    } catch (e) {
      return err(c, 503, "unavailable", (e as Error).message);
    }
    if (!own.some((s) => s.name === name)) {
      let base = false;
      try {
        base = readLibrary(o.repoDir).some((s) => s.name === name);
      } catch {
        /* no library */
      }
      return base
        ? err(c, 403, "base_skill", `${name} is one of the team skills every world has: it cannot be removed here, untick it on the personas that use it`)
        : err(c, 404, "not_found", `no skill named ${name} among ${world}'s own skills`);
    }
    const users = o.personas().filter((p) => p.skills.includes(name));
    const confirm = /^(1|true|yes)$/i.test(c.req.query("confirm") ?? "");
    if (users.length && !confirm)
      return err(c, 409, "in_use", `${name} is attached to ${users.map((p) => p.name).join(", ")}: confirm to remove it and take it off ${users.length > 1 ? "them" : "that persona"}`, {
        usedBy: users.map((p) => ({ id: p.id, name: p.name })),
      });
    const w = await writeWorld(dir, (text) => {
      let next: string | undefined;
      try {
        next = text === undefined ? undefined : removeFromManifest(text, name);
      } catch (e) {
        return { skip: `${WORLD_MANIFEST} is not readable: ${(e as Error).message}` };
      }
      return next === undefined
        ? { skip: `${name} is no longer in ${WORLD_MANIFEST}` }
        : {
            text: next,
            msg: `World skills: remove ${name} (owner, via console)`,
            body: `The world's owner removed ${name} from ${world}'s own skills on the Team skills screen.${users.length ? `\n\nAlso taken off: ${users.map((p) => p.name).join(", ")}.` : ""}`,
          };
    });
    if (w.status !== "written") return err(c, w.status === "failed" ? 502 : 409, w.status === "failed" ? "git_failed" : "conflict", `nothing removed: ${w.reason}`);
    await Promise.all(users.map((p) => o.detach(p.id, p.skills.filter((s) => s !== name))));
    return c.json({ removed: name, sha: w.sha, push: w.push.state, detachedFrom: users.map((p) => ({ id: p.id, name: p.name })), sync: await relinkWorld(world), syncNote: WORLD_SYNC_NOTE });
  };

  api.delete("/team-skills/:name", async (c) => {
    const world = callerWorld();
    if (world) return removeWorld(c, world, c.req.param("name"));
    const no = refusal(c);
    if (no) return no;
    const name = c.req.param("name");
    if (!o.repoDir) return err(c, 503, "unavailable", `no ${homeRepo()} checkout under the console's repos root: nothing removed`);
    let lib: TeamSkill[];
    try {
      lib = readLibrary(o.repoDir);
    } catch (e) {
      return err(c, 503, "unavailable", (e as Error).message);
    }
    if (!lib.some((s) => s.name === name)) return err(c, 404, "not_found", `no skill named ${name} in the library`);
    const users = o.allPersonas().filter((p) => p.skills.includes(name));
    const confirm = /^(1|true|yes)$/i.test(c.req.query("confirm") ?? "");
    if (users.length && !confirm)
      return err(c, 409, "in_use", `${name} is attached to ${users.map((p) => p.name).join(", ")}: confirm to remove it from the library and from ${users.length > 1 ? "them" : "that persona"}`, {
        usedBy: users.map((p) => ({ id: p.id, name: p.name })),
      });
    const w = await o.spine.edit({
      repoDir: o.repoDir,
      path: MANIFEST,
      label: `team skill ${name}`,
      edit: (text) => {
        let next: string | undefined;
        try {
          next = removeFromManifest(text, name);
        } catch (e) {
          return { skip: `${MANIFEST} is not readable: ${(e as Error).message}` };
        }
        return next === undefined
          ? { skip: `${name} is no longer in ${MANIFEST}` }
          : {
              text: next,
              msg: `Team skills: remove ${name} (${ownerName()}, via console)`,
              body: `${ownerName()} removed ${name} from the team library on the console Team skills screen.${users.length ? `\n\nAlso taken off: ${users.map((p) => p.name).join(", ")}.` : ""}`,
            };
      },
    });
    if (w.status !== "written") return err(c, w.status === "failed" ? 502 : 409, w.status === "failed" ? "git_failed" : "conflict", `nothing removed: ${w.reason ?? "the manifest could not be written"}`);
    await Promise.all(users.map((p) => o.detach(p.id, p.skills.filter((s) => s !== name))));
    return c.json({ removed: name, sha: w.sha, detachedFrom: users.map((p) => ({ id: p.id, name: p.name })), sync: await syncAll(), syncNote: syncNote() });
  });
}
