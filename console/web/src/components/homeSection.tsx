import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** a Team home section's fold, kept per section in localStorage (default open). */
const SECTION_STORE = "teamHome.section.";
function storedOpen(key: string): boolean | undefined {
  try {
    const v = window.localStorage.getItem(SECTION_STORE + key);
    return v === "open" ? true : v === "closed" ? false : undefined;
  } catch {
    return undefined;
  }
}
/**
 * the owner (2026-11-15: "I want to maybe land with everything collapsed, and then I expand where I want
 * to look at"): inside the Inbox every section opens folded on each visit, whatever was open last time; a tap opens it
 * for this visit only, so the next visit lands folded again.
 */
export const LandFolded = createContext(false);
/**
 * `lead` (the owner 2026-11-16: "It should just be at the top on blocked waiting for me or top done waiting
 * for your review"): while a section holds something ready for him (a ready or deadline card, a priority ask) at its
 * top, it opens by itself, even where the Inbox lands folded, until he folds it himself.
 */
export function useSectionOpen(key: string | undefined, byDefault = true, lead = false): [boolean, (open: boolean) => void] {
  const landFolded = useContext(LandFolded);
  const [open, setOpen] = useState(() => lead || (landFolded ? false : key ? (storedOpen(key) ?? byDefault) : byDefault));
  const touched = useRef(false);
  useEffect(() => {
    if (lead && !touched.current) setOpen(true);
  }, [lead]);
  const set = (o: boolean) => {
    touched.current = true;
    setOpen(o);
    if (!key || landFolded) return;
    try {
      window.localStorage.setItem(SECTION_STORE + key, o ? "open" : "closed");
    } catch {
      /* storage off: the toggle still works for this page */
    }
  };
  return [open, set];
}

/**
 * each Team home section's own sort: highest priority (the server's milestone order; the
 * default), most recent (newest first) or longest standing (oldest first). Kept per section in localStorage.
 */
export type SectionSort = "priority" | "recent" | "oldest";
export const SORT_LABELS: Record<SectionSort, string> = { priority: "Highest priority", recent: "Most recent", oldest: "Longest standing" };
const SORT_STORE = "teamHome.sort.";
const isSort = (v: unknown): v is SectionSort => v === "priority" || v === "recent" || v === "oldest";
export function useSectionSort(key: string | undefined): [SectionSort, (s: SectionSort) => void] {
  const [sort, setSort] = useState<SectionSort>(() => {
    if (!key) return "priority";
    try {
      const v = window.localStorage.getItem(SORT_STORE + key);
      return isSort(v) ? v : "priority";
    } catch {
      return "priority";
    }
  });
  const set = (s: SectionSort) => {
    setSort(s);
    if (!key) return;
    try {
      window.localStorage.setItem(SORT_STORE + key, s);
    } catch {
      /* storage off: the choice still holds for this page */
    }
  };
  return [sort, set];
}

/** Stable sort by `sort`: priority keeps the given (server) order; dated sorts put undated items last, ties in given order. */
export function sortSection<T>(items: T[], sort: SectionSort, dateOf: (i: T) => string | undefined): T[] {
  if (sort === "priority") return items;
  const dir = sort === "recent" ? -1 : 1;
  return items
    .map((it, i) => ({ it, i, t: dateOf(it) ? Date.parse(dateOf(it)!) : NaN }))
    .sort((a, b) => (isNaN(a.t) ? (isNaN(b.t) ? a.i - b.i : 1) : isNaN(b.t) ? -1 : dir * (a.t - b.t) || a.i - b.i))
    .map((x) => x.it);
}

