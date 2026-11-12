import { execFile } from "node:child_process";
import type { Ticket } from "./milestone.js";

export type IssueLister = (slug: string) => Promise<Ticket[]>;

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value?: Ticket[]; error?: Error }>();
const pending = new Map<string, Promise<Ticket[]>>();

const fetchIssues = (slug: string): Promise<Ticket[]> => {
  let p = pending.get(slug);
  if (p) return p;
  p = new Promise<string>((resolve, reject) =>
    execFile(
      "gh",
      ["issue", "list", "-R", slug, "--state", "open", "--json", "number,title,url,assignees", "--limit", "100"],
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(out)),
    ),
  )
    .then((stdout) => {
      const value: Ticket[] = (JSON.parse(stdout) as any[]).map((i) => ({
        id: `#${i.number}`,
        title: i.title,
        repo: slug,
        status: "open",
        owner: i.assignees?.map((a: { login: string }) => a.login).join(", ") || undefined,
        source: "github" as const,
        url: i.url,
      }));
      cache.set(slug, { at: Date.now(), value });
      return value;
    })
    .catch((e: Error) => {
      const prev = cache.get(slug);
      // A failed refresh keeps the last good list; with none, the failure is remembered for one TTL (no re-spawn per request).
      cache.set(slug, prev?.value ? { at: Date.now(), value: prev.value } : { at: Date.now(), error: e });
      if (prev?.value) return prev.value;
      throw e;
    })
    .finally(() => pending.delete(slug));
  pending.set(slug, p);
  return p;
};

/**
 * Open GitHub issues via `gh issue list` (read-only); cached 60 s per repo. Rejects if gh fails and no list was ever read.
 * stale-while-revalidate: past the TTL the last list answers at once while one background `gh` refreshes it, so
 * /tickets never waits on GitHub after the first read; a failure is cached for the TTL too.
 */
export const ghOpenIssues: IssueLister = async (slug) => {
  const hit = cache.get(slug);
  if (!hit) return fetchIssues(slug);
  if (Date.now() - hit.at >= TTL_MS) fetchIssues(slug).catch(() => {});
  if (hit.error) throw hit.error;
  return hit.value!;
};
