import { saysNeedle, useInboxSearch, useSearchNeedle } from "@/lib/inboxSearch";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useSlotReady } from "@/components/slot";
import { OwnerPriorityTag } from "./ownerPriority";
import { NoteMarkBand } from "./noteMark";
import { ACTION, PRESS, pressProps, type Pressing } from "@/components/cardActions";
import { Link } from "react-router-dom";
import { Check, Loader2, X } from "lucide-react";
import { api, type ReviewItem } from "@/api";
import type { CardFace, CardPageNote, ClosedCardRef, ClosedGoal, PostCardInfo, TreeLine } from "@/api/review-types";
import { mutate, useQuery } from "@/lib/data";
import { milestoneBookHref } from "@/lib/book";
import { deckHref } from "@/lib/deck";
import { snoozeReview, unsnoozeReview, useSnoozes } from "@/lib/snooze";
import { onPress, PressUndone } from "@/lib/press";
import { showClosed, useClosedNote, type BackResult } from "@/lib/afterClose";
import { cardBody, cardHeading } from "@/lib/askLead";
import { CARD_WORD, DECIDE_QUESTION, isDecisionCard, leadsFirst, leadsSection } from "@/lib/cardKind";
import { LeadLines } from "@/components/readyFirst";
import { useMinuteClock } from "@/components/deadlineFirst";
import { cn } from "@/lib/utils";
import { useProject } from "@/lib/project";
import { markReviewGoneAfter, unmarkReviewGone, useReviewCards } from "@/lib/inbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, ErrorBox, PHONE_TAP, RelTime } from "@/components/common";
import { CARD_LINK, CardButton } from "@/components/ui/cardButton";
import { cardPage, shortTo, useAnswerVoice } from "@/voice/AnswerVoice";
import { useChatAttach } from "@/components/ChatAttach";
import { WordsBox } from "@/components/WordsBox";
import { CardFeedback, FeedbackBlock, RowPair } from "@/components/cardFeedback";
import { reviewCard, SectionCallButton } from "@/voice/SectionCall";
import { CARD_FRAME, CARD_TITLE, CardMeta, CardShell } from "@/components/cardShell";

/** A voice note's press the card did not take (the card says why). */
const refused = (): never => {
  throw new Error("the card did not take it, open the card to see why");
};
import { FoldSection, SkeletonCards, SortControl, sortSection, useSectionOpen, useSectionSort } from "@/components/homeSection";
import { LimitControl, ListPane, limitList, useListLimit } from "@/components/listPane";
import { HOLD_MS, SnoozeDate, SnoozeDropdown, SnoozingLinesFor } from "@/components/waiting";
import { ParkButton, parkReview } from "@/components/parkButton";
import { paragraphs, slotShort, slotWords as slotUtc, splitTitle } from "@/lib/postBasics";
import { keepPlace } from "@/lib/keepPlace";
import { unmarkSent, useKeepSent, useSent } from "@/lib/sentRows";
import { SentOr, SentRow } from "@/components/sentRow";

/** the server adds the milestone's title to each card it lists. */
type Listed = ReviewItem & { milestoneTitle?: string };

/**
 * (the owner 2026-11-03, approved mockup docs/status/e48-s26/real-feed-mockup.html, spec docs/status/e48-s26-card-spec.md):
 * "Done, waiting for your review" is one flat list, every card fully shown: no goal groups, folding, progress bars or
 * Show 20/50/all. The server lists only rows that passed the gate (review/rows.ts verdict `card`), so the count here is
 * the badge's and the sidebar's. A pressed card slides away and the count drops at once; every press writes the spine
 * first and a refused write changes nothing and shows why, with Retry.
 */
export function WaitingForReview({
  fold,
  only,
  title = REVIEW_SECTION,
  closedGoals = true,
  testId = "waiting-for-review",
  tone = "review",
  empty = "Nothing finished waiting for your review.",
  snoozedList = "own",
}: {
  fold?: string;
  only?: (i: ReviewItem) => boolean;
  title?: string;
  /** the Inbox shows its closed goals under Everything else, so it turns them off here. */
  closedGoals?: boolean;
  /** E948-S103: the Decisions bucket is this list again, its own test id, red (it waits on his choice) */
  testId?: string;
  tone?: "review" | "needs-you";
  empty?: string;
  /** E948-S103: the Inbox keeps one Snoozed reviews list, under review, holding every snoozed card (decisions too). */
  snoozedList?: "own" | "all" | "none";
} = {}) {
  // tagged "inbox", so a snooze refreshes this list and the green pill (counts) together.
  // the cards are `useReviewCards`, the list the green pills count (one fetch, this browser's snoozes and presses
  // applied the same way), so the header, the sidebar and the phone top bar never show a card the list does not.
  const project = useProject();
  const { data: fetchedAll, error, cards: allCards } = useReviewCards({ keep: project.keep });
  // a goal set shows its own cards only; the Inbox shows every card.
  const cards = only ? allCards?.filter(only) : allCards;
  useSlotReady(!!fetchedAll || !!error);
  const { data: fetchedSnoozedAll } = useQuery(() => api.listReviewItems({ state: "snoozed" }) as Promise<Listed[]>, [], { tag: "inbox" });
  // the selected project's review cards only.
  const fetched = fetchedAll?.filter((i) => project.keep(i.milestoneId) && (!only || only(i)));
  const fetchedSnoozed = fetchedSnoozedAll?.filter((i) => project.keep(i.milestoneId) && (!only || snoozedList === "all" || only(i)));
  // (the owner 20:27Z: "It should just be at the top on blocked waiting for me or top done waiting for your
  // review"): a card ready for him, or with a deadline, leads this section, never a section of its own; while one is
  // here the section opens by itself (even where the Inbox lands folded).
  const leads = !!cards?.some((i) => leadsSection(i.face));
  const now = useMinuteClock(leads);
  // the Team home's section header folds like every section (L-39, remembered); the cards in it are never folded
  const [open, setOpen] = useSectionOpen(fold, true, leads);
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  // the owner 2026-11-12, "on the mobile, it's just a total mess": 21 open cards made
  // Home about 40 phone screens long. On a phone the first PHONE_FIRST show and one button shows the rest; every card
  // stays whole (its feedback block open), the computer shows them all, and a search shows every match.
  const [phoneAll, setPhoneAll] = useState(false);
  const [snoozedLimit, setSnoozedLimit] = useListLimit("review-snoozed");
  // a pressed card: `leaving` slides it out, then it is gone from every list and count (lib/inbox) until the refetch no longer has it
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const { entries: snoozing, back } = useSnoozes();
  // the Inbox's search box keeps only the cards the server's search names (title, card text, his notes).
  const search = useInboxSearch();
  const hits = search.active ? search.hits : undefined;
  // on the Team home (fold set) the same Sort as Blocked on you, remembered per section (the owner
  // 2026-11-12 "I want to be able to do sorting"): Highest priority keeps the server's order, the others by the date it came to review.
  const [sort, setSort] = useSectionSort(fold);
  const shown = hits ? (cards as Listed[] | undefined)?.filter((i) => hits.has(i.id)) : (cards as Listed[] | undefined);
  const data = shown && leadsFirst(sortSection(shown, sort, (i) => i.createdAt || undefined));
  const snoozedFrom = snoozedList === "all" ? fetchedAll?.filter((i) => project.keep(i.milestoneId)) : fetched;
  const snoozedAll = snoozedList === "none" ? [] : [
    ...(snoozedFrom ?? []).filter((i) => snoozing.has(i.id)).map((i) => ({ ...i, snoozedUntil: snoozing.get(i.id)!.until })),
    ...(fetchedSnoozed ?? []).filter((i) => !back.has(i.id) && !snoozedFrom?.some((x) => x.id === i.id)),
  ].sort((a, b) => (a.snoozedUntil ?? "").localeCompare(b.snoozedUntil ?? ""));
  const snoozed = hits ? snoozedAll.filter((i) => hits.has(i.id)) : snoozedAll;
  const items = data ?? [];
  // vn_e00f1134: a card he pressed stays where it was as its green Sent row, after the refetch drops it too
  const rows = useKeepSent(items, (i) => `review:${i.id}`, `review:${fold ?? testId}`);
  // tasks just marked here are no longer open, before the list refetches (a goal's confirm never names them)
  // what a pressed card is doing once it has left: "Saved · writing it to the project… 3 s", then "Done ✓ … in 6.1 s"
  const progress = usePressProgress((id) => fetched?.find((i) => i.id === id));
  const pressedRefs = new Set((fetched ?? []).filter((i) => leaving.has(i.id)).map((i) => `${i.repo}:${i.path}#${i.ref}`));
  const pressed = (id: string) => {
    setLeaving((s) => new Set(s).add(id));
    markReviewGoneAfter(id, 320);
  };
  // a card leaves on its 202; a press that then fails for good brings it back, saying why
  const [failed, setFailed] = useState<Map<string, string>>(new Map());
  const comeBack = (id: string, why: string) => {
    setLeaving((s) => new Set([...s].filter((x) => x !== id)));
    unmarkReviewGone(id);
    setFailed((m) => new Map(m).set(id, why));
  };
  // Bring it back: the card is in the list again, fresh (its buttons back), with no error line
  const [backs, setBacks] = useState<Map<string, number>>(new Map());
  const broughtBack = (id: string) => {
    setLeaving((s) => new Set([...s].filter((x) => x !== id)));
    unmarkReviewGone(id);
    setFailed((m) => (m.has(id) ? new Map([...m].filter(([k]) => k !== id)) : m));
    setBacks((m) => new Map(m).set(id, (m.get(id) ?? 0) + 1));
  };
  // under CONSOLE_AUTH=on a world other than the home world is refused this list (403 world_scope): no section.
  // a slid-out card that a later fetch lists again (the console's rescan lags a press, or the row was reopened) shows
  // as a card, never as an invisible card-sized gap (the owner 2026-11-12, "look at all this space"): once off the list,
  // its slide-out is dropped when it comes back.
  const offList = useRef(new Set<string>());
  const listed = items.map((i) => i.id).join(" ");
  useEffect(() => {
    const on = new Set(listed.split(" "));
    const back = [...leaving].filter((id) => on.has(id) && offList.current.has(id));
    leaving.forEach((id) => !on.has(id) && offList.current.add(id));
    back.forEach((id) => offList.current.delete(id));
    if (back.length) setLeaving((s) => new Set([...s].filter((id) => !back.includes(id))));
  }, [listed, leaving]);
  if ((error as { status?: number } | undefined)?.status === 403) return null;
  return (
    <>
      <FoldSection
        title={title}
        count={data ? items.length : fold && !error ? undefined : 0}
        hideZero={!fold}
        tone={tone}
        testId={testId}
        open={open || !!hits}
        onToggle={fold ? setOpen : undefined}
        call={fold && items.length > 0 && <SectionCallButton section={title} testId={testId} cards={() => items.map(reviewCard)} />}
        actions={fold && <SortControl value={sort} onChange={setSort} testId={testId} />}
      >
        <SnoozingLinesFor items={[...(fetched ?? []), ...(fetchedSnoozed ?? []).filter((i) => !fetched?.some((x) => x.id === i.id))].map((i) => ({ id: i.id, label: i.face?.title ?? i.title }))} />
        {error && <ErrorBox error={error} muted />}
        {!data && !error && <SkeletonCards count={undefined} testId={`${testId}-loading`} />}
        {data && items.length === 0 && (hits ? <p className="text-sm text-muted-foreground" data-testid="nothing-matches-review">Nothing here matches “{search.q}”.</p> : <Empty>{empty}</Empty>)}
        {rows.length > 0 && (
          <ul className="grid min-w-0 grid-cols-1 gap-[18px]" data-testid="review-feed">
            {rows.map(({ slot, item: i, sent }, n) =>
              !i || sent ? (
                <li key={slot} className="min-w-0" data-testid="review-feed-sent">
                  {sent && <SentRow slot={slot} entry={sent} />}
                </li>
              ) : (
              <li
                key={i.id}
                className={cn("min-w-0 transition-all duration-300 ease-in", n >= PHONE_FIRST && !phoneAll && !hits && "max-sm:hidden")}
                style={leaving.has(i.id) ? { opacity: 0, transform: "translateX(-40px)" } : undefined}
                data-testid="review-feed-item"
                data-inbox-card={`review:${i.id}`}
                data-lead={leadsSection(i.face) ? "yes" : undefined}
              >
                {leadsSection(i.face) && (
                  <div className="mb-2 grid min-w-0 gap-2" data-testid="lead-lines">
                    <LeadLines face={i.face} now={now} />
                  </div>
                )}
                {i.kind === "post" && i.post ? (
                  <PostReviewCard key={failed.get(i.id)} item={i} onDone={() => pressed(i.id)} onFailed={(why) => comeBack(i.id, why)} failed={failed.get(i.id)} />
                ) : (
                  <ReviewCard key={`${failed.get(i.id) ?? ""}:${backs.get(i.id) ?? 0}`} item={i} onDone={() => pressed(i.id)} onFailed={(why) => comeBack(i.id, why)} onBack={() => broughtBack(i.id)} failed={failed.get(i.id)} closedRefs={pressedRefs} />
                )}
              </li>
              ),
            )}
          </ul>
        )}
        {items.length > PHONE_FIRST && !phoneAll && !hits && (
          <CardButton variant="outline" className="mt-3 w-full sm:hidden" onClick={() => setPhoneAll(true)} data-testid="review-phone-more">
            Show {items.length - PHONE_FIRST} more to review
          </CardButton>
        )}
      </FoldSection>
      <PressProgress lines={progress} />
      {closedGoals && <ClosedGoalsFold />}
      {/* snoozed reviews, folded under the section with their own count and Unsnooze (as Snoozed asks). */}
      {snoozed.length > 0 && (
        <FoldSection
          title="Snoozed reviews"
          count={snoozed.length}
          testId="review-snoozed"
          bodyTestId="review-snoozed-section"
          open={snoozedOpen || !!hits}
          onToggle={setSnoozedOpen}
          actions={<LimitControl limit={snoozedLimit} onChange={setSnoozedLimit} total={snoozed.length} testId="review-snoozed" />}
        >
          <p className="mb-2 text-xs text-muted-foreground">Done, waiting for your review, hidden until the time shown.</p>
          <ListPane shown={limitList(snoozed, snoozedLimit).length} total={snoozed.length} testId="review-snoozed" className="grid-cols-1">
            {limitList(snoozed, snoozedLimit).map((i) => (
              <SnoozedReviewRow key={i.id} item={i} />
            ))}
          </ListPane>
        </FoldSection>
      )}
    </>
  );
}

