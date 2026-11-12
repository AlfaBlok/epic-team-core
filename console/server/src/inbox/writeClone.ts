import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withRepoLock } from "../repoLock.js";
import { localHealRunner, parseRedundant, REDUNDANT, type HealRunner } from "../gitStaleLock.js";
import { runner, type EditInput, type SpineWrite, type SpineWriter } from "./spineWrite.js";

/**
 * the console writes from its own clone. Every spine write used to commit in the
 * shared checkout (`~/github/<repo>`) that agent sessions, the 15-min background sync and the console's own pulls also
 * use, so a write was refused whenever someone else left it dirty, diverged, mid-rebase or locked (diverged,
 * 34e88de4 stale index, dirty AGENTS.md, and 2026-11-07 21:20Z a staged approve of that refused every
 * press until 7171dc80). Now each tracked repo has a console-only clone (`<root>/<repo>-<hash>`, nothing else touches
 * it): it is put back to a clean `main` before each write, the spine writer commits and pushes there, and the shared
 * checkout then fast-forwards from it (`git fetch <clone> main`, no network). A shared checkout that cannot follow
 * (a foreign change in the same file, a local commit) keeps its change; the press has landed on origin all the same,
 * and the lag shows on /api/write-health and in the checkout-sync alert.
 *
 * `CONSOLE_WRITE_CLONE=off` is the old path (writes in the shared checkout), kept until this is proven; a clone that
 * cannot be made also falls back to it for that write.'s healing stays: in the writer (a no-op in a clean
 * clone) and in the shared checkout's fast-forward.
 *
 * caps (2026-11-08: 11 full clones put 2.1 GB on the main server's system disk overnight): a clone
 * borrows the shared checkout's objects (`git clone --shared`: alternates, so it costs only the commits the console makes,
 * on any disk), never runs git's auto gc or maintenance (a repack would copy the borrowed history into it), and checks
 * out a sparse tree without the evidence images and documents (SPARSE_PATTERNS): the spine writer edits text files only.
 * A file a write targets inside an excluded path is added to the sparse set before the write. A clone that lost an object
 * it borrowed (its alternates dir is gone or its tree no longer reads) is made again.
 *
 * every tracked file over BIG_BLOB_BYTES is left out of
 * the clone's tree too (one `!/<path>` pattern each, recomputed at each full check below, so a big file added later goes
 * as well). A write that targets one of them widens for it as above.
 *
 * the full check of a clone (about 11 git calls, among them a
 * `ls-tree -r -l` of the whole tree for the size cap) ran before every press; on the main server each git call from the console
 * costs 100-300 ms, so it added about 3 s to every press. A clone that passed it and whose writes since ended clean
 * (written, or refused for a reason that leaves it untouched) skips it for ENSURE_TTL_MS; any other outcome, an error
 * or a restart drops that, and the next write checks it in full. Its sparse set is kept in memory the same way.
 */

/** how long a checked clone skips the full check (`CONSOLE_CLONE_CHECK_TTL_MS`, 0 = check before every write). */
export const ENSURE_TTL_MS = Number(process.env.CONSOLE_CLONE_CHECK_TTL_MS ?? 300_000);

/** a write result after which the clone may hold something (dirty, mid-rebase, ahead): check it in full next time. */
export function leavesCloneUnsure(w: SpineWrite | undefined): boolean {
  if (!w) return true;
  if (w.status === "written") return false;
  if (w.status === "failed") return true;
  return /checkout|commit|origin|HEAD|rebase|fast-forward|clone|git /i.test(w.reason ?? "");
}

export interface SharedLag {
  dir: string;
  reason: string;
  since: string;
}

export interface CloneWriter extends SpineWriter {
  /** The console's clone of a shared checkout (undefined = not made yet, or clones are off). */
  cloneOf(shared: string): string | undefined;
  /** Shared checkouts that could not fast-forward to the console's last push, and why. */
  lagging(): SharedLag[];
  /** Writes that fell back to the shared checkout because no clone could be made (since start). */
  fallbacks(): { dir: string; reason: string; at: string }[];
  enabled: boolean;
  /** the background push of this clone landed: its shared checkout follows. */
  pushedFrom(cloneDir: string): void;
  /** push what a restart left unpushed in the clones; how many clones. */
  resumePushes(): Promise<number>;
}

