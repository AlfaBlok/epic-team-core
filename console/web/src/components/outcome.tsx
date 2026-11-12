import { useState, type ReactNode } from "react";
import { CheckSquare, ExternalLink, Square } from "lucide-react";
import { Link } from "react-router-dom";
import type { CurrentState, Milestone, MilestoneStatusView, Outcome, Run, Verdict, WaitingItem } from "@/api";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { RelTime, ThreadLink } from "@/components/common";
import { formatDateTime, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { isWakeRun } from "@/lib/derive";
import { hasInlineLinks, linkSegments } from "@/lib/mdlinks";
import { InlineMd } from "@/pages/Milestone";

const VERDICT_VARIANT: Record<string, BadgeProps["variant"]> = {
  accomplished: "green",
  "accomplished?": "green",
  "partially accomplished": "amber",
  "not accomplished": "red",
  superseded: "gray",
  parked: "gray",
  "in progress": "blue",
};

/** Verdict chip (outcome or derived); `big` on the milestone page, small on Team rows. */
export function VerdictChip({ verdict, big }: { verdict?: Verdict; big?: boolean }) {
  if (!verdict) return null;
  return (
    <Badge
      variant={VERDICT_VARIANT[verdict.word] ?? (verdict.word.startsWith("blocked on ") ? "red" : "gray")}
      title={verdict.note ?? (verdict.source === "outcome" ? "from the spine's ## Outcome" : "derived by the console")}
      className={cn(big && "px-3 py-1 text-sm", verdict.word === "accomplished?" && "border-dashed border-emerald-500/60")}
    >
      {verdict.word}
    </Badge>
  );
}

/** outcome mark (server): never red; red is only for open items for the owner. */
export const OUTCOME_LABEL: Record<MilestoneStatusView["outcome"]["word"], string> = {
  not_yet: "not yet",
  ready_to_mark: "ready to mark",
  accomplished: "accomplished",
  partially: "partially accomplished",
  superseded: "superseded",
  reopened: "reopened",
};
const OUTCOME_VARIANT: Record<MilestoneStatusView["outcome"]["word"], BadgeProps["variant"]> = {
  not_yet: "gray",
  ready_to_mark: "green",
  accomplished: "green",
  partially: "amber",
  superseded: "gray",
  reopened: "amber",
};

export function OutcomeChip({ outcome, big }: { outcome?: MilestoneStatusView["outcome"]; big?: boolean }) {
  if (!outcome) return null;
  return (
    <Badge
      variant={OUTCOME_VARIANT[outcome.word]}
      title={outcome.note ?? (outcome.source === "outcome" ? "from the spine's ## Outcome" : "computed by the console")}
      className={cn(big && "px-3 py-1 text-sm", outcome.word === "ready_to_mark" && "border-dashed border-emerald-500/60")}
      data-testid="outcome-chip"
      data-outcome={outcome.word}
    >
      {OUTCOME_LABEL[outcome.word]}
      {outcome.word === "reopened" && outcome.open ? ` (${outcome.open} open)` : ""}
    </Badge>
  );
}

/** An evidence item → link: URL as is; short/long sha → commit; `PR #n` / `#n` → pull; repo path → blob. */
export function evidenceLink(item: string, remote?: string): { label: string; href?: string } {
  const s = item.trim();
  const gh = remote ? `https://github.com/${remote}` : undefined;
  if (/^https?:\/\//i.test(s)) {
    const pr = /github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/.exec(s);
    const sha = /github\.com\/[^/]+\/[^/]+\/commit\/([0-9a-f]{7})/.exec(s);
    return { label: pr ? `PR #${pr[1]}` : sha ? sha[1] : s.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60), href: s };
  }
  if (/^[0-9a-f]{7,40}$/.test(s)) return { label: s.slice(0, 7), href: gh && `${gh}/commit/${s}` };
  const pr = /^(?:PR\s*)?#(\d+)$/i.exec(s);
  if (pr) return { label: `PR #${pr[1]}`, href: gh && `${gh}/pull/${pr[1]}` };
  if (/^[\w.-]+(\/[\w.-]+)+$|\.md$/.test(s)) return { label: s, href: gh && `${gh}/blob/HEAD/${s.replace(/^\.\//, "")}` };
  return { label: s };
}

