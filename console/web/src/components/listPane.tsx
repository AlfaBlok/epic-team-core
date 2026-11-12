import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * one shared list pane for every folded list (Moving now, Answered, Coming up, Superseded; Snoozed,
 * Decided for you, Done waiting for your review, Asked no row yet, the Runs and Tickets pages): compact
 * rows in a scroll pane about 20 lines tall, a Show 20 / 50 / all control (default 20, remembered per list) and an
 * "N of M shown" foot. Built for Moving now in, shared here so every list behaves the same.
 */
export const LIST_LIMITS = [20, 50, 0] as const;
const LIMIT_STORE = "teamHome.limit.";

/** The list's Show choice (0 = all), kept in localStorage under `teamHome.limit.<key>`; default 20. */
export function useListLimit(key: string): [number, (n: number) => void] {
  const [limit, setLimit] = useState(() => {
    try {
      const raw = window.localStorage.getItem(LIMIT_STORE + key);
      const v = Number(raw);
      return raw !== null && (LIST_LIMITS as readonly number[]).includes(v) ? v : LIST_LIMITS[0];
    } catch {
      return LIST_LIMITS[0];
    }
  });
  const set = (n: number) => {
    setLimit(n);
    try {
      window.localStorage.setItem(LIMIT_STORE + key, String(n));
    } catch {
      /* storage off: the choice still holds for this page */
    }
  };
  return [limit, set];
}

/** The first `limit` items (0 = all): the client-side cut for lists already loaded. */
export const limitList = <T,>(items: T[], limit: number): T[] => (limit ? items.slice(0, limit) : items);

/** Show 20 / 50 / all; only when the list is longer than the smallest choice (nothing to limit otherwise). */
export function LimitControl({ limit, onChange, total, testId, className }: { limit: number; onChange: (n: number) => void; total: number | undefined; testId: string; className?: string }) {
  if (total === undefined || total <= LIST_LIMITS[0]) return null;
  return (
    <div className={cn("ml-auto flex items-center gap-1 text-xs text-muted-foreground", className)} role="group" aria-label="Show" data-testid={`${testId}-limit`}>
      <span>Show</span>
      {LIST_LIMITS.map((n) => (
        <button
          key={n}
          type="button"
          className={cn("rounded-md border px-2 py-0.5", n === limit ? "bg-muted font-medium text-foreground" : "hover:text-foreground")}
          aria-pressed={n === limit}
          onClick={() => onChange(n)}
          data-testid={`${testId}-limit-${n || "all"}`}
        >
          {n || "all"}
        </button>
      ))}
    </div>
  );
}

/**
 * The rows (`<li>`s) in a fixed-height scroll pane (~20 one-line rows, 30rem), then "N of M shown" when cut.
 * `as="div"` for content that is not a list of `<li>`s (the Tickets table). `footClassName` pads the
 * foot when the pane sits edge to edge in a fold section (Runs, Tickets).
 */
export function ListPane({ shown, total, testId, className, footClassName, as = "ul", children }: { shown: number; total: number; testId: string; className?: string; footClassName?: string; as?: "ul" | "div"; children: ReactNode }) {
  const Pane = as;
  return (
    <>
      <Pane className={cn(as === "ul" ? "grid gap-1" : "", "max-h-[30rem] overflow-y-auto", className)} data-testid={`${testId}-pane`}>
        {children}
      </Pane>
      {total > shown && (
        <p className={cn("mt-1 text-xs text-muted-foreground", footClassName)} data-testid={`${testId}-more`}>
          {shown} of {total} shown
        </p>
      )}
    </>
  );
}
