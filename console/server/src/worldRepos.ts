import type { DB } from "./db.js";
import { forTenant, type Store } from "./store.js";
import { resolveRepo, type Repo } from "./adapters/repos.js";

// moved unchanged from social/route.ts.
/** The world's repos (checked out under reposRoot), oldest milestone first; undefined = world not visible to `store`. */
export function worldRepos(db: DB, store: Store, reposRoot: string, tenantId: string): Repo[] | undefined {
  if (!store.getTenant(tenantId)) return undefined;
  const seen = new Map<string, Repo>();
  for (const m of forTenant(db, tenantId).listMilestones({ includeSettled: true })) {
    const repo = m.repo && resolveRepo(reposRoot, m.repo);
    if (repo && !seen.has(repo.path)) seen.set(repo.path, repo);
  }
  return [...seen.values()];
}