/** E948-S103: the Inbox's Decisions bucket, the review cards that wait on his choice, counted red as waiting on him. */
export function InboxDecisions() {
  return <WaitingForReview fold="decisions" closedGoals={false} only={(i) => isDecisionCard(i.face)} title={DECISIONS_SECTION} testId="inbox-decisions" tone="needs-you" empty="No decision waits on you." snoozedList="none" />;
}
/** E948-S103: Done, waiting for your review keeps only finished work he marks done (a ready or deadline card leads it,). */
export function InboxDoneForReview() {
  return <WaitingForReview fold="review" closedGoals={false} only={(i) => !isDecisionCard(i.face)} snoozedList="all" />;
}

/**
 * Q3: goals you closed with items still open. Those items show nowhere else until you reopen the goal here;
 * nothing was deleted.
 */
export function ClosedGoalsFold() {
  const { data } = useQuery(() => api.listClosedGoals().catch(() => [] as ClosedGoal[]), [], { tag: "inbox" });
  const [open, setOpen] = useState(false);
  // E948-S78: the Inbox search keeps the closed goals whose title, code or hidden items hold it; none left, it hides.
  const needle = useSearchNeedle();
  const items = (data ?? []).filter((g) => g.hidden.length > 0 && saysNeedle(needle, g.title, g.code, ...g.hidden));
  if (!items.length) return null;
  return (
    <FoldSection title="Closed goals with open items" count={items.length} testId="review-closed-goals" bodyTestId="review-closed-goals-section" open={open || !!needle} onToggle={setOpen}>
      <p className="mb-2 text-xs text-muted-foreground">You closed these goals while items were still open. Those items show nowhere else until you reopen the goal. Nothing was deleted.</p>
      <ul className="grid gap-2">
        {items.map((g) => (
          <ClosedGoalRow key={g.key} goal={g} />
        ))}
      </ul>
    </FoldSection>
  );
}

function ClosedGoalRow({ goal }: { goal: ClosedGoal }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const reopen = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      await mutate(() => api.reopenGoal(goal.key));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const book = goal.milestoneId ? `${milestoneBookHref(goal.milestoneId)}#${encodeURIComponent(goal.code)}` : undefined;
  return (
    <li className="grid gap-1 text-sm" data-testid="review-closed-goal" data-goal={goal.code}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate" title={goal.title}>
          {book ? <Link className="underline-offset-2 hover:underline" to={book}>{goal.title}</Link> : goal.title}
        </span>
        <CardButton variant="outline" className="h-7 text-xs" disabled={busy} pending={busy} pendingLabel="Reopening…" onClick={reopen} data-testid="review-reopen-goal">
          ↺ Reopen the goal
        </CardButton>
      </div>
      <div className="text-xs text-muted-foreground">
        {goal.hidden.length} open {goal.hidden.length === 1 ? "item is" : "items are"} hidden until you reopen it.
      </div>
      {err && <div className="text-xs text-destructive">{err}</div>}
    </li>
  );
}

/** "the code repo · the code repo" (repo · spine title, the same word) reads once. */
export function milestoneLabel(title?: string): string | undefined {
  if (!title) return title;
  const parts = title.split(" · ").map((p) => p.trim());
  return parts.filter((p, i) => i === 0 || p.toLowerCase() !== parts[i - 1].toLowerCase()).join(" · ");
}

/** one snoozed review: its title (one line, full on a click), until when, Unsnooze (the card is back). */
function SnoozedReviewRow({ item }: { item: Listed }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [full, setFull] = useState(false);
  const snoozing = useSnoozes().entries.get(item.id);
  useEffect(() => {
    if (!busy) return;
    const t = setTimeout(() => setBusy(false), HOLD_MS);
    return () => clearTimeout(t);
  }, [busy]);
  const unsnooze = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await unsnoozeReview(item);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const title = item.face?.title ?? item.title;
  return (
    <li className="min-w-0 text-sm" data-testid="review-snoozed-row" data-review-id={item.id}>
      <div className="flex min-w-0 items-center gap-x-2 whitespace-nowrap" title={title}>
        <button type="button" className={cn("min-w-[4rem] flex-1 text-left", full ? "whitespace-normal break-words" : "truncate")} aria-expanded={full} onClick={() => setFull(!full)}>
          {title}
        </button>
        {item.snoozedUntil && (
          <Badge variant="outline" className="shrink-0">
            <SnoozeDate until={item.snoozedUntil} />
          </Badge>
        )}
        {snoozing && !snoozing.done ? (
          <span className="shrink-0 text-xs text-muted-foreground">Snoozing…</span>
        ) : (
          <CardButton variant="outline" className="h-7 shrink-0 text-xs" disabled={busy} pending={busy} pendingLabel="Unsnoozing…" onClick={unsnooze} data-testid="review-unsnooze">
            Unsnooze
          </CardButton>
        )}
      </div>
      {error && <div className="text-xs text-red-700 dark:text-red-400">{error}</div>}
    </li>
  );
}

// ---------- links: nothing on a card looks like a link without being one ----------

/** A row code, a URL or a repo path in card text. */
const TOKEN = /\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>"')\]]+)|((?:[\w.-]+\/)+[\w.-]+\.(?:md|ts|tsx|js|mjs|json|py|sh|ya?ml|html|txt|log|png|jpe?g|css)\b)|(\b[A-Z][A-Z0-9]*-[A-Z]{0,3}\d+[a-z]?\b)/g;