const LINK_CLASS = "min-w-0 font-mono text-xs text-foreground underline decoration-foreground/25 underline-offset-[3px] [overflow-wrap:anywhere] hover:decoration-current";

/** Spine text holding Markdown links / URLs: text stays text, each safe link is an <a>. */
export function LinkedText({ text, remote, path, className }: { text: string; remote?: string; path?: string; className?: string }) {
  return (
    <span className={className}>
      {linkSegments(text, { remote, path }).map((seg, i) =>
        seg.href ? (
          <a key={i} href={seg.href} target="_blank" rel="noopener noreferrer" className="underline decoration-foreground/25 underline-offset-[3px] [overflow-wrap:anywhere] hover:decoration-current">
            {seg.text}
          </a>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </span>
  );
}

/** `path` = the spine's repo path: Markdown link targets resolve against its folder. */
export function EvidenceLinks({ links, remote, path }: { links: string[]; remote?: string; path?: string }) {
  if (!links.length) return <span className="text-muted-foreground">no evidence</span>;
  return (
    <span className="flex min-w-0 flex-wrap gap-x-2 gap-y-0.5">
      {links.map((l, i) => {
        if (hasInlineLinks(l)) return <LinkedText key={i} text={l} remote={remote} path={path} className="min-w-0 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]" />;
        const { label, href } = evidenceLink(l, remote);
        return href ? (
          <a key={i} href={href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
            {label}
          </a>
        ) : (
          <span key={i} className="min-w-0 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {label}
          </span>
        );
      })}
    </span>
  );
}

const norm = (s: string) => s.replace(/[`*]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

interface DoneRow {
  label: string;
  done: boolean | null;
  links?: string[];
}

/** Done means items (doctrine, else DoD checkboxes), each with the evidence row that names it; unmatched evidence last. */
export function doneRows(m: Milestone, outcome?: Outcome | null): DoneRow[] {
  const items = m.doctrine?.doneMeans?.length
    ? m.doctrine.doneMeans.map((d) => ({ id: d.id, text: d.text, done: d.done as boolean | null }))
    : (m.dod?.items ?? []).map((d) => ({ id: d.id, text: d.text, done: d.checked }));
  const evidence = [...(outcome?.evidence ?? [])];
  const rows: DoneRow[] = items.map((it) => {
    const t = norm(it.text);
    const k = evidence.findIndex((e) => {
      const n = norm(e.doneMeans);
      return !!n && (n === t || n.endsWith(t) || t.endsWith(n) || (!!it.id && n.split(" ")[0] === norm(it.id)));
    });
    const e = k >= 0 ? evidence.splice(k, 1)[0] : undefined;
    return { label: it.id && !it.text.startsWith(it.id) ? `${it.id} ${it.text}` : it.text, done: it.done, links: e?.links };
  });
  for (const e of evidence) rows.push({ label: e.doneMeans || "(evidence)", done: null, links: e.links });
  return rows;
}

export const spineOutcomeUrl = (m: Pick<Milestone, "remote" | "path">) =>
  m.remote && m.path ? `https://github.com/${m.remote}/blob/HEAD/${m.path.replace(/^\.\//, "")}#outcome` : undefined;

/** The run named in `closed_by` (a console run id), if it is one of ours. */
export function closingRun(closedBy: string | null | undefined, runs: Run[]): Run | undefined {
  if (!closedBy) return undefined;
  return runs.find((r) => closedBy.includes(r.id));
}

/** Top of the milestone page: verdict, outcome sentence, Done means x/y with evidence, risk, closed at/by. */
export function OutcomeCard({ m, runs = [], outcome }: { m: Milestone; runs?: Run[]; outcome?: MilestoneStatusView["outcome"] }) {
  const o = m.outcome ?? null;
  const rows = doneRows(m, o);
  const tracked = rows.filter((r) => r.done !== null);
  const done = tracked.filter((r) => r.done).length;
  const url = spineOutcomeUrl(m);
  const run = closingRun(o?.closedBy, runs);
  return (
    <Card className="mb-4" data-testid="outcome-card">
      <CardContent className="grid grid-cols-1 gap-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3">
          {outcome ? <OutcomeChip outcome={outcome} big /> : <VerdictChip verdict={m.verdict} big />}
          {tracked.length > 0 && (
            <span className="text-sm text-muted-foreground">
              Done means {done}/{tracked.length}
            </span>
          )}
          {m.verdict?.note && <span className="text-xs text-muted-foreground">{m.verdict.note}</span>}
          {url && (
            <a href={url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline">
              Open spine: Outcome <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        {o?.sentence && <LinkedText text={o.sentence} remote={m.remote} path={m.path} className="block break-words text-base" />}
        {rows.length > 0 && (
          <ul className="grid gap-1.5">
            {rows.map((r, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                {r.done === null ? (
                  <span aria-hidden className="mx-1.5 mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
                ) : r.done ? (
                  <CheckSquare className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Square className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="grid min-w-0 gap-0.5">
                  <LinkedText text={r.label} remote={m.remote} path={m.path} className="break-words" />
                  {o && <EvidenceLinks links={r.links ?? []} remote={m.remote} path={m.path} />}
                </span>
              </li>
            ))}
          </ul>
        )}
        {o && (o.risk || o.closedAt || o.closedBy) && (
          <div className="grid gap-1 border-t pt-3 text-xs text-muted-foreground">
            <span>Risk: {o.risk ?? "none"}</span>
            {(o.closedAt || o.closedBy) && (
              <span className="flex flex-wrap items-center gap-x-1.5">
                Closed{o.closedAt && <> <RelTime iso={o.closedAt} /></>}
                {o.closedBy && <> by {o.closedBy}</>}
                {run && (
                  <>
                    {" · "}
                    <a className="hover:text-foreground hover:underline" href={`?tab=activity#run-${run.id}`}>
                      closing run
                    </a>
                    {run.threadId && (
                      <ThreadLink className="inline-flex items-center gap-1 hover:text-foreground hover:underline" threadId={run.threadId} environmentId={run.environmentId}>
                        thread <ExternalLink className="h-3 w-3" />
                      </ThreadLink>
                    )}
                  </>
                )}
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Top of every milestone tab: the Outcome when the spine has one, else the latest written Current State. */
export function MilestoneTopCard({ m, runs = [], open, waitingHref, outcome }: { m: Milestone; runs?: Run[]; open?: WaitingItem[]; waitingHref?: string; outcome?: MilestoneStatusView["outcome"] }) {
  return m.outcome ? <OutcomeCard m={m} runs={runs} outcome={outcome} /> : <CurrentStateCard m={m} runs={runs} open={open} waitingHref={waitingHref} outcome={outcome} />;
}

/** "Verified at: 2026-10-16 03:10 CEST" → epoch ms of the date/time part (zone ignored); NaN when unreadable. */
export function parseVerifiedAt(text?: string): number {
  const m = text && /(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(text);
  return m ? Date.parse(`${m[1]}T${m[2] ?? "00:00"}:00Z`) : NaN;
}

/**
 * When the state was last written — `Verified at:`, else the spine's last commit — and whether it is stale:
 * older than the milestone's last run endedAt (the persona ran but did not update Current State).
 */
export function stateFreshness(m: Pick<Milestone, "spineCommitAt" | "state">, runs: Run[]) {
  const verified = parseVerifiedAt(m.state?.verifiedAt ?? undefined);
  const updated = Number.isFinite(verified) ? verified : m.spineCommitAt ? Date.parse(m.spineCommitAt) : NaN;
  const lastEnd = runs
    .filter((r) => isWakeRun(r) && r.endedAt)
    .map((r) => Date.parse(r.endedAt!))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];
  return {
    updatedAt: Number.isFinite(updated) ? new Date(updated).toISOString() : undefined,
    from: Number.isFinite(verified) ? ("verified at" as const) : ("spine commit" as const),
    lastRunEndedAt: lastEnd === undefined ? undefined : new Date(lastEnd).toISOString(),
    stale: Number.isFinite(updated) && lastEnd !== undefined && updated < lastEnd,
  };
}

/** Long text clamped to two lines with a more / less toggle. */
export function Clamp({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 160;
  return (
    <span className={cn("min-w-0", className)}>
      <span className={cn("break-words [overflow-wrap:anywhere]", !open && long && "line-clamp-2")}>
        <InlineMd text={text} />
      </span>
      {long && (
        <button type="button" className="text-xs text-muted-foreground hover:text-foreground hover:underline" onClick={() => setOpen(!open)}>
          {open ? "less" : "more"}
        </button>
      )}
    </span>
  );
}

function StateRow({ label, text, className, children }: { label: string; text?: string | null; className?: string; children?: ReactNode }) {
  if (!text) return null;
  return (
    <div className={cn("grid min-w-0 grid-cols-1 gap-0.5 text-sm sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-3", className)}>
      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground sm:pt-0.5">{label}</span>
      {children ?? <Clamp text={text} />}
    </div>
  );
}

/** `Evidence:` text → items split on `,` / `;` (outside link parens); Markdown links stay whole (EvidenceLinks renders them). */
export function evidenceItems(text: string): string[] {
  return text
    .split(/[,;](?![^(]*\))/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** No `## Outcome` yet: the spine's latest written state, how fresh it is, and the derived verdict. */
/**
 * the Waiting on row is highlighted (amber, linking to Waiting on you) only when the milestone is Needs you:
 * `open` = its open asks, the same list the header strip counts. Text naming the owner alone never colours it.
 */
export function CurrentStateCard({ m, runs = [], open = [], waitingHref, outcome }: { m: Milestone; runs?: Run[]; open?: WaitingItem[]; waitingHref?: string; outcome?: MilestoneStatusView["outcome"] }) {
  const st: Partial<CurrentState> = m.state ?? {};
  const rows = doneRows(m).filter((r) => r.done !== null);
  const done = rows.filter((r) => r.done).length;
  const f = stateFreshness(m, runs);
  const url = m.remote && m.path ? `https://github.com/${m.remote}/blob/HEAD/${m.path.replace(/^\.\//, "")}#current-state` : undefined;
  const needsYou = open.length > 0;
  const empty = !st.status && !st.lastAttempted && !st.result && !st.evidence && !st.waitingOn && !st.nextAction;
  return (
    <Card className="mb-4" data-testid="state-card">
      <CardContent className="grid grid-cols-1 gap-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3">
          {outcome ? <OutcomeChip outcome={outcome} big /> : <VerdictChip verdict={m.verdict} big />}
          {rows.length > 0 && (
            <span className="text-sm text-muted-foreground">
              Done means {done}/{rows.length}
            </span>
          )}
          {f.updatedAt && (
            <span className="text-xs text-muted-foreground" title={`${f.from}: ${formatDateTime(f.updatedAt)}`}>
              updated {formatRelative(f.updatedAt)}
            </span>
          )}
          {f.stale && (
            <span
              className="min-w-0 break-words rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-400"
              title={`last run ended ${formatDateTime(f.lastRunEndedAt)}`}
            >
              stale: a run ended {formatRelative(f.lastRunEndedAt)} without updating it
            </span>
          )}
          {url && (
            <a href={url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline">
              Open spine: Current State <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        {empty ? (
          <p className="text-sm text-muted-foreground">
            {m.docError ? `Could not read the file: ${m.docError}` : "No Status / Last attempted / Result / Waiting on / Next action lines in ## Current State."}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-2">
            <StateRow label="Status" text={st.status} />
            <StateRow label="Last attempted" text={st.lastAttempted} />
            <StateRow label="Result" text={st.result} />
            <StateRow label="Evidence" text={st.evidence}>
              <EvidenceLinks links={evidenceItems(st.evidence ?? "")} remote={m.remote} path={m.path} />
            </StateRow>
            <StateRow
              label="Waiting on"
              text={st.waitingOn}
              className={cn(needsYou && "rounded-md border border-amber-500/40 bg-amber-500/5 px-2 py-1")}
            >
              {needsYou ? (
                <span className="grid min-w-0 gap-0.5" data-testid="waiting-on-needs-you">
                  <Clamp text={st.waitingOn ?? ""} />
                  {waitingHref && (
                    <Link to={waitingHref} className="text-xs font-medium text-amber-800 hover:underline dark:text-amber-300">
                      {open.length} waiting on you →
                    </Link>
                  )}
                </span>
              ) : undefined}
            </StateRow>
            <StateRow label="Next action" text={st.nextAction} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
