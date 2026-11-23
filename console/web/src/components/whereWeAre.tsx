import { api } from "@/api";
import type { WhereWeAre } from "@/api/pursuit-types";
import { useQuery } from "@/lib/data";

/** "2026-11-22T22:30Z" as "22 Nov 22:30Z". */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function stampWords(at?: string): string {
  const m = at ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})Z$/.exec(at) : null;
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[4]}Z` : (at ?? "");
}

/**
 * The objective's one where-we-are (the kernel): the first thing on its Context tab. One file
 * beside its key results (docs/scorecards/<id>.md), read first and rewritten last by every worker and wake on it:
 * the answer now, the open questions, what changed. Nothing here is copied into tickets.
 */
export function WhereWeAreBox({ id }: { id: string }) {
  const { data, error, loading } = useQuery<WhereWeAre>(() => api.whereWeAre(id), [id]);
  const head = <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Where we are</div>;
  if (loading && !data) return <section className="rounded-xl border bg-card p-4 text-sm text-muted-foreground" data-testid="where-we-are">{head}Reading…</section>;
  if (error || !data) return <section className="rounded-xl border bg-card p-4 text-sm text-muted-foreground" data-testid="where-we-are">{head}Could not read it{error ? `: ${error.message}` : ""}.</section>;
  // drawn in place (no component of its own here), so the box that said Reading… is the box that shows it.
  return WhereWeAreView({ data });
}

/** the where-we-are drawn from its parts (an objective's Context reads it by id, a campaign's from the wheel it serves). */
export function WhereWeAreView({ data }: { data: WhereWeAre }) {
  const head = <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Where we are</div>;
  if (!data.present)
    return (
      <section className="grid gap-1.5 rounded-xl border border-dashed bg-card p-4" data-testid="where-we-are" data-present="false">
        {head}
        <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">None written yet. The next worker on this objective starts it, in {data.path}.</p>
      </section>
    );
  return (
    <section className="grid gap-4 rounded-xl border bg-card p-4" data-testid="where-we-are" data-present="true">
      <div className="grid gap-1.5">
        {head}
        <p className="whitespace-pre-line text-base leading-relaxed text-foreground [overflow-wrap:anywhere]" data-testid="where-answer">
          {data.answer ?? "No answer written."}
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid content-start gap-1.5" data-testid="where-open">
          <h3 className="text-sm font-medium">Open questions</h3>
          {data.open.length ? (
            <ul className="grid gap-1.5">
              {data.open.map((q) => (
                <li key={q} className="border-l-2 border-amber-500/70 pl-2.5 text-sm text-foreground [overflow-wrap:anywhere]">
                  {q}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">None open.</p>
          )}
        </div>
        <div className="grid content-start gap-1.5" data-testid="where-changed">
          <h3 className="text-sm font-medium">What changed</h3>
          {data.changed.length ? (
            <ol className="grid gap-1.5">
              {data.changed.map((c) => {
                const m = /^(\d{4}-\d{2}-\d{2}) (\S+): ([\s\S]*)$/.exec(c);
                return (
                  <li key={c} className="text-sm text-foreground [overflow-wrap:anywhere]">
                    {m ? (
                      <>
                        <span className="tabular-nums text-muted-foreground">{stampWords(`${m[1]}T00:00Z`).replace(" 00:00Z", "")} · {m[2]}</span> {m[3]}
                      </>
                    ) : (
                      c
                    )}
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing yet.</p>
          )}
        </div>
      </div>
      <p className="border-t pt-2 text-xs text-muted-foreground [overflow-wrap:anywhere]" data-testid="where-stamp">
        {data.at ? `Rewritten ${stampWords(data.at)}${data.row ? ` for ${data.row}` : ""}. ` : ""}Read first and rewritten last by every worker on this objective · {data.path}
      </p>
    </section>
  );
}