/** A short label for a URL (never the raw URL): host and a short path. */
export function urlLabel(url: string): string {
  try {
    const u = new URL(url);
    const p = u.pathname.replace(/\/$/, "");
    return `${u.hostname.replace(/^www\./, "")}${p && p.length <= 24 ? p : ""}`;
  } catch {
    return "Open it";
  }
}

const githubFile = (github: string | undefined, rel: string) => (github ? `https://github.com/${github}/blob/main/${rel.split("/").map(encodeURIComponent).join("/")}` : undefined);

/** The mockup's link blue. */
// links are ink with a thin underline, never blue.
const LINK = "underline decoration-foreground/25 underline-offset-[3px] [overflow-wrap:anywhere] hover:decoration-current";

function A({ href, children, testId }: { href: string; children: ReactNode; testId?: string }) {
  if (href.startsWith("/")) return <Link className={LINK} to={href} data-testid={testId}>{children}</Link>;
  return (
    <a className={LINK} href={href} target="_blank" rel="noreferrer" data-testid={testId}>
      {children}
    </a>
  );
}

/**
 * Card text with every markdown link and URL as a real link, and (the gate keeps them off the card, this is the safety
 * net) any row code or file path linked to its file in the repo. the owner 2026-11-03: "DON'T GIVE ME A LINK I CAN'T CLICK".
 */
export function CardText({ text, item }: { text: string; item: Pick<ReviewItem, "github" | "path" | "milestoneId" | "face"> }) {
  const out: ReactNode[] = [];
  let last = 0;
  const codeHref = item.github && item.path ? githubFile(item.github, item.path) : item.milestoneId ? milestoneBookHref(item.milestoneId) : "/";
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    let tok = m[0];
    if (m[3]) tok = tok.replace(/[.,;:!?]+$/, "");
    out.push(text.slice(last, at));
    last = at + tok.length;
    if (m[1]) out.push(<A key={at} href={m[2]}>{m[1]}</A>);
    else if (m[3]) out.push(<A key={at} href={tok}>{urlLabel(tok)}</A>);
    else if (m[4]) out.push(<A key={at} href={githubFile(item.github, tok) ?? codeHref ?? "/"}>{tok}</A>);
    else out.push(<A key={at} href={codeHref ?? "/"}>{tok}</A>);
  }
  out.push(text.slice(last));
  return (
    <>
      {out.map((n, i) => (
        <Fragment key={i}>{n}</Fragment>
      ))}
    </>
  );
}

// ---------- the card ----------

/** the buttons by case, each with its sub-line (the mockup's words; "approve" never appears). */
export function cardButtons(face: Pick<CardFace, "closesGoal" | "next" | "after">, start: boolean[]): { label: string; sub: string; how: "switches" | "park"; go: boolean }[] {
  const next = face.next ?? [];
  const n = start.filter(Boolean).length;
  const close = face.closesGoal;
  const stays = face.after ? `The goal stays open. ${face.after}` : "The goal stays open. The team goes on with its next task.";
  if (!next.length)
    return [
      close
        ? { label: "✓ Mark this task complete and close the goal", sub: "This is the last open part of the goal, so the goal closes.", how: "switches", go: true }
        : { label: "✓ Mark this task complete", sub: stays, how: "switches", go: true },
    ];
  // follow-ups for other goals (a persona's switches): one button sends every On and Off
  if (next.some((s) => s.target)) {
    const off = next.length - n;
    // a proposer's card offers new goals: on starts the goal, off parks it
    const goals = next.every((s) => s.kind === "new");
    const onWords = goals
      ? `${n === 1 ? "The goal you switched on starts" : `The ${n} goals you switched on start`}, and a Delivery Manager is sent to ${n === 1 ? "it" : "them"}. `
      : `${n === 1 ? "The one you switched on becomes a task" : `The ${n} you switched on become tasks`} in ${n === 1 ? "its goal" : "their goals"}, and the team starts ${n === 1 ? "it" : "them"}. `;
    return [
      {
        label: `✓ Send my choices: ${n} on, ${off} off`,
        sub: `${n ? onWords : ""}${off ? `${off === 1 ? "The one switched off is" : `The ${off} switched off are`} ${goals ? "parked" : "dropped"} with your reason and not suggested again.` : ""}`.trim(),
        how: "switches",
        go: true,
      },
    ];
  }
  const started = next.filter((_, i) => start[i]).map((s) => s.title);
  const parked = next.length - n;
  return [
    ...(n > 0
      ? [
          {
            label: `✓ Mark this task complete${close ? ", close the goal" : ""} and start ${n} next ${n === 1 ? "step" : "steps"}`,
            sub: `The team starts: ${joinSteps(started)}.${parked ? ` ${parked === 1 ? "The other next step is" : `The other ${parked} next steps are`} parked on the goal.` : ""}`,
            how: "switches" as const,
            go: true,
          },
        ]
      : []),
    {
      label: `✓ Mark this task complete${close ? ", close the goal" : ""}, don't start anything`,
      sub: `${next.length === 1 ? "The next step is" : next.length === 2 ? "Both next steps are" : `All ${next.length} next steps are`} parked on the goal. Nothing new starts.`,
      how: "park" as const,
      go: n === 0,
    },
  ];
}

/**
 * E979-G20261113 iteration 2 (the owner 2026-11-14, vn_78c963b6, on the Gap finder card: "the button shouldn't be marked
 * complete. It should be start ... the count, start the 6. And if I switch one off, start 5. Mark complete is ambiguous."):
 * the main button names what the press does, counted live from the switches.
 *  - any follow-ups (On / Off switches or Start now / Park steps): "Start <n>", "Close, start nothing" when none starts;
 *  - no next steps: "Mark complete" (the owner 2026-11-12 21:46Z: accept it as is, or Give feedback); never on a card
 *    with follow-ups (E948-S83, cardInventory.test.tsx renders every card kind and fails on it).
 * A press that closes the goal says so: ", close the goal".
 */
export function mainButtonLabel(face: { closesGoal?: boolean; next?: CardFace["next"] }, start: boolean[]): string {
  const next = face.next ?? [];
  const n = next.filter((_, i) => start[i]).length;
  const close = face.closesGoal ? ", close the goal" : "";
  // E948-S83 (the owner, third time, ^e-f43544: "We're still not getting the button names that make sense for the tasks"):
  // every card with follow-ups, switches or Start now / Park steps alike, names the press by what it starts.
  if (next.length) return n ? `Start ${n}${close}` : `Close${close ? " the goal" : ""}, start nothing`;
  return `Mark complete${close}`;
}

/**
 * E948-S69 (the owner 2026-11-13, vn_9e6f5fa4: "when we have decisions, then the buttons need to be the decisions, or I can
 * leave feedback ... we cannot have a button that says Mark complete when the card is about a decision"): a card that
 * asks a decision answers it with its options, each button named by what happens next, never Mark complete.
 * A decision card is one with `options:` (2 to 4 `<label>: <next step>`), or whose decision asks "Do we / Should we …?".
 * Undefined for a review card (Mark complete or Give feedback).
 */
/** step titles in one sentence: each without its own closing full stop, so "…for the app., Three…" never shows (vn_e751eeeb). */
export const joinSteps = (titles: string[]) => titles.map((t) => t.trim().replace(/[.。]+$/, "")).join(", ");
export { DECIDE_QUESTION } from "@/lib/cardKind";
export type DecisionChoice = { label: string; sub: string; start: boolean; recommended: boolean };
export function decisionChoices(face: Pick<CardFace, "decision" | "options" | "next">): DecisionChoice[] | undefined {
  const next = face.next ?? [];
  const titles = joinSteps(next.map((s) => s.title));
  const decision = face.decision ?? "";
  const own = (face.options ?? []).filter((o) => /^[^:]{1,30}:\s*\S/.test(o));
  const rec = (label: string) => {
    const word = label.split(":")[0].trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!word) return false;
    const said = /recommends?\s+(?:to\s+|the\s+)?["“']?([a-z0-9]+)/i.exec(decision)?.[1]?.toLowerCase();
    return said === word;
  };
  const parks = (label: string) => {
    const [answer, ...rest] = label.split(":");
    const step = rest.join(":").trim();
    return /^(?:park|drop|stop|leave|not now|keep it parked)\b/i.test(step) || /^(?:no|not now)\b/i.test(answer.trim());
  };
  const subOf = (label: string, start: boolean) =>
    start
      ? /:\s*plan\b/i.test(label)
        ? `The team writes a detailed plan${titles ? ` for ${titles}` : ""} and brings it to you before building.`
        : titles
          ? `The team starts: ${titles}.`
          : "The team takes your answer and goes on."
      : titles
        ? `${titles} ${next.length === 1 ? "stays" : "stay"} parked on the goal. Nothing new starts.`
        : "Nothing new starts. It stays parked.";
  const list =
    own.length >= 2
      ? own.slice(0, 4)
      : DECIDE_QUESTION.test(decision.trim())
        ? ["Yes: plan it", "No: park it"]
        : undefined;
  if (!list) return undefined;
  const out = list.map((label) => ({ label, start: !parks(label), sub: subOf(label, !parks(label)), recommended: rec(label) }));
  // the team's recommendation leads (filled); with none named, the first option does
  if (!out.some((c) => c.recommended)) out[0].recommended = true;
  return [...out.filter((c) => c.recommended), ...out.filter((c) => !c.recommended)];
}

export { CARD_WORD, FEEDBACK_OPTION, isDecisionCard } from "@/lib/cardKind";
export const DECISIONS_SECTION = "Decisions waiting on you";
export const REVIEW_SECTION = "Done, waiting for your review";

const MARK: Record<TreeLine["mark"], string> = { done: "✓", progress: "◐", this: "●", next: "○" };

function Label({ children }: { children: ReactNode }) {
  return <div className="mb-[3px] text-[13px] font-bold text-muted-foreground">{children}</div>;
}

/**
 * a card a persona sent on its own names it, says in one line what it does, where it runs (its level, the
 * milestone its assignment sits on, cadence and repo) and links its settings.
 */
