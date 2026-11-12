import type { Run, RunCheck } from "@/api";
import { OutcomeBadge } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { RubricScore } from "@/components/rubricScore";

/** the run is the Unblocker's (persona name) or carries the asks it checked. */
export const isUnblockerRun = (r: Run, personaName?: string) => !!r.checks?.length || /unblocker/i.test(personaName ?? "");

/** answered (split counts as answered: it answered the parts it could) · left. */
export function checkCounts(checks: RunCheck[] = []) {
  const left = checks.filter((c) => c.decision === "left").length;
  const split = checks.filter((c) => c.decision === "split").length;
  return { answered: checks.length - left, left, split };
}

/**
 * an ended Unblocker run reads "Unblocker · answered N · left M", never "idle" (the owner: "when unblocker unblocks, in the
 * logs on Activity I WANT TO SEE IT"). Running, failed, blocked and unreported runs keep their outcome badge.
 */
export function RunOutcomeChip({ run, personaName }: { run: Run; personaName?: string }) {
  const ended = run.outcome === "progressed" || run.outcome === "idle";
  if (!ended || !isUnblockerRun(run, personaName)) return <OutcomeBadge outcome={run.outcome} run={run} />;
  const { answered, left, split } = checkCounts(run.checks);
  const label = run.checks
    ? `Unblocker · answered ${answered} · left ${left}${split ? ` · split ${split}` : ""}`
    : run.outcome === "idle"
      ? "Unblocker · answered none"
      : "Unblocker · answered (see summary)";
  return (
    <Badge variant={answered ? "green" : "gray"} data-testid="unblocker-chip" title={run.checks ? undefined : "This run did not list the asks it checked."}>
      {label}
    </Badge>
  );
}

/** `docs/x.md:42` → GitHub blob link at that line (needs the repo remote). */
export function spineLineHref(spine?: string, remote?: string) {
  if (!spine || !remote) return undefined;
  const m = /^(.*?)(?::(\d+))?$/.exec(spine.trim());
  if (!m?.[1]) return undefined;
  return `https://github.com/${remote}/blob/HEAD/${m[1].replace(/^\.?\//, "")}${m[2] ? `#L${m[2]}` : ""}`;
}

/**
 * one line per ask the run checked: ANSWERED (answer, confidence, source, spine link) / SPLIT / LEFT (why).
 * a remembered verdict carried unchanged reads `left (unchanged since <run>)`.
 */
export function RunChecks({ checks, remote, className }: { checks?: RunCheck[]; remote?: string; className?: string }) {
  if (!checks?.length) return null;
  return (
    <ul className={cn("grid gap-1 text-xs", className)} data-testid="run-checks">
      {checks.map((c, i) => {
        const href = spineLineHref(c.spine, remote);
        const left = c.decision === "left";
        return (
          <li key={`${c.code}:${i}`} className="flex min-w-0 flex-wrap items-baseline gap-x-2" data-testid="run-check">
            {href ? (
              <a className="font-mono font-semibold text-sky-700 hover:underline dark:text-sky-400" href={href} target="_blank" rel="noreferrer" title={c.spine}>
                {c.code}
              </a>
            ) : (
              <span className="font-mono font-semibold" title={c.spine}>
                {c.code}
              </span>
            )}
            <span className={cn("font-semibold uppercase tracking-wide", left ? "text-muted-foreground" : "text-emerald-700 dark:text-emerald-400")}>
              {c.carriedFrom ? `left (unchanged since ${c.carriedFrom})` : c.decision}
            </span>
            {left ? (
              <span className="min-w-0 text-muted-foreground">
                {c.why ?? "no reason given"}
                {c.searched && <span> · searched: {c.searched}</span>}
                <RubricScore check={c} />
                {c.skipped && !c.carriedFrom && <span> · not re-checked (nothing new)</span>}
              </span>
            ) : (
              <span className="min-w-0">
                {c.answer ?? "(no answer text)"}
                {c.confidence !== undefined && <span className="text-muted-foreground"> · {c.confidence}% confident</span>}
                {c.source && <span className="text-muted-foreground"> · source: {c.source}</span>}
                {c.why && <span className="text-muted-foreground"> · why: {c.why}</span>}
                <RubricScore check={c} />
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
