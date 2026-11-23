import { useRef, useState, type PointerEvent } from "react";
import { X } from "lucide-react";
import { api } from "@/api";
import type { SentBackCard } from "@/api/review-types";
import { mutate, useQuery } from "@/lib/data";
import { useProject } from "@/lib/project";
import { CardFeedback } from "@/components/cardFeedback";
import { CardMeta, CardShell, CARD_TITLE } from "@/components/cardShell";
import { CardButton } from "@/components/ui/cardButton";
import { FoldSection, useSectionOpen } from "@/components/homeSection";
import { saysNeedle, useSearchNeedle } from "@/lib/inboxSearch";
import { useSlotReady } from "@/components/slot";
import { aboutFrom } from "@/lib/about";
import { cn } from "@/lib/utils";

/**
 * (the owner 2026-11-22 23:07Z, Team desk: "Why is it not on my inbox if it doesn't come back to me, then it gets lost
 * ... Why are these things not popping up on my inbox so that I can keep giving input until it gets built?")
 *
 * A card he sent back (Change it, his words) used to leave his inbox until its next round returned. Now it stays, in
 * this one list right under "Done, waiting for your review": the same card, marked with where it is (a worker on it,
 * waiting for one, or closed by the team without coming back), his own words when he sent it back, and the same Voice
 * and Text block as every card, so he keeps adding input while it is built. It leaves the list the moment its next
 * round is back in review (then it is his card again, above) or he closes it.
 *
 * Nothing here waits on him, so it is in no red or green count; the section's pill is grey.
 *
 * Round 2 (the owner 23 Nov 00:29Z and 00:39Z: "Closed by the team, it should not be possible ... I don't want the things to
 * stay in the inbox when I've already responded"; closed ones "sit there forever" and he cannot swipe them away): the
 * list holds only work truly in progress, a worker on it now. A card nobody is on, or one the team closed, is never shown
 * here: the console starts its round itself (and reopens it), and it shows on Hosts while it waits for a slot. He takes
 * any card off the list with a swipe on the phone or its x on a laptop; it comes back only as its next round, in review.
 */
export const SENT_BACK_SECTION = "Sent back, in progress";
/** the card's kind word (one word, as on every card): he returned it to the team. */
export const SENT_BACK_KIND = "Returned";
export const SENT_BACK_WORD: Record<SentBackCard["state"], string> = { in_progress: "In progress", waiting: "Waiting for a worker", closed_by_team: "Being reopened" };
/** on a phone the first few show; one button shows the rest (as Done, waiting for your review). */
const PHONE_FIRST = 5;
const DAY_MS = 86_400_000;

const clock = (iso?: string) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : undefined;
};

/** who is on it now, in plain words: "Ticket worker on host1, since 22:52". */
export function workerLine(c: Pick<SentBackCard, "state" | "worker" | "why" | "continuesIn" | "checkAt">): string {
  if (c.state === "closed_by_team") return "It is being set back to active and its round started. Only you close a card you sent back.";
  if (c.state === "waiting") {
    const at = c.checkAt ? new Date(c.checkAt.replace(/T(\d\d:\d\d)Z$/, "T$1:00Z")) : undefined;
    if (at && Number.isFinite(at.getTime())) return `It waits on a timed check, due ${at.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}. No worker is needed until then.`;
    return "Nobody is on it right now. It starts by itself within 15 minutes of your answer; Hosts shows it while it waits for a slot.";
  }
  const carried = c.continuesIn ? ` It continues as ${c.continuesIn} and comes back as that card.` : "";
  const w = c.worker;
  if (!w) return `A worker is on it.${carried}`;
  if (!w.live) return `Held by a worker (${w.run.slice(0, 12)})${w.leaseUntil ? ` until ${clock(w.leaseUntil.replace(/Z$/, ":00Z")) ?? w.leaseUntil}` : ""}.${carried}`;
  const since = clock(w.startedAt);
  return `${w.persona ?? "A worker"}${w.host ? ` on ${w.host}` : ""}${since ? `, since ${since}` : ""}.${carried}`;
}

/** the cards he took off the list, by card and send-back: a later send-back of the same card shows again. */
const GONE_KEY = "inbox.sentBack.gone";
const goneId = (c: Pick<SentBackCard, "id" | "since">) => `${c.id}@${c.since ?? ""}`;
function readGone(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(GONE_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(-300) : [];
  } catch {
    return [];
  }
}
function saveGone(ids: string[]) {
  try {
    localStorage.setItem(GONE_KEY, JSON.stringify(ids.slice(-300)));
  } catch {
    /* a private window: the card is off the list until the page reloads */
  }
}
/** a swipe sideways past this many px (or a third of the card) takes the card off the list, as the Sent row does. */
const SWIPE_AWAY = 80;

