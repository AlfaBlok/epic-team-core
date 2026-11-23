import { api } from "@/api";
import type { KeyResultPlan, ScorecardRow, WheelPlan, WheelStep } from "@/api/pursuit-types";
import { ErrorBox, Loading } from "@/components/common";
import { inline } from "@/lib/chatMarkdown";
import { useQuery } from "@/lib/data";
import { cn } from "@/lib/utils";

/**
 * An objective's Plan tab: the plan of its wheel. The owner (vn_9c02d869, 23 Nov): "The plan is the plan ... we need to
 * have the plan for each of them, man. So that when an agent reads this, he gets the plan ... Don't rewrite what is
 * already in other places." So per key result (its name as the heading, nothing more) it shows how we get it to green:
 * the steps as one drawn line, the approach, each step with what it changes, who and by when, then what proves it green
 * and what we do if it stalls. The key results' numbers, the tickets (a step's row reaches agents in their briefs, never
 * this page) and where we are stay on their own tabs.
 */
const day = (s?: string) => {
  if (!s) return undefined;
  const d = new Date(`${s.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
};

/** a date for the drawn line; a step dated in words ("after your pick") shows no label there, its words stay in the list. */
const shortDay = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? day(s) : undefined);

/** the drawn step line: one dot per step in order (filled when done), ending on green. */
function StepLine({ steps, n }: { steps: WheelStep[]; n: number }) {
  const count = steps.length + 1; // the last stop is the key result green
  const w = 640, pad = 28, gap = count > 1 ? (w - pad * 2) / (count - 1) : 0;
  const x = (i: number) => pad + i * gap;
  return (
    <figure className="diagram -mx-1 overflow-hidden" data-testid="plan-line-diagram" aria-label={`Step line for key result ${n}: ${steps.length} steps to green`}>
      <svg viewBox={`0 0 ${w} 64`} className="block h-auto w-full text-foreground" role="img">
        <line x1={x(0)} y1={22} x2={x(count - 1)} y2={22} className="stroke-muted-foreground/40" strokeWidth={2} />
        {steps.map((s, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={22} r={11} className={s.done ? "fill-foreground stroke-foreground" : "fill-background stroke-foreground"} strokeWidth={2} />
            <text x={x(i)} y={26.5} textAnchor="middle" fontSize={12} className={s.done ? "fill-background" : "fill-foreground"}>
              {s.done ? "✓" : i + 1}
            </text>
            <text x={x(i)} y={54} textAnchor="middle" fontSize={12} className="fill-muted-foreground">
              {shortDay(s.by) ?? ""}
            </text>
          </g>
        ))}
        <circle cx={x(count - 1)} cy={22} r={11} className="fill-emerald-700 stroke-emerald-700" strokeWidth={2} />
        <text x={x(count - 1)} y={54} textAnchor="middle" fontSize={12} className="fill-emerald-700">
          green
        </text>
      </svg>
    </figure>
  );
}

function Step({ s, n }: { s: WheelStep; n: number }) {
  return (
    <li className={cn("grid grid-cols-[1.5rem_1fr] gap-x-2 border-t py-2.5", s.done && "text-muted-foreground")} data-testid="plan-step">
      <span className="text-xs tabular-nums text-muted-foreground">{s.done ? "✓" : n}</span>
      <span className="grid gap-0.5 text-sm leading-snug">
        <span>{inline(s.do)}</span>
        {s.changes && <span className="text-muted-foreground" data-testid="plan-step-changes">Changes: {inline(s.changes)}</span>}
        <span className="text-xs text-muted-foreground">
          <span data-testid="plan-step-owner">{s.owner ?? "no owner yet"}</span> · <span data-testid="plan-step-by">{day(s.by) ?? "no date"}</span>
        </span>
      </span>
    </li>
  );
}

function KeyResultSection({ label, n, k, anchor }: { label: string; n: number; k?: KeyResultPlan; anchor: string }) {
  const empty = !k || (!k.how && !k.steps.length);
  return (
    <section id={`${anchor}-kr-${n}`} className="grid gap-2" data-testid="plan-kr">
      <h3 className="text-base font-semibold leading-snug">{label}</h3>
      {empty ? (
        <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground" data-testid="plan-kr-empty">
          No plan written for it yet.
        </p>
      ) : (
        <>
          {k.steps.length > 0 && <StepLine steps={k.steps} n={n} />}
          <p className="text-sm leading-relaxed" data-testid="plan-how">
            {k.how ? inline(k.how) : <span className="text-muted-foreground">The approach is not written yet.</span>}
          </p>
          {k.steps.length > 0 && (
            <ol className="grid">
              {k.steps.map((s, i) => (
                <Step key={i} s={s} n={i + 1} />
              ))}
            </ol>
          )}
          {(k.greenWhen || k.ifStuck) && (
            <dl className="grid gap-1 border-t pt-2.5 text-sm sm:grid-cols-[7rem_1fr]">
              {k.greenWhen && (
                <>
                  <dt className="text-muted-foreground">Green when</dt>
                  <dd data-testid="plan-green-when">{inline(k.greenWhen)}</dd>
                </>
              )}
              {k.ifStuck && (
                <>
                  <dt className="text-muted-foreground">If it stalls</dt>
                  <dd data-testid="plan-if-stuck">{inline(k.ifStuck)}</dd>
                </>
              )}
            </dl>
          )}
        </>
      )}
    </section>
  );
}

/** `anchor` names its key results' ids (`<anchor>-kr-<n>`), so a page with two wheels' plans keeps each link apart. */
export function WheelPlanView({ plan, keyResults, title, anchor = "plan" }: { plan: WheelPlan; keyResults: Pick<ScorecardRow, "label">[]; title?: string; anchor?: string }) {
  const krPlans = plan.keyResults ?? []; // an older server sends none
  const count = Math.max(keyResults.length, ...krPlans.map((k) => k.kr), 0);
  const sections = Array.from({ length: count }, (_, i) => ({ n: i + 1, label: keyResults[i]?.label ?? `Key result ${i + 1}`, k: krPlans.find((k) => k.kr === i + 1) }));
  return (
    <div id={anchor === "plan" ? undefined : anchor} className="grid max-w-3xl gap-7" data-testid="plan-tab" data-plan="wheel">
      <div className="grid gap-1">
        {title && (
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground" data-testid="plan-wheel">
            {title}
          </p>
        )}
        <p className="text-lg font-semibold leading-snug" data-testid="plan-line">
          {plan.line ? inline(plan.line) : "No plan written yet."}
        </p>
        <p className="text-xs text-muted-foreground" data-testid="plan-source">
          {plan.present
            ? `How each key result gets to green${plan.by ? `, all by ${day(plan.by)}` : ""}.`
            : "The Delivery Manager writes it: for each key result, how it gets to green, the steps, who and by when."}
        </p>
      </div>
      {plan.present && sections.map((s) => <KeyResultSection key={s.n} {...s} anchor={anchor} />)}
    </div>
  );
}

/** the objective's Plan tab (GET /api/pursuits/:id/plan), its key results' names from the page's scorecard. */
export function WheelPlanTab({ id, keyResults }: { id: string; keyResults: ScorecardRow[] }) {
  const { data, error, loading } = useQuery(() => api.getObjectivePlan(id), [id]);
  if (error) return <ErrorBox error={error} />;
  if (loading || !data) return <Loading />;
  return <WheelPlanView plan={data} keyResults={keyResults} />;
}