export interface CloneWriterOptions {
  /** Where the clones live (one dir per shared checkout). */
  root: string;
  enabled?: boolean;
  log?: (msg: string) => void;
  heal?: HealRunner;
  now?: () => Date;
  /** how long a checked clone skips the full check (default ENSURE_TTL_MS). */
  checkTtlMs?: number;
}

const env = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=15",
});
const MAIN = "main";
/** Local config of the shared checkout the clone copies (identity, credentials, URL rewrites); never printed. */
const COPY_KEYS = /^(user|credential|http|url)\./i;
/** Local config every clone carries: no auto gc / maintenance (a repack would copy the borrowed objects in). */
const CLONE_CONFIG: [string, string][] = [
  ["gc.auto", "0"],
  ["maintenance.auto", "false"],
  ["core.sparseCheckout", "true"],
];
/** Evidence binaries and pages the spine writer never edits (the code repo docs/status + docs/proposals, research PDFs). */
const SKIP_EXT = ["pdf", "png", "jpg", "jpeg", "gif", "webp", "mp4", "webm", "mov", "zip"];
const caseless = (e: string) => [...e].map((c) => `[${c.toLowerCase()}${c.toUpperCase()}]`).join("");
/** Non-cone sparse patterns that leave out media/archive files anywhere (also staging's clones, E44). */
export const NO_MEDIA_PATTERNS = ["/*", ...SKIP_EXT.map((e) => `!*.${caseless(e)}`)];
/** Non-cone sparse patterns: everything except docs/status, docs/proposals and media/archive files anywhere. */
export const SPARSE_PATTERNS = ["/*", "!/docs/status/", "!/docs/proposals/", ...NO_MEDIA_PATTERNS.slice(1)];
/** a tracked file over this size stays out of the clone's tree (the spine writer edits small text files). */
export const BIG_BLOB_BYTES = 1024 * 1024;
/** A non-cone sparse pattern naming exactly one repo-relative path (gitignore escapes for its glob characters). */
export const exactPattern = (rel: string): string => `/${rel.replace(/^\/+/, "").replace(/[\\*?[\]]/g, "\\$&")}`;
/** Does a repo-relative path fall outside SPARSE_PATTERNS (so a write to it must widen the clone's sparse set first)? */
export function sparseExcluded(rel: string): boolean {
  const r = rel.replace(/^\/+/, "");
  return /^docs\/(status|proposals)\//.test(r) || SKIP_EXT.includes(path.extname(r).slice(1).toLowerCase());
}

export function cloneDirFor(root: string, shared: string): string {
  const real = (() => {
    try {
      return fs.realpathSync(shared);
    } catch {
      return path.resolve(shared);
    }
  })();
  const hash = crypto.createHash("sha256").update(real).digest("hex").slice(0, 8);
  return path.join(root, `${path.basename(real)}-${hash}`);
}

