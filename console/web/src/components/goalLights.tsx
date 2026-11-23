import { api } from "@/api";
import type { Goal, GoalLight, GoalLine } from "@/api/company-types";
import { useQuery } from "@/lib/data";
import { cn } from "@/lib/utils";
import { byRingColour } from "@/lib/ringOrder";

/**
 * the owner ("I want to see a list of key results and traffic light for each"): the goal on top ("5 testers using
 * SocialApp", its "0 of 5" at the right), then its key results as a table, key result, target, current in its colour,
 * green first, then amber, then red (vn_68cda1fe); the rule
 * in one small line under them. Read only, from the goal's one source (docs/goals/<name>.json via GET /api/goals).
 */

const DOT: Record<GoalLight, string> = { green: "bg-emerald-500", amber: "bg-amber-400", red: "bg-red-500" };
const WORD: Record<GoalLight, string> = { green: "green", amber: "amber", red: "red" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDay = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : iso;
};

/** "0 of 10" ("? of 10" when it could not be read: never a fake zero). */
export const goalCount = (l: Pick<GoalLine, "now" | "target">) => `${l.now === null ? "?" : l.now} of ${l.target}`;
/** the goal's headline as the owner reads it everywhere: its name alone, its count beside it like a key result's. */
export const goalHeadline = (g: Goal) => g.name;

export const useGoals = () => useQuery(() => (api.listGoals ? api.listGoals() : Promise.resolve({ goals: [] as Goal[] })), [], { tag: "inbox" });

function Dot({ light, big }: { light: GoalLight; big?: boolean }) {
  return (
    <span className={cn("inline-block shrink-0 rounded-full", big ? "h-3.5 w-3.5" : "h-3 w-3", DOT[light])} aria-hidden data-testid="goal-light" data-light={light} />
  );
}

const TINT: Record<GoalLight, string> = { green: "hsl(142 72% 29% / 0.12)", amber: "hsl(38 92% 50% / 0.16)", red: "hsl(0 72% 51% / 0.12)" };
const INK: Record<GoalLight, string> = { green: "hsl(142 72% 26%)", amber: "hsl(30 90% 35%)", red: "hsl(0 72% 42%)" };
const COLS = "grid-cols-[minmax(0,1fr)_minmax(0,5.5rem)_minmax(0,5.5rem)] sm:grid-cols-[minmax(0,1fr)_minmax(0,9rem)_minmax(0,9rem)]";

/** one key result as a table row: what it is, its target (and by when), where it is now in its colour (vn_68cda1fe). */
function KeyResult({ k }: { k: GoalLine }) {
  return (
    <li className={cn("grid min-h-11 min-w-0 items-stretch gap-x-2 sm:gap-x-3", COLS)} data-testid="goal-kr" data-id={k.id} data-light={k.light} title={k.why}>
      <span className="min-w-0 py-2 text-[15px] leading-snug">
        {k.label}
        <span className="sr-only">: {WORD[k.light]}, {k.why}</span>
      </span>
      <span className="py-2 text-[15px] tabular-nums" data-testid="goal-kr-target">
        {k.target}
        <span className="ml-1 text-xs text-muted-foreground">by {shortDay(k.by)}</span>
      </span>
      <span className="px-2 py-2 text-[15px] font-semibold tabular-nums" style={{ background: TINT[k.light], color: INK[k.light] }} data-testid="goal-kr-count">
        {k.now === null ? "?" : k.now}
      </span>
    </li>
  );
}

/** one goal: its headline with a light, its key results, the rule. */
export function GoalBlock({ g, className }: { g: Goal; className?: string }) {
  return (
    <section className={cn("rounded-xl border bg-card px-4 py-3", className)} data-testid="goal" data-id={g.id}>
      <h2 className="flex min-w-0 items-center gap-3 text-lg font-semibold leading-tight" data-light={g.light} title={g.why}>
        <Dot light={g.light} big />
        <span className="min-w-0 [overflow-wrap:anywhere]" data-testid="goal-headline">
          {goalHeadline(g)}
        </span>
        <span className="ml-auto shrink-0 text-[15px] font-semibold tabular-nums" data-testid="goal-count">
          {goalCount(g)}
        </span>
        <span className="sr-only">: {WORD[g.light]}, {g.why}</span>
      </h2>
      {g.keyResults.length > 0 && (
        <ul className="mt-2 divide-y border-t" data-testid="goal-krs">
          <li aria-hidden="true" className={cn("grid gap-x-2 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:gap-x-3", COLS)} data-testid="goal-krs-head">
            <span className="py-1.5">Key result</span>
            <span className="py-1.5">Target</span>
            <span className="px-2 py-1.5">Current</span>
          </li>
          {byRingColour(g.keyResults.map((k) => ({ ...k, state: k.light }))).map((k) => (
            <KeyResult key={k.id} k={k} />
          ))}
        </ul>
      )}
      {g.lightRule && (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground" data-testid="goal-rule">
          {g.lightRule}
        </p>
      )}
    </section>
  );
}

/** every goal of the home repo, the Home's first screen; nothing while it loads or when there is none. */
export function GoalLights({ className }: { className?: string }) {
  const { data } = useGoals();
  const goals = data?.goals ?? [];
  if (!goals.length) return null;
  return (
    <div className={cn("grid gap-3", className)} data-testid="goal-lights">
      {goals.map((g) => (
        <GoalBlock key={g.id} g={g} />
      ))}
    </div>
  );
}
