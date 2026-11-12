/**
 * a GitHub repo renamed in place answers to both names. GitHub serves the new one and
 * redirects the old (web, clone, fetch, push, API) as long as no new repo takes the old name, so a milestone, a desk
 * note's reply-to, a deck link or a `--repo` key may say either name for years. Every place the console compares repo
 * names goes through `sameRepo` / `repoKey`, so `the team's code repo`, `the team's code repo`, `the code repo` and
 * `epic-team` are one repo. The checkouts keep their old folder names (step A renames no folder): `checkoutName` maps
 * either name to that folder.
 *
 * The renames: what a hosted layer adds at load (addRepoRename) and CONSOLE_REPO_RENAMES="Owner/old=Owner/new,…".
 */
const REPO_RENAMES: (readonly [old: string, renamed: string])[] = [];

/** a repo renamed in place: `Owner/old` now answers as `Owner/new` too (a hosted layer's own repos, at load) */
export function addRepoRename(old: string, renamed: string): void {
  if (!REPO_RENAMES.some(([o, n]) => o === old && n === renamed)) REPO_RENAMES.push([old, renamed] as const);
}

/** forget the added renames (a test that sets its own) */
export function resetRepoRenames(): void {
  REPO_RENAMES.length = 0;
}

const norm = (s: string) =>
  s
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
const lastPart = (s: string) => s.split("/").pop()!;

function renames(env: NodeJS.ProcessEnv = process.env): (readonly [string, string])[] {
  const extra = (env.CONSOLE_REPO_RENAMES ?? "")
    .split(",")
    .map((p) => p.split("=").map((x) => x.trim()))
    .filter((p): p is [string, string] => p.length === 2 && /^[\w.-]+\/[\w.-]+$/.test(p[0]) && /^[\w.-]+\/[\w.-]+$/.test(p[1]));
  return [...REPO_RENAMES, ...extra];
}

/** One key per repo: `owner/name` or a bare name, lower case, a renamed repo's old name mapped to its new one. */
export function repoKey(repo: string): string {
  const r = norm(repo);
  for (const [o, n] of renames()) {
    const [ol, nl] = [o.toLowerCase(), n.toLowerCase()];
    if (r === ol) return nl;
    if (r === lastPart(ol)) return lastPart(nl);
  }
  return r;
}

/** True when two repo names (`owner/name`, a bare name or a GitHub URL; old or new name) are the same repo. */
export function sameRepo(a: string | undefined | null, b: string | undefined | null): boolean {
  return !!a && !!b && repoKey(a) === repoKey(b);
}

/** Every name a repo answers to: itself, plus the other name of a renamed one, in the same form (slug or bare name). */
export function repoAliases(repo: string): string[] {
  const r = norm(repo);
  const out = [repo.trim()];
  for (const [o, n] of renames()) {
    for (const [a, b] of [[o, n], [n, o]]) {
      if (r === a.toLowerCase()) out.push(b);
      else if (r === lastPart(a.toLowerCase())) out.push(lastPart(b));
    }
  }
  return [...new Set(out)];
}

/** The checkout folder of a repo on our hosts (`~/github/<this>`): a renamed repo keeps its old folder name. */
export function checkoutName(repo: string): string {
  const r = norm(repo);
  for (const [o, n] of renames()) if (r === n.toLowerCase() || r === lastPart(n.toLowerCase()) || r === o.toLowerCase()) return lastPart(o);
  return lastPart(repo.trim().replace(/\/+$/, "").replace(/\.git$/, ""));
}