export function createCloneWriter(inner: SpineWriter, o: CloneWriterOptions): CloneWriter {
  const enabled = o.enabled !== false;
  const log = o.log ?? ((m: string) => console.warn(m));
  const heal = o.heal ?? localHealRunner;
  const now = () => o.now?.() ?? new Date();
  const made = new Map<string, string>();
  const lag = new Map<string, SharedLag>();
  const fell: { dir: string; reason: string; at: string }[] = [];
  /** clones checked in full (when), and their sparse sets as last read or set. */
  const checked = new Map<string, number>();
  const sparse = new Map<string, Set<string>>();
  const ttl = o.checkTtlMs ?? ENSURE_TTL_MS;
  const unsure = (dir: string) => {
    checked.delete(dir);
    sparse.delete(dir);
  };
  const settle = (dir: string, ws: (SpineWrite | undefined)[]) => {
    if (ws.some(leavesCloneUnsure)) unsure(dir);
  };

  async function readable(dir: string): Promise<boolean> {
    let alt = "";
    try {
      alt = fs.readFileSync(path.join(dir, ".git", "objects", "info", "alternates"), "utf8");
    } catch {
      /* a pre-cap clone has none */
    }
    const objects = path.join(dir, ".git", "objects");
    if (alt.split("\n").some((l) => l.trim() && !l.startsWith("#") && !fs.existsSync(path.resolve(objects, l.trim())))) return false;
    return (await runner(dir, env())(["cat-file", "-e", "HEAD^{tree}"])).ok;
  }

  /** Make the clone (first write) or put it back to a clean main at origin's URL; undefined + reason when it cannot be. */
  async function ensure(shared: string): Promise<{ dir: string } | { error: string }> {
    const dir = cloneDirFor(o.root, shared);
    return withRepoLock(dir, async () => {
      // checked a moment ago and every write since ended clean: no git call
      const at = checked.get(dir);
      if (at !== undefined && ttl > 0 && Date.now() - at < ttl && fs.existsSync(path.join(dir, ".git"))) return { dir };
      unsure(dir);
      const s = runner(shared, env());
      const url = (await s(["remote", "get-url", "origin"])).out;
      if (!url) return { error: "the shared checkout has no origin remote" };
      // a clone whose borrowed store is gone (shared checkout moved) or that cannot read its tree is made again
      if (fs.existsSync(path.join(dir, ".git")) && !(await readable(dir))) {
        log(`spine write: ${dir} lost objects it borrows; making it again`);
        fs.rmSync(dir, { recursive: true, force: true });
      }
      if (!fs.existsSync(path.join(dir, ".git"))) {
        fs.mkdirSync(o.root, { recursive: true });
        const tmp = `${dir}.tmp-${process.pid}`;
        fs.rmSync(tmp, { recursive: true, force: true });
        const c = await runner(o.root, env())(["clone", "-q", "--shared", "--no-checkout", shared, tmp], { timeout: 120_000 });
        if (!c.ok) {
          fs.rmSync(tmp, { recursive: true, force: true });
          return { error: `git clone failed: ${c.err}` };
        }
        const t = runner(tmp, env());
        await t(["remote", "set-url", "origin", url]);
        // identity, credential helpers and URL rewrites set on the shared checkout itself (global ones apply anyway)
        const local = (await s(["config", "--local", "--list", "--name-only"])).out.split("\n").filter((k) => COPY_KEYS.test(k));
        for (const k of [...new Set(local)]) {
          const vals = (await s(["config", "--local", "--get-all", k])).out.split("\n").filter(Boolean);
          for (const [i, v] of vals.entries()) await t(["config", ...(i ? ["--add"] : []), k, v]);
        }
        // the repo's hooks run on the console's commits too (a global core.hooksPath already covers every clone)
        if (!(await s(["config", "core.hooksPath"])).out) {
          const hooks = (await s(["rev-parse", "--git-path", "hooks"])).out;
          if (hooks) await t(["config", "core.hooksPath", path.resolve(shared, hooks)]);
        }
        for (const [k, v] of CLONE_CONFIG) await t(["config", k, v]);
        await t(["sparse-checkout", "set", "--no-cone", ...SPARSE_PATTERNS]);
        const f = await t(["fetch", "-q", "origin", MAIN], { timeout: 60_000 });
        if (!f.ok) {
          fs.rmSync(tmp, { recursive: true, force: true });
          return {
            error: `git fetch origin ${MAIN} in the new clone failed: ${f.err}`,
          };
        }
        const co = await t(["checkout", "-q", "-B", MAIN, `origin/${MAIN}`], {
          timeout: 300_000,
        });
        if (!co.ok) {
          fs.rmSync(tmp, { recursive: true, force: true });
          return {
            error: `checkout of origin/${MAIN} in the new clone failed: ${co.err}`,
          };
        }
        await t(["branch", "-q", "--set-upstream-to", `origin/${MAIN}`, MAIN]);
        fs.renameSync(tmp, dir);
        log(`spine write: made the console's own clone ${dir} of ${shared}`);
      }
      const g = runner(dir, env());
      // a clone made before the caps: no auto gc, sparse tree (one time; a no-op afterwards)
      if ((await g(["config", "core.sparseCheckout"])).out !== "true") {
        for (const [k, v] of CLONE_CONFIG) await g(["config", k, v]);
        await g(["sparse-checkout", "set", "--no-cone", ...SPARSE_PATTERNS], { timeout: 300_000 });
      }
      if ((await g(["remote", "get-url", "origin"])).out !== url) await g(["remote", "set-url", "origin", url]);
      // Nothing but the console writes here: anything left over (a write cut off by a restart) is dropped.
      if ((await g(["rev-parse", "-q", "--verify", "REBASE_HEAD"])).ok) await g(["rebase", "--abort"]);
      if ((await g(["symbolic-ref", "--short", "-q", "HEAD"])).out !== MAIN) await g(["checkout", "-q", "-f", MAIN], { timeout: 300_000 });
      const st = await g(["status", "--porcelain", "--untracked-files=all"]);
      if (!st.ok) return { error: `git status in the clone failed: ${st.err}` };
      if (st.out) {
        await g(["reset", "-q", "--hard"], { timeout: 300_000 });
        await g(["clean", "-fdq"], { timeout: 120_000 });
        log(`spine write: cleaned leftovers in ${dir} (${st.out.split("\n")[0].trim()}${st.out.includes("\n") ? ", …" : ""})`);
      }
      await capBig(dir);
      checked.set(dir, Date.now());
      return { dir };
    });
  }

  /** After a write: the shared checkout fast-forwards to what the clone pushed (local fetch from the clone, no network). */
  async function follow(shared: string, clone: string): Promise<void> {
    await withRepoLock(shared, async () => {
      const s = runner(shared, env());
      const branch = (await s(["symbolic-ref", "--short", "-q", "HEAD"])).out;
      const cloneHead = (await runner(clone, env())(["rev-parse", MAIN])).out;
      const note = (reason: string) => {
        const prev = lag.get(shared);
        lag.set(shared, {
          dir: shared,
          reason,
          since: prev?.since ?? now().toISOString(),
        });
        if (!prev) log(`spine write: ${shared} did not follow the console's push (${reason}); the press landed on origin all the same`);
      };
      // not forced: when the shared checkout already fetched something newer, its origin/main stays
      await s(["fetch", "-q", clone, `${MAIN}:refs/remotes/origin/${MAIN}`], {
        timeout: 30_000,
      });
      if (branch !== MAIN) return note(`it is on ${branch || "a detached HEAD"}, not ${MAIN}`);
      const head = (await s(["rev-parse", "HEAD"])).out;
      if (cloneHead && head === cloneHead) return void lag.delete(shared);
      const lr = (await s(["rev-list", "--left-right", "--count", `HEAD...origin/${MAIN}`])).out.split(/\s+/).map(Number);
      if (lr[0] > 0) return note(`it holds ${lr[0]} local commit(s) not on origin`);
      if (!(lr[1] > 0)) return void lag.delete(shared);
      let ff = await s(["merge", "-q", "--ff-only", `origin/${MAIN}`], {
        timeout: 120_000,
      });
      // a local edit already in HEAD or upstream holds no work: restore it and try once more
      if (!ff.ok && parseRedundant(await heal(path.resolve(shared), REDUNDANT, 0).catch(() => "")).removed)
        ff = await s(["merge", "-q", "--ff-only", `origin/${MAIN}`], {
          timeout: 120_000,
        });
      // a leftover that only appended lines upstream already has (the old path's stranded copy of an append-only
      // file, e.g. the desk chat) holds no work either: its diff is kept, then it is restored and the fast-forward retried
      if (!ff.ok && (await healAppended(shared, ff.err + "\n" + (ff.stderr ?? ""))).length)
        ff = await s(["merge", "-q", "--ff-only", `origin/${MAIN}`], {
          timeout: 120_000,
        });
      if (!ff.ok) return note(`fast-forward refused: ${ff.err}`);
      if (lag.delete(shared)) log(`spine write: ${shared} follows origin/${MAIN} again`);
    });
  }

  /**
   * Files a refused fast-forward names whose local change (worktree and index, against HEAD) removes nothing and adds only
   * lines upstream's version already holds: the diff goes to `<root>/_healed/`, the file is restored from HEAD. Anything
   * else is left as it is. Returns the files restored.
   */
  async function healAppended(shared: string, err: string): Promise<string[]> {
    const s = runner(shared, env());
    const named = [
      ...new Set(
        err
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !/\s/.test(l) && !/^(error|fatal|hint|Aborting|Please)\b/i.test(l)),
      ),
    ];
    const done: string[] = [];
    for (const f of named) {
      const diff = await s(["diff", "HEAD", "--", f]);
      if (!diff.ok || !diff.out) continue;
      const body = diff.out.split("\n").filter((l) => !/^(diff --git|index |--- |\+\+\+ |@@)/.test(l));
      if (body.some((l) => l.startsWith("-"))) continue;
      const added = body.filter((l) => l.startsWith("+")).map((l) => l.slice(1));
      const up = await s(["show", `origin/${MAIN}:${f}`]);
      if (!up.ok) continue;
      const have = new Set(up.out.split("\n"));
      if (!added.length || added.some((l) => !have.has(l))) continue;
      const keep = path.join(o.root, "_healed");
      fs.mkdirSync(keep, { recursive: true });
      const file = path.join(keep, `${path.basename(shared)}-${now().toISOString().replace(/[:.]/g, "")}-${f.replace(/[^\w.-]+/g, "_")}.diff`);
      fs.writeFileSync(file, diff.out + "\n");
      const r = await s(["checkout", "HEAD", "--", f]);
      if (!r.ok) continue;
      done.push(f);
      log(`spine write: ${shared}: restored ${f} (its local change only added lines origin/${MAIN} already has; diff kept in ${file})`);
    }
    return done;
  }

  /**
   * the clone's sparse set is SPARSE_PATTERNS, then `!/<path>` for each tracked file over BIG_BLOB_BYTES, then the
   * paths earlier writes widened for (kept, so a widened file stays in). Re-applied only when that list changed.
   */
  async function capBig(dir: string): Promise<void> {
    const g = runner(dir, env());
    const tree = await g(["ls-tree", "-r", "-l", "-z", "--full-tree", "HEAD"], { timeout: 120_000 });
    if (!tree.ok) return log(`spine write: could not list ${dir}'s tree for the size cap: ${tree.err}`);
    const big = tree.out
      .split("\0")
      .map((l) => /^\d+ blob \w+ +(\d+)\t([^\n]+)$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m && Number(m[1]) > BIG_BLOB_BYTES)
      .map((m) => `!${exactPattern(m[2])}`);
    const cur = (await g(["sparse-checkout", "list"])).out.split("\n").filter(Boolean);
    const base = new Set(SPARSE_PATTERNS);
    const widened = cur.filter((p) => !base.has(p) && !p.startsWith("!"));
    const want = [...SPARSE_PATTERNS, ...big, ...widened];
    if (want.join("\n") === cur.join("\n")) return void sparse.set(dir, new Set(cur));
    sparse.delete(dir);
    const r = await g(["sparse-checkout", "set", "--no-cone", ...want], { timeout: 300_000 });
    if (!r.ok) return log(`spine write: size cap on ${dir} failed: ${r.err}`);
    log(`spine write: ${dir} leaves out ${big.length} file(s) over ${BIG_BLOB_BYTES} bytes`);
  }

  /** Add the paths a write touches to the clone's sparse set when SPARSE_PATTERNS or the size cap leaves them out. */
  async function widen(dir: string, rels: string[]): Promise<void> {
    const g = runner(dir, env());
    const have = sparse.get(dir) ?? new Set((await g(["sparse-checkout", "list"])).out.split("\n"));
    sparse.set(dir, have);
    const out = rels.map((r) => r.replace(/^\/+/, "")).filter((r) => r && (sparseExcluded(r) || have.has(`!${exactPattern(r)}`)));
    if (!out.length) return;
    const add = out.map(exactPattern).filter((p) => !have.has(p));
    if (!add.length) return;
    const r = await g(["sparse-checkout", "add", ...add], { timeout: 120_000 });
    if (r.ok) for (const p of add) have.add(p);
    else sparse.delete(dir);
  }

  const via =
    <I extends { repoDir: string }>(call: (i: I) => Promise<SpineWrite>) =>
    async (i: I): Promise<SpineWrite> => {
      if (!enabled) return call(i);
      const shared = i.repoDir;
      const c = await ensure(shared).catch((e: Error) => ({
        error: e.message,
      }));
      if ("error" in c) {
        fell.push({ dir: shared, reason: c.error, at: now().toISOString() });
        if (fell.length > 50) fell.shift();
        log(`spine write: no own clone of ${shared} (${c.error}); writing in the shared checkout as before`);
        return call(i);
      }
      made.set(path.resolve(shared), c.dir);
      const target = "target" in i ? (i as { target: { path?: string } }).target.path : (i as { path?: string }).path;
      if (target) await widen(c.dir, [target]);
      // a scaffold's files are known only after its script ran: widen for them before the writer adds them
      const scaffold = (i as { scaffold?: (d: string) => Promise<{ ok: true; files: string[] } | { ok: false; error: string }> }).scaffold;
      const next = scaffold
        ? {
            ...i,
            repoDir: c.dir,
            scaffold: async (d: string) => {
              const r = await scaffold(d);
              if (r.ok) await widen(c.dir, r.files);
              return r;
            },
          }
        : { ...i, repoDir: c.dir };
      const w = await call(next).catch((e: Error) => {
        unsure(c.dir);
        throw e;
      });
      settle(c.dir, [w]);
      // a press committed here and still pushing: the shared checkout follows once origin has it (pushedFrom)
      if (!w.pushing) await follow(shared, c.dir).catch((e: Error) => log(`spine write: following ${shared} failed: ${e.message}`));
      return w;
    };

  /** a batch of edits to one shared checkout: the clone made ready once, one commit and push there, one follow. */
  async function edits(list: EditInput[]): Promise<SpineWrite[]> {
    const run = inner.edits ? (l: EditInput[]) => inner.edits!(l) : (l: EditInput[]) => Promise.all(l.map((i) => inner.edit(i)));
    if (!enabled || !list.length) return run(list);
    const shared = list[0].repoDir;
    const c = await ensure(shared).catch((e: Error) => ({ error: e.message }));
    if ("error" in c) {
      fell.push({ dir: shared, reason: c.error, at: now().toISOString() });
      if (fell.length > 50) fell.shift();
      log(`spine write: no own clone of ${shared} (${c.error}); writing in the shared checkout as before`);
      return run(list);
    }
    made.set(path.resolve(shared), c.dir);
    await widen(c.dir, list.map((i) => i.path).filter(Boolean));
    const ws = await run(list.map((i) => ({ ...i, repoDir: c.dir }))).catch((e: Error) => {
      unsure(c.dir);
      throw e;
    });
    settle(c.dir, ws);
    if (!ws.some((w) => w.pushing)) await follow(shared, c.dir).catch((e: Error) => log(`spine write: following ${shared} failed: ${e.message}`));
    return ws;
  }

  /**
   * the background push of a clone landed (the spine writer's onPushed): its shared checkout follows now. Never
   * before: a shared checkout that took a commit origin then got rebased would hold a stray copy of it.
   */
  function pushedFrom(cloneDir: string): void {
    const dir = path.resolve(cloneDir);
    const shared = [...made.entries()].find(([, c]) => path.resolve(c) === dir)?.[0];
    if (shared) void follow(shared, cloneDir).catch((e: Error) => log(`spine write: following ${shared} failed: ${e.message}`));
  }

  /** at start: a clone holding console commits origin lacks (a restart cut their push off) pushes them now. */
  async function resumePushes(): Promise<number> {
    if (!enabled || !inner.pushes || !fs.existsSync(o.root)) return 0;
    let n = 0;
    for (const name of fs.readdirSync(o.root)) {
      const dir = path.join(o.root, name);
      if (name.startsWith("_") || name.includes(".tmp-") || !fs.existsSync(path.join(dir, ".git"))) continue;
      const ahead = await runner(dir, env())(["rev-list", "--count", `origin/${MAIN}..${MAIN}`]);
      if (!ahead.ok || !(Number(ahead.out) > 0)) continue;
      // a commit older than 48 h is no press still waiting: left to the next write's guards, never pushed blind at start
      const oldest = Number((await runner(dir, env())(["log", "--reverse", "--format=%ct", `origin/${MAIN}..${MAIN}`])).out.split("\n")[0]) * 1000;
      if (!(oldest > Date.now() - 48 * 3600_000)) {
        log(`spine write: ${dir} holds ${ahead.out} console commit(s) not on origin, older than 48 h: not pushed at start`);
        continue;
      }
      // the shared checkout it belongs to: the one whose objects it borrows
      try {
        const alt = fs.readFileSync(path.join(dir, ".git", "objects", "info", "alternates"), "utf8").split("\n")[0]?.trim();
        if (alt && !made.has(path.dirname(path.dirname(path.resolve(dir, ".git", "objects", alt))))) made.set(path.dirname(path.dirname(path.resolve(dir, ".git", "objects", alt))), dir);
      } catch {
        /* no alternates: the follow waits for its next write */
      }
      log(`spine write: ${dir} holds ${ahead.out} console commit(s) not on origin yet: pushing them`);
      inner.pushes.kick(dir);
      n++;
    }
    return n;
  }

  return {
    enabled,
    pushedFrom,
    resumePushes,
    ...(inner.pushes ? { pushes: inner.pushes } : {}),
    edits,
    answer: via((i) => inner.answer(i)),
    change: via((i) => inner.change(i)),
    revert: via((i) => inner.revert(i)),
    edit: via((i) => inner.edit(i)),
    scaffold: via((i) => inner.scaffold(i)),
    cloneOf: (shared) => made.get(path.resolve(shared)),
    lagging: () => [...lag.values()],
    fallbacks: () => [...fell],
  };
}
