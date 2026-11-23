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
import { DailyBriefingPanel } from "./DailyBriefing";
import { WheelPlanView } from "@/components/wheelPlan";

/**
 * The campaign's Plan tab is the plan of the wheel it serves. The owner (vn_f405ae72, 22 Nov): "It's not a marketing plan,
 * man. It's the plan. It's the plan for the wheel, whatever the objective is." So it shows, per key result of the objective
 * the campaign serves, how it gets to green (the same view and the same file as that objective's Plan tab),
 * then the campaign's latest morning briefing. The campaign's eight-part brief stays in its spine for its writers.
 */
export function PlanTab({ m }: { m: Milestone }) {
  const { data, error, loading } = useQuery(async () => api.getCampaignWheelPlan(await worldId(), m.id), [m.id]);
  if (error) return <ErrorBox error={error} />;
  if (loading || !data) return <Loading />;
  return (
    <div className="grid gap-10" data-testid="campaign-wheel-plan">
      {data.wheels.length ? (
        data.wheels.map((w) => <WheelPlanView key={w.id} anchor={`plan-${w.id}`} title={w.name} plan={w.plan} keyResults={w.keyResults.map((label) => ({ label }))} />)
      ) : (
        <p className="max-w-2xl rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground" data-testid="campaign-wheel-plan-none">
          This campaign serves no objective yet, so it has no plan. Its plan is the plan of the objective it moves.
        </p>
      )}
      <DailyBriefingPanel m={m} />
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

/** wraps words into lines of at most `max` characters, at most `rows` lines (the last one cut with an ellipsis). */
export function wrapWords(text: string, max: number, rows: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of text.replace(/[*_`]/g, "").split(/\s+/).filter(Boolean)) {
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= max) cur += ` ${w}`;
    else {
      out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  if (out.length > rows) {
    const keep = out.slice(0, rows);
    keep[rows - 1] = `${keep[rows - 1].slice(0, Math.max(0, max - 1)).replace(/[\s,.;:]+$/, "")}…`;
    return keep;
  }
  return out;
}

interface FlowNode {
  key: MarketingPlanSection["key"];
  label: string;
  text: string;
  written: boolean;
}

/** the plan's shape in five stops: who we reach, what we say, where, what they get, the goal; built from its sections. */
export function flowNodes(plan: MarketingPlan): FlowNode[] {
  const by = (k: MarketingPlanSection["key"]) => plan.sections.find((s) => s.key === k);
  const first = (k: MarketingPlanSection["key"]) => by(k)?.boxes[0]?.text || by(k)?.lead || "";
  const count = (k: MarketingPlanSection["key"], one: string, many: string) => {
    const n = by(k)?.boxes.length ?? 0;
    return n ? `${n} ${n === 1 ? one : many}` : by(k)?.lead || "";
  };
  const channels = by("channels")?.boxes.map((b) => (b.label || b.text).split(/[\s,]/)[0]).filter(Boolean) ?? [];
  const goal = by("goal")?.boxes.map((b) => b.text).join(", then ") || by("goal")?.lead || "";
  const node = (key: MarketingPlanSection["key"], label: string, text: string): FlowNode => ({
    key,
    label,
    text: text || "not written yet",
    written: !!by(key)?.written && !!text,
  });
  return [
    node("who", "Who", first("who")),
    node("messages", "Message", count("messages", "message", "messages")),
    node("channels", "Channels", channels.length ? channels.join(", ") : count("channels", "channel", "channels")),
    node("offer", "Offer", by("offer")?.lead || first("offer")),
    node("goal", "Goal", goal),
  ];
}

/**
 * The plan drawn before its words (root L-59, the owner: "when you tell me a plan, I expect to see a diagram"): who →
 * message → channels → offer → goal, and the measure-and-change loop back to the messages. One line across on a laptop,
 * a column on a phone. Each stop opens its section.
 */
function PlanFlow({ plan }: { plan: MarketingPlan }) {
  const nodes = flowNodes(plan);
  const loop = "measure every evening, then change the messages";
  const box = (n: FlowNode, x: number, y: number, w: number, h: number, max: number, rows: number) => (
    <a key={n.key} href={`#plan-${n.key}`} data-testid={`plan-flow-${n.key}`}>
      <rect x={x} y={y} width={w} height={h} rx={6} className={n.written ? "fill-background stroke-foreground" : "fill-background stroke-muted-foreground"} strokeWidth={1.25} strokeDasharray={n.written ? undefined : "4 3"} />
      <text x={x + 10} y={y + 17} fontSize={10.5} letterSpacing={0.6} className="fill-muted-foreground">
        {n.label.toUpperCase()}
      </text>
      {wrapWords(n.text, max, rows).map((l, i) => (
        <text key={i} x={x + 10} y={y + 36 + i * 16} fontSize={13} className={n.written ? "fill-foreground" : "fill-muted-foreground"}>
          {l}
        </text>
      ))}
    </a>
  );
  const arrow = "plan-flow-arrow";
  // laptop: five boxes in a line, the loop drawn under them from Goal back to Message.
  const W = 960, bw = 164, gap = (W - 5 * bw) / 4, by = 8, bh = 92;
  const hx = (i: number) => i * (bw + gap);
  // phone: five boxes in a column, the loop drawn on the right from Goal back up to Message.
  const PW = 360, pbw = 280, pbh = 66, pgap = 20;
  const vy = (i: number) => 4 + i * (pbh + pgap);
  const PH = vy(4) + pbh + 8;
  return (
    <figure className="diagram my-1" data-testid="plan-flow" aria-label={`The plan: ${nodes.map((n) => `${n.label} ${n.text}`).join(", then ")}; ${loop}.`}>
      <svg viewBox={`-2 0 ${W + 4} 150`} className="block h-auto w-full max-sm:hidden" role="img">
        <defs>
          <marker id={arrow} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className="fill-foreground" />
          </marker>
        </defs>
        {nodes.slice(1).map((_, i) => (
          <line key={i} x1={hx(i) + bw + 2} y1={by + bh / 2} x2={hx(i + 1) - 3} y2={by + bh / 2} className="stroke-foreground" strokeWidth={1.25} markerEnd={`url(#${arrow})`} />
        ))}
        {nodes.map((n, i) => box(n, hx(i), by, bw, bh, 20, 3))}
        <path d={`M ${hx(4) + bw / 2} ${by + bh + 2} V ${by + bh + 26} H ${hx(1) + bw / 2} V ${by + bh + 5}`} fill="none" className="stroke-emerald-700" strokeWidth={1.5} markerEnd={`url(#${arrow})`} />
        <a href="#plan-measure">
          <text x={(hx(1) + hx(4) + bw) / 2} y={by + bh + 44} textAnchor="middle" fontSize={12.5} className="fill-emerald-700">
            {loop}
          </text>
        </a>
      </svg>
      <svg viewBox={`-2 0 ${PW + 4} ${PH}`} className="hidden h-auto w-full max-sm:block" role="img">
        <defs>
          <marker id={`${arrow}-p`} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className="fill-foreground" />
          </marker>
        </defs>
        {nodes.slice(1).map((_, i) => (
          <line key={i} x1={pbw / 2} y1={vy(i) + pbh + 1} x2={pbw / 2} y2={vy(i + 1) - 2} className="stroke-foreground" strokeWidth={1.25} markerEnd={`url(#${arrow}-p)`} />
        ))}
        {nodes.map((n, i) => box(n, 0, vy(i), pbw, pbh, 34, 2))}
        <path d={`M ${pbw + 2} ${vy(4) + pbh / 2} H ${pbw + 30} V ${vy(1) + pbh / 2} H ${pbw + 5}`} fill="none" className="stroke-emerald-700" strokeWidth={1.5} markerEnd={`url(#${arrow}-p)`} />
        <a href="#plan-measure">
          <text transform={`translate(${pbw + 46} ${(vy(1) + vy(4) + pbh) / 2}) rotate(90)`} textAnchor="middle" fontSize={12} className="fill-emerald-700">
            measure every evening, then change
          </text>
        </a>
      </svg>
    </figure>
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
        <PlanFlow plan={plan} />
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
