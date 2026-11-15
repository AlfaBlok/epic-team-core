/**
 * a console checkout that a plain `git pull --ff-only` cannot move follows main again by itself.
 *
 * Seen 2026-11-15: the console's own code-repo checkout on the main server sat 84 commits behind main, held by one console
 * commit whose change main already had; on the worker server pre-wake pulls failed every few wakes with "Cannot
 * fast-forward to multiple branches" (a second fetch rewrote FETCH_HEAD under the pull) or "local changes would be
 * overwritten". After the usual pull (and its lock retry and stale-lock heal) fails, `recoverPull`:
 *
 * 1. fetches the upstream branch and merges `origin/<branch>` by name (never FETCH_HEAD, so a parallel fetch cannot
 *    turn it into "multiple branches"); a lock or a racing fetch is tried once more after a pause;
 * 2. untracked files main is adding are removed only when they already hold main's exact bytes (nothing lost);
 *    any other untracked file in the way stops it;
 * 3. uncommitted edits (an agent's write in progress) are stashed and put back after the move, only when a dry merge
 *    (`git stash create` + `git merge-tree`) shows they apply cleanly on top of main; else nothing is touched;
 * 4. local commits main lacks are rebased onto main only when each is the console's own (its trailer) or its change
 *    is already in main (applying it to main changes nothing, so the rebase drops it); a person's or an agent's own
 *    unpushed commit stops it. A failed rebase is aborted and the edits put back.
 *
 * Never `reset`, never a force: what it did not write stays byte for byte (a stash that cannot be put back stays in the
 * stash list, named, and the reason says so). Every step runs through `git`, so the worker server path is the same over ssh.
 */

/** Runs `git <args>` in the checkout; resolves with stdout, rejects with an Error whose message is git's reason. */
export type GitIn = (args: string[]) => Promise<string>;

export type Recovered = { ok: true; did: string } | { ok: false; reason: string; tried: boolean };

/** The console's commit trailer (spineWrite.ts CONSOLE_TRAILER; kept here as a literal to avoid an import cycle). */
export const CONSOLE_COMMIT_TRAILER = "Console-Write: spine-writer";

const LOCKISH = /index\.lock|\.lock': File exists|cannot lock ref|another git process|Cannot fast-forward to multiple branches|FETCH_HEAD|shallow file has changed/i;

const ok = async (git: GitIn, args: string[]) =>
  git(args).then(
    (out) => ({ ok: true as const, out: out.trim() }),
    (e) => ({ ok: false as const, out: "", err: (e as Error).message }),
  );

export interface RecoverOptions {
  /** pause before the one retry of a step another git process got in the way of (ms). */
  retryMs?: number;
  /** stash message suffix (time), for tests. */
  now?: () => Date;
}

