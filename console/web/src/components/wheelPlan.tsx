import { api } from "@/api";
import type { KeyResultPlan, ScorecardRow, WheelPlan, WheelStep } from "@/api/pursuit-types";
import { ErrorBox, Loading } from "@/components/common";
import { inline } from "@/lib/chatMarkdown";
import { useQuery } from "@/lib/data";
import { cn } from "@/lib/utils";

/**
 * An objective's Plan tab: the plan of its wheel. The owner (vn_06b0de06, 24 Nov): "I would like to see the
 * plan basically answering the steps that we're going to take to accomplish the key result in a very simple way." So per
 * key result (its name as the heading) it shows only the steps, in order, one short line each with who and by when, drawn
 * as one line of numbered stops that ends on green. Steps already done fold into one line above them. The approach, what
 * proves it green and what we do if it stalls stay in the data (`how`, `greenWhen`, `ifStuck`), where agents read them in
 * their briefs and wake prompts; the screen never shows them. Numbers, tickets and where we are stay on their
 * own tabs.
 */
const day = (s?: string) => {
  if (!s) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return s; // a step dated in words ("after your pick") keeps its words
  const d = new Date(`${s.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
};

/** one stop on the drawn line: a numbered dot (ticked when done), the step in one line, who and by when under it. */
function Step({ s, n, last }: { s: WheelStep; n: number; last?: boolean }) {
  return (
    <li className={cn("relative grid grid-cols-[1.75rem_1fr] gap-x-3 pb-4", s.done && "text-muted-foreground")} data-testid="plan-step" data-done={s.done ? "1" : undefined}>
      {!last && <span aria-hidden className="absolute bottom-0 left-[0.8125rem] top-7 w-0.5 bg-border" />}
      <span
        aria-hidden
        className={cn(
          "relative z-[1] grid size-7 place-items-center rounded-full border-2 text-xs tabular-nums",
          s.done ? "border-muted-foreground bg-muted-foreground text-background" : "border-foreground bg-background text-foreground",
        )}
      >
        {s.done ? "✓" : n}
      </span>
      <span className="grid gap-0.5 pt-0.5 text-sm leading-snug">
        <span data-testid="plan-step-do">{inline(s.do)}</span>
        <span className="text-xs text-muted-foreground">
          <span data-testid="plan-step-owner">{s.owner ?? "no owner yet"}</span> · <span data-testid="plan-step-by">{day(s.by) ?? "no date"}</span>
        </span>
      </span>
    </li>
  );
}

function KeyResultSection({ label, n, k, anchor }: { label: string; n: number; k?: KeyResultPlan; anchor: string }) {
  const steps = k?.steps ?? [];
  const done = steps.filter((s) => s.done);
  const open = steps.filter((s) => !s.done);
  return (
    <section id={`${anchor}-kr-${n}`} className="grid gap-3" data-testid="plan-kr">
      <h3 className="text-base font-semibold leading-snug">{label}</h3>
      {!steps.length ? (
        <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground" data-testid="plan-kr-empty">
          No steps written for it yet.
        </p>
      ) : (
        <ol className="grid" data-testid="plan-steps" aria-label={`${open.length} steps to turn it green`}>
          {done.length > 0 && (
            <li className="pb-3">
              <details className="group text-sm text-muted-foreground" data-testid="plan-done">
                <summary className="cursor-pointer list-none select-none">
                  <span className="inline-grid size-7 place-items-center rounded-full border-2 border-muted-foreground bg-muted-foreground text-xs text-background align-middle">✓</span>
                  <span className="ml-3 align-middle">
                    {done.length} {done.length === 1 ? "step" : "steps"} done
                  </span>
                </summary>
                <ol className="mt-3 grid">
                  {done.map((s, i) => (
                    <Step key={i} s={s} n={i + 1} last={i === done.length - 1} />
                  ))}
                </ol>
              </details>
            </li>
          )}
          {open.map((s, i) => (
            <Step key={i} s={s} n={i + 1} />
          ))}
          <li className="grid grid-cols-[1.75rem_1fr] items-center gap-x-3" data-testid="plan-green">
            <span aria-hidden className="size-7 rounded-full bg-emerald-700" />
            <span className="text-sm font-medium text-emerald-700">Green</span>
          </li>
        </ol>
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
            ? `The steps we take to turn each key result green${plan.by ? `, all by ${day(plan.by)}` : ""}.`
            : "The Delivery Manager writes it: for each key result, the steps to turn it green, who and by when."}
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
