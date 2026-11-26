import { useCallback, useEffect, useState } from "react";
import { api } from "@/api";

/**
 * Which desk an objective's Chat chapter talks to. The owner's screenshot: an objective's Chat chapter
 * showed "No team runs this objective yet" and the chat came back a moment later. One scorecards read that came back
 * without the objective's milestone was taken as "no team". Now:
 * - the scorecards read names the milestone: the chat opens on it, and it is remembered for this session;
 * - a later read that drops it keeps the remembered desk on screen while one fresh read checks;
 * - with nothing known yet, the chapter says it is looking (pending) or that the read failed, with a retry;
 * - "no team" shows only when that fresh read answered and truly names no team.
 */
export type DeskRead = { state: "ready"; id: string } | { state: "checking" } | { state: "none" } | { state: "failed"; message: string };

type Fetch = (id: string) => Promise<{ milestoneId: string | null }>;

/** objective id → the milestone last seen for it, this session. */
const lastDesk = new Map<string, string>();
export const forgetDesks = () => lastDesk.clear();

export function useObjectiveDesk(objectiveId: string, fromScorecards: string | undefined, read: Fetch = (id) => api.objectiveDesk(id)): { desk: DeskRead; retry: () => void } {
  if (fromScorecards) lastDesk.set(objectiveId, fromScorecards);
  const [tries, setTries] = useState(0);
  const [check, setCheck] = useState<{ for: string; desk: DeskRead } | undefined>();
  useEffect(() => {
    if (fromScorecards) return;
    let live = true;
    setCheck({ for: objectiveId, desk: { state: "checking" } });
    read(objectiveId).then(
      (r) => {
        if (!live) return;
        if (r.milestoneId) lastDesk.set(objectiveId, r.milestoneId);
        else lastDesk.delete(objectiveId);
        setCheck({ for: objectiveId, desk: r.milestoneId ? { state: "ready", id: r.milestoneId } : { state: "none" } });
      },
      (e: unknown) => {
        if (live) setCheck({ for: objectiveId, desk: { state: "failed", message: e instanceof Error ? e.message : String(e) } });
      },
    );
    return () => {
      live = false;
    };
    // `read` is a plain function; a new one each render must not read again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectiveId, fromScorecards, tries]);
  const retry = useCallback(() => setTries((n) => n + 1), []);
  if (fromScorecards) return { desk: { state: "ready", id: fromScorecards }, retry };
  const known = lastDesk.get(objectiveId);
  const got = check?.for === objectiveId ? check.desk : ({ state: "checking" } as DeskRead);
  // a desk seen before stays on screen while the fresh read checks or fails: a slow or failed read is never "no team".
  if (known && (got.state === "checking" || got.state === "failed")) return { desk: { state: "ready", id: known }, retry };
  return { desk: got, retry };
}
