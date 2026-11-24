import { api } from "@/api";
import type { KeyResultPlan, ScorecardRow, WheelPlan, WheelStep } from "@/api/pursuit-types";
import { ErrorBox, Loading } from "@/components/common";
import { inline } from "@/lib/chatMarkdown";
import { useQuery } from "@/lib/data";
import { useLayoutEffect, useRef, useState } from "react";

/**
 * An objective's Plan tab: the plan of its wheel. The owner (vn_06b0de06, 24 Nov): "I would like to see the
 * plan basically answering the steps that we're going to take to accomplish the key result in a very simple way." So per
 * key result (its name as the heading) it shows only the steps, in order, one short label each with who and by when, drawn
 * (an SVG, as the card check asks) as one line of numbered stops that ends on green; the one-line approach folds away. Steps already done fold into one line above them. The approach, what
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

/** a step's words as plain text for the drawing: links keep their words, marks go. */
const plain = (s: string) => s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();

/** the words of one label broken into lines of at most `max` characters. */
export function wrapWords(text: string, max: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of text.split(" ").filter(Boolean)) {
    if (cur && cur.length + 1 + w.length > max) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

/** the width the drawing has to fill, followed as the screen changes (a test's screen has none: a laptop column). */
export function useDrawWidth(fallback = 560) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => el.clientWidth > 0 && setWidth(Math.round(el.clientWidth));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

const R = 13; // a stop's radius
const LABEL_X = 42;
const LINE = 19; // a label line's height
const GAP = 16; // between two stops

/**
 * The steps drawn as one line of numbered stops (ticked when done), each step's words beside its stop and who and by when
 * under them, ending on a green stop when `green`. A drawing, not a list: the owner asked for the plan as a picture with
 * short labels (the card check, rule 7).
 */
function StepLine({ steps, green, label }: { steps: WheelStep[]; green?: boolean; label: string }) {
  const [ref, width] = useDrawWidth();
  const max = Math.max(18, Math.floor((width - LABEL_X - 4) / 7.4));
  let y = 2;
  const stops = steps.map((s, i) => {
    const lines = wrapWords(plain(s.do), max);
    const top = y;
    const h = Math.max(2 * R, lines.length * LINE + 18);
    y += h + GAP;
    return { s, n: i + 1, lines, top };
  });
  const greenTop = y;
  const height = green ? greenTop + 2 * R + 2 : Math.max(0, y - GAP + 2);
  const ink = (done?: boolean) => (done ? "fill-muted-foreground" : "fill-foreground");
  return (
    <div ref={ref} className="w-full min-w-0">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} className="block max-w-full overflow-visible" data-testid="plan-steps">
        {stops.slice(0, green ? stops.length : -1).map(({ top }, i) => (
          <line key={i} x1={R + 1} x2={R + 1} y1={top + R} y2={(stops[i + 1]?.top ?? greenTop) + R} className="stroke-border" strokeWidth={2} />
        ))}
        {stops.map(({ s, n, lines, top }) => (
          <g key={n} data-testid="plan-step" data-done={s.done ? "1" : undefined}>
            <circle cx={R + 1} cy={top + R} r={R} strokeWidth={2} className={s.done ? "fill-muted-foreground stroke-muted-foreground" : "fill-background stroke-foreground"} />
            <text x={R + 1} y={top + R + 4} textAnchor="middle" fontSize={12} className={s.done ? "fill-background" : "fill-foreground"}>
              {s.done ? "✓" : n}
            </text>
            <text x={LABEL_X} y={top + 15} fontSize={14} className={ink(s.done)} data-testid="plan-step-do">
              {lines.map((l, j) => (
                <tspan key={j} x={LABEL_X} dy={j ? LINE : 0}>
                  {j < lines.length - 1 ? `${l} ` : l}
                </tspan>
              ))}
            </text>
            <text x={LABEL_X} y={top + 15 + (lines.length - 1) * LINE + 17} fontSize={12} className="fill-muted-foreground">
              <tspan data-testid="plan-step-owner">{s.owner ?? "no owner yet"}</tspan>
              <tspan>{" · "}</tspan>
              <tspan data-testid="plan-step-by">{day(s.by) ?? "no date"}</tspan>
            </text>
          </g>
        ))}
        {green && (
          <g data-testid="plan-green">
            <circle cx={R + 1} cy={greenTop + R} r={R} className="fill-emerald-700" />
            <text x={LABEL_X} y={greenTop + R + 5} fontSize={14} fontWeight={600} className="fill-emerald-700">
              Green
            </text>
          </g>
        )}
      </svg>
    </div>
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
        <div className="grid gap-3">
          {done.length > 0 && (
            <details className="group text-sm text-muted-foreground" data-testid="plan-done">
              <summary className="cursor-pointer select-none">
                {done.length} {done.length === 1 ? "step" : "steps"} done
              </summary>
              <div className="mt-3">
                <StepLine steps={done} label={`${done.length} steps done`} />
              </div>
            </details>
          )}
          <StepLine steps={open} green label={`${open.length} steps to turn it green: ${open.map((s, i) => `${i + 1}. ${plain(s.do)}`).join(" ")}`} />
        </div>
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
          <p className="text-lg font-semibold leading-snug" data-testid="plan-wheel">
            {title}
          </p>
        )}
        <p className="text-sm text-muted-foreground" data-testid="plan-source">
          {plan.present
            ? `Steps to green${plan.by ? `, all by ${day(plan.by)}` : ""}.`
            : "The Delivery Manager writes it: for each key result, the steps to turn it green, who and by when."}
        </p>
        {/* the one-line approach folds away: the plan on screen is the drawn steps (vn_06b0de06); agents read it in briefs. */}
        {plan.line && (
          <details className="text-sm text-muted-foreground" data-testid="plan-approach">
            <summary className="cursor-pointer select-none">The approach in one line</summary>
            <p className="mt-1 text-foreground" data-testid="plan-line">
              {inline(plan.line)}
            </p>
          </details>
        )}
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
