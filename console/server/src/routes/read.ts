import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type { Milestone, Store } from "../store.js";
import { ghOpenIssues, type IssueLister } from "../adapters/github.js";
import { backlogFor, deriveMilestone, locate, openTicketFiles, type Ticket } from "../adapters/milestone.js";
import { listRepos, repoForDir, resolveRepo, type Repo } from "../adapters/repos.js";
import { readSeats } from "../adapters/seats.js";
import { seatBoard } from "../adapters/seatBoard.js";
import fs from "node:fs";
import type { DB } from "../db.js";
import { packPyRunner, resolvePackSkillDir, type PackRunner } from "../packRunner.js";
import { cachedRunner, fixtureRunner, pickerDocs, rescanGapMs, resolveSkillDir, spinesPyRunner, type SpinesRunner } from "../adapters/spines.js";
import { t3UrlResolver } from "../t3/url.js";
import { movingLimit } from "../cycle/movement.js";
import { errorText } from "../t3/client.js";
import { t3ThreadLister, type Thread, type ThreadLister } from "../adapters/threads.js";
import { seatDir } from "../identity.js";

/** read adapters. Everything here only reads target repos, T3 and seats.json. */
export interface ReadConfig {
  reposRoot: string;
  seatsFile: string;
  listThreads: ThreadLister;
  /** undefined = GitHub issues off. */
  listIssues?: IssueLister;
  /** EpicSpine `spines.py --json` for the doc picker; undefined = path rules only (fallback). */
  spines?: SpinesRunner;
  /** the EpicSpine skill dir (spine_new.py / validate_spine.py for Add on a tree node); undefined = not installed. */
  skillDir?: string;
  /** runs the social pack export for a checkout (social/packExport.ts); undefined = no skill with the export. */
  packRunner?: PackRunner;
  /** the skill dir with the social pack (schema + `pack.py validate`) for the write API; undefined = writes 503. */
  packSkillDir?: string;
}

const home = os.homedir();
const expand = (p: string) => (p.startsWith("~/") ? path.join(home, p.slice(2)) : p);

/**
 * Config from env: REPOS_ROOT, SEATS_FILE, T3_MCP_URL (else T3 server-runtime.json, T3_RUNTIME_FILE), T3_TOKEN_FILE,
 * CONSOLE_GH=0 to skip gh, EPICSPINE_SKILL_DIR,
 * CONSOLE_SPINES_FIXTURE=<file> (test/preview only: that JSON replaces the spines.py call for every repo).
 */
export function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ReadConfig {
  const reposRoot = expand(env.REPOS_ROOT || "~/github");
  const skillDir = resolveSkillDir({ ...env, EPICSPINE_SKILL_DIR: env.EPICSPINE_SKILL_DIR && expand(env.EPICSPINE_SKILL_DIR) });
  const packSkillDir = resolvePackSkillDir({ ...env, EPICSPINE_SKILL_DIR: env.EPICSPINE_SKILL_DIR && expand(env.EPICSPINE_SKILL_DIR) }, home, skillDir);
  return {
    skillDir,
    packRunner: packSkillDir ? packPyRunner(packSkillDir) : undefined,
    packSkillDir,
    reposRoot,
    seatsFile: env.SEATS_FILE ? expand(env.SEATS_FILE) : path.join(seatDir(), "seats.json"),
    listThreads: t3ThreadLister({
      url: t3UrlResolver(env),
      tokenFile: env.T3_TOKEN_FILE ? expand(env.T3_TOKEN_FILE) : path.join(seatDir(), ".t3token"),
    }),
    listIssues: env.CONSOLE_GH === "0" ? undefined : ghOpenIssues,
    spines: env.CONSOLE_SPINES_FIXTURE
      ? fixtureRunner(expand(env.CONSOLE_SPINES_FIXTURE))
      : skillDir
        ? cachedRunner(spinesPyRunner(skillDir), undefined, undefined, undefined, { minGapMs: rescanGapMs(env) })
        : undefined,
  };
}

