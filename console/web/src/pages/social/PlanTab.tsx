import { useState } from "react";
import { api, type Milestone } from "@/api";
import type { MarketingPlan, MarketingPlanSection, MarketingPlanWrite } from "@/api/campaign-types";
import { ErrorBox, Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { inline } from "@/lib/chatMarkdown";
import { mutate, useQuery } from "@/lib/data";
import { worldId } from "@/lib/useSocial";
import { cn } from "@/lib/utils";
import { DailyBriefingPanel } from "./DailyBriefing";

/**
 * The owner: "for any campaign ... this type of marketing plan needs to be there ... a normal web page with fixed
 * sections ... it's just one of the tabs when I have a campaign selected." The campaign's Plan tab: its eight fixed
 * sections in order, each a row of labelled boxes (diagrams first, words as labels), read from the campaign spine's
 * `## Plan` section (docs/campaign-plan.md). A section not written yet says so, so every campaign shows the same plan.
 */
export function PlanTab({ m }: { m: Milestone }) {
  const { data, error, loading } = useQuery(async () => api.getCampaignPlan(await worldId(), m.id), [m.id]);
  // the plan is the owner's to write (the Strategist still writes it when it wakes).
  const [editing, setEditing] = useState(false);
  if (error) return <ErrorBox error={error} />;
  if (loading || !data) return <Loading />;
  if (editing) return <PlanEditor plan={data} onSave={async (w) => api.saveCampaignPlan(await worldId(), m.id, w)} onDone={() => setEditing(false)} />;
  // the campaign's latest morning briefing first, then its Plan (its key results sit above the tabs).
  return (
    <div className="grid gap-6">
      <DailyBriefingPanel m={m} />
      <PlanView plan={data} onEdit={() => setEditing(true)} />
    </div>
  );
}

/** what each section holds, in the owner's words, with the line shape the Plan tab draws (docs/campaign-plan.md). */
const SECTION_HELP: Record<MarketingPlanSection["key"], string> = {
  goal: "One sentence, then the funnel as a table: | Step | Today | Goal | and one row per step, e.g. | Sign-ups | 0 | 5 |",
  who: "One line per group of people: - First: founders who post on LinkedIn every week",
  messages: "One line per message: - Message 1: what you say · 10 posts, 2 videos",
  channels: "One line per channel: - LinkedIn: 3 posts a week",
  offer: "What a reader gets, in one sentence.",
  test: "What you try this week, and what would show it works.",
  budget: "One line per cost: - Ads: €0 a month",
  measure: "What you count, when, and what you change when it does not move.",
};

/**
 * the Plan tab's editor. The plan's line and its eight fixed sections, each prefilled with what is written;
 * Save writes them into the campaign spine's `## Plan` (one commit) and the tab shows the result.
 */
export function PlanEditor({ plan, onSave, onDone }: { plan: MarketingPlan; onSave: (w: MarketingPlanWrite) => Promise<unknown>; onDone: () => void }) {
  const [line, setLine] = useState(plan.line && !/^approved:/i.test(plan.line) ? plan.line : "");
  const [text, setText] = useState<Record<string, string>>(() => Object.fromEntries(plan.sections.map((s) => [s.key, s.raw ?? ""])));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error>();
  const save = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      await mutate(() => onSave({ line: line.trim(), sections: Object.fromEntries(plan.sections.map((s) => [s.key, text[s.key] ?? ""])) }));
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid max-w-4xl gap-4" data-testid="plan-editor">
      <div className="grid gap-1">
        <h2 className="text-lg font-semibold">Write your plan</h2>
        <p className="text-sm text-muted-foreground">Eight parts, in this order. Leave a part empty if you do not know it yet.</p>
      </div>
      {err && <ErrorBox error={err} />}
      <div className="grid gap-1">
        <Label htmlFor="plan-line">The plan in one line</Label>
        <Input id="plan-line" value={line} onChange={(e) => setLine(e.target.value)} placeholder="Fifty founders hear about us on LinkedIn this month" data-testid="plan-edit-line" />
      </div>
      {plan.sections.map((s, i) => (
        <div key={s.key} className="grid gap-1 border-t pt-3">
          <Label htmlFor={`plan-edit-${s.key}`} className="flex items-baseline gap-2">
            <span className="text-xs font-normal tabular-nums text-muted-foreground">{i + 1}</span>
            {s.title}
          </Label>
          <Textarea id={`plan-edit-${s.key}`} rows={s.key === "goal" || s.key === "messages" ? 5 : 3} value={text[s.key] ?? ""} onChange={(e) => setText({ ...text, [s.key]: e.target.value })} data-testid={`plan-edit-${s.key}`} />
          <span className="text-xs text-muted-foreground">{SECTION_HELP[s.key]}</span>
        </div>
      ))}
      <div className="sticky bottom-0 flex justify-end gap-2 border-t bg-background py-3">
        <Button variant="outline" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={save} pending={busy} pendingLabel="Saving…" data-testid="plan-save">
          Save plan
        </Button>
      </div>
    </div>
  );
}

/** an objective's Plan tab: the same eight sections, from the campaign spine the objective names (GET /api/pursuits/:id/plan). */
export function ObjectivePlanTab({ id }: { id: string }) {
  const { data, error, loading } = useQuery(() => api.getObjectivePlan(id), [id]);
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

export function PlanView({ plan, onEdit }: { plan: MarketingPlan; onEdit?: () => void }) {
  const where =
    onEdit && plan.source === "none"
      ? "Not written yet. Write it with Edit plan; the Strategist adds to it when it wakes."
      : plan.source === "spine"
      ? `From ${plan.repo} · ${plan.path}, section Plan.`
      : plan.source === "copy"
        ? `The team's copy (${plan.path}) until the campaign's own spine has its Plan section.`
        : `Not written yet. It belongs in ${plan.repo} · ${plan.path}, section Plan.`;
  return (
    <div className="grid max-w-4xl gap-4" data-testid="plan-tab">
      <div className="grid gap-1">
        <div className="flex items-start gap-3">
          {plan.line ? <p className="min-w-0 flex-1 text-lg font-semibold leading-snug">{inline(plan.line)}</p> : <span className="flex-1" />}
          {onEdit && (
            <Button size="sm" variant={plan.source === "none" ? "default" : "outline"} onClick={onEdit} data-testid="plan-edit">
              Edit plan
            </Button>
          )}
        </div>
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
