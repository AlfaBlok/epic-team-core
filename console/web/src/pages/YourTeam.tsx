import { Link } from "react-router-dom";
import { api, type Assignment, type Persona, type Run, type RunOutcome } from "@/api";
import { useQuery } from "@/lib/data";
import { isWakeRun, nextWake, runPersonaId } from "@/lib/derive";
import { isLiveNow } from "@/lib/status";
import { Card, CardContent } from "@/components/ui/card";
import { ErrorBox, Loading, PageHeader, RelTime } from "@/components/common";
import { YOUR_TEAM_PATH } from "@/lib/routePaths";
export { YOUR_TEAM_PATH };

/**
 * "Your team", the four social personas as cards: what each did (last wakes, in
 * plain words), what it is doing now, and when it wakes next. Reads the existing persona, assignment and run routes.
 */
export const YOUR_TEAM_LABEL = "Your team";

export const TEAM_ROLES: { name: string; job: string }[] = [
  { name: "Listener", job: "Finds what people are talking about today." },
  { name: "Author", job: "Writes posts and drafts from what the Listener found." },
  { name: "Responder", job: "Answers replies and messages on our posts." },
  { name: "Engager", job: "Joins conversations worth being part of." },
];

const DID: Record<RunOutcome, string> = {
  running: "Working",
  progressed: "Got work done",
  monitoring: "Checked in, keeping watch",
  idle: "Nothing new to do",
  blocked: "Needed your OK",
  failed: "Hit a problem",
  blank_report: "Finished without saying what it did",
  stopped: "Stopped by you",
  deferred: "Waiting for room to start, will retry",
};

// Team-internal bookkeeping a customer does not need to read (ledger rows, workers, commits, run ids).
const JARGON = /\b(ready rows?|rows?|workers?|ledger|spine|epic|dispatch\w*|reconcil\w*|run_[0-9a-f]+)\b|\b[0-9a-f]{7,}\b/i;

