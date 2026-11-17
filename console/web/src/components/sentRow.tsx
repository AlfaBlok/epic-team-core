import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Check, Loader2, MessageSquarePlus, Undo2, X } from "lucide-react";
import { invalidate } from "@/lib/data";
import { GAP, scrollerOf, visibleTop } from "@/lib/keepPlace";
import { dismissSent, sentMounted, shownSent, unmarkSent, useSent, type SentEntry } from "@/lib/sentRows";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { PHONE_TAP } from "@/components/common";
import { ThoughtBox } from "@/components/afterClose";
import { CardFeedback } from "@/components/cardFeedback";

/**
 * vn_e00f1134: an answered card collapses in place to this one green row (the owner, vn_e00f1134: "the card shrinks into a row
 * that says sent ... mark it as in green ... it's one row ... add comment ... it stays there"):
 *
 *   ✓ Sent · Approved · The Notes logo was made …            [ Add comment ] [ Bring it back ]
 *
 * Add comment opens a note box on the same card (typed or a voice note, filed to its row or ask and sent to its owner;
 * a card with no row, like a persona's request, sends it to the Team desk with the card named).
 * It keeps `data-inbox-card` so the page does not jump to the next card; if the card's top was above the screen (he
 * pressed low in a long card) the row is brought just under the top bar, so he sees it landed.
 *
 * E948-S140 (the owner 17 Nov 21:39Z: "I just want to see the last one that was done. I don't want to see 20 cards
 * parked."): only the newest answer shows its row; an earlier one draws nothing (its card stays answered).
 * E948-S145 (vn_a95bfbab): he swipes the row away on the phone or closes it with its x on a laptop.
 */
export function SentRow({ slot, entry, className }: { slot: string; entry: SentEntry; className?: string }) {
  // the one newest answer in the whole inbox, whichever section or list draws it (iteration 2: four showed at once)
  return shownSent(entry) ? <ShownSentRow slot={slot} entry={entry} className={className} /> : null;
}

/** a swipe sideways past this many px (or a third of the row) takes the row away */
const SWIPE_AWAY = 80;

