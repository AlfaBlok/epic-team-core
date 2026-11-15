import { api } from "@/api";
import type { Goal, GoalLight, GoalLine } from "@/api/company-types";
import { useQuery } from "@/lib/data";
import { cn } from "@/lib/utils";

/**
 * the owner ("I want to see a list of key results and traffic light for each"): the goal on top ("5 testers using
 * SocialApp · 0 of 5"), then each key result on one line, its number against its target and a traffic light; the rule
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
/** the goal's headline as the owner reads it everywhere: "5 testers using SocialApp · 0 of 5". */
export const goalHeadline = (g: Goal) => `${g.name} · ${goalCount(g)}`;

export const useGoals = () => useQuery(() => (api.listGoals ? api.listGoals() : Promise.resolve({ goals: [] as Goal[] })), [], { tag: "inbox" });

function Dot({ light, big }: { light: GoalLight; big?: boolean }) {
  return (
    <span className={cn("inline-block shrink-0 rounded-full", big ? "h-3.5 w-3.5" : "h-3 w-3", DOT[light])} aria-hidden data-testid="goal-light" data-light={light} />
  );
}

function KeyResult({ k }: { k: GoalLine }) {
  return (
    <li className="flex min-h-11 min-w-0 items-center gap-3 py-1.5" data-testid="goal-kr" data-id={k.id} data-light={k.light} title={k.why}>
      <Dot light={k.light} />
      <span className="min-w-0 flex-1 text-[15px] leading-snug">
        {k.label}
        <span className="sr-only">: {WORD[k.light]}, {k.why}</span>
      </span>
      <span className="shrink-0 text-right text-[15px] font-semibold tabular-nums" data-testid="goal-kr-count">
        {goalCount(k)}
        <span className="ml-1 text-xs font-normal text-muted-foreground">by {shortDay(k.by)}</span>
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
        <span className="sr-only">: {WORD[g.light]}, {g.why}</span>
      </h2>
      {g.keyResults.length > 0 && (
        <ul className="mt-2 divide-y border-t" data-testid="goal-krs">
          {g.keyResults.map((k) => (
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