/** Short key from a milestone file (Ticket ID / Spine ID / filename id) used to match thread titles. */
function milestoneKey(reposRoot: string, m: Milestone): string | undefined {
  const loc = locate(reposRoot, m);
  const fromInfo = "info" in loc ? loc.info.ticketId ?? loc.info.spineId : undefined;
  const stem = path.basename(m.path, ".md");
  return (fromInfo ?? /^([A-Za-z]+\d+[\w.]*)/.exec(stem)?.[1] ?? stem).replace(/[`*]/g, "").trim() || undefined;
}

/**
 * Thread → milestone: the thread's project/worktree must be the milestone's checkout. One milestone in that
 * repo → it; several → the one whose key (e.g. "E5") appears as a word in the thread title; else none.
 */
export function mapThreadsToMilestones(reposRoot: string, threads: Thread[], milestones: Milestone[]): Thread[] {
  const byRepo = new Map<string, Milestone[]>();
  for (const m of milestones) {
    const r = resolveRepo(reposRoot, m.repo);
    if (r) byRepo.set(r.path, [...(byRepo.get(r.path) ?? []), m]);
  }
  const repoCache = new Map<string, Repo | undefined>();
  return threads.map((t) => {
    if (!t.workspaceRoot) return t;
    if (!repoCache.has(t.workspaceRoot)) repoCache.set(t.workspaceRoot, repoForDir(reposRoot, t.workspaceRoot));
    const repo = repoCache.get(t.workspaceRoot);
    const cands = repo ? byRepo.get(repo.path) ?? [] : [];
    let hit = cands.length === 1 ? cands[0] : undefined;
    if (cands.length > 1)
      hit = cands.find((m) => {
        const key = milestoneKey(reposRoot, m);
        return key && new RegExp(`(^|[^\\w])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w]|$)`, "i").test(t.title);
      });
    return hit ? { ...t, milestoneId: hit.id } : t;
  });
}

const THREADS_TTL_MS = 15_000;
/** one collator for the ticket sort (`localeCompare` with options builds one per comparison). */
const NUMERIC = new Intl.Collator(undefined, { numeric: true });

export function readRoutes(cfg: ReadConfig, store: Store, threadsEnvironment?: () => string | undefined, db?: DB) {
  const r = new Hono();
  const notFound = (what: string) => ({ error: { code: "not_found", message: `${what} not found` } });

  r.get("/repos", (c) => c.json(listRepos(cfg.reposRoot)));
  r.get("/repos/:name/docs", async (c) => {
    const repo = listRepos(cfg.reposRoot).find((x) => x.name === c.req.param("name"));
    if (!repo) return c.json(notFound(`repo ${c.req.param("name")}`), 404);
    return c.json(await pickerDocs(repo.path, cfg.spines));
  });

  r.get("/milestones/:id/backlog", (c) => {
    const m = store.getMilestone(c.req.param("id"));
    if (!m) return c.json(notFound(`milestone ${c.req.param("id")}`), 404);
    return c.json(backlogFor(cfg.reposRoot, m));
  });

  let threadsCache: { at: number; value: Thread[] } | undefined;
  // requests that find the cache stale share one T3 read (after a restart every open tab asked T3 at once)
  let threadsLoading: Promise<Thread[]> | undefined;
  r.get("/threads", async (c) => {
    try {
      if (!threadsCache || Date.now() - threadsCache.at > THREADS_TTL_MS) {
        threadsLoading ??= cfg.listThreads().finally(() => (threadsLoading = undefined));
        threadsCache = { at: Date.now(), value: await threadsLoading };
      }
    } catch (e) {
      console.error(`threads: ${errorText(e)}`);
      return c.json({ error: { code: "t3_unavailable", message: `T3 threads unavailable: ${errorText(e)}` } }, 503);
    }
    // these threads are on the console's own T3 (the main server): one environment for all of them, when known.
    const environmentId = threadsEnvironment?.();
    const threads = mapThreadsToMilestones(cfg.reposRoot, threadsCache.value, store.listMilestones({ includeSettled: true }));
    return c.json(environmentId ? threads.map((t) => ({ ...t, environmentId })) : threads);
  });

  r.get("/tickets", async (c) => {
    const milestones = store.listMilestones({ includeSettled: true });
    const repos = new Map<string, { repo: Repo; milestones: Milestone[] }>();
    for (const m of milestones) {
      const repo = resolveRepo(cfg.reposRoot, m.repo);
      if (!repo) continue;
      const e = repos.get(repo.path) ?? { repo, milestones: [] };
      e.milestones.push(m);
      repos.set(repo.path, e);
    }
    const warnings: string[] = [];
    const out: Ticket[] = [];
    await Promise.all(
      [...repos.values()].map(async ({ repo, milestones: ms }) => {
        // Ticket files → the milestone that is that file, else one whose backlog lists it.
        const owner = new Map<string, string>();
        for (const m of ms) for (const t of backlogFor(cfg.reposRoot, m)) if (t.path && !owner.has(t.path)) owner.set(t.path, m.id);
        for (const m of ms) owner.set(path.normalize(m.path), m.id);
        for (const t of openTicketFiles(repo)) out.push({ ...t, milestoneId: owner.get(t.path!) ?? owner.get(path.normalize(t.path!)) });
        if (cfg.listIssues && repo.remote) {
          try {
            const issues = await cfg.listIssues(repo.remote);
            out.push(...issues.map((i) => ({ ...i, milestoneId: ms.length === 1 ? ms[0].id : undefined })));
          } catch (e) {
            warnings.push(`${repo.remote}: ${(e as Error).message}`);
          }
        }
      }),
    );
    if (warnings.length) c.header("X-Console-Warnings", warnings.join(" | ").replace(/[\r\n]+/g, " ").slice(0, 1000));
    out.sort((a, b) => a.repo.localeCompare(b.repo) || NUMERIC.compare(a.id, b.id));
    // `?limit=20|50|all`: the first n and the count, `{ tickets, total }` (the Tickets page's Show 20 / 50
    // / all). Without it, the whole array as before.
    const limitQ = c.req.query("limit");
    if (limitQ !== undefined) {
      const limit = movingLimit(limitQ);
      return c.json({ tickets: limit ? out.slice(0, limit) : out, total: out.length });
    }
    return c.json(out);
  });

  r.get("/seats", (c) => {
    try {
      return c.json(readSeats(cfg.seatsFile));
    } catch (e) {
      return c.json({ error: { code: "seats_unavailable", message: `seats.json unreadable: ${(e as Error).message}` } }, 503);
    }
  });

  // every AI subscription with the personas on it and its load (adapters/seatBoard.ts); read-only.
  r.get("/seats/board", (c) => {
    try {
      return c.json(seatBoard(JSON.parse(fs.readFileSync(cfg.seatsFile, "utf8")), db));
    } catch (e) {
      return c.json({ error: { code: "seats_unavailable", message: `seats.json unreadable: ${(e as Error).message}` } }, 503);
    }
  });

  return r;
}

export { deriveMilestone };
