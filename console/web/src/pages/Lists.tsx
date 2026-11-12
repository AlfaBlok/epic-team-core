import { Link } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import { ACTIVE_THREAD_STATUSES, api } from "@/api";
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

function Usage({ pct }: { pct?: number }) {
  if (pct === undefined) return <span className="text-muted-foreground">unknown</span>;
  return (
    <div className="flex min-w-[8rem] items-center gap-2">
      <Progress value={pct} className="h-1.5" />
      <span className="w-9 text-right text-xs tabular-nums">{pct}%</span>
    </div>
  );
}

export function SeatsPage() {
  const { data, error, loading } = useQuery(() => api.listSeats(), []);
  return (
    <>
      <PageHeader title="Seats" description="Claude seats and their usage (from M1 seats.json, read-only)." />
      {error && <ErrorBox error={error} muted />}
      {loading && <Loading />}
      {data && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Seat</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>5-hour</TableHead>
              <TableHead>Weekly</TableHead>
              <TableHead>In flight</TableHead>
              <TableHead>Resets</TableHead>
              <TableHead>Read</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-medium">
                  {s.name}
                  {s.org && <span className="ml-2 text-xs font-normal text-muted-foreground">{s.org}</span>}
                </TableCell>
                <TableCell>
                  <Badge variant={s.status === "ok" ? "green" : s.status === "limited" ? "red" : "gray"} title={s.reason}>
                    {s.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Usage pct={s.usage5h} />
                </TableCell>
                <TableCell>
                  <Usage pct={s.usageWeekly} />
                </TableCell>
                <TableCell className="tabular-nums">{s.inFlight}</TableCell>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {s.limited && s.resetsAt.limitedUntil
                    ? <span title={formatDateTime(s.resetsAt.limitedUntil)}>limited, resets {formatRelative(s.resetsAt.limitedUntil)}</span>
                    : s.resetsAt.fiveHour
                      ? <span title={formatDateTime(s.resetsAt.fiveHour)}>5h {formatRelative(s.resetsAt.fiveHour)}</span>
                      : (s.reason ?? "—")}
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground"><RelTime iso={s.readAt} /></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