/** The section's sort picker (a native select: the phone's own picker). */
export function SortControl({ value, onChange, testId }: { value: SectionSort; onChange: (s: SectionSort) => void; testId: string }) {
  return (
    <label className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
      <span className="sr-only sm:not-sr-only">Sort</span>
      <select
        className="h-8 rounded-md border bg-background px-2 text-xs text-foreground"
        value={value}
        onChange={(e) => isSort(e.target.value) && onChange(e.target.value)}
        aria-label="Sort"
        data-testid={`${testId}-sort`}
      >
        {(Object.keys(SORT_LABELS) as SectionSort[]).map((s) => (
          <option key={s} value={s}>
            {SORT_LABELS[s]}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * the one count pill. Same shape, size and font everywhere; the colour says only what the count means:
 * `needs-you` (red: the owner has to unblock it: blocked asks, drafts to approve), `review` (green: finished work
 * waiting for his review), `unread` (the owner: "not blue, maybe black or dark gray subtle": a quiet
 * dark grey, so red and green stay the only bright counters: chat replies he has not opened) or `info` (grey: everything else). A 0
 * is always `info`; `undefined` = not known yet (a quiet "…"). Never a count in brackets.
 */
export type PillTone = "needs-you" | "review" | "unread" | "info";
export const PILL_TONES: Record<PillTone, string> = {
  // red blocked on him, green
  // finished work for his review, grey unread.
  "needs-you": "bg-[hsl(0_72%_51%)] text-white",
  review: "bg-[hsl(142_72%_29%)] text-white",
  unread: "bg-border text-foreground/85",
  info: "bg-muted text-muted-foreground",
};
/** what each tone's pill says on hover in the sidebar and top bar. */
export const PILL_TITLES: Record<Exclude<PillTone, "info">, (n: number) => string> = {
  "needs-you": (n) => `${n} waiting on you to unblock`,
  review: (n) => `${n} waiting for your review`,
  unread: (n) => `${n} unread ${n === 1 ? "message" : "messages"}`,
};
export const PILL_SHAPE = "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-xs font-semibold leading-none tabular-nums";
export function CountPill({
  count,
  tone = "info",
  testId,
  title,
  className,
  milestoneId,
}: {
  count: number | undefined;
  tone?: PillTone;
  testId?: string;
  title?: string;
  className?: string;
  /** a sidebar milestone's pill names its milestone. */
  milestoneId?: string;
}) {
  if (count === undefined)
    return (
      <span className={cn(PILL_SHAPE, PILL_TONES.info, className)} data-testid={testId && `${testId}-loading`} data-count-pill="" data-tone="info" data-milestone-id={milestoneId} title="counting…">
        …
      </span>
    );
  const t: PillTone = count > 0 ? tone : "info";
  return (
    <span className={cn(PILL_SHAPE, PILL_TONES[t], className)} data-testid={testId} data-count-pill="" data-tone={t} data-milestone-id={milestoneId} title={title}>
      {count}
    </span>
  );
}

/**
 * the one fold section, used by every Team home section and every ListPane list (heading +
 * pane): one bordered box, a header line of chevron, title-case title and count pill (the fold button), then `meta`
 * (always) and `actions` (open only: sort, Show 20 / 50 / all); open, the body sits under a rule inside the same box.
 * Folded, every section is that same one line. Without `onToggle` it is always open (no chevron).
 */
export function FoldSection({
  title,
  count,
  tone,
  testId,
  open = true,
  onToggle,
  hideZero,
  meta,
  call,
  actions,
  bodyClassName,
  bodyTestId,
  className,
  children,
}: {
  title: ReactNode;
  count: number | undefined;
  tone?: PillTone;
  testId: string;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  /** No pill at 0 (the milestone pages' rule). */
  hideZero?: boolean;
  meta?: ReactNode;
  /** the section's phone button (a call about its cards), shown open or folded. */
  call?: ReactNode;
  actions?: ReactNode;
  bodyClassName?: string;
  bodyTestId?: string;
  className?: string;
  children?: ReactNode;
}) {
  const pill = hideZero && count === 0 ? null : <CountPill count={count} tone={tone} testId={`${testId}-count`} />;
  // a folded section is its header line alone, so its sticky heading never moves: one class for open and folded
  const stick = !!onToggle;
  const label = (
    <>
      {onToggle && (open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />)}
      <span className="min-w-0">{title}</span>
      {pill}
    </>
  );
  return (
    // a section is its heading and its cards, room instead of a frame around them.
    <section className={cn("mb-7 min-w-0 [overflow-wrap:anywhere]", className)} data-testid={testId} data-fold-section="">
      {/* E948-S145 (vn_a95bfbab): an open section's heading sticks under the top bar while he scrolls its cards */}
      <div
        className={cn("flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1", stick && "sticky top-[calc(52px+env(safe-area-inset-top))] z-30 bg-background md:top-[calc(2.75rem+env(safe-area-inset-top))]")}
        data-fold-header=""
        data-sticky={stick ? "" : undefined}
      >
        <h2 className="min-w-0 text-[15px] font-semibold">
          {onToggle ? (
            <button type="button" className="flex min-h-8 items-center gap-2 text-left hover:text-foreground/80" onClick={() => onToggle(!open)} aria-expanded={open} data-testid={`${testId}-toggle`}>
              {label}
            </button>
          ) : (
            <span className="flex min-h-8 items-center gap-2">{label}</span>
          )}
        </h2>
        {meta}
        {call}
        {open && actions}
      </div>
      {open && children !== undefined && children !== null && children !== false && (
        <div className={cn("pt-2", bodyClassName)} data-testid={bodyTestId}>
          {children}
        </div>
      )}
    </section>
  );
}

/** placeholder cards while a list loads: as many as the known count (capped), else a few; pulsing. */
export function SkeletonCards({ count, testId }: { count: number | undefined; testId: string }) {
  const n = Math.min(count ?? 3, 12);
  return (
    <div className="grid grid-cols-1 gap-3" data-testid={testId} aria-busy="true" aria-label="Loading">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="grid animate-pulse gap-2 rounded-lg border bg-card p-3" data-testid="skeleton-card">
          <div className="h-4 w-2/3 rounded bg-muted" />
          <div className="h-3 w-1/3 rounded bg-muted" />
          <div className="h-3 w-full rounded bg-muted" />
          <div className="h-8 w-28 rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}
