import { ArrowLeftRight, ArrowRight, ExternalLink, Paperclip, type LucideIcon } from "lucide-react";
import { RelTime } from "@/components/common";
import { cn } from "@/lib/utils";
import { passedLabel, type Passed, type PassedKind } from "@/lib/passed";

/**
 * a message the console or his other desk passed into this desk's Chat. It sits on the desk's side (left), in the
 * shared band look of the readable cards (a coloured left band, one symbol, strong contrast), labelled with who
 * passed it, his quoted words set apart, and a link to where he said them. Never his colour or his side: those stay his own.
 */
const STYLE: Record<PassedKind, { icon: LucideIcon; band: string; dot: string; label: string }> = {
  from: {
    icon: ArrowLeftRight,
    band: "border-l-amber-500 bg-amber-50 dark:bg-amber-950/40",
    dot: "bg-amber-600 text-white",
    label: "text-amber-900 dark:text-amber-200",
  },
  to: {
    icon: ArrowRight,
    band: "border-l-slate-500 bg-slate-100 dark:bg-slate-800/60",
    dot: "bg-slate-600 text-white",
    label: "text-slate-800 dark:text-slate-200",
  },
  spill: {
    icon: Paperclip,
    band: "border-l-sky-600 bg-sky-50 dark:bg-sky-950/40",
    dot: "bg-sky-700 text-white",
    label: "text-sky-900 dark:text-sky-200",
  },
};

export function PassedBubble({ p, at }: { p: Passed; at?: string }) {
  const s = STYLE[p.kind];
  const Icon = s.icon;
  const link =
    p.url && p.kind === "from"
      ? { href: p.url, text: `Open your ${p.desk} desk, where you said it` }
      : p.url && p.kind === "to"
        ? { href: p.url, text: p.by === "desk" ? "Open where it went" : `Open your ${p.desk} desk` }
        : undefined;
  return (
    <li className="flex justify-start" data-testid="chat-passed" data-kind={p.kind} data-id={p.id} data-by={p.by}>
      <div className={cn("min-w-0 max-w-[92%] rounded-xl border-l-[6px] px-3 py-2.5 text-sm sm:max-w-[85%]", s.band)}>
        <div className="flex items-center gap-2">
          <span className={cn("inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full", s.dot)} aria-hidden>
            <Icon className="h-3.5 w-3.5" strokeWidth={2.75} />
          </span>
          <span className={cn("text-[13px] font-bold", s.label)} data-testid="chat-passed-label">
            {passedLabel(p)}
          </span>
        </div>
        {p.about && (
          <p className="mt-1.5 text-[15px] font-semibold leading-snug text-gray-950 [overflow-wrap:anywhere] dark:text-white" data-testid="chat-passed-about">
            {p.about.charAt(0).toUpperCase() + p.about.slice(1)}
          </p>
        )}
        {p.where && <p className="mt-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">Recorded on {p.where}</p>}
        {p.quote && (
          <blockquote className="mt-2 border-l-2 border-current/30 pl-2.5 text-gray-800 dark:text-gray-200" data-testid="chat-passed-quote">
            <span className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Your words</span>
            <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{p.quote}</span>
          </blockquote>
        )}
        {link && (
          <a
            href={link.href}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-[13px] font-medium underline underline-offset-2"
            data-testid="chat-passed-link"
          >
            {link.text}
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        )}
        {p.brief && (
          <details className="mt-1.5 text-[11px] text-muted-foreground">
            <summary className="cursor-pointer">What the desk was told</summary>
            <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{p.brief}</p>
          </details>
        )}
        <p className="mt-1 text-[11px] text-muted-foreground">
          {p.by === "desk" ? "This desk passed it on · " : p.kind === "to" ? "Note from the console · " : "Passed by the console · "}
          <RelTime iso={at} />
        </p>
      </div>
    </li>
  );
}