export function SentBackCardView({ card: c, onAway }: { card: SentBackCard; onAway?: () => void }) {
  const tone = c.state === "in_progress" ? "bg-emerald-500" : "bg-amber-500";
  const el = useRef<HTMLElement>(null);
  const swipe = useRef<{ x: number; y: number; id: number; on: boolean } | undefined>(undefined);
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e: PointerEvent) => {
    if (!onAway || e.pointerType === "mouse" || (e.target as HTMLElement).closest?.("button, textarea, input, a")) return;
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
    const w = el.current?.offsetWidth || 300;
    if (Math.abs(dx) > Math.min(SWIPE_AWAY, w / 3)) {
      setDx(Math.sign(dx) * w * 1.2);
      setTimeout(() => onAway?.(), 180);
    } else setDx(0);
  };
  return (
    <CardShell
      ref={el as never}
      as="article"
      kind="sent-back"
      className="relative touch-pan-y"
      style={dx ? { transform: `translateX(${dx}px)`, opacity: Math.max(0.2, 1 - Math.abs(dx) / 300), transition: dragging ? "none" : "transform 180ms ease-out, opacity 180ms ease-out" } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      data-testid="sent-back-card"
      data-ref={c.ref}
      data-state={c.state}
    >
      {onAway && (
        <button type="button" className="absolute right-2 top-2 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Take this card off the list" title="Take it off this list" onClick={onAway} data-testid="sent-back-away">
          <X className="size-4" aria-hidden />
        </button>
      )}
      <CardMeta kind={SENT_BACK_KIND} about={aboutFrom(c.title)} since={c.since} sinceWhat="you sent it back">
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground" data-testid="sent-back-state">
          <span className={cn("inline-block size-2 shrink-0 rounded-full", tone, c.state === "in_progress" && c.worker?.live && "animate-pulse")} aria-hidden />
          {SENT_BACK_WORD[c.state]}
        </span>
        <span>round {c.iteration}</span>
      </CardMeta>
      <h3 className={CARD_TITLE}>{c.title}</h3>
      <p className="mt-1.5 text-sm text-muted-foreground" data-testid="sent-back-worker">
        {workerLine(c)}
      </p>
      {c.words && (
        <p className="mt-2 border-l-2 pl-3 text-sm leading-snug text-foreground/90" data-testid="sent-back-words">
          <span className="text-muted-foreground">You said: </span>
          {c.words}
        </p>
      )}
      <CardFeedback
        origin={`sent-back:${c.id}`}
        title={c.title}
        refName={c.ref}
        send={(words, files, via) =>
          mutate(() => api.commentClosedCard({ kind: "review", repo: c.repo, path: c.path, ref: c.ref, title: c.title, ...(c.milestoneId ? { milestoneId: c.milestoneId } : {}), text: words, ...(files.length ? { attachments: files } : {}), via, stage: "in_work" }), "inbox")
        }
      />
    </CardShell>
  );
}

/** The Inbox's list of every card he sent back that is not back in review yet. Not drawn while there is none. */
export function InboxSentBack() {
  const project = useProject();
  const { data, error } = useQuery(() => (api.listSentBackCards ? api.listSentBackCards() : Promise.resolve([] as SentBackCard[])), [], { tag: "inbox" });
  useSlotReady(!!data || !!error);
  const q = useSearchNeedle();
  const [gone, setGone] = useState(readGone);
  const away = (c: SentBackCard) =>
    setGone((g) => {
      const next = [...g.filter((x) => x !== goneId(c)), goneId(c)];
      saveGone(next);
      return next;
    });
  // only work truly in progress: a worker on it now. Waiting and closed ones are the console's to start, not his to look at.
  const all = (data ?? []).filter((c) => c.state === "in_progress" && !gone.includes(goneId(c)) && project.keep(c.milestoneId));
  const cards = q ? all.filter((c) => saysNeedle(q, c.title, c.ref, c.words)) : all;
  // one he sent back in the last day opens the section by itself, even where the Inbox lands folded: he just pressed
  // and looks for it
  const fresh = all.some((c) => c.since && Date.now() - Date.parse(c.since) < DAY_MS);
  const [open, setOpen] = useSectionOpen("sent-back", true, fresh);
  const [phoneAll, setPhoneAll] = useState(false);
  if (!cards.length) return null;
  return (
    <FoldSection title={SENT_BACK_SECTION} count={cards.length} tone="info" testId="sent-back" bodyTestId="sent-back-section" open={open || !!q} onToggle={setOpen}>
      <ul className="grid min-w-0 grid-cols-1 gap-[18px]" data-testid="sent-back-list">
        {cards.map((c, n) => (
          <li key={c.id} className={cn("min-w-0", n >= PHONE_FIRST && !phoneAll && !q && "max-sm:hidden")} data-testid="sent-back-item">
            <SentBackCardView card={c} onAway={() => away(c)} />
          </li>
        ))}
      </ul>
      {cards.length > PHONE_FIRST && !phoneAll && !q && (
        <CardButton variant="outline" className="mt-3 w-full sm:hidden" onClick={() => setPhoneAll(true)} data-testid="sent-back-phone-more">
          Show {cards.length - PHONE_FIRST} more in progress
        </CardButton>
      )}
    </FoldSection>
  );
}
