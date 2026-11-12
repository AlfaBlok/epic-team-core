import { Link } from "react-router-dom";
import { api, type MovingEpic } from "@/api";
import { formatRelative } from "@/lib/format";
import { useQuery } from "@/lib/data";
import { FoldSection, useSectionOpen } from "@/components/homeSection";
import { zoned } from "@/lib/status";
import { LimitControl, LIST_LIMITS, ListPane, useListLimit } from "@/components/listPane";
import { useProject } from "@/lib/project";

/** An epic with ready rows and nothing moving for this long reads amber (the stall watch's window). */
export const STILL_MS = 2 * 3600_000;

/** One line's words: "2 workers · commit 3 h ago · 1 row done today". */
export function movingWords(e: MovingEpic, now: number) {
  const workers = e.workers.length
    ? `${e.workers.length} worker${e.workers.length === 1 ? "" : "s"} (${e.workers.map((w) => w.ticket).join(", ")})`
    : "no worker";
  const commit = e.lastCommitAt ? `commit ${formatRelative(e.lastCommitAt, new Date(now))}` : "no commit";
  const done = `${e.doneToday.length} row${e.doneToday.length === 1 ? "" : "s"} done today`;
  return { workers, commit, done };
}

/** Ready rows waiting, no worker, and no commit for 2 h: what the stall watch would wake the Delivery manager for. */
export const isStill = (e: MovingEpic, now: number) =>
  !e.workers.length && e.ready.length > 0 && (!e.lastCommitAt || now - Date.parse(e.lastCommitAt) >= STILL_MS);

/** how many lines the strip asks the server for; 0 = all (the shared list pane's choices). */
export const MOVING_LIMITS = LIST_LIMITS;

/**
 * the Team page's "Moving now" strip. Per epic: worker running · last commit age ·
 * rows done today; an epic with ready rows and nothing moving for 2 h reads amber.
 * folds on its heading with the count (remembered); unfolded, one compact line per spine in a scroll pane
 * about 20 lines tall, and Show 20 / 50 / all (default 20) is what the server returns. The server sends each spine once,
 * workers first then the most recent commit; the sort here only keeps that order for an older server.
 */
export function MovingNow({ now = Date.now() }: { now?: number }) {
  const [open, setOpen] = useSectionOpen("moving-now");
  const [limit, setLimit] = useListLimit("moving-now");
  // inside Epic Social the strip follows the selected project (its milestones, and any no project owns); narrowed,
  // it asks for every epic and cuts to the limit here, so the count is the project's.
  const project = useProject();
  const narrowed = !!project.current;
  const q = useQuery(() => api.movingNow(narrowed ? undefined : limit || undefined), [limit, narrowed]);
  const mine = (q.data?.epics ?? []).filter((e) => project.keep(e.milestoneId));
  const sorted = [...mine].sort((a, b) => b.workers.length - a.workers.length || (b.lastCommitAt ?? "").localeCompare(a.lastCommitAt ?? ""));
  const epics = narrowed && limit ? sorted.slice(0, limit) : sorted;
  const total = q.data ? (narrowed ? mine.length : (q.data.total ?? q.data.epics.length)) : undefined;
  return (
    <FoldSection
      title="Moving now"
      count={total}
      testId="moving-now"
      open={open}
      onToggle={setOpen}
      actions={<LimitControl limit={limit} onChange={setLimit} total={total} testId="moving-now" />}
      bodyClassName="text-sm"
    >
          {q.loading && !q.data && <p className="text-muted-foreground">…</p>}
          {q.data && epics.length === 0 && (
            <p className="text-muted-foreground" data-testid="moving-now-empty">
              No ready or active epic
            </p>
          )}
          {epics.length > 0 && (
            <ListPane shown={epics.length} total={total ?? epics.length} testId="moving-now">
              {epics.map((e) => {
                const w = movingWords(e, now);
                const still = isStill(e, now);
                const words = [w.workers, w.commit, w.done, ...(still ? [`${e.ready.length} ready, nothing moving`] : [])].join(" · ");
                return (
                  <li key={`${e.repo}:${e.path}`} className="flex min-w-0 items-baseline gap-x-2 whitespace-nowrap" data-testid="moving-epic" data-still={still || undefined} title={`${e.title}\n${words}`}>
                    <Link to={`/milestones/${e.milestoneId}?tab=tree`} className="min-w-0 max-w-[60%] shrink-0 truncate font-medium hover:underline" title={`${e.repo} · ${e.path}`}>
                      {e.title}
                    </Link>
                    <span className="min-w-0 flex-1 truncate text-xs">
                      <span className={e.workers.length ? "text-emerald-700 dark:text-emerald-400" : still ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"}>{w.workers}</span>
                      <span className="text-muted-foreground" title={e.lastCommitAt ? zoned(e.lastCommitAt) : undefined}>
                        {" "}
                        · {w.commit}
                      </span>
                      <span className="text-muted-foreground" title={e.doneToday.join(", ") || undefined}>
                        {" "}
                        · {w.done}
                      </span>
                      {still && (
                        <span className="text-amber-700 dark:text-amber-400" data-testid="moving-still">
                          {" "}
                          · {e.ready.length} ready, nothing moving
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ListPane>
          )}
    </FoldSection>
  );
}
