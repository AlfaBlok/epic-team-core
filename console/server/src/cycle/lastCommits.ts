/**
 * the newest commit time touching any of `paths` in the checkout `dir` (the roll-up check's question, cycle/rollup.ts),
 * kept per (checkout, paths) with the HEAD it holds for. When HEAD moves, one `git log --name-only <old>..<new>` per
 * checkout moves every kept answer forward: the main server commits every few minutes, and each move used to re-run one
 * `git log -1` spawn per parent spine (2.5 s of a 90 s live profile on the console's one thread).
 */
export function createLastCommits(git: (dir: string, args: string[]) => Promise<string>, headSha: (dir: string) => string | undefined) {
  const lastCommits = new Map<string, { head: string; answers: Map<string, string | undefined>; moving?: Promise<boolean> }>();
  const touchedSince = (dir: string, from: string, to: string): Promise<Map<string, string> | undefined> =>
    git(dir, ["log", "--format=%x01%cI", "--name-only", `${from}..${to}`]).then(
      (out) => {
        const at = new Map<string, string>();
        let when = "";
        for (const line of out.split("\n")) {
          if (line.startsWith("\x01")) when = line.slice(1).trim();
          else if (line && when && (!at.has(line) || Date.parse(when) > Date.parse(at.get(line)!))) at.set(line, when);
        }
        return at;
      },
      () => undefined,
    );
  const newest = (a: string | undefined, b: string | undefined) => (!a ? b : !b ? a : Date.parse(b) > Date.parse(a) ? b : a);
  return async (dir: string, paths: string[]): Promise<string | undefined> => {
    const sha = headSha(dir);
    const key = paths.join("\0");
    const ask = () =>
      git(dir, ["log", "-1", "--format=%cI", "--", ...paths]).then(
        (s) => s.trim() || undefined,
        () => undefined,
      );
    if (!sha) return ask();
    let kept = lastCommits.get(dir);
    if (kept && kept.head !== sha) {
      const k = kept;
      k.moving ??= touchedSince(dir, k.head, sha)
        .then((touched) => {
          if (!touched) return false;
          for (const [pk, was] of k.answers) {
            let at = was;
            for (const p of pk.split("\0")) for (const [f, when] of touched) if (f === p || f.startsWith(`${p}/`)) at = newest(at, when);
            k.answers.set(pk, at);
          }
          k.head = sha;
          return true;
        })
        .finally(() => (k.moving = undefined));
      const moved = await k.moving;
      if (!moved) lastCommits.delete(dir);
      kept = lastCommits.get(dir);
      if (kept && kept.head !== headSha(dir)) return ask(); // moved again meanwhile: answer fresh, the next call catches up
    }
    if (kept?.answers.has(key)) return kept.answers.get(key);
    const at = await ask();
    if (headSha(dir) === sha) {
      if (!kept) lastCommits.set(dir, (kept = { head: sha, answers: new Map() }));
      if (kept.head === sha) {
        if (kept.answers.size > 5000) kept.answers.clear();
        kept.answers.set(key, at);
      }
    }
    return at;
  };
}