/** A run summary in plain words: drops bookkeeping sentences and parentheticals with ids; empty when nothing is left. */
export function plainSummary(summary: string, max = 160): string {
  const cleaned = summary.replace(/\s*\([^)]*\b[0-9a-f]{7,}\b[^)]*\)/gi, "").replace(/\s+/g, " ");
  const kept = cleaned
    .split(/(?<=[.;!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s && !JARGON.test(s));
  const text = kept.join(" ");
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export interface MemberView {
  role: (typeof TEAM_ROLES)[number];
  persona?: Persona;
  recent: Run[];
  live?: Run;
  next?: { at?: string; off: boolean; retry: boolean };
}

/** Pure view model of one role card (tested directly). Recent = the last `n` ended wakes, newest first. */
export function memberView(role: MemberView["role"], personas: Persona[], assignments: Assignment[], runs: Run[], now: number, n = 3): MemberView {
  const persona = personas.find((p) => p.name.trim().toLowerCase() === role.name.toLowerCase());
  if (!persona) return { role, recent: [] };
  const mine = runs
    .filter((r) => isWakeRun(r) && runPersonaId(r, assignments) === persona.id)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const live = mine.find((r) => r.outcome === "running" && isLiveNow(r, now));
  const recent = mine.filter((r) => r.outcome !== "running").slice(0, n);
  const own = assignments.filter((a) => a.personaId === persona.id);
  const wakes = own
    .map((a) => ({ ...nextWake(a), a }))
    .filter((w) => w.at)
    .sort((x, y) => Date.parse(x.at!) - Date.parse(y.at!));
  const first = wakes[0];
  const next = first ? { at: first.at, off: false, retry: !!first.retry } : { off: true, retry: false };
  return { role, persona, recent, live, next };
}

/**
 * what a persona did lately, in plain words: its last `n` ended wakes' summaries
 * (bookkeeping dropped, empty ones skipped), newest first. The Personas page shows it on every row, both sites; it replaces
 * the Your team cards.
 */
export function latelyOf(personaId: string, assignments: Assignment[], runs: Run[], n = 3): string[] {
  return runs
    .filter((r) => isWakeRun(r) && r.outcome !== "running" && runPersonaId(r, assignments) === personaId)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .map((r) => plainSummary(r.summary ?? "", 90) || (r.outcome === "idle" ? "nothing new to do" : ""))
    .filter(Boolean)
    .slice(0, n);
}

function doingNow(v: MemberView): string {
  if (v.live) return "Working on it right now.";
  const last = v.recent[0];
  if (last?.outcome === "blocked") return "Waiting for your OK before going on.";
  if (last?.outcome === "monitoring") return "Keeping watch until its next check.";
  if (last?.outcome === "failed") return "Paused after a problem; it tries again at its next wake.";
  return v.next?.off ? "Resting. It is switched off." : "Resting until its next wake.";
}

function MemberCard({ v, now }: { v: MemberView; now: number }) {
  return (
    <Card data-testid="team-member" className="min-w-0">
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="min-w-0">
          <div className="text-base font-semibold">{v.role.name}</div>
          <div className="text-sm text-muted-foreground">{v.role.job}</div>
        </div>
        {!v.persona ? (
          <div className="text-sm text-muted-foreground">Not on your team yet.</div>
        ) : (
          <>
            <section>
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Doing now</div>
              <div className="text-sm" data-testid="doing-now">
                {doingNow(v)}
                {v.live && (
                  <>
                    {" "}
                    <span className="text-muted-foreground">
                      Started <RelTime iso={v.live.startedAt} now={now} />.
                    </span>
                  </>
                )}
              </div>
            </section>
            <section>
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Next wake</div>
              <div className="text-sm" data-testid="next-wake">
                {v.next?.at ? (
                  <>
                    <RelTime iso={v.next.at} now={now} />
                    {v.next.retry && <span className="text-muted-foreground"> (it asked to check back)</span>}
                  </>
                ) : (
                  "Only when you ask"
                )}
              </div>
            </section>
            <section className="min-w-0">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Lately</div>
              {v.recent.length === 0 ? (
                <div className="text-sm text-muted-foreground">Nothing yet.</div>
              ) : (
                <ul className="mt-1 grid gap-2" data-testid="recent">
                  {v.recent.map((r) => {
                    const text = plainSummary(r.summary);
                    return (
                      <li key={r.id} className="min-w-0 text-sm">
                        <span className="font-medium">{DID[r.outcome]}</span>
                        <span className="text-muted-foreground">
                          {" · "}
                          <RelTime iso={r.endedAt ?? r.startedAt} now={now} />
                        </span>
                        {text && <div className="break-words text-muted-foreground [overflow-wrap:anywhere]">{text}</div>}
                      </li>
                    );
                  })}
                </ul>
              )}
              <Link to={`/runs?persona=${encodeURIComponent(v.persona.id)}`} className="mt-2 inline-block text-xs underline">
                All activity
              </Link>
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function YourTeamPage({ now = Date.now() }: { now?: number }) {
  const { data: personas, error, loading } = useQuery(() => api.listPersonas(), []);
  const { data: assignments } = useQuery(() => api.listAssignments(), []);
  const { data: runs } = useQuery(() => api.listRuns(), []);
  const ready = personas && assignments && runs;
  return (
    <>
      <PageHeader title={YOUR_TEAM_LABEL} description="Four team members share the work: what each did, what it is doing, and when it wakes next." />
      {error && <ErrorBox error={error} />}
      {(loading || (!error && !ready)) && <Loading />}
      {ready && (
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2" data-testid="your-team">
          {TEAM_ROLES.map((role) => (
            <MemberCard key={role.name} v={memberView(role, personas, assignments, runs, now)} now={now} />
          ))}
        </div>
      )}
    </>
  );
}
