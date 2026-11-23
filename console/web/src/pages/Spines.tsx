import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { RotateCw } from "lucide-react";
import { api, type Repo, type SpineListing } from "@/api";
import { useQuery } from "@/lib/data";
import { useSocial } from "@/lib/useSocial";
import { socialHref } from "@/pages/social/nav";
import { spineViewHref } from "@/lib/nodes";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Empty, ErrorBox, Loading, PageHeader, RelTime } from "@/components/common";
import { TreeDot, TreeLegend } from "@/components/tree";
import { cn } from "@/lib/utils";
import { FoldChevron } from "@/components/foldChevron";

// Spines page: every repo's spine tree (spines.py), cached per repo here and on the server.
const STORE_KEY = "console.spines.";
const memory = new Map<string, SpineListing>();

export function cachedListing(repo: string): SpineListing | undefined {
  const hit = memory.get(repo);
  if (hit) return hit;
  try {
    const raw = globalThis.localStorage?.getItem(STORE_KEY + repo);
    const v = raw ? (JSON.parse(raw) as SpineListing) : undefined;
    if (v) memory.set(repo, v);
    return v;
  } catch {
    return undefined;
  }
}
function remember(v: SpineListing) {
  memory.set(v.repo, v);
  try {
    globalThis.localStorage?.setItem(STORE_KEY + v.repo, JSON.stringify(v));
  } catch {
    /* quota / private mode */
  }
}
/** Test hook. */
export const clearSpinesCache = () => memory.clear();

// At most 3 spines.py reads in flight from this page (the host is shared).
let inFlight = 0;
const queue: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= 3) await new Promise<void>((r) => queue.push(r));
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    queue.shift()?.();
  }
}

/** Cached listing at once, then a background read; while the server says `refreshing`, read again (≤3 times). */
function useRepoSpines(repo: string) {
  const [data, setData] = useState<SpineListing | undefined>(() => cachedListing(repo));
  const [error, setError] = useState<Error>();
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      setBusy(true);
      limited(() => api.listRepoSpines(repo))
        .then((v) => {
          if (!alive) return;
          remember(v);
          setData(v);
          setError(undefined);
          if (v.refreshing && ++tries <= 3) timer = setTimeout(load, 4_000);
        })
        .catch((e: Error) => alive && setError(e))
        .finally(() => alive && setBusy(false));
    };
    load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [repo, tick]);
  return { data, error, busy, reload: () => setTick((t) => t + 1) };
}

export function SpinesPage() {
  const repos = useQuery(() => api.listRepos(), []);
  // Engine room, the other way: the world's social repo gets a menu entry to its social screens (same data).
  const socialRepo = useSocial().data?.repo;
  const [showAll, setShowAll] = useState(false);
  const withSpines = repos.data?.filter((r) => r.hasEpicSpine) ?? [];
  const others = repos.data?.filter((r) => !r.hasEpicSpine) ?? [];
  return (
    <>
      <PageHeader title="Spines" description="Every repo's spine tree. Open any spine to see its status from there down and what waits on you; no need to track it first." />
      <div className="mb-4">
        <TreeLegend />
      </div>
      {repos.error && <ErrorBox error={repos.error} />}
      {repos.loading && !repos.data && <Loading />}
      {repos.data && withSpines.length === 0 && <Empty>No EpicSpine repos found.</Empty>}
      <div className="grid gap-4">
        {(showAll ? [...withSpines, ...others] : withSpines).map((r) => (
          <RepoSpines key={r.name} repo={r} social={r.name === socialRepo} />
        ))}
      </div>
      {others.length > 0 && !showAll && (
        <button type="button" className="mt-4 text-xs text-muted-foreground hover:underline" onClick={() => setShowAll(true)}>
          Show {others.length} repos without EpicSpine
        </button>
      )}
    </>
  );
}

function RepoSpines({ repo, social }: { repo: Repo; social?: boolean }) {
  const { data, error, busy, reload } = useRepoSpines(repo.name);
  const [open, setOpen] = useState(true);
  const asks = data?.nodes.reduce((s, n) => s + n.openAsks, 0) ?? 0;
  return (
    <Card id={repo.name} data-testid="repo-spines">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <button type="button" className="flex items-center gap-1.5 font-medium" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <FoldChevron open={open} />
          {repo.name}
        </button>
        {repo.remote && <span className="font-mono text-xs text-muted-foreground">{repo.remote}</span>}
        {data && (
          <span className="text-xs text-muted-foreground" data-testid="spine-count">
            {data.nodes.length} spine{data.nodes.length === 1 ? "" : "s"}
          </span>
        )}
        {asks > 0 && <Badge variant="red">{asks} open ask{asks === 1 ? "" : "s"}</Badge>}
        {social && (
          <Link to={socialHref("socialHome", repo.name)} className="text-xs underline" data-testid="social-screens">
            Social screens
          </Link>
        )}
        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {data && <span>read <RelTime iso={data.fetchedAt} /></span>}
          <button type="button" aria-label={`Refresh ${repo.name}`} onClick={reload} disabled={busy}>
            <RotateCw className={cn("h-3.5 w-3.5", (busy || data?.refreshing) && "animate-spin")} />
          </button>
        </span>
      </div>
      {open && (
        <div className="px-2 py-2">
          {error && !data && <ErrorBox error={error} muted />}
          {!data && !error && <Loading />}
          {data && data.nodes.length === 0 && <div className="px-2 py-1 text-sm text-muted-foreground">No spines.</div>}
          <ul className="grid gap-0.5">
            {data?.nodes.map((n) => (
              <li key={n.path} data-testid="spine-row">
                <Link
                  to={spineViewHref({ repo: repo.name, path: n.path, title: n.title })}
                  className="flex items-start gap-2 rounded-md py-1 pr-2 text-sm hover:bg-accent/50"
                  style={{ paddingLeft: n.depth * 20 + 8 }}
                >
                  <TreeDot node={{ color: n.color, flags: [] }} className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="font-medium">{n.title}</span>
                      <span className="text-xs text-muted-foreground">{n.status}</span>
                      {n.rollup && n.rollup !== n.status && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground" title="rollup status (aggregate of child spines)">
                          <TreeDot node={{ color: n.rollupColor, flags: [] }} className="h-2.5 w-2.5" /> rollup {n.rollup}
                        </span>
                      )}
                      {n.dod.total > 0 && (
                        <span className="text-xs tabular-nums text-muted-foreground">
                          DoD {n.dod.done}/{n.dod.total}
                        </span>
                      )}
                      {n.openAsks > 0 && (
                        <Badge variant="red" data-testid="open-asks">
                          {n.openAsks} ask{n.openAsks === 1 ? "" : "s"}
                        </Badge>
                      )}
                      {n.milestoneId && <Badge variant="gray">tracked</Badge>}
                      {n.orphan && <Badge variant="amber" title={n.orphan}>orphan</Badge>}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">{n.path}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