function ShownSentRow({ slot, entry, className }: { slot: string; entry: SentEntry; className?: string }) {
  const [open, setOpen] = useState(false);
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const swipe = useRef<{ x: number; y: number; id: number; on: boolean } | undefined>(undefined);
  const [commented, setCommented] = useState(false);
  const [back, setBack] = useState<{ s: "busy" } | { s: "failed"; line: string }>();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => sentMounted(slot), [slot]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof el.getBoundingClientRect !== "function") return;
    const scroller = scrollerOf(el);
    const top0 = visibleTop(scroller);
    const top = el.getBoundingClientRect().top;
    if (top >= top0) return;
    const by = Math.round(top - top0 - GAP);
    if (by) (scroller ?? window).scrollBy?.({ top: by, behavior: "auto" });
  }, []);
  const bringBack = async () => {
    if (!entry.back) return;
    setBack({ s: "busy" });
    try {
      const r = await entry.back();
      if (r.back) {
        unmarkSent(slot);
        invalidate("inbox");
      } else {
        setBack({ s: "failed", line: r.line });
        if (entry.card) setOpen(true);
      }
    } catch (e) {
      setBack({ s: "failed", line: `Not brought back: ${e instanceof Error ? e.message : String(e)}` });
    }
  };
  // E948-S145: a sideways swipe (touch or pen) moves the row with the finger; far enough and it leaves, else it springs back
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === "mouse" || open || (e.target as HTMLElement).closest?.("button, textarea, input, a")) return;
    swipe.current = { x: e.clientX, y: e.clientY, id: e.pointerId, on: false };
  };
  const onPointerMove = (e: PointerEvent) => {
    const s = swipe.current;
    if (!s || s.id !== e.pointerId) return;
    const x = e.clientX - s.x;
    if (!s.on) {
      if (Math.abs(e.clientY - s.y) > 12) return void (swipe.current = undefined); // he is scrolling
      if (Math.abs(x) < 10) return;
      s.on = true;
      setDragging(true);
    }
    setDx(x);
  };
  const onPointerEnd = () => {
    const s = swipe.current;
    swipe.current = undefined;
    if (!s?.on) return;
    setDragging(false);
    const w = ref.current?.offsetWidth || 300;
    if (Math.abs(dx) > Math.min(SWIPE_AWAY, w / 3)) {
      setDx(Math.sign(dx) * w * 1.2);
      setTimeout(() => dismissSent(slot), 180);
    } else setDx(0);
  };
  return (
    <div
      ref={ref}
      className={cn("min-w-0 touch-pan-y rounded-xl border border-emerald-600/40 bg-card px-3 py-2 text-card-foreground", className)}
      style={dx ? { transform: `translateX(${dx}px)`, opacity: Math.max(0.2, 1 - Math.abs(dx) / 300), transition: dragging ? "none" : "transform 180ms ease-out, opacity 180ms ease-out" } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      data-testid="sent-row"
      data-sent-slot={slot}
      data-inbox-card={slot}
      role="status"
      aria-live="polite"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="flex shrink-0 items-center gap-1 font-medium text-emerald-700 dark:text-emerald-400" data-testid="sent-row-word">
          <Check className="h-4 w-4" strokeWidth={3} aria-hidden /> Sent
        </span>
        <span className="shrink-0 text-muted-foreground" data-testid="sent-row-said">
          {entry.said}
        </span>
        <span className="min-w-0 basis-full truncate text-foreground/85 sm:basis-0 sm:flex-1" title={entry.title} data-testid="sent-row-title">
          {entry.title}
        </span>
        <span className="ml-auto flex shrink-0 gap-2">
          {!open && (
            <Button size="sm" variant="outline" className={cn("h-7 text-xs", PHONE_TAP)} onClick={() => setOpen(true)} data-testid="sent-row-comment">
              <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden /> Add comment
            </Button>
          )}
          {entry.back && back?.s !== "failed" && (
            <Button size="sm" variant="ghost" className={cn("h-7 text-xs text-muted-foreground", PHONE_TAP)} disabled={back?.s === "busy"} onClick={() => void bringBack()} data-testid="sent-row-back">
              {back?.s === "busy" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Undo2 className="h-3.5 w-3.5" aria-hidden />} {back?.s === "busy" ? "Bringing it back…" : "Bring it back"}
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground max-sm:hidden" onClick={() => dismissSent(slot)} aria-label="Close" title="Close" data-testid="sent-row-close">
            <X className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </span>
      </div>
      {entry.detail && (
        <p className="pt-1 text-xs text-muted-foreground" data-testid="sent-row-detail">
          {entry.detail}
        </p>
      )}
      {commented && !open && (
        <p className="pt-1 text-xs text-emerald-700 dark:text-emerald-400" data-testid="sent-row-commented">
          Your comment was sent. The owner reads it and acts on it.
        </p>
      )}
      {back?.s === "failed" && (
        <p className="pt-1 text-xs text-amber-700 dark:text-amber-400" data-testid="sent-row-back-line">
          {back.line}
        </p>
      )}
      {open && (
        <div className="mt-2 border-t pt-2">
          {entry.card ? (
            <ThoughtBox card={{ ...entry.card, title: entry.title }} label="Your comment" onSent={() => (setCommented(true), setOpen(false))} onCancel={() => setOpen(false)} testid="sent-row-box" />
          ) : (
            // no row or ask to file to (a persona's request, a set): his words go to the Team desk with the card named
            <CardFeedback origin={`sent:${slot}`} title={entry.title} refName={entry.title} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * E948-S130 (vn_4f13161d: "basically all cards should have the same behavior"): the one wrapper every card kind uses, so
 * each collapses to its green Sent row the same way once he answered it (a press, his words or a voice note), and keeps
 * it after a reload. `slot` is the card's `data-inbox-card` id (`ask:`, `review:`, `team:`, `status:`, `mac:`, `connect:`).
 */
export function SentOr({ slot, children }: { slot: string; children: ReactNode }) {
  const sent = useSent(slot);
  return sent ? <SentRow slot={slot} entry={sent} /> : <>{children}</>;
}
