import { ClaimChip } from "@/components/tree";
import { Link } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import { ACTIVE_THREAD_STATUSES, api } from "@/api";
import type { BoardPersona, BoardSeat } from "@/api/types";
import { useQuery } from "@/lib/data";
import { formatDateTime, formatRelative, milestoneName } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Empty, ErrorBox, Loading, PageHeader, RelTime, ThreadLink } from "@/components/common";
import { TicketStatus } from "@/pages/Milestone";
import { FoldSection, useSectionOpen } from "@/components/homeSection";
import { LimitControl, ListPane, useListLimit } from "@/components/listPane";
import { cap, useWords } from "@/lib/skin";

function useMilestoneTitles() {
  const { data = [] } = useQuery(() => api.listMilestones(), []);
  return (id?: string) => {
    const m = id ? data.find((x) => x.id === id) : undefined;
    return m ? (
      <Link to={`/milestones/${m.id}`} className="hover:underline" title={milestoneName(m)}>
        {milestoneName(m)}
      </Link>
    ) : (
      <span className="text-muted-foreground">—</span>
    );
  };
}

export function ThreadsPage() {
  const { data, error, loading } = useQuery(() => api.listThreads(), []);
  const milestone = useMilestoneTitles();
  const w = useWords();
  return (
    <>
      <PageHeader title="Threads" description="Open T3 threads across repos, active first." />
      {error && <ErrorBox error={error} muted />}
      {loading && <Loading />}
      {data?.length === 0 && <Empty>No active threads.</Empty>}
      {data && data.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Thread</TableHead>
              {/* a thread's project field is its repo; Project now names the milestone, as everywhere on EpicTeam. */}
              <TableHead>Repo</TableHead>
              <TableHead>{cap(w.milestone)}</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="min-w-[12rem]">
                    <ThreadLink className="inline-flex items-center gap-1 hover:underline" threadId={t.id} environmentId={t.environmentId}>
                      {t.title} <ExternalLink className="h-3 w-3 text-muted-foreground" />
                    </ThreadLink>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{t.project}</TableCell>
                  <TableCell>{milestone(t.milestoneId)}</TableCell>
                  <TableCell>
                    <Badge variant={ACTIVE_THREAD_STATUSES.includes(t.status) ? "blue" : t.status === "failed" ? "red" : "gray"}>{t.status}</Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground"><RelTime iso={t.updatedAt} /></TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}

/**
 * the tickets sit in the shared scroll pane with Show 20 / 50 / all (default 20), which is what the
 * server sends (`?limit=`); one line per ticket (title cut, full on hover). On a phone: ticket, title and status only.
 */
export function TicketsPage() {
  const [limit, setLimit] = useListLimit("tickets");
  const [ticketsOpen, setTicketsOpen] = useSectionOpen("tickets");
  const { data: page, error, loading } = useQuery(() => api.listTicketsTop(limit || undefined), [limit]);
  const data = page?.tickets;
  const milestone = useMilestoneTitles();
  const w = useWords();
  return (
    <>
      <PageHeader title="Tickets" description={`Open ticket files and GitHub issues across project repos.`} />
      {error && <ErrorBox error={error} muted />}
      {loading && !page && <Loading />}
      {data?.length === 0 && <Empty>No tickets.</Empty>}
      {data && data.length > 0 && (
        <FoldSection
          title="Open tickets"
          count={page!.total}
          testId="tickets"
          open={ticketsOpen}
          onToggle={setTicketsOpen}
          actions={<LimitControl limit={limit} onChange={setLimit} total={page!.total} testId="tickets" />}
          bodyClassName="p-0"
        >
        <ListPane as="div" shown={data.length} total={page!.total} testId="tickets" className="[&>div]:rounded-none [&>div]:border-0" footClassName="mt-0 border-t px-4 py-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ticket</TableHead>
                <TableHead>Title</TableHead>
                <TableHead className="max-sm:hidden">{cap(w.milestone)}</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="max-sm:hidden">Owner</TableHead>
                <TableHead className="max-sm:hidden">Repo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((t) => (
                <TableRow key={`${t.repo}:${t.id}`}>
                  <TableCell className="whitespace-nowrap font-mono text-xs">
                    {t.url ? (
                      <a href={t.url} target="_blank" rel="noreferrer" className="hover:underline">
                        {t.id}
                      </a>
                    ) : (
                      t.id
                    )}
                  </TableCell>
                  <TableCell className="min-w-[12rem] max-w-[24rem] truncate max-sm:min-w-0 max-sm:max-w-[11rem]" title={t.title}>
                    {t.title}
                  </TableCell>
                  <TableCell className="min-w-[10rem] max-w-[16rem] truncate max-sm:hidden">
                    {milestone(t.milestoneId)}
                  </TableCell>
                  <TableCell className="max-w-[9rem] [&>*]:max-w-full">
                    <TicketStatus status={t.status} detail={t.statusDetail} />
                    <ClaimChip owner={t.owner} status={t.status} />
                  </TableCell>
                  <TableCell className="max-w-[10rem] truncate text-muted-foreground max-sm:hidden" title={t.owner}>
                    {t.owner ?? "—"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground max-sm:hidden">{t.repo}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ListPane>
        </FoldSection>
      )}
    </>
  );
}

function Load({ label, pct, none, testId }: { label: string; pct?: number; none?: string; testId?: string }) {
  return (
    <div className="flex items-center gap-2 text-xs" data-testid={testId}>
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      {none ? (
        <span className="text-muted-foreground">{none}</span>
      ) : pct === undefined ? (
        <span className="text-muted-foreground">not read</span>
      ) : (
        <>
          <Progress value={pct} className="h-1.5" />
          <span className="w-10 shrink-0 whitespace-nowrap text-right tabular-nums">{Math.round(pct)}%</span>
        </>
      )}
    </div>
  );
}

/** Fable credit left this week (percent left, not used): a Fable run goes only to a seat with some left. */
function FableLeft({ s }: { s: BoardSeat }) {
  const refused = s.fableNote?.startsWith("refused until ") ? s.fableNote.slice("refused until ".length) : undefined;
  const none = s.fableNote === "not in its plan" ? "none in its plan" : refused ? `none, back ${formatRelative(refused)}` : undefined;
  return (
    <div title={s.fableLeft === undefined ? undefined : "Fable credit left this week"}>
      <Load label="Fable left" pct={s.fableLeft} none={none} testId="seat-fable" />
    </div>
  );
}

const SEAT_STATE: Record<BoardSeat["state"], { label: string; variant: "green" | "blue" | "red" | "gray" | "amber" }> = {
  working: { label: "Working", variant: "green" },
  free: { label: "Free", variant: "blue" },
  limited: { label: "At its limit", variant: "amber" },
  signed_out: { label: "Signed out", variant: "red" },
  unknown: { label: "Load not read", variant: "gray" },
};

const seatNumber = (id: string) => id.replace(/^seat/i, "Seat ");

function People({ list, max }: { list: BoardPersona[]; max: number }) {
  if (!list.length) return <span className="text-muted-foreground">nobody</span>;
  const shown = list.slice(0, max);
  return (
    <span>
      {shown.map((p, i) => (
        <span key={`${p.world}-${p.name}`}>
          {i > 0 && ", "}
          <span className="text-foreground">{p.name}</span>
          {p.world && p.world !== "EpicTeam" && <span className="text-muted-foreground"> in {p.world}</span>}
          {p.runs > 1 && <span className="text-muted-foreground tabular-nums"> ×{p.runs}</span>}
        </span>
      ))}
      {list.length > max && <span className="text-muted-foreground">, {list.length - max} more</span>}
    </span>
  );
}

function SeatCard({ s }: { s: BoardSeat }) {
  const st = SEAT_STATE[s.state];
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border bg-card p-3" data-testid="seat-card" data-seat={s.id}>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold">{seatNumber(s.id)}</div>
          <div className="text-xs text-muted-foreground">{s.plan ?? "Plan not read"}</div>
        </div>
        <Badge className="shrink-0 whitespace-nowrap" variant={st.variant} title={s.limitedUntil ? `until ${formatDateTime(s.limitedUntil)}` : undefined}>
          {st.label}
        </Badge>
      </div>
      {s.state === "limited" && s.limitedUntil && (
        <div className="-mt-1 text-xs text-muted-foreground" title={formatDateTime(s.limitedUntil)}>
          Back {formatRelative(s.limitedUntil)}
        </div>
      )}
      <div className="text-xs">
        <div className="text-muted-foreground">On it now</div>
        {s.now.length === 0 && s.running > 0 ? (
          <span>{s.running === 1 ? "1 turn running" : `${s.running} turns running`}, its persona not recorded on this seat</span>
        ) : (
          <People list={s.now} max={2} />
        )}
      </div>
      <div className="text-xs">
        <div className="text-muted-foreground">Last 24 hours · {s.runs24h} {s.runs24h === 1 ? "turn" : "turns"}</div>
        <People list={s.day} max={3} />
      </div>
      <div className="mt-auto flex flex-col gap-1 border-t pt-2">
        <Load label="5 hours" pct={s.usage5h} />
        <Load label="Week" pct={s.usageWeekly} />
        <FableLeft s={s} />
      </div>
    </div>
  );
}

/**
 * Seats: every AI subscription the team runs on, who is on it and how loaded it is. Read-only (root L-80:
 * with the console's pages, never under Settings). Only real seats from seats.json: never padded to the 20 the
 * landing page shows; the gap is said in words. No account or company names.
 */
export function SeatsPage() {
  const { data, error, loading } = useQuery(() => api.getSeatBoard(), []);
  const count = data?.seats.length ?? 0;
  return (
    <>
      <PageHeader title="Seats" description="Every AI subscription the team runs on, who is on it, and how loaded it is." />
      {error && <ErrorBox error={error} muted />}
      {loading && <Loading />}
      {data && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4" data-testid="seat-summary">
            {[
              { n: count, what: count === 1 ? "AI subscription" : "AI subscriptions" },
              { n: data.workingNow, what: "working now" },
              { n: data.personas, what: data.personas === 1 ? "persona on them today" : "personas on them today" },
              { n: data.runs24h, what: "turns in 24 hours" },
            ].map((b) => (
              <div key={b.what} className="bg-card px-3 py-2.5">
                <div className="text-2xl font-semibold tabular-nums">{b.n}</div>
                <div className="text-xs text-muted-foreground">{b.what}</div>
              </div>
            ))}
          </div>
          <p className="mb-4 text-xs text-muted-foreground" data-testid="seat-target">
            {count >= data.target
              ? `${count} subscriptions running, the ${data.target} the landing page shows.`
              : `${count} of the ${data.target} subscriptions the landing page shows are running today; ${data.target - count} more are not bought yet. ${count - data.signedIn > 0 ? `${count - data.signedIn} signed out.` : "All signed in."}`}
            {data.fableSeats !== undefined && <> Fable credit left on {data.fableSeats} of {count}: Fable work goes only to those.</>}
            {data.readAt && <> Load read <RelTime iso={data.readAt} />.</>}
          </p>
          {count === 0 ? (
            <Empty>No seats yet.</Empty>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {data.seats.map((s) => (
                <SeatCard key={s.id} s={s} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