export async function recoverPull(git: GitIn, o: RecoverOptions = {}): Promise<Recovered> {
  const retryMs = o.retryMs ?? 2_000;
  const step = async (args: string[]) => {
    let r = await ok(git, args);
    if (!r.ok && LOCKISH.test(r.err)) {
      await new Promise((x) => setTimeout(x, retryMs));
      r = await ok(git, args);
    }
    return r;
  };
  const no = (reason: string, tried = true): Recovered => ({ ok: false, reason, tried });

  // which branch, following which upstream (only a branch with an origin upstream is ours to move)
  const branch = await ok(git, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (!branch.ok || !branch.out) return no("not on a branch (detached HEAD), left as is", false);
  const up = await ok(git, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const m = up.ok ? /^([^/]+)\/(.+)$/.exec(up.out) : null;
  if (!m) return no(`${branch.out} has no upstream branch, left as is`, false);
  const [upstream, remote, rbranch] = [m[0], m[1], m[2]];
  const busy = await ok(git, ["rev-parse", "-q", "--verify", "REBASE_HEAD"]);
  if (busy.ok && busy.out) return no("a rebase is in progress in the checkout, left as is");

  const fetched = await step(["fetch", "-q", remote, `+refs/heads/${rbranch}:refs/remotes/${remote}/${rbranch}`]);
  if (!fetched.ok) return no(`fetch ${upstream} failed: ${fetched.err}`);
  const lr = await ok(git, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`]);
  const [ahead, behind] = lr.out.split(/\s+/).map(Number);
  if (!lr.ok || Number.isNaN(ahead) || Number.isNaN(behind)) return no(`cannot compare with ${upstream}: ${lr.ok ? lr.out : lr.err}`);
  if (behind === 0) return { ok: true, did: ahead ? `nothing to pull (${ahead} local commit(s) ahead of ${upstream})` : `already at ${upstream}` };
  const did: string[] = [`fetched ${upstream}`];

  // local commits main lacks: each must be the console's own or already in main
  let dropped = 0;
  if (ahead > 0) {
    const tree = (await ok(git, ["rev-parse", `${upstream}^{tree}`])).out;
    const shas = (await ok(git, ["rev-list", "--reverse", `${upstream}..HEAD`])).out.split("\n").filter(Boolean);
    for (const c of shas) {
      const body = await ok(git, ["log", "-1", "--format=%P%x1f%s%x1f%B", c]);
      const [parents, subject, msg] = body.out.split("\x1f");
      const parentList = (parents ?? "").trim().split(/\s+/).filter(Boolean);
      // applying c on main gives main's own tree: its change is already there
      const inMain = parentList.length === 1 && (await ok(git, ["merge-tree", "--write-tree", "--merge-base", parentList[0], upstream, c])).out.split("\n")[0] === tree;
      if (inMain) dropped++;
      else if (!(msg ?? "").includes(CONSOLE_COMMIT_TRAILER)) return no(`local commit ${c.slice(0, 8)} “${subject ?? ""}” is not on ${upstream} and not the console's: push or rebase it (left as is)`);
    }
  }

  // untracked files main is about to add
  const added = (await ok(git, ["diff", "--name-only", "--diff-filter=A", "-z", "HEAD", upstream])).out.split("\0").filter(Boolean);
  if (added.length) {
    const untracked = (await ok(git, ["ls-files", "-o", "--exclude-standard", "-z", "--", ...added.slice(0, 500)])).out.split("\0").filter(Boolean);
    const same: string[] = [];
    for (const p of untracked) {
      const mine = (await ok(git, ["hash-object", "--", p])).out;
      const theirs = (await ok(git, ["rev-parse", "-q", "--verify", `${upstream}:${p}`])).out;
      if (!mine || mine !== theirs) return no(`untracked ${p} differs from the file ${upstream} adds (kept, nothing removed)`);
      same.push(p);
    }
    if (same.length) {
      const c = await ok(git, ["clean", "-q", "-f", "--", ...same]);
      if (!c.ok) return no(`could not clear untracked ${same.join(", ")}: ${c.err}`);
      did.push(`cleared untracked ${same.join(", ")} (main's exact bytes)`);
    }
  }

  // uncommitted edits: stash and put back, only when they merge cleanly onto main
  let stashed = false;
  const dirty = await ok(git, ["status", "--porcelain", "-uno"]);
  if (!dirty.ok) return no(`git status failed: ${dirty.err}`);
  if (dirty.out) {
    const files = dirty.out.split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
    const s = await ok(git, ["stash", "create"]);
    if (!s.ok) return no(`cannot read the local edits: ${s.err}`);
    if (s.out) {
      const dry = await ok(git, ["merge-tree", "--write-tree", "--name-only", s.out, upstream]);
      if (!dry.ok) return no(`local edits in ${files.slice(0, 3).join(", ")} clash with ${upstream} (kept, nothing reset)`);
      const stamp = (o.now?.() ?? new Date()).toISOString();
      const push = await step(["stash", "push", "-q", "-m", `console-sync ${stamp}`]);
      if (!push.ok) return no(`could not stash the local edits: ${push.err}`);
      stashed = true;
    }
  }
  const putBack = async (): Promise<string | undefined> => {
    if (!stashed) return undefined;
    if ((await ok(git, ["stash", "pop", "-q", "--index"])).ok) return undefined;
    const r = await ok(git, ["stash", "pop", "-q"]);
    return r.ok ? undefined : `the local edits could not be put back, they are kept as the newest stash (console-sync): ${r.err}`;
  };

  const move = ahead > 0 ? await step(["rebase", "-q", upstream]) : await step(["merge", "-q", "--ff-only", upstream]);
  if (!move.ok) {
    if (ahead > 0) await ok(git, ["rebase", "--abort"]);
    const lost = await putBack();
    return no(`${ahead > 0 ? "rebase" : "fast-forward"} onto ${upstream} failed: ${move.err}${lost ? `; ${lost}` : ""}`);
  }
  if (ahead > 0) did.push(dropped ? `dropped ${dropped} local commit(s) already on ${upstream}${ahead - dropped ? `, rebased ${ahead - dropped} console commit(s)` : ""}` : `rebased ${ahead} console commit(s) onto ${upstream}`);
  else did.push(`fast-forwarded ${behind} commit(s)`);
  const lost = await putBack();
  if (lost) return no(`moved to ${upstream} but ${lost}`);
  if (stashed) did.push("kept the local edits (stashed and put back)");
  return { ok: true, did: did.join("; ") };
}