function FromBand({ from }: { from: NonNullable<CardFace["from"]> }) {
  return (
    <section className="mx-[18px] mt-3 rounded-[10px] border border-dashed px-3 py-2 text-[13px]" data-testid="review-from">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-bold">From the {from.name}</span>
        {/* its own page first, then its schedule and its instructions. */}
        {from.page && (
          <A href={from.page} testId="review-from-page">
            All its runs ↗
          </A>
        )}
        {from.url && (
          <A href={from.url} testId="review-from-settings">
            Its settings ↗
          </A>
        )}
        {from.file && (
          <A href={from.file} testId="review-from-file">
            Its instructions ↗
          </A>
        )}
      </div>
      {from.line && <div className="text-muted-foreground">{from.line}</div>}
      {from.runs && <div className="text-muted-foreground">{from.runs}</div>}
      {from.stores && <div className="text-muted-foreground" data-testid="review-from-stores">{from.stores}</div>}
      {from.readers && <div className="text-muted-foreground" data-testid="review-from-readers">{from.readers}</div>}
    </section>
  );
}

/** what a card says once its press is saved, and once it is in the repo (L-48: plain words). */
export const SAVED_LINE = "Saved ✓ It is being written to the project now.";
export const LANDED_LINE = "Done ✓ It is in the project.";

type Progress = { id: string; title: string; state: "writing" | "done"; at: number; doneAt?: number; ms?: number; steps?: Record<string, number> };

/**
 * every review press the console saved (its 202) gets a line at the bottom of the screen while it is written to
 * the project in the background (seconds counting), then "Done" with how long it took, for PRESS.doneShowMs. A press that
 * fails for good drops its line: its card comes back saying why.
 */
