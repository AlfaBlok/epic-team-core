/**
 * the web side of the server's adapters/repoNames.ts: a repo renamed on GitHub in place answers to both names (a
 * milestone or a checkout's remote may say either). The renames are the hosted layer's (src/hosted/repoRenames.ts,
 * read through an optional glob): a build without src/hosted has none.
 */
const plugs = import.meta.glob<{ HOSTED_REPO_RENAMES?: ReadonlyArray<readonly [string, string]> }>("../../../../../hosted/console/web/src/hosted/repoRenames.ts", { eager: true });
const RENAMES: ReadonlyArray<readonly [string, string]> = Object.values(plugs).flatMap((m) => m.HOSTED_REPO_RENAMES ?? []);
const last = (s: string) => s.split("/").pop()!;

export function repoKey(repo: string): string {
  const r = repo.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, "").replace(/\.git$/, "").toLowerCase();
  for (const [o, n] of RENAMES) {
    if (r === o) return n;
    if (r === last(o)) return last(n);
  }
  return r;
}

export const sameRepo = (a: string | undefined | null, b: string | undefined | null): boolean => !!a && !!b && repoKey(a) === repoKey(b);
