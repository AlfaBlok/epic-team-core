import { api, type Milestone } from "@/api";
import type { MarketingPlan, MarketingPlanSection } from "@/api/campaign-types";
import { ErrorBox, Loading } from "@/components/common";
import { inline } from "@/lib/chatMarkdown";
import { useQuery } from "@/lib/data";
import { worldId } from "@/lib/useSocial";
import { cn } from "@/lib/utils";

/**
 * The owner: "for any campaign ... this type of marketing plan needs to be there ... a normal web page with fixed
 * sections ... it's just one of the tabs when I have a campaign selected." The campaign's Plan tab: its eight fixed
 * sections in order, each a row of labelled boxes (diagrams first, words as labels), read from the campaign spine's
 * `## Plan` section (docs/campaign-plan.md). A section not written yet says so, so every campaign shows the same plan.
 */
export function PlanTab({ m }: { m: Milestone }) {
  const { data, error, loading } = useQuery(async () => api.getCampaignPlan(await worldId(), m.id), [m.id]);
  if (error) return <ErrorBox error={error} />;
  if (loading || !data) return <Loading />;
  return <PlanView plan={data} />;
}

const num = (s: string | undefined) => {
  const n = Number((s ?? "").replace(/[^\d.]/g, ""));
  return s && /\d/.test(s) && Number.isFinite(n) ? n : null;
};

/** the funnel: each step today against its goal, a bar filled to today's share of the goal. */
function Funnel({ table }: { table: NonNullable<MarketingPlanSection["table"]> }) {
  const h = table.head.map((x) => x.toLowerCase());
  const ti = h.findIndex((x) => x.startsWith("today"));
  const gi = h.findIndex((x) => x.startsWith("goal"));
  if (ti < 0 || gi < 0) return <PlainTable table={table} />;
  return (
    <div className="grid gap-2" data-testid="plan-funnel">
      {table.rows.map((r, i) => {
        const today = num(r[ti]);
        const goal = num(r[gi]);
        const share = today !== null && goal ? Math.min(1, today / goal) : 0;
        const rest = r.flatMap((c, j) => (j !== 0 && j !== ti && j !== gi && c ? [`${table.head[j] ?? ""} ${c}`.trim()] : []));
        return (
          <div key={i} className="grid grid-cols-[minmax(6rem,9rem)_1fr] items-center gap-3 text-sm max-sm:grid-cols-1 max-sm:gap-1">
            <span className="font-medium">{r[0]}</span>
            <div className="grid gap-0.5">
              <div className="h-2.5 w-full rounded-full bg-muted">
                <div className="h-2.5 rounded-full bg-emerald-700" style={{ width: `${Math.max(share * 100, today ? 2 : 0)}%` }} />
              </div>
              <span className="text-xs text-muted-foreground">
                today {r[ti] || "–"} · goal {r[gi] || "–"}
                {rest.length ? ` · ${rest.join(" · ")}` : ""}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PlainTable({ table }: { table: NonNullable<MarketingPlanSection["table"]> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
            {table.head.map((c, i) => (
              <th key={i} className="py-1 pr-3 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r, i) => (
            <tr key={i} className="border-t">
              {r.map((c, j) => (
                <td key={j} className="py-1 pr-3">
                  {inline(c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Section({ s, n }: { s: MarketingPlanSection; n: number }) {
  return (
    <section className="grid gap-3 border-t pt-4" data-testid={`plan-section-${s.key}`}>
      <h3 className="flex items-baseline gap-2 text-base font-semibold">
        <span className="text-xs font-normal tabular-nums text-muted-foreground">{n}</span>
        {s.title}
      </h3>
      {!s.written ? (
        <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground" data-testid="plan-not-written">
          Not written yet.
        </p>
      ) : (
        <>
          {s.lead && <p className="text-sm">{inline(s.lead)}</p>}
          {s.boxes.length > 0 && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2">
              {s.boxes.map((b, i) => (
                <div key={i} className="grid content-start gap-1 rounded-md border bg-card px-3 py-2" data-testid="plan-box">
                  {b.label && <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{b.label}</span>}
                  <span className="text-sm font-medium leading-snug">{inline(b.text)}</span>
                  {b.note && <span className="text-xs text-muted-foreground">{inline(b.note)}</span>}
                </div>
              ))}
            </div>
          )}
          {s.table && (s.key === "goal" ? <Funnel table={s.table} /> : <PlainTable table={s.table} />)}
          {s.quotes.length > 0 && (
            <div className="grid gap-1">
              {s.quotes.map((q, i) => (
                <p key={i} className="border-l-2 pl-3 text-xs text-muted-foreground">
                  {inline(q)}
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function PlanView({ plan }: { plan: MarketingPlan }) {
  const where =
    plan.source === "spine"
      ? `From ${plan.repo} · ${plan.path}, section Plan.`
      : plan.source === "copy"
        ? `The team's copy (${plan.path}) until the campaign's own spine has its Plan section.`
        : `Not written yet. It belongs in ${plan.repo} · ${plan.path}, section Plan.`;
  return (
    <div className="grid max-w-4xl gap-4" data-testid="plan-tab">
      <div className="grid gap-1">
        {plan.line && <p className="text-lg font-semibold leading-snug">{inline(plan.line)}</p>}
        {/* the eight fixed sections as one line of steps: the plan's shape before its words. */}
        <ol className="flex flex-wrap gap-1.5 text-xs" aria-label="The plan's sections">
          {plan.sections.map((s, i) => (
            <li key={s.key}>
              <a href={`#plan-${s.key}`} className={cn("inline-block rounded-full border px-2 py-0.5", s.written ? "border-emerald-700/40 text-foreground" : "border-dashed text-muted-foreground")}>
                {i + 1} {s.title}
              </a>
            </li>
          ))}
        </ol>
        <p className="text-xs text-muted-foreground" data-testid="plan-source">
          {where}
          {plan.source !== "none" && plan.missing.length > 0 ? ` Missing: ${plan.missing.join(", ")}.` : ""}
        </p>
      </div>
      {plan.sections.map((s, i) => (
        <div key={s.key} id={`plan-${s.key}`}>
          <Section s={s} n={i + 1} />
        </div>
      ))}
    </div>
  );
}
