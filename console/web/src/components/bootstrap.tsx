/** A milestone whose path is still empty is being bootstrapped by an agent in its repo. */
export function MilestonePath({ path }: { path: string }) {
  return path ? <>{path}</> : <span className="italic text-amber-600 dark:text-amber-400">bootstrapping…</span>;
}
