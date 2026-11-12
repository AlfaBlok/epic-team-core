import { Check, Eye, KeyRound, MessageCircle, MousePointerClick, Split, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { LinkedText } from "@/components/outcome";
import { cn } from "@/lib/utils";
import type { Lead, LeadKind } from "@/lib/askLead";

/**
 * one colour and one symbol per kind, strong contrast in light and dark mode.
 */
export const LEAD_STYLE: Record<LeadKind, { icon: LucideIcon; band: string; dot: string; verb: string }> = {
  approve: {
    icon: Check,
    band: "border-l-emerald-600 bg-emerald-50 dark:bg-emerald-950/50",
    dot: "bg-emerald-700 text-white",
    verb: "text-emerald-800 dark:text-emerald-300",
  },
  decide: {
    icon: Split,
    band: "border-l-violet-600 bg-violet-50 dark:bg-violet-950/50",
    dot: "bg-violet-700 text-white",
    verb: "text-violet-800 dark:text-violet-300",
  },
  do: {
    icon: MousePointerClick,
    band: "border-l-orange-500 bg-orange-50 dark:bg-orange-950/50",
    dot: "bg-orange-600 text-white",
    verb: "text-orange-800 dark:text-orange-300",
  },
  give: {
    icon: KeyRound,
    band: "border-l-sky-600 bg-sky-50 dark:bg-sky-950/50",
    dot: "bg-sky-700 text-white",
    verb: "text-sky-800 dark:text-sky-300",
  },
  check: {
    icon: Eye,
    band: "border-l-blue-600 bg-blue-50 dark:bg-blue-950/50",
    dot: "bg-blue-700 text-white",
    verb: "text-blue-800 dark:text-blue-300",
  },
  answer: {
    icon: MessageCircle,
    band: "border-l-slate-600 bg-slate-100 dark:bg-slate-800/60",
    dot: "bg-slate-700 text-white",
    verb: "text-slate-800 dark:text-slate-200",
  },
};

/** The card's first thing: "You approve: <one thing>" big, "Why: <one line>" under it, and the one tap a `do` needs. */
export function LeadBand({
  lead,
  action,
  className,
  children,
  line,
  why,
}: {
  lead: Lead;
  action?: { url: string; label: string };
  className?: string;
  children?: ReactNode;
  /** The line's own rendering (a review card's title with its links); `lead.what` otherwise. */
  line?: ReactNode;
  /** The why's own rendering; `lead.why` otherwise. */
  why?: ReactNode;
}) {
  const s = LEAD_STYLE[lead.kind];
  const Icon = s.icon;
  return (
    <div className={cn("rounded-xl border-l-[6px] px-3 py-3 sm:px-4", s.band, className)} data-testid="ask-lead" data-kind={lead.kind} data-own={lead.own ? "yes" : "no"}>
      <div className="flex items-start gap-3">
        <span className={cn("mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full", s.dot)} aria-hidden>
          <Icon className="h-[18px] w-[18px]" strokeWidth={2.75} />
        </span>
        <div className="grid min-w-0 flex-1 gap-1.5">
          <div className="text-[19px] font-bold leading-snug text-gray-950 dark:text-white sm:text-[21px]" data-testid="ask-lead-line">
            <span className={s.verb}>{lead.verb}:</span> {line ?? <LinkedText text={lead.what} />}
          </div>
          {(why || lead.why) && (
            <div className="text-base leading-snug text-gray-900 dark:text-gray-100" data-testid="ask-lead-why">
              <span className="font-bold">Why:</span> {why ?? <LinkedText text={lead.why!} />}
            </div>
          )}
          {action && (
            <a
              className={cn("mt-1 inline-flex w-fit items-center gap-2 rounded-lg px-4 py-2.5 text-base font-bold shadow-sm hover:opacity-90", s.dot)}
              href={action.url}
              target="_blank"
              rel="noreferrer"
              data-testid="ask-lead-step"
            >
              <Icon className="h-4 w-4" strokeWidth={2.75} /> {action.label} ↗
            </a>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}

/** "More: context, risk and ids" folded behind one tap. */
export function MoreFold({ children, label = "More: context, risk and ids", testId = "ask-more" }: { children: ReactNode; label?: string; testId?: string }) {
  return (
    <details className="group text-sm" data-testid={testId}>
      <summary className="cursor-pointer select-none rounded-md py-1 text-sm font-semibold text-gray-800 hover:underline dark:text-gray-200">{label}</summary>
      <div className="mt-2 grid grid-cols-1 gap-2">{children}</div>
    </details>
  );
}
