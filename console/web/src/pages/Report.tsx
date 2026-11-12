import { useMemo } from "react";
import { Link } from "react-router-dom";
import { api, type RunOutcome } from "@/api";
import { useQuery } from "@/lib/data";
import { useWords } from "@/lib/skin";
import { buildWeeklyReport, MOCK_CREDITS, postsOf, type CreditsView } from "@/lib/social";
import { useSocial } from "@/lib/useSocial";
import { Card } from "@/components/ui/card";
import { Empty, ErrorBox, Loading, OutcomeBadge, PageHeader, RelTime } from "@/components/common";
import { ClampText } from "@/components/unblock";

/** Badge for numbers that are not the world's real data yet (sample posts, mock credits). */
function SampleTag({ testId, children }: { testId: string; children: string }) {
  return (
    <span data-testid={testId} className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-700 dark:text-amber-400">
      {children}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0 rounded-md border p-3">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="truncate text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function Section({ title, tag, children, testId }: { title: string; tag?: React.ReactNode; children: React.ReactNode; testId: string }) {
  return (
    <Card className="min-w-0 p-4" data-testid={testId}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {tag}
      </div>
      {children}
    </Card>
  );
}

const fmtDay = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const OUTCOME_ORDER: RunOutcome[] = ["progressed", "monitoring", "idle", "blocked", "failed", "running", "deferred", "blank_report", "stopped"];

export function CreditsCard({ credits = MOCK_CREDITS }: { credits?: CreditsView }) {
  return (
    <Section title="Credits" testId="credits" tag={credits.mock && <SampleTag testId="credits-mock">placeholder</SampleTag>}>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-3xl font-semibold tabular-nums" data-testid="credits-balance">
          {credits.balance.toLocaleString("en-GB")}
        </span>
        <span className="text-sm text-muted-foreground">
          credits left (≈ €{(credits.balance / 100).toLocaleString("en-GB", { minimumFractionDigits: 2 })})
        </span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {credits.plan} plan: {credits.monthlyGrant.toLocaleString("en-GB")} credits a month.
      </p>
      {credits.mock && <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">Placeholder value, not your real balance: credits are not metered yet.</p>}
    </Section>
  );
}

/** what the team did this week, plus the credits balance. Social skin only (lib/skin.tsx "report"). Posts come from the pack export. */
export function ReportPage({ now: nowProp }: { now?: Date }) {
  const w = useWords();
  const { data: runs, error, loading } = useQuery(() => api.listRuns(), []);
  const { data: personas = [] } = useQuery(() => api.listPersonas(), []);
  const now = useMemo(() => nowProp ?? new Date(), [nowProp]);
  const { data: social } = useSocial(); // posts from the pack export
  const posts = useMemo(() => postsOf(social?.data), [social]);
  const report = useMemo(() => (runs ? buildWeeklyReport({ runs, personas, posts, now }) : undefined), [runs, personas, posts, now]);

  return (
    <>
      <PageHeader title="Weekly report" description={report ? `Last 7 days: ${fmtDay(report.from)} – ${fmtDay(report.to)} (UTC)` : "What your team did this week."} />
      {error && <ErrorBox error={error} />}
      {loading && !runs && <Loading />}
      {report && (
        <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
          <Section title="Posts" testId="report-posts" tag={social?.sample && <SampleTag testId="posts-sample">sample</SampleTag>}>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Stat label="Drafted" value={report.posts.drafted} />
              <Stat label="Scheduled" value={report.posts.scheduled} />
              <Stat label="Published" value={report.posts.published} />
              <Stat label="Replies sent" value={report.posts.repliesSent} />
              <Stat label="Replies received" value={report.posts.repliesReceived} />
              <Stat label="Waiting on you" value={report.posts.waiting} />
            </div>
            {social?.sample && <p className="mt-2 text-xs text-muted-foreground">Sample posts: no console server here.</p>}
            {social && !social.sample && !social.repo && <p className="mt-2 text-xs text-muted-foreground">No social repo in this world yet.</p>}
          </Section>

          <CreditsCard />

          <Section title={`${w.runs} this week`} testId="report-runs">
            {report.runs.total === 0 ? (
              <Empty>No {w.runs.toLowerCase()} this week yet.</Empty>
            ) : (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-semibold tabular-nums" data-testid="runs-total">
                    {report.runs.total}
                  </span>
                  <span className="text-muted-foreground">in total</span>
                  {OUTCOME_ORDER.filter((o) => report.runs.byOutcome[o]).map((o) => (
                    <span key={o} className="flex items-center gap-1">
                      <OutcomeBadge outcome={o} />
                      <span className="tabular-nums">{report.runs.byOutcome[o]}</span>
                    </span>
                  ))}
                </div>
                <ul className="divide-y text-sm">
                  {report.runs.byPersona.map((p) => (
                    <li key={p.personaId} className="min-w-0 py-2" data-testid="report-persona">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium">{p.name}</span>
                        <span className="text-muted-foreground">
                          ran {p.runs} {p.runs === 1 ? "time" : "times"}, {p.progressed} moved work forward
                        </span>
                        {p.last && <RelTime iso={p.last.startedAt} now={now.getTime()} className="ml-auto text-xs text-muted-foreground" />}
                      </div>
                      {p.last?.summary && <ClampText text={p.last.summary} lines={2} links={false} className="mt-0.5 text-muted-foreground" />}
                    </li>
                  ))}
                </ul>
                <Link to="/runs" className="mt-2 inline-block text-sm underline">
                  All {w.runs.toLowerCase()}
                </Link>
              </>
            )}
          </Section>

          <Section title="Listening highlights" testId="report-listening">
            {report.listening.length === 0 ? (
              <Empty>Nothing heard this week yet.</Empty>
            ) : (
              <ul className="divide-y text-sm">
                {report.listening.map((r) => (
                  <li key={r.id} className="min-w-0 py-2" data-testid="listening-item">
                    <RelTime iso={r.startedAt} now={now.getTime()} className="text-xs text-muted-foreground" />
                    <ClampText text={r.summary} lines={3} links={false} />
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}
    </>
  );
}
