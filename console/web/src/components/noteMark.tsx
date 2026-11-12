import type { NoteMark } from "@/api/review-types";
import { cn } from "@/lib/utils";

/** `2026-11-10 23:08Z` in his own clock: `23:08`, with the day when it was not today. */
export function noteTime(at: string, now = Date.now()): string {
  const t = Date.parse(at.replace(" ", "T").replace(/Z$/, ":00Z"));
  if (!Number.isFinite(t)) return at;
  const d = new Date(t);
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return new Date(now).toDateString() === d.toDateString() ? hm : `${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} ${hm}`;
}

/**
 * a long voice note of his touched this card. Stale: the note changed what it is about, so it waits for its owner
 * before he judges it. Updated: the note adds to it; it still holds. Shown until the owner moves the row or rewrites the ask.
 */
export function NoteMarkBand({ mark, className, now }: { mark: NoteMark; className?: string; now?: number }) {
  const stale = mark.kind === "stale";
  return (
    <div
      className={cn(
        "rounded-[10px] border px-3 py-2 text-sm",
        stale ? "border-amber-500/50 bg-amber-50 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100" : "border-sky-500/40 bg-sky-50 text-sky-950 dark:bg-sky-950/40 dark:text-sky-100",
        className,
      )}
      data-testid="note-mark"
      data-kind={mark.kind}
      role="status"
    >
      <div className="font-semibold">{stale ? `Stale: your note of ${noteTime(mark.at, now)} changed this` : `Updated by your note of ${noteTime(mark.at, now)}`}</div>
      {mark.quote && <div className="mt-0.5 border-l-2 border-current/30 pl-2 italic opacity-90">You said “{mark.quote}”</div>}
      <div className="mt-0.5 text-[13px] opacity-80">{stale ? "Its owner has your words and is changing it. No need to judge it yet." : "Its owner has your words and adds them."}</div>
    </div>
  );
}