function usePressProgress(itemOf: (id: string) => Listed | undefined): Progress[] {
  const [lines, setLines] = useState<Progress[]>([]);
  const [, tick] = useState(0);
  const of = useRef(itemOf);
  of.current = itemOf;
  useEffect(
    () =>
      onPress((n) => {
        const m = /\/review-items\/([^/]+)\//.exec(n.path);
        if (!m) return;
        const id = decodeURIComponent(m[1]);
        if (n.state === "landing") {
          const i = of.current(id);
          const title = i?.face?.title ?? i?.post?.title ?? i?.title ?? "Your press";
          setLines((l) => [...l.filter((x) => x.id !== id), { id, title, state: "writing", at: Date.now() }]);
        } else if (n.state === "landed") setLines((l) => l.map((x) => (x.id === id ? { ...x, state: "done", doneAt: Date.now(), ms: n.ms ?? Date.now() - x.at, steps: n.steps } : x)));
        else setLines((l) => l.filter((x) => x.id !== id));
      }),
    [],
  );
  // the seconds count while a line is writing; a done line goes after PRESS.doneShowMs
  useEffect(() => {
    if (!lines.length) return;
    const t = setInterval(() => {
      tick((n) => n + 1);
      setLines((l) => (l.some((x) => x.doneAt && Date.now() - x.doneAt > PRESS.doneShowMs) ? l.filter((x) => !x.doneAt || Date.now() - x.doneAt <= PRESS.doneShowMs) : l));
    }, 1000);
    return () => clearInterval(t);
  }, [lines.length]);
  return lines;
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
/** Where the seconds went, for the line's tooltip: waiting for the project, getting the latest, saving, sending. */
const STEP_WORDS: Record<string, string> = { lock: "waiting its turn", fetch: "getting the latest", commit: "saving", push: "sending", rebase: "catching up", guards: "checks" };
const stepsText = (s?: Record<string, number>) =>
  s ? Object.entries(s).filter(([k, v]) => STEP_WORDS[k] && v >= 50).map(([k, v]) => `${STEP_WORDS[k]} ${secs(v)}`).join(", ") : undefined;

function PressProgress({ lines }: { lines: Progress[] }) {
  // the floating "Saved" note stands at the bottom; these lines go above it while it shows
  const note = useClosedNote();
  if (!lines.length) return null;
  return (
    <div className={cn("pointer-events-none fixed inset-x-0 z-50 flex flex-col items-center gap-1.5 px-3", note ? "bottom-40" : "bottom-3")} role="status" aria-live="polite" data-testid="press-progress">
      {lines.slice(-3).map((l) => (
        <div
          key={l.id}
          className={cn(
            "pointer-events-auto flex w-full max-w-md items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg",
            l.state === "done" ? "border-emerald-600/40 bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100" : "bg-card text-card-foreground",
          )}
          data-testid="press-progress-line"
          data-state={l.state}
          title={l.state === "done" ? stepsText(l.steps) : undefined}
        >
          {l.state === "done" ? <Check className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={3} aria-hidden /> : <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" aria-hidden />}
          <span className="min-w-0">
            <b>{l.state === "done" ? `${PRESS.done} in ${secs(l.ms ?? 0)}.` : `${PRESS.writing} ${Math.floor((Date.now() - l.at) / 1000)} s`}</b>
            <span className="block truncate text-xs opacity-80">{l.title}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

type CardProps = { item: Listed; onDone?: () => void; onFailed?: (why: string) => void; failed?: string; /** Bring it back put the card back in the list */ onBack?: () => void };

/** what the floating note says a review card's press did. */
const SAID: Record<string, string> = { close: "Closed", decline: "Declined", changes: "Changes sent to the team" };
/** the row a review card is on (its spine), for Add a last thought and Bring it back; undefined when unknown. */
const cardOf = (item: ReviewItem): ClosedCardRef | undefined =>
  item.repo && item.path && item.ref ? { kind: "review", repo: item.repo, path: item.path, ref: item.ref, ...(item.milestoneId ? { milestoneId: item.milestoneId } : {}) } : undefined;
/**
 * what the Sent row says for each press. E948-S130 (vn_4f13161d): every press collapses its card alike, a Decision's option
 * (its own words, "Yes: plan it") and a held post's schedule too; before, those two slid away with no Sent row.
 */
const saidOf = (key: string) =>
  SAID[key] ?? (key.startsWith("complete:") ? "Closed" : key.startsWith("choice:") ? key.slice(7) : key.startsWith("schedule:") || key === "pick-schedule" ? "Scheduled" : undefined);

/**
 * one press on a review or post card. The pressed button spins with "Sending…" in the frame of the
 * tap and the card's other buttons wait; on the console's answer (the 202 once the press is saved) the button says
 * "Saved ✓" and the card leaves PRESS.savedMs later, while the press is written in the background. A failure before that
 * gives the buttons back with the reason (Retry); a press that fails for good after the card left brings it back
 * (`onFailed`). Before, the card waited for the press to land (6 to 13 s) and the spinner showed for one 202 (a few ms).
 */
function useCardPress({ item, onDone, onFailed, failed, onBack }: CardProps) {
  const [pressing, setPressing] = useState<Pressing>();
  const [err, setErr] = useState<string | undefined>(failed && `It was not written: ${failed}. Press again.`);
  // the failed action, so Retry runs it again (a refused spine write changed nothing).
  const [last, setLast] = useState<{ key: string; fn: () => Promise<unknown> }>();
  const [landing, setLanding] = useState<string>();
  const running = useRef(false);
  /** True when the console took the press (a voice note's Send needs to know). */
  const act = async (key: string, fn: () => Promise<unknown>): Promise<boolean> => {
    if (running.current) return false; // a second tap while the first is on its way
    running.current = true;
    // when the card leaves, the next card's top lands where this one's was
    keepPlace(`review:${item.id}`);
    setPressing({ key, phase: "sending" });
    setErr(undefined);
    setLanding(undefined);
    let saved = false;
    let gone = false;
    let leave: ReturnType<typeof setTimeout> | undefined;
    let pressId: string | undefined;
    let backed = false;
    // Bring it back on the floating note: the press taken back while it waits out its window (nothing written),
    // else the row his press closed set back to review; either way the card is in the list again.
    const back = async (): Promise<BackResult> => {
      clearTimeout(leave);
      const again = () => {
        backed = true;
        setPressing(undefined);
        setLanding(undefined);
        onBack?.();
      };
      if (pressId) {
        try {
          await api.undoPress(pressId);
          again();
          return { back: true, line: "It is back in your inbox. Nothing was written." };
        } catch (e) {
          if ((e as { status?: number }).status !== 409) throw e; // being written or landed: reopen it below
        }
      }
      const row = cardOf(item);
      if (!row) return { back: false, line: "It is in the project already, and this card does not say which row it was." };
      // L-1: answered once the console has saved it (its 202); the card is back when the row is written
      const reopened = mutate(() => api.reopenReviewRow({ ...row, title: item.face?.title ?? item.title, id: item.id }), "inbox");
      const saved = new Promise<void>((ok) => {
        const off = onPress((n) => n.path === "/review-items/reopen" && n.state === "landing" && (off(), ok()));
        void reopened.then(() => (off(), ok()), () => off());
      });
      await Promise.race([saved, reopened]);
      again();
      void reopened.catch(() => undefined);
      return { back: true, line: "It is coming back to your inbox. The team was told to hold." };
    };
    const said = saidOf(key.replace(/^retry$/, last?.key ?? "retry"));
    const onSaved = () => {
      if (saved) return;
      saved = true;
      if (said)
        showClosed({
          said,
          slot: `review:${item.id}`,
          title: item.face?.title ?? item.title,
          ...(cardOf(item) ? { card: cardOf(item) } : {}),
          back,
        });
      setPressing({ key, phase: "saved" });
      leave = setTimeout(() => {
        if (!onDone) return (setPressing(undefined), setLanding(SAVED_LINE));
        gone = true;
        onDone();
        // the list and every count refetch (after the slide)
        setTimeout(() => void mutate(async () => undefined).catch(() => undefined), 330);
        // vn_e00f1134: the card is its green Sent row already, so it leaves the counts at once (no slide to wait for)
      }, said ? 0 : PRESS.savedMs);
    };
    const off = onPress((n) => {
      if (!n.path.includes(`/review-items/${encodeURIComponent(item.id)}/`)) return;
      if (n.state === "landing" && n.id) pressId ??= n.id;
      if (n.state === "landing") onSaved();
      if (n.state === "landed" && !onDone) setLanding(LANDED_LINE);
    });
    try {
      await fn();
      onSaved();
      setLast(undefined);
      return true;
    } catch (e) {
      // brought back before it was written: nothing to report, the card is in the list again
      if (e instanceof PressUndone || backed) return false;
      const why = e instanceof Error ? e.message : String(e);
      clearTimeout(leave);
      // vn_e00f1134: its Sent row goes, the card is back with the reason
      unmarkSent(`review:${item.id}`);
      if ((gone || saved) && onFailed) onFailed(why);
      else {
        setPressing(undefined);
        setLanding(undefined);
        setErr(why);
        setLast({ key, fn });
      }
      return false;
    } finally {
      off();
      running.current = false;
    }
  };
  return { act, pressing, busy: !!pressing, err, last, landing, props: (key: string, disabled = false) => pressProps(pressing, key, disabled) };
}

/** how many review cards a phone shows before "Show N more to review". */
export const PHONE_FIRST = 5;

/**
 * vn_e00f1134: a review card he pressed (Mark complete, Start N, an option, Give feedback, Park, Snooze) collapses in place to
 * one green Sent row with Add comment, never vanishing (the owner, vn_e00f1134: ); a press that fails brings the card back.
 */
export function ReviewCard(props: CardProps & { closedRefs?: Set<string> }) {
  const slot = `review:${props.item.id}`;
  const sent = useSent(slot);
  return sent ? <SentRow slot={slot} entry={sent} /> : <ReviewCardBody {...props} />;
}

function ReviewCardBody({ closedRefs, ...card }: CardProps & { closedRefs?: Set<string> }) {
  const { item } = card;
  const face = item.face;
  const [denyOpen, setDenyOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const { act, pressing, busy, err, last, landing, props } = useCardPress(card);
  /** More (opened by the heading), a Give feedback pressed with no words. */
  const [open, setOpen] = useState(false);
  const [needWords, setNeedWords] = useState(false);
  const files = useChatAttach({ enabled: true, disabled: busy });
  // a spoken note goes back as feedback, with what is typed before it
  const voice = useAnswerVoice({
    origin: `review:${item.id}:changes`,
    to: shortTo(item.face?.title ?? item.title),
    page: cardPage(item.ref ?? item.id, item.face?.title ?? item.title),
    typed: feedback,
    deliver: (reply) => act("changes", () => (files.ids.length ? api.relaunchReviewItem(item.id, reply, files.ids) : api.relaunchReviewItem(item.id, reply))).then((ok) => (ok ? (setFeedback(""), files.clear()) : refused())),
    disabled: busy,
    big: true,
  });
  const next = face?.next ?? [];
  // a Start now / Park switch per next step, preset to the team's recommendation
  const [start, setStart] = useState<boolean[]>(() => next.map((s) => s.recommend === "start"));
  // the one-line reason of each switch turned off
  const [offWhy, setOffWhy] = useState<string[]>(() => next.map(() => ""));
  const switches = next.some((s) => s.target);
  if (!face) return <OldCard item={item} />;
  const pickOf = (how: "switches" | "park") => {
    const idx = next.map((_, i) => i);
    if (how === "park") return { start: [], park: idx };
    return { start: idx.filter((i) => start[i]), park: idx.filter((i) => !start[i]), ...(switches ? { why: next.map((_, i) => (start[i] ? "" : offWhy[i].trim())) } : {}) };
  };
  // E948-S53: the button does what it says. The console only offers to close the goal when this is its last open part,
  // so there is no confirm that warns against the close it just offered.
  const complete = (how: "switches" | "park") => void act(`complete:${how}`, () => api.completeReviewItem(item.id, pickOf(how)));
  const stillOpen = face.openInGoal.filter((o) => !closedRefs?.has(`${item.repo}:${item.path}#${o.ref}`));
  const goalHref = item.milestoneId ? `${milestoneBookHref(item.milestoneId)}#${encodeURIComponent(face.goal.code)}` : undefined;
  const goal = goalHref ? <A href={goalHref}>{face.goal.text}</A> : <span>{face.goal.text}</span>;
  const tasks = `${face.tasks.done} of ${face.tasks.total} tasks done`;
  const buttons = cardButtons(face, start);
  const choices = decisionChoices(face);
  // E948-S69: a decision button answers the decision: Yes-like starts every next step (planned first), No-like parks them
  const choose = (c: DecisionChoice) => {
    const idx = next.map((_, i) => i);
    const plain = (face.decision ?? "").split("?")[0].replace(/^(?:do|should|shall|will|can|would) (?:we|the team|i)\s+/i, "").trim();
    const plan = !next.length && c.start && plain ? `${/:\s*plan\b/i.test(c.label) ? "Plan" : "Do"}: ${plain}` : undefined;
    void act(`choice:${c.label}`, () =>
      api.completeReviewItem(item.id, { ...(c.start ? { start: idx, park: [] } : { park: idx }), ...(switches && c.start ? { why: next.map(() => "") } : {}), choice: c.label, ...(plan ? { plan } : {}) }),
    );
  };
  const spine = githubFile(item.github, item.path ?? "");
  // Review,
  // the project and the age; a short heading; the goal as the Why; what was delivered; Mark complete or Give feedback; one foot.
  const heading = cardHeading({ title: face.title });
  const body = cardBody({ title: face.title }, heading);
  // the owner 2026-11-12, "on the mobile, it's just a total mess": on a phone the heading is the whole
  // title (one sentence of 20 words or fewer, docs/review-cards.md) and the body that only repeats it is left out: the
  // short heading plus the same sentence again cost two to four lines on every card. The computer keeps the mockup.
  const phoneHeading = cardHeading({ title: face.title }, 200);
  const phoneBody = cardBody({ title: face.title }, phoneHeading);
  const mainHow = buttons[0].how;
  // E948-S53: a press that closes the goal says so on the button itself
  const mainLabel = mainButtonLabel(face, start);
  // E948-S60 iteration 3 (the owner 2026-11-12 21:46Z: only "Mark complete" or "Give feedback", never "Not yet"):
  // the feedback block is always open; Give feedback sends his words, or asks for them and puts the cursor in the box
  const feedbackSend = () => {
    const words = feedback.trim();
    if (!words && !files.ids.length) return setNeedWords(true);
    void act("changes", () => (files.ids.length ? api.relaunchReviewItem(item.id, words, files.ids) : api.relaunchReviewItem(item.id, words))).then((ok) => ok && (setFeedback(""), files.clear()));
  };
  return (
    <article className={CARD_FRAME} data-card-shell="review" data-testid="review-card" data-review-id={item.id} data-row={item.ref}>
      {/* vn_7c5aa36e, vn_4d2a86f9: its age right after the kind word, from when it reached his inbox, as on every card */}
      <CardMeta kind={isDecisionCard(face) ? CARD_WORD.decision : CARD_WORD.review} kindTestId="review-kind-word" since={item.inboxSince ?? item.createdAt} data-testid="review-crumb">
        {face.project.url ? <A href={face.project.url}>{face.project.name}</A> : <span>{face.project.name}</span>}
        {/* on a phone the long objective tag wraps inside the card, never past its edge */}
        {item.ownerPriority && <OwnerPriorityTag p={item.ownerPriority} className="max-sm:min-w-0 max-sm:shrink max-sm:text-left" />}
      </CardMeta>
      {/* his long voice note touched this card: stale or updated until its owner moves the row. */}
      {item.noteMark && <NoteMarkBand mark={item.noteMark} className="mt-2" />}
      {/* a note he left inside the page itself shows on its card, so he sees it landed. */}
      {!!face.pageNotes?.length && <PageNotes notes={face.pageNotes} />}
      <button
        type="button"
        className="mt-1.5 text-left text-[15px] font-medium leading-snug text-foreground hover:underline hover:decoration-foreground/30 hover:underline-offset-[3px]"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        data-testid="review-title"
      >
        <span className={cn(heading !== phoneHeading && "max-sm:hidden")} data-heading="computer">
          {heading}
        </span>
        {heading !== phoneHeading && (
          <span className="sm:hidden" data-heading="phone">
            {phoneHeading}
          </span>
        )}
      </button>
      {/* (the owner 2026-11-14, vn_e751eeeb: "the art of the non-confusion"): the card opens with what was made, its title,
          then where it came from: his own words and date, or who raised it and why. It never opens with an objective's score. */}
      {(face.source || face.from?.name) && (
        <p className="mt-2 text-[13px] leading-snug text-foreground/80" data-testid="review-source">
          <span className="font-medium text-foreground">Came from: </span>
          {face.source ? <CardText text={face.source} item={item} /> : `the ${face.from!.name}${face.from!.line ? `. ${face.from!.line}` : ""}`}
        </p>
      )}
      {body && (
        <p className={cn("mt-1 text-sm leading-relaxed text-foreground/85", body !== phoneBody && !phoneBody && "max-sm:hidden")} data-testid="review-body">
          <CardText text={body} item={item} />
        </p>
      )}
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground" data-testid="review-task-goal">
        Why: <CardText text={face.taskGoal} item={item} />
      </p>
      <ul className="m-0 mt-2 list-none p-0 text-sm text-foreground/85" data-testid="review-delivered">
        {face.delivered.map((d, i) => (
          <li key={i} className="flex gap-2 py-0.5" data-ok={d.ok}>
            <span className={cn("mt-[3px] shrink-0", d.ok ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground")} data-mark={d.ok ? "done" : "not-done"}>
              {d.ok ? <Check className="h-4 w-4" aria-label="done" /> : <X className="h-4 w-4" aria-label="not done" />}
            </span>
            <span className="min-w-0">
              <CardText text={d.text} item={item} />
            </span>
          </li>
        ))}
      </ul>
      {/* The owner 2026-11-14 23:43Z: the link to check comes right after what was delivered, before the
          follow-ups, the decision and every button, so he sees the thing before he decides. */}
      <a className={CARD_LINK} href={face.evidence.url} target="_blank" rel="noreferrer" data-testid="review-go">
        {face.evidence.label} ↗
      </a>
      {/* vn_e751eeeb: the steps his answer decides, one plain sentence a line (never joined after their own full stops). */}
      {next.length > 0 && choices && (
        <section className="mt-3 text-sm text-foreground/85" data-testid="review-decision-next">
          <div className="text-xs text-muted-foreground">Next steps your answer decides:</div>
          <ul className="m-0 mt-0.5 list-disc pl-5">
            {next.map((s, i) => (
              <li key={i} className="py-0.5">
                <CardText text={s.title} item={item} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {next.length > 0 && !choices && (
        <section className="mt-3" data-testid="review-next">
          <div className="mb-1 text-xs text-muted-foreground">{switches ? (next.every((s) => s.kind === "new") ? "New goals it proposes, each on or off" : "Follow-ups it suggests, each on or off") : "Next steps the team suggests"}</div>
          {switches ? (
            <ul className="grid list-none grid-cols-1 p-0 text-sm" data-testid="review-switches">
              {next.map((s, i) => (
                <li key={i} className={cn("grid min-w-0 gap-1 py-2", i > 0 && "border-t")} data-testid="review-switch-item" data-on={start[i] ? "yes" : "no"}>
                  <div className="flex min-w-0 flex-wrap items-start gap-2">
                    <span className="min-w-0 flex-1 basis-36 sm:basis-56 text-foreground/85">
                      <CardText text={s.title} item={item} />
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={start[i]}
                      aria-label={`${s.title}: ${start[i] ? "on" : "off"}`}
                      className={cn("inline-flex h-7 shrink-0 items-center rounded-md border px-2.5 text-xs font-medium", PHONE_TAP, start[i] ? "bg-foreground text-background" : "text-muted-foreground")}
                      onClick={() => setStart(start.map((x, j) => (j === i ? !x : x)))}
                      data-testid="review-switch"
                    >
                      {start[i] ? "On" : "Off"}
                    </button>
                  </div>
                  {s.why && <div className="text-[13px] text-muted-foreground">{s.why}</div>}
                  {s.quote && <div className="text-[13px] text-muted-foreground">You said {s.quote}</div>}
                  {s.also?.length ? <div className="text-xs text-muted-foreground" data-testid="review-switch-also">Also proposed by the {s.also.join(" and the ")}</div> : null}
                  {s.kind === "new" && s.target && item.repo ? (
                    <div className="text-xs text-muted-foreground" data-testid="review-switch-goal">
                      {start[i] ? "Starts as a new goal" : "Stays parked"}
                      {s.targetName ? `: ${s.targetName}` : ""}.{" "}
                      <Link className={LINK} to={`${deckHref(item.repo, s.target)}?from=home`} data-testid="review-switch-open">
                        Open the proposed goal
                      </Link>
                    </div>
                  ) : (
                    s.targetName && <div className="text-xs text-muted-foreground">{start[i] ? "Becomes a task in" : "Would go to"}: {s.targetName}</div>
                  )}
                  {!start[i] && (
                    <input
                      className="mt-0.5 w-full rounded-md border bg-background px-2 py-1 text-sm"
                      placeholder="Why not? One line, so it is not suggested again"
                      maxLength={300}
                      value={offWhy[i] ?? ""}
                      onChange={(e) => setOffWhy(offWhy.map((x, j) => (j === i ? e.target.value : x)))}
                      aria-label={`Why ${s.title} is off`}
                      data-testid="review-switch-why"
                    />
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <ul className="grid list-none grid-cols-1 p-0 text-sm">
              {next.map((s, i) => (
                <li key={i} className={cn("flex min-w-0 flex-wrap items-center gap-2 py-1.5", i > 0 && "border-t")} data-testid="review-suggestion">
                  <span className="min-w-0 flex-1 basis-36 sm:basis-56 text-foreground/85">
                    <CardText text={s.title} item={item} />
                  </span>
                  <span className="inline-flex shrink-0 overflow-hidden rounded-md border text-xs" role="group" aria-label={`${s.title}: start now or park`}>
                    {(["start", "park"] as const).map((w) => (
                      <button
                        key={w}
                        type="button"
                        aria-pressed={start[i] === (w === "start")}
                        className={cn("whitespace-nowrap px-2 py-1 [overflow-wrap:normal]", PHONE_TAP, start[i] === (w === "start") ? "bg-foreground text-background" : "bg-transparent text-muted-foreground")}
                        onClick={() => setStart(start.map((x, j) => (j === i ? w === "start" : x)))}
                        data-testid={`review-switch-${w}`}
                      >
                        {w === "start" ? "Start now" : "Park"}
                      </button>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {open && (
        <div className="mt-3 grid grid-cols-1 gap-3 border-t pt-3 text-sm" data-testid="review-more">
          {face.from && <FromBand from={face.from} />}
          <a className="relative block overflow-hidden rounded-lg border" href={face.evidence.url} target="_blank" rel="noreferrer" data-testid="review-evidence">
            {face.screenshot ? (
              <img className="block h-[170px] w-full object-cover object-top sm:h-[200px]" src={`/api/review-items/${encodeURIComponent(item.id)}/screenshot`} alt="Screenshot of the evidence. Click to open it." loading="lazy" />
            ) : (
              <div className="h-[120px] w-full bg-muted" />
            )}
          </a>
          <div className="text-[13px] text-foreground/85" data-testid="review-tree">
            <div>
              {goal} <span className="text-muted-foreground">· goal open, {tasks}</span>
            </div>
            {face.tree.map((l, i) => (
              <div key={i} className={cn("pl-5", l.mark === "this" ? "text-foreground" : "text-muted-foreground")} data-mark={l.mark}>
                {MARK[l.mark]} {l.mark === "this" ? `This task: ${l.text}` : l.text}
                {l.mark !== "this" && l.sub ? ` · ${l.sub}` : ""}
              </div>
            ))}
          </div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs text-muted-foreground" data-testid="review-details">
            <dt>Task</dt>
            <dd>{spine ? <A href={spine}>{item.ref}</A> : goalHref ? <A href={goalHref}>{item.ref}</A> : null}</dd>
            {spine && (
              <>
                <dt>Plan file</dt>
                <dd>
                  <A href={spine}>{item.path}</A>
                </dd>
              </>
            )}
            {item.cardPath && githubFile(item.github, item.cardPath) && (
              <>
                <dt>Card file</dt>
                <dd>
                  <A href={githubFile(item.github, item.cardPath)!}>{item.cardPath}</A>
                </dd>
              </>
            )}
            <dt>Evidence</dt>
            <dd>
              <A href={face.evidence.url}>{urlLabel(face.evidence.url)}</A>
              {item.checkedAt && (
                <>
                  {" "}
                  · checked <RelTime iso={item.checkedAt} />
                </>
              )}
            </dd>
            {(item.iteration ?? 1) > 1 && (
              <>
                <dt>Round</dt>
                <dd>{item.iteration}</dd>
              </>
            )}
          </dl>
          {/* closing it as a no stays one tap away, under the card's details (two buttons on the card). */}
          {denyOpen ? (
            <DenyPanel pressing={pressing} origin={`review:${item.id}:decline`} to={shortTo(item.face?.title ?? item.title)} page={cardPage(item.ref ?? item.id, item.face?.title ?? item.title)} onCancel={() => setDenyOpen(false)} onDeny={(why, f) => act("decline", () => (f.length ? api.denyReviewItem(item.id, why, f) : api.denyReviewItem(item.id, why)))} sub={ACTION.decline.hint} />
          ) : (
            <button type="button" className="w-max text-xs text-muted-foreground underline max-sm:min-h-11 max-sm:text-left decoration-foreground/25 underline-offset-[3px] hover:text-foreground" disabled={busy} onClick={() => setDenyOpen(true)} data-testid="review-deny">
              Decline it instead: it closes as a no
            </button>
          )}
        </div>
      )}
      {face.closesGoal && stillOpen.length > 0 && (
        <p className="mt-3 text-xs text-muted-foreground" data-testid="review-parked-left">
          Parked for later, kept with the goal:{" "}
          {stillOpen.map((o, i) => (
            <Fragment key={o.ref}>
              {i > 0 && ", "}
              {o.name ?? <A href={spine ?? goalHref ?? "/"}>{o.ref}</A>}
            </Fragment>
          ))}
          .
        </p>
      )}
      {/* (the owner 2026-11-15, vn_5ef65752: "maybe 50% the amount of text"): no foot repeating the project, the goal and the
          task count: the meta line names the project and More (the title) shows the goal and its tasks. */}
      {/* the card ends with the one decision asked of him, right above the buttons that answer it. */}
      {face.decision && (
        <div className="mt-3 rounded-lg border border-emerald-700/40 bg-emerald-50/60 px-3 py-2 dark:border-emerald-400/40 dark:bg-emerald-950/30" data-testid="review-decision">
          <div className="text-xs font-medium text-emerald-800 dark:text-emerald-300">Your decision</div>
          <div className="text-[15px] font-medium leading-snug text-foreground">
            <CardText text={face.decision} item={item} />
          </div>
        </div>
      )}
      {/* The owner 2026-11-15 00:0xZ: "Isn't the feedback one of the options of the buttons? Why is there something in between?":
          the buttons and the feedback box with its microphone are one group, nothing between, no text explaining them. */}
      <div className="mt-3.5 grid min-w-0 gap-2" data-testid="review-answer" data-card-answer="">
      {/* E948-S131 (vn_73e840cd): one row, his answers then Voice and Text; the box opens on Text (it replaced Give feedback). */}
      <div className="grid" data-testid="review-note">
        <FeedbackBlock
          actions={
            <div className="contents" data-testid="review-buttons" data-card-buttons={choices ? "decision" : "review"}>
        {choices ? (
          choices.map((c) => (
            <CardButton key={c.label} variant={c.recommended ? "default" : "outline"} className="h-auto min-h-8 shrink whitespace-normal py-1.5 text-left [overflow-wrap:anywhere]" {...props(`choice:${c.label}`)} onClick={() => choose(c)} title={c.sub} data-testid="review-choice" data-start={c.start ? "yes" : "no"}>
              {c.label}
            </CardButton>
          ))
        ) : (
          <CardButton {...props(`complete:${mainHow}`)} onClick={() => complete(mainHow)} title={buttons[0].sub} data-testid={mainHow === "park" && next.length ? "review-complete-park" : "review-complete"}>
            {mainLabel}
          </CardButton>
        )}
        {/* E948-S83 iteration 2: Park on every card, beside its own buttons (a month, nothing decided, brought back any time). */}
        {item.state === "review" && (
          <RowPair>
          <ParkButton disabled={busy} onPark={() => parkReview(item, face.title, cardOf(item))} />
          {/* (the owner 2026-11-15, vn_5ef65752): Snooze beside Park, in the one decisions block, never at the top of the card. */}
          <SnoozeDropdown
            id={item.id}
            disabled={busy}
            title="Hide it for a while; it stays waiting for your review"
            onPick={(c) => {
              void snoozeReview(item, c, face.title);
              // the same floating note; Bring it back unsnoozes it
              showClosed({
                said: "Snoozed",
                slot: `review:${item.id}`,
                title: face.title,
                ...(cardOf(item) ? { card: cardOf(item) } : {}),
                back: async () => (await unsnoozeReview(item), { back: true, line: "It is back in your inbox." }),
              });
            }}
          />
          </RowPair>
        )}

            </div>
          }
          id={`note-review-${item.id}`}
          value={feedback}
          onChange={(v) => (setFeedback(v), setNeedWords(false))}
          files={files}
          voice={voice}
          sending={pressing?.key === "changes" && pressing.phase === "sending"}
          disabled={busy}
          onSend={feedbackSend}
          className="mt-0"
          note={needWords ? "Say what should change: write, paste a screenshot, or speak, then press Send." : undefined}
        />
      </div>
      </div>
      {landing && !err && (
        <div className="mt-2 text-sm text-muted-foreground" data-testid="review-landing">
          {landing}
        </div>
      )}
      {err && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-destructive" data-testid="review-error">
          <span className="min-w-0 flex-1">Nothing was changed. {err}</span>
          {last && (
            <CardButton variant="outline" className="h-7 text-xs" {...props("retry")} onClick={() => void act("retry", last.fn)} data-testid="review-retry">
              Retry
            </CardButton>
          )}
        </div>
      )}
    </article>
  );
}

/** A card from a server without the face (older release): its title and the live link, never a row code as text. */
function OldCard({ item }: { item: Listed }) {
  return (
    <CardShell as="article" kind="review" data-testid="review-card" data-review-id={item.id} data-row={item.ref}>
      <CardMeta kind="Review" since={item.inboxSince ?? item.createdAt}>
        {milestoneLabel(item.milestoneTitle) && <span>{milestoneLabel(item.milestoneTitle)}</span>}
      </CardMeta>
      <div className={CARD_TITLE}>
        <CardText text={item.title} item={item} />
      </div>
      {item.liveUrl && (
        <div className="mt-1 text-sm">
          <A href={item.liveUrl}>{urlLabel(item.liveUrl)} ↗</A>
        </div>
      )}
      {/* E948-S83 iteration 2: even a card from an older release can be parked. */}
      {item.state === "review" && (
        <div className="mt-3.5 flex flex-wrap items-center gap-2" data-testid="review-buttons">
          <ParkButton onPark={() => parkReview(item, item.title, cardOf(item))} />
        </div>
      )}
      {/* E948-S60: even a card from an older release takes feedback; it goes back to the team as a new round. */}
      <CardFeedback origin={`review-feedback:${item.id}`} title={item.title} refName={item.ref ?? item.id} send={(words, files) => (files.length ? api.relaunchReviewItem(item.id, words, files) : api.relaunchReviewItem(item.id, words))} sent={{ slot: `review:${item.id}`, said: "Changes sent to the team", ...(cardOf(item) ? { card: cardOf(item) } : {}) }} />
    </CardShell>
  );
}

// ----------: a held post, the same card in the post's own words ----------

/** When the post goes out, in words: its slot (UTC), or that its time has passed. */
export function slotWords(slot: string | undefined, now = Date.now()): string | undefined {
  if (!slot) return undefined;
  const t = Date.parse(/Z$/.test(slot) ? slot : `${slot.replace(" ", "T")}Z`);
  if (Number.isNaN(t)) return undefined;
  if (t <= now) return "its time has passed";
  // the post page's words: "Thursday 5 Nov, 14:00 UTC"
  return slotUtc(slot);
}

/**
 * the buttons of a held post's card, each with its sub-line. A held post never has Post now. When its time has passed, Schedule names the next free slot
 * within the campaign's limits (`nextSlot`, the server's) and Pick a new time sits beside it.
 */
export function postButtons(p: Pick<PostCardInfo, "kind" | "slot" | "nextSlot">, now = Date.now()): { label: string; sub: string; how: "schedule" | "pick"; go: boolean; slot?: string }[] {
  const reply = p.kind === "outreach";
  const when = slotWords(p.slot, now);
  if (reply) return [{ label: "✓ Schedule this reply", sub: "The team sends this reply in the thread, inside today's limits.", how: "schedule", go: true }];
  // its time has passed and nothing is free in the next 3 days: no Schedule (it would send now), he picks a time.
  if (!p.nextSlot && when === "its time has passed")
    return [{ label: "Pick a new time", sub: "Its time has passed and nothing is free in the next 3 days within the campaign's limits. You choose when it goes out, in UTC.", how: "pick", go: false }];
  if (p.nextSlot)
    return [
      { label: `✓ Schedule for ${slotShort(p.nextSlot)}`, sub: `${p.slot ? "Its own time has passed. " : ""}This is the next free time within the campaign's limits.`, how: "schedule", go: true, slot: p.nextSlot },
      { label: "Pick a new time", sub: "You choose when it goes out, in UTC.", how: "pick", go: false },
    ];
  return [{ label: "✓ Schedule", sub: when && when !== "its time has passed" ? `It goes out ${when}.` : "It goes out at the next free time.", how: "schedule", go: true }];
}

/** E948-S130: a held post he answered collapses to its green Sent row too, like every card. */
export function PostReviewCard(props: CardProps) {
  return (
    <SentOr slot={`review:${props.item.id}`}>
      <PostReviewCardBody {...props} />
    </SentOr>
  );
}

function PostReviewCardBody(card: CardProps) {
  const { item } = card;
  const p = item.post!;
  const { act, pressing, busy, err, last, landing, props } = useCardPress(card);
  const [relaunchOpen, setRelaunchOpen] = useState(false);
  const [denyOpen, setDenyOpen] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const [slot, setSlot] = useState("");
  const [feedback, setFeedback] = useState("");
  const campaignHref = item.milestoneId ? `/milestones/${encodeURIComponent(item.milestoneId)}` : undefined;
  const where = [p.platform, p.community].filter(Boolean).join(", ");
  const when = slotWords(p.slot);
  const BTN = cn("h-auto min-h-10 justify-start whitespace-normal px-4 py-2.5 text-left text-[15px] font-bold [overflow-wrap:normal]", PHONE_TAP);
  // E948-S131: the post's own buttons lead the card's one row, Voice and Text close it.
  const postRow = (
            <div className="contents" data-testid="review-buttons">
              {postButtons(p).map((b) => (
                <Button
                  key={b.label}
                  className={cn(BTN, b.go && "bg-green-600 text-white hover:bg-green-700")}
                  variant={b.go ? "default" : "outline"}
                  title={b.sub}
                  {...props(`schedule:${b.label}`)}
                  onClick={() => (b.how === "pick" ? setPickOpen(true) : void act(`schedule:${b.label}`, () => api.completeReviewItem(item.id, b.slot ? { slot: b.slot } : {})))}
                  data-testid={b.how === "pick" ? "review-pick" : "review-schedule"}
                >
                  {b.label}
                </Button>
              ))}
              <Button variant="secondary" className={BTN} disabled={busy} title="The writer makes a new version with your words. It comes back to you." onClick={() => setRelaunchOpen(true)} data-testid="review-iteration">
                ↻ {ACTION.changes.label}
              </Button>
              {/* the third outcome: the held post is not sent. */}
              <Button variant="outline" className={BTN} disabled={busy} title="The post is not sent." onClick={() => setDenyOpen(true)} data-testid="review-deny">
                ✕ {ACTION.decline.label}
              </Button>
            </div>
  );
  return (
    <CardShell as="article" kind="post" data-testid="review-card" data-review-id={item.id} data-kind="post">
      {/* E948-S60: the one shell: the kind word first, then the project and the campaign, like every card. */}
      {/* how long: from the commit that made it held; an old server's day-only date reads in days */}
      <CardMeta kind={p.kind === "outreach" ? "Reply" : "Post"} since={item.inboxSince ?? item.createdAt?.replace(/T00:00:00(?:\.000)?Z$/, "")} data-testid="review-crumb">
        {p.project.url ? <A href={p.project.url}>{p.project.name}</A> : <span>{p.project.name}</span>}
        {campaignHref ? <A href={campaignHref}>{p.campaign}</A> : <span>{p.campaign}</span>}
        <span>waiting for you</span>
      </CardMeta>
      <section>
        <h3 className={CARD_TITLE} data-testid="review-title">
          {/* the post page's reading: the writer's notes (topic, idea codes) stay off the title */}
          <A href={p.pageUrl}>{splitTitle(p.title || item.title).title}</A>
        </h3>
      </section>
      <section className="pt-2.5">
        <Label>Where it goes</Label>
        <div data-testid="review-post-where">
          {p.kind === "outreach" && p.thread ? (
            <>
              A reply in the thread {p.thread.link ? <A href={p.thread.link}>“{p.thread.title}”</A> : <>“{p.thread.title}”</>}
              {where ? ` on ${where}` : ""}.{p.thread.numbers ? ` ${p.thread.numbers}.` : ""}
            </>
          ) : (
            <>
              {where || "Its platform"}
              {when ? `, ${when === "its time has passed" ? "its time has passed" : when}` : ""}.
            </>
          )}
        </div>
      </section>
      <section className="pt-2.5">
        <Label>What it says</Label>
        <div className="grid gap-2 rounded-[10px] border bg-muted/30 px-3 py-2" data-testid="review-post-text">
          {paragraphs(p.text ?? "").map((t, i) => (
            <p key={i} className="m-0 whitespace-pre-wrap">
              <CardText text={t} item={item} />
            </p>
          ))}
        </div>
      </section>
      {p.revisedFor && (
        <section className="pt-2.5">
          <div className="-mx-2 rounded-md bg-yellow-100 px-2 py-1 text-yellow-900 dark:bg-yellow-950 dark:text-yellow-200" data-testid="review-post-revised">
            A new version after your words: “<CardText text={p.revisedFor} item={item} />”
          </div>
        </section>
      )}
      {p.images.length > 0 && (
        <section className="pt-2.5">
          <Label>The picture</Label>
          <div className="grid grid-cols-1 gap-2">
            {p.images.map((im) => (
              <a key={im.id} className="block overflow-hidden rounded-[10px] border" href={im.url} target="_blank" rel="noreferrer">
                <img className="block w-full" src={im.url} alt="The picture that goes out with the post. Click to open it." loading="lazy" />
              </a>
            ))}
          </div>
        </section>
      )}
      <details className="mt-3 text-xs text-muted-foreground" data-testid="review-details">
        <summary className="cursor-pointer select-none">Details</summary>
        <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
          <dt>Post</dt>
          <dd>
            <A href={p.pageUrl}>{p.id}</A>
          </dd>
          <dt>Campaign files</dt>
          <dd>{p.repo}</dd>
        </dl>
      </details>
      {/* The owner 2026-11-15: "Isn't the feedback one of the options of the buttons? Why is there something in between?":
          one answer block, the buttons then the feedback box, no line under a button explaining it (its words sit in its tooltip). */}
      <div className="mt-3.5 grid min-w-0 gap-2" data-testid="review-answer" data-card-answer="">
        {denyOpen ? (
          <DenyPanel pressing={pressing} origin={`review:${item.id}:decline`} to={shortTo(item.title)} page={`post ${item.ref ?? item.id}`} onCancel={() => setDenyOpen(false)} onDeny={() => act("decline", () => api.denyReviewItem(item.id, ""))} sub="The post is not sent. You can undo it from the campaign's posts." label={`✕ ${ACTION.decline.label}`} words={false} />
        ) : pickOpen ? (
          <div className="grid gap-2" data-testid="review-pick-time">
            <label className="text-sm font-medium" htmlFor={`slot-${item.id}`}>
              New time (UTC)
            </label>
            <input id={`slot-${item.id}`} type="datetime-local" aria-label="New time (UTC)" className="w-fit rounded-md border bg-background px-2 py-1 text-sm" value={slot} onChange={(e) => setSlot(e.target.value)} />
            <span className="text-xs text-muted-foreground">It moves to Scheduled and goes out at this time.</span>
            <div className="flex flex-wrap items-start gap-2">
              <CardButton {...props("pick-schedule", !slot)} onClick={() => void act("pick-schedule", () => api.completeReviewItem(item.id, { slot: `${slot.slice(0, 16)}Z` }))} data-testid="review-pick-schedule">
                ✓ Schedule it
              </CardButton>
              <CardButton variant="ghost" disabled={busy} onClick={() => (setSlot(""), setPickOpen(false))}>
                Cancel
              </CardButton>
            </div>
          </div>
        ) : relaunchOpen ? (
          <ChangesPanel
            pressing={pressing}
            origin={`review:${item.id}:changes`}
            to={shortTo(item.face?.title ?? item.title)}
            page={cardPage(item.ref ?? item.id, item.face?.title ?? item.title)}
            value={feedback}
            onChange={setFeedback}
            placeholder="What should change? Your words go to the writer."
            hint="The writer makes a new version. It comes back here."
            onSend={(words, files) => act("changes", () => (files.length ? api.relaunchReviewItem(item.id, words, files) : api.relaunchReviewItem(item.id, words)))}
            onCancel={() => setRelaunchOpen(false)}
          />
        ) : null}
        {/* E948-S60: the one feedback block on the held post too: the writer makes a new version with his words. */}
        {!relaunchOpen && (
          <CardFeedback
            origin={`post-feedback:${item.id}`}
            title={p.title || item.title}
            className="mt-0"
            refName={item.ref ?? item.id}
            send={(words, files) => act("changes", () => (files.length ? api.relaunchReviewItem(item.id, words, files) : api.relaunchReviewItem(item.id, words))).then((ok) => { if (!ok) throw new Error("the card did not take it"); })}
            actions={pickOpen ? undefined : postRow}
          />
        )}
        {/* what a press did, after the answer block, never between the buttons and the feedback */}
        {landing && !err && (
          <div className="mt-2 text-sm text-muted-foreground" data-testid="review-landing">
            {landing}
          </div>
        )}
        {err && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-destructive" data-testid="review-error">
            <span className="min-w-0 flex-1">Nothing was changed. {err}</span>
            {last && (
              <CardButton variant="outline" className="h-7 text-xs" {...props("retry")} onClick={() => void act("retry", last.fn)} data-testid="review-retry">
                Retry
              </CardButton>
            )}
          </div>
        )}
      </div>
    </CardShell>
  );
}

/**
 * Changes wanted on a review or post card: his words, then one press. Or a voice note, its words in the box
 * (he edits them, then presses); the words sent name the note and keep its recording's link.
 */
function ChangesPanel(p: { pressing?: Pressing; origin: string; to: string; page: string; value: string; onChange: (v: string) => void; placeholder: string; hint: string; onSend: (words: string, files: string[]) => Promise<boolean>; onCancel: () => void }) {
  const busy = !!p.pressing;
  // the same box as Chat: a pasted or dropped screenshot goes with his words (their links follow them).
  const files = useChatAttach({ enabled: true, disabled: busy });
  const send = (words: string) => p.onSend(words, files.ids).then((ok) => (ok && files.clear(), ok));
  // the voice note's Send presses Send what should change itself, with what is typed before the spoken words.
  const voice = useAnswerVoice({ origin: p.origin, to: p.to, page: p.page, typed: p.value, deliver: (reply) => send(reply).then((ok) => (ok ? p.onChange("") : refused())), disabled: busy });
  return (
    <div className="grid gap-2">
      <WordsBox label="Your feedback" boxClassName="min-h-20" placeholder={p.placeholder} value={p.value} onChange={p.onChange} files={files} voice={voice} />
      <div className="flex flex-wrap items-start gap-2">
        <div className="grid gap-0.5">
          <CardButton {...pressProps(p.pressing, "changes", voice.busy || !files.ready || (!p.value.trim() && !files.ids.length))} onClick={() => void send(p.value.trim())} data-testid="review-iteration-start">
            ↻ {ACTION.changes.send}
          </CardButton>
          <span className="text-xs text-muted-foreground">{p.hint}</span>
        </div>
        <CardButton variant="ghost" disabled={busy || voice.busy} onClick={p.onCancel}>
          Cancel
        </CardButton>
      </div>
    </div>
  );
}

/** Decline on a review card: an optional reason, then one press that closes it as a no. The reason can be spoken. */
function DenyPanel({ pressing, origin, to, page, onCancel, onDeny, sub, label = `✕ ${ACTION.decline.label}`, words = true }: { pressing?: Pressing; origin: string; to: string; page: string; onCancel: () => void; onDeny: (why: string, files: string[]) => Promise<boolean>; sub: string; label?: string; words?: boolean }) {
  const busy = !!pressing;
  const [why, setWhy] = useState("");
  // the reason's box is the same as Chat's (a screenshot can go with it).
  const files = useChatAttach({ enabled: words, disabled: busy });
  const deny = (reason: string) => onDeny(reason, files.ids).then((ok) => (ok && files.clear(), ok));
  // the spoken reason's Send presses Decline itself.
  const voice = useAnswerVoice({ origin, to, page, typed: why, deliver: (reply) => deny(reply).then((ok) => (ok ? setWhy("") : refused())), disabled: busy || !words });
  return (
    <div className="grid gap-2" data-testid="review-deny-panel">
      {words && <WordsBox label="Why you decline it" boxClassName="min-h-16" placeholder={ACTION.decline.placeholder} value={why} onChange={setWhy} files={files} voice={voice} />}
      <div className="flex flex-wrap items-start gap-2">
        <div className="grid gap-0.5">
          <CardButton variant="destructive" {...pressProps(pressing, "decline", voice.busy || !files.ready)} onClick={() => void deny(why.trim())} data-testid="review-deny-confirm">
            {label}
          </CardButton>
          <span className="text-xs text-muted-foreground">{sub}</span>
        </div>
        <CardButton variant="ghost" disabled={busy || voice.busy} onClick={onCancel}>
          Cancel
        </CardButton>
      </div>
    </div>
  );
}

/** "1 Dec 23:49" in the reader's own time when the line kept the time, else "1 Dec". */
function noteWhen(n: CardPageNote): string {
  const d = new Date(n.time ? `${n.date}T${n.time}:00Z` : `${n.date}T12:00:00Z`);
  if (isNaN(d.getTime())) return n.date;
  const day = d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return n.time ? `${day} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}` : day;
}

/** his notes left in the page's own feedback box, newest first: when, his words, a link to the page. */
export function PageNotes({ notes }: { notes: CardPageNote[] }) {
  return (
    <div className="mt-2 rounded-md border border-border/70 bg-muted/40 px-3 py-2 text-[13px] leading-snug" data-testid="review-page-notes">
      {[...notes].reverse().map((n, i) => (
        <p key={i} className={cn("[overflow-wrap:anywhere]", i > 0 && "mt-1.5")} data-testid="review-page-note">
          <span className="font-medium text-foreground">{n.stuck ? "You marked it stuck on the page" : "Your note on the page"}</span>
          <span className="text-muted-foreground"> · {noteWhen(n)}</span>
          {n.url && (
            <>
              {" · "}
              <a href={n.url} target="_blank" rel="noreferrer" className="underline decoration-foreground/30 underline-offset-2">
                open the page
              </a>
            </>
          )}
          <span className="mt-0.5 line-clamp-3 block text-foreground/80" title={n.words}>
            “{n.words}”
          </span>
        </p>
      ))}
    </div>
  );
}

