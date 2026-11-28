import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { Link, useLocation } from "react-router-dom";
import { Switch } from "@/components/ui/switch";
import { CalendarDays, ChevronRight, ChevronUp, Columns3, GripVertical, Loader2, Maximize2, MessageSquare, Minimize2, Rows3, Send } from "lucide-react";
import { api, type Assignment, type Persona } from "@/api";
import type { CampaignCard } from "@/api/campaign-types";
import type { SocialData, SocialIdea, SocialMetrics, SocialTopic, SocialWriteAction, SocialWriteResult } from "@/api/types";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { IdeaDetail, PostDetail, postHook } from "./detail";
import { ErrorBox, Loading, PageHeader, PHONE_TAP } from "@/components/common";
import { useChatAttach, wordsWithFiles } from "@/components/ChatAttach";
import { WordsBox } from "@/components/WordsBox";
import { shortTo, useAnswerVoice } from "@/voice/AnswerVoice";
import { invalidate, mutate, useQuery } from "@/lib/data";
import { liveCards, useCampaignScope, useCampaigns } from "@/lib/campaign";
import { useProject } from "@/lib/project";
import { cn } from "@/lib/utils";
import { WeekView } from "@/pages/Calendar";
import { campaignName } from "@/components/draftsToApprove";
import { postHref, socialHref, type PostFrom } from "./nav";
import { approvesEveryPost, BOARD_LANES, boardLanes, boardMove, ideaUsedOn, ledgerNumbers, POSTED_DAYS, postedRecently, postImages, revisedAt, lastReviseAsk, movedFrom, noFreeSlot, slotPassed, type BoardItem, type BoardLaneId, type Post, type PostNumbers } from "@/lib/social";
import { worldId } from "@/lib/useSocial";
import { describeWrite, scopeOf, undoOf, useSocialScreen, type WriteNote } from "@/lib/useSocialWrite";
import { dayLabel, OutLink, PostActions, PostBadge, slotLabel, SocialScreen, takeAsk, useEgress, WriteNoteLine, type CardAsk, type Write, ScopedNote } from "./parts";
import { ownerName } from "@/lib/identity";

/**
 * Pipeline (deck v3 slide 14): every post from idea to live. Four columns, Ideas, Drafts, Scheduled, Posted, and a post visibly moves through them. Draft it now
 * moves the idea into Drafts at once as a spinning card the Writer is working on (not clickable); when the draft is ready
 * the card stops spinning and offers Schedule (the approve of a held draft: Approve every post and the hold rules still
 * hold drafts here; the owner's voice note: "not posted, that's ambiguous"); Schedule moves it to Scheduled; Post now there skips
 * the slot (only there, and only while it really sends at once); at its slot the Publisher posts it and it moves to Posted by itself. Give feedback (typed or spoken) on an idea
 * or a draft keeps the card in its column with its forward button spinning until the rewrite is in
 * (the screen re-reads every 30 s). Posted is also monitoring: each card shows its numbers and when they were read. Every
 * move slides the card to its new column (none under prefers-reduced-motion). The same board serves one campaign (its
 * Pipeline tab) and every campaign at once (the menu's Pipeline, each card naming its campaign).
 */

/** One campaign on a board: its data and its clicks (they write to that campaign's repo). */
export interface BoardSource {
  repo: string;
  /** Set on the all-campaigns board: the card names its campaign. */
  campaign?: string;
  /** on the all-campaigns board, the campaign's code (null = the repo level): its Auto-approve toggle. */
  code?: string | null;
  milestoneId?: string | null;
  social: SocialData;
  write: Write;
  busy?: string;
  note?: WriteNote;
  writer?: WriterWake;
}

/** the Posted lane shows the last POSTED_DAYS days; older ones fold away (and stay in History). */

// ---- Draft it, Give feedback on an idea: remembered in this browser until the team's answer shows in the data ----

/** An idea the owner sent stays pending this long without news, then shows as before (honest, not stuck). */
export const DRAFTING_MS = 45 * 60_000;
type PendingMap = Record<string, { at: number; snap?: string } | number>;
const readPending = (key: string): PendingMap => {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(key) ?? "{}") as PendingMap;
  } catch {
    return {};
  }
};
const atOf = (v: PendingMap[string]) => (typeof v === "number" ? v : v.at);
/** Draft it (`e61:drafting:v1`: the idea waits in Drafts) or Give feedback (`e61:idea-feedback:v1`: `snap` = the idea's words then). */
function usePending(key: string) {
  const [map, setMap] = useState<PendingMap>(() => readPending(key));
  const save = (m: PendingMap) => {
    setMap(m);
    try {
      globalThis.localStorage?.setItem(key, JSON.stringify(m));
    } catch {
      // private mode: this tab only
    }
  };
  const live = Object.fromEntries(Object.entries(map).filter(([, v]) => Date.now() - atOf(v) < DRAFTING_MS));
  return {
    /** Idea ids of `repo` pending. */
    of: (repo: string) => new Set(Object.keys(live).flatMap((k) => (k.startsWith(`${repo}|`) ? [k.slice(repo.length + 1)] : []))),
    /** idea id → its snap (for Draft it: how many posts it had when the owner pressed). */
    map: (repo: string) => new Map(Object.entries(live).flatMap(([k, v]) => (k.startsWith(`${repo}|`) ? [[k.slice(repo.length + 1), typeof v === "number" ? "" : (v.snap ?? "")] as [string, string]] : []))),
    snap: (repo: string, id: string) => {
      const v = live[`${repo}|${id}`];
      return v === undefined ? undefined : typeof v === "number" ? "" : (v.snap ?? "");
    },
    add: (repo: string, id: string, snap?: string) => save({ ...live, [`${repo}|${id}`]: { at: Date.now(), ...(snap !== undefined ? { snap } : {}) } }),
    drop: (repo: string, id: string) => save(Object.fromEntries(Object.entries(live).filter(([k]) => k !== `${repo}|${id}`))),
  };
}

// ---- the slide: FLIP each card whose column changed ----

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** After each render, a card (`data-card`) that sits in another column (`data-lane`) than before slides from where it was. */
export function useCardMoves(root: RefObject<HTMLElement | null>) {
  const prev = useRef(new Map<string, { x: number; y: number; lane: string }>());
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const base = el.getBoundingClientRect();
    const next = new Map<string, { x: number; y: number; lane: string }>();
    const still = reducedMotion();
    el.querySelectorAll<HTMLElement>("[data-card]").forEach((card) => {
      const r = card.getBoundingClientRect();
      if (!r.width) return; // a column hidden on the phone
      const now = { x: r.left - base.left, y: r.top - base.top, lane: card.dataset.lane ?? "" };
      next.set(card.dataset.card!, now);
      const was = prev.current.get(card.dataset.card!);
      if (!still && was && was.lane !== now.lane && typeof card.animate === "function") {
        card.animate(
          [
            { transform: `translate(${was.x - now.x}px, ${was.y - now.y}px)`, boxShadow: "0 12px 32px rgb(0 0 0 / 0.18)" },
            { transform: "none", boxShadow: "none" },
          ],
          { duration: 600, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" },
        );
      }
    });
    // Keep the last place of cards hidden right now (phone), so they slide when they show again in the same render.
    for (const [k, v] of prev.current) if (!next.has(k) && el.querySelector(`[data-card="${CSS.escape(k)}"]`)) next.set(k, v);
    prev.current = next;
  });
}

// ----: drag a card to another column (mouse anywhere on a folded card; touch and pen by its grip) ----

/**
 * The drag: past 6 px a copy of the card follows the pointer; the column under it (`data-drop-lane`, the phone's lane
 * chips too) lights up. On release `onDrop` says what happens: undefined = the move is made (the card's own button);
 * a string = it snaps back (the reason, if any, is shown by the caller). No HTML5 drag and drop: it has no touch.
 */
export function useBoardDrag(onDrop: (key: string, from: BoardLaneId, to: BoardLaneId | undefined) => string | undefined) {
  const [over, setOver] = useState<BoardLaneId>();
  const [dragging, setDragging] = useState<string>();
  const drop = useRef(onDrop);
  drop.current = onDrop;
  const st = useRef<{ key: string; lane: BoardLaneId; el: HTMLElement; x: number; y: number; id: number; ghost?: HTMLElement }>(undefined);
  const ended = useRef(0);
  useEffect(() => {
    const laneAt = (x: number, y: number) => {
      const el = typeof document.elementFromPoint === "function" ? document.elementFromPoint(x, y) : null;
      return ((el as HTMLElement | null)?.closest?.("[data-drop-lane]") as HTMLElement | null)?.dataset.dropLane as BoardLaneId | undefined;
    };
    const move = (e: PointerEvent) => {
      const s = st.current;
      if (!s || e.pointerId !== s.id) return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      if (!s.ghost) {
        if (Math.hypot(dx, dy) < 6) return;
        const r = s.el.getBoundingClientRect();
        const g = s.el.cloneNode(true) as HTMLElement;
        g.removeAttribute("data-card");
        g.setAttribute("data-testid", "drag-ghost");
        g.setAttribute("aria-hidden", "true");
        Object.assign(g.style, { position: "fixed", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, margin: "0", zIndex: "60", pointerEvents: "none", boxShadow: "0 14px 34px rgb(0 0 0 / 0.22)", borderRadius: "0.75rem" });
        document.body.appendChild(g);
        s.ghost = g;
        setDragging(s.key);
      }
      e.preventDefault();
      s.ghost.style.transform = `translate(${dx}px, ${dy}px) rotate(1.5deg)`;
      setOver(laneAt(e.clientX, e.clientY));
    };
    const end = (e: PointerEvent, cancelled: boolean) => {
      const s = st.current;
      if (!s || e.pointerId !== s.id) return;
      st.current = undefined;
      const g = s.ghost;
      if (!g) return; // a click, not a drag
      ended.current = Date.now();
      setOver(undefined);
      setDragging(undefined);
      const back = cancelled ? "" : drop.current(s.key, s.lane, laneAt(e.clientX, e.clientY));
      // A refused drop snaps back to where the card is; an accepted one lets go (the card slides once the move is in).
      if (back !== undefined && !reducedMotion() && typeof g.animate === "function")
        g.animate([{ transform: g.style.transform }, { transform: "none" }], { duration: 260, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" }).finished.then(
          () => g.remove(),
          () => g.remove(),
        );
      else g.remove();
    };
    const up = (e: PointerEvent) => end(e, false);
    const cancel = (e: PointerEvent) => end(e, true);
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
  }, []);
  /** On the card's pointerdown: a mouse anywhere on a folded card (not on its controls), any pointer on the grip. */
  const begin = (e: ReactPointerEvent<HTMLElement>, key: string, lane: BoardLaneId, folded: boolean) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    const grip = !!t.closest("[data-grip]");
    if (!grip && (!folded || e.pointerType !== "mouse" || t.closest("button:not([data-fold-open]), a, input, textarea, select, label"))) return;
    st.current = { key, lane, el: e.currentTarget, x: e.clientX, y: e.clientY, id: e.pointerId };
  };
  /** The click that ends a drag does not open the card. */
  const justDragged = () => Date.now() - ended.current < 400;
  return { begin, over, dragging, justDragged };
}

// ---- the board ----

type Placed = { key: string; lane: BoardLaneId; src: BoardSource; item: BoardItem };
const cardKey = (repo: string, it: BoardItem) => `${repo}|${it.kind === "post" ? it.post.id : `idea:${it.idea.id ?? it.idea._line}`}`;
const sortKey = (it: BoardItem) => (it.kind === "post" ? (it.post.slot ?? it.post.date) : (it.idea.date ?? ""));
const platformOf = (it: BoardItem) => (it.kind === "post" ? it.post.platform : (it.idea.platform ?? "")).replace(/\s*\(.*$/, "");

/** The four columns of every source, merged: Drafts ready first, Scheduled by slot, the rest newest first. */
function placeAll(sources: BoardSource[], drafting: (repo: string) => ReadonlySet<string> | ReadonlyMap<string, string>): { lanes: Record<BoardLaneId, Placed[]>; replies: number } {
  const lanes: Record<BoardLaneId, Placed[]> = { idea: [], draft: [], scheduled: [], posted: [] };
  let replies = 0;
  for (const src of sources) {
    const b = boardLanes(src.social.data, drafting(src.repo));
    replies += b.replies;
    for (const l of BOARD_LANES) for (const item of b.lanes[l.id]) lanes[l.id].push({ key: cardKey(src.repo, item), lane: l.id, src, item });
  }
  if (sources.length > 1) {
    const newest = (a: Placed, b: Placed) => sortKey(b.item).localeCompare(sortKey(a.item));
    lanes.idea.sort(newest);
    lanes.posted.sort(newest);
    lanes.scheduled.sort((a, b) => sortKey(a.item).localeCompare(sortKey(b.item)));
    lanes.draft.sort((a, b) => Number(!!a.item.working) - Number(!!b.item.working) || newest(a, b));
  }
  return { lanes, replies };
}

/** The live numbers of each source's posted X posts (GET …/social/metrics), only while it has posts in Posted. */
function useLiveNumbers(sources: BoardSource[]) {
  const want = sources.filter((s) => (s.social.data.posts ?? []).some((p) => (p.status === "posted" || p.status === "measured") && /x\.com|twitter\.com/.test(p.link ?? "")));
  const key = want.map((s) => s.repo).join(",");
  const { data } = useQuery(async () => {
    if (!want.length) return {} as Record<string, SocialMetrics>;
    const t = await worldId();
    const all = await Promise.all(want.map((s) => api.getSocialMetrics(t, s.repo).catch(() => undefined)));
    return Object.fromEntries(all.flatMap((m, i) => (m ? [[want[i].repo, m]] : []))) as Record<string, SocialMetrics>;
  }, [key]);
  return data ?? {};
}

/** Open all / Fold all, remembered in this browser (default: folded, the Kanban). */
export const OPEN_ALL_KEY = "e74:open-all:v1";
const readOpenAll = () => {
  try {
    return globalThis.localStorage?.getItem(OPEN_ALL_KEY) === "1";
  } catch {
    return false;
  }
};

/** what a drop asked one card to do (its own button), and the reason a refused drop snapped back. */
type BoardAsk = { key: string; move: "draft" | "schedule" | "post-now"; n: number };
let dropCount = Date.now();

/**
 * the board's columns are real columns (a tinted background, a header
 * with the count, all the same height, each scrolling on its own), the board scrolls sideways with a visible bar and an
 * edge fade when it is wider than the screen (on the phone the next column peeks in); Rows lists every post as one row,
 * each one opens in place; every card has Full screen (a dialog with the whole post, its image, its numbers, its
 * feedback and its buttons); Full width opens the Pipeline over the whole screen (Esc leaves). The view and Full width
 * are remembered in this browser.
 */
export const VIEW_KEY = "e46s13:pipeline-view:v1";
export const FOCUS_KEY = "e46s13:pipeline-focus:v1";
type BoardView = "board" | "rows" | "week";
const VIEWS: [BoardView, string][] = [
  ["board", "Columns"],
  ["rows", "Rows"],
  ["week", "Week"],
];
const readKey = (key: string) => {
  try {
    return globalThis.localStorage?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
};
const saveKey = (key: string, v: string) => {
  try {
    globalThis.localStorage?.setItem(key, v);
  } catch {
    // private mode: this tab only
  }
};

/** Whether a sideways-scrolling box has more to its left or right (for the edge fades and the "more columns" cue). */
function useSideScroll(ref: RefObject<HTMLElement | null>, on: boolean) {
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const el = ref.current;
    if (!on || !el) return;
    const read = () => {
      const left = el.scrollLeft > 4;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
      setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
    };
    read();
    el.addEventListener("scroll", read, { passive: true });
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(read) : undefined;
    ro?.observe(el);
    window.addEventListener("resize", read);
    return () => {
      el.removeEventListener("scroll", read);
      ro?.disconnect();
      window.removeEventListener("resize", read);
    };
  }, [ref, on]);
  return edges;
}

export function PipelineBoard({ sources, now, addIdea, approval }: { sources: BoardSource[]; now?: Date; addIdea: boolean; approval?: { on: boolean; campaign?: string | null; src: BoardSource } }) {
  const [platform, setPlatform] = useState<string>();
  const [view, setViewState] = useState<BoardView>(() => {
    const v = readKey(VIEW_KEY);
    return v === "rows" || v === "week" ? v : "board";
  });
  const setView = (v: BoardView) => (setViewState(v), saveKey(VIEW_KEY, v));
  const [focus, setFocusState] = useState(() => readKey(FOCUS_KEY) === "1");
  const setFocus = (v: boolean) => (setFocusState(v), saveKey(FOCUS_KEY, v ? "1" : "0"));
  // The lane the phone's chips point at (the board scrolls to it; the chips are drop targets too).
  const [lane, setLane] = useState<BoardLaneId>("draft");
  const [ideasView, setIdeasView] = useState<"ideas" | "topics">("ideas");
  const drafting = usePending("e61:drafting:v1");
  const rewording = usePending("e61:idea-feedback:v1");
  const [postedBy, setPostedBy] = useState<NumberKey>("newest");
  const [olderShown, setOlderShown] = useState(false);
  const { lanes, replies } = placeAll(sources, drafting.map);
  const live = useLiveNumbers(sources);
  const egress = useEgress();
  const boardRef = useRef<HTMLDivElement>(null);
  useCardMoves(boardRef);
  const edges = useSideScroll(boardRef, view === "board");
  // r2b: on the phone the chips follow the column the board is scrolled to (it opens on Ideas, not Drafts).
  useEffect(() => {
    const box = boardRef.current;
    if (view !== "board" || !box) return;
    const read = () => {
      if (box.scrollWidth <= box.clientWidth) return;
      const cols = [...box.querySelectorAll<HTMLElement>("[data-drop-lane]")];
      const at = cols.reduce<HTMLElement | undefined>((best, c) => (!best || Math.abs(c.offsetLeft - box.offsetLeft - box.scrollLeft) < Math.abs(best.offsetLeft - box.offsetLeft - box.scrollLeft) ? c : best), undefined);
      const id = at?.dataset.dropLane as BoardLaneId | undefined;
      if (id) setLane((l) => (l === id ? l : id));
    };
    read();
    box.addEventListener("scroll", read, { passive: true });
    return () => box.removeEventListener("scroll", read);
  }, [view, sources]);
  const scoped = !!useCampaignScope();
  // folded cards are all the same height; a click opens one in place (several may be open). Open all / Fold all
  // flips every card, and this browser remembers it; a click then flips just that card.
  const [allOpen, setAllOpen] = useState(() => readOpenAll());
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
  const isOpenKey = (key: string) => allOpen !== flipped.has(key);
  const toggle = (key: string) => setFlipped((o) => (o.has(key) ? new Set([...o].filter((k) => k !== key)) : new Set([...o, key])));
  const openKey = (key: string) => !isOpenKey(key) && toggle(key);
  const setAll = (v: boolean) => {
    setAllOpen(v);
    setFlipped(new Set());
    saveKey(OPEN_ALL_KEY, v ? "1" : "0");
  };
  // the card shown full screen (by its key, so it follows the card when it changes column).
  const [full, setFull] = useState<string>();
  const [ask, setAsk] = useState<BoardAsk>();
  const [refused, setRefused] = useState<{ key: string; text: string }>();
  useEffect(() => {
    if (!refused) return;
    const t = setTimeout(() => setRefused(undefined), 8_000);
    return () => clearTimeout(t);
  }, [refused]);

  // Full width: Esc leaves it (unless a full-screen post is open: Esc closes that first); the page under it does not scroll.
  useEffect(() => {
    if (!focus) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !full && !e.defaultPrevented) setFocus(false);
    };
    window.addEventListener("keydown", key);
    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", key);
      document.body.style.overflow = was;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, full]);

  /** Scroll the board sideways to a column (the phone's chips, and a card the owner moved). */
  const showLane = (id: BoardLaneId) => {
    setLane(id);
    const box = boardRef.current;
    const col = box?.querySelector<HTMLElement>(`[data-testid="lane-${id}"]`);
    if (box && col && typeof box.scrollTo === "function" && box.scrollWidth > box.clientWidth) box.scrollTo({ left: col.offsetLeft - box.offsetLeft - 8, behavior: reducedMotion() ? "auto" : "smooth" });
  };

  // On the phone the card the owner acted on leaves the column he is looking at: follow it to its new column, so he sees it land.
  const [follow, setFollow] = useState<{ key: string; from: BoardLaneId }>();
  const all = BOARD_LANES.flatMap((l) => lanes[l.id]);
  const followed = follow && all.find((p) => p.key === follow.key);
  useEffect(() => {
    if (follow && followed && followed.lane !== follow.from) {
      if (view === "board") showLane(followed.lane);
      else setLane(followed.lane);
      setFollow(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow, followed]);
  const track = (p: Placed) => setFollow({ key: p.key, from: p.lane });

  const drag = useBoardDrag((key, from, to) => {
    const p = all.find((x) => x.key === key);
    if (!p || !to) return "";
    const m = boardMove(p.item, from, to, { writer: !!p.src.writer, egress });
    if (!m) return "";
    if ("reason" in m) {
      setRefused({ key, text: m.reason });
      return m.reason;
    }
    setRefused(undefined);
    track(p);
    if (m.move === "post-now") openKey(key);
    setAsk({ key, move: m.move, n: ++dropCount });
    return undefined;
  });

  const platforms = [...new Set(all.filter((p) => p.item.kind === "post").map((p) => platformOf(p.item)).filter(Boolean))].sort();
  const keep = (p: Placed) => !platform || platformOf(p.item).startsWith(platform);
  const many = sources.length > 1 || !!sources[0]?.campaign;
  const topics = sources.flatMap((s) => s.social.data.topics);
  const first = sources[0];
  const historyHref = !many && first ? (scoped ? "?tab=history" : socialHref("history", first.social.repo ?? first.repo)) : undefined;
  const at = now ?? new Date();
  const recent = (p: Placed) => p.item.kind !== "post" || postedRecently(p.item.post, at);

  /** Each column's cards (Posted: sorted, the last POSTED_DAYS days unless the owner unfolds the older ones). */
  const cols = BOARD_LANES.map((l) => {
    const kept = lanes[l.id].filter(keep);
    const sorted = l.id === "posted" ? sortPosted(kept, postedBy, live) : kept;
    const list = l.id === "posted" ? sorted.filter(recent) : sorted;
    const older = l.id === "posted" ? sorted.filter((p) => !recent(p)) : [];
    return { l, sorted, list, older, items: olderShown ? sorted : list, ready: l.id === "draft" ? list.filter((p) => !p.item.working).length : 0 };
  });
  type Col = (typeof cols)[number];

  /** One card, folded or open, in a column or as a row; `inFull`: the copy in the full-screen dialog. */
  const renderCard = (p: Placed, shape: "card" | "row" | "full") => {
    const isOpen = shape === "full" || isOpenKey(p.key);
    const fold: Fold = {
      open: isOpen,
      onToggle: shape === "full" ? () => setFull(undefined) : () => !drag.justDragged() && toggle(p.key),
      refused: refused?.key === p.key ? refused.text : undefined,
      shape,
      onFull: shape === "full" ? undefined : () => setFull(p.key),
    };
    const mine = shape !== "full" && ask?.key === p.key ? ask : undefined;
    return p.item.kind === "idea" ? (
      <IdeaCard
        idea={p.item.idea}
        src={p.src}
        working={p.item.working ?? rewordingOf(p, rewording)}
        forward={p.item.working ? "Schedule" : "Draft it"}
        onDrafting={(id) => (track(p), drafting.add(p.src.repo, id, String(p.item.kind === "idea" ? ideaUsedOn(p.item.idea, p.src.social.data).reduce((n, u) => n + u.posts.length, 0) : 0)))}
        onNotDrafting={(id) => drafting.drop(p.src.repo, id)}
        onFeedback={(id) => rewording.add(p.src.repo, id, p.item.kind === "idea" ? (p.item.idea.idea ?? "") : "")}
        ask={mine?.move === "draft" ? mine.n : undefined}
        {...fold}
      />
    ) : (
      <PostCard
        post={p.item.post}
        src={p.src}
        working={p.item.working}
        now={now}
        numbers={numbersOf(p.item.post, live[p.src.repo])}
        onAct={() => track(p)}
        ask={mine && mine.move !== "draft" ? { move: mine.move, n: mine.n } : undefined}
        {...fold}
      />
    );
  };
  const placed = (p: Placed, laneId: BoardLaneId, shape: "card" | "row") => (
    <div key={p.key} data-card={p.key} data-lane={laneId} onPointerDown={(e) => drag.begin(e, p.key, laneId, !isOpenKey(p.key))} className={cn("relative min-w-0 rounded-xl", drag.dragging === p.key && "opacity-30")}>
      {renderCard(p, shape)}
    </div>
  );

  /** A column's (or a row group's) title: its name, its count as a pill, Drafts' ready count, and its own controls. */
  const laneHead = ({ l, list, ready }: Col) => (
    <h2 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold" data-testid={`lane-head-${l.id}`}>
      <span className="flex items-center gap-1.5">
        <span className={cn("h-2 w-2 rounded-full", LANE_DOT[l.id])} aria-hidden />
        {l.id === "posted" ? `Posted · last ${POSTED_DAYS} days` : l.label}
        <span className="rounded-full bg-background px-2 py-0.5 text-xs font-medium tabular-nums text-foreground ring-1 ring-border" data-testid={`lane-count-${l.id}`}>
          {list.length}
        </span>
      </span>
      {l.id === "draft" && (
        <span className="text-xs font-normal text-violet-700 dark:text-violet-400" data-testid="drafts-ready">
          {ready} ready for you
        </span>
      )}
      {l.id === "posted" && (
        <label className="ml-auto flex items-center gap-1 text-xs font-normal">
          Sort
          <select aria-label="Sort posted by" value={postedBy} onChange={(e) => setPostedBy(e.target.value as NumberKey)} className="h-7 rounded-md border bg-background px-1 text-xs" data-testid="posted-sort">
            {NUMBER_KEYS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      {l.id === "idea" && (
        <span className="ml-auto flex gap-1 text-xs font-normal" role="group" aria-label="Ideas or topics" data-testid="ideas-view">
          {(["ideas", "topics"] as const).map((v) => (
            <button key={v} type="button" aria-pressed={ideasView === v} onClick={() => setIdeasView(v)} className={cn("rounded-full border bg-background px-2 py-0.5", ideasView === v ? "bg-primary text-primary-foreground" : "hover:bg-accent")}>
              {v === "ideas" ? "Ideas" : `Topics ${topics.length}`}
            </button>
          ))}
        </span>
      )}
    </h2>
  );
  /** What sits under a column's title: Add an idea, the one-line help, "none". */
  const laneTop = ({ l, items }: Col) => (
    <>
      {l.id === "idea" && addIdea && <AddIdea sources={sources} />}
      {l.id === "draft" && <div className="text-xs text-muted-foreground">Spinning: the Writer is on it, nothing for you yet. Drag a ready one to Scheduled, or open it.</div>}
      {l.id === "posted" && <div className="text-xs text-muted-foreground">Open a post to see its numbers and give the Writer feedback.</div>}
      {items.length === 0 && <div className="text-xs text-muted-foreground/70">none</div>}
    </>
  );
  /** Under a column: the older Posted, All posted in History. */
  const laneFoot = ({ l, older, sorted }: Col) => (
    <>
      {older.length > 0 && (
        <button type="button" className="justify-self-start text-xs underline" onClick={() => setOlderShown((v) => !v)} data-testid="posted-older">
          {olderShown ? `Fold the ${older.length} older than ${POSTED_DAYS} days` : `${older.length} older than ${POSTED_DAYS} days, folded away`}
        </button>
      )}
      {l.id === "posted" && sorted.length > 0 && historyHref && (
        <Link to={historyHref} className="text-xs underline" data-testid="all-posted">
          All posted in History
        </Link>
      )}
    </>
  );
  const laneBody = (c: Col, shape: "card" | "row") =>
    c.l.id === "idea" && ideasView === "topics" ? (
      <TopicList topics={topics} />
    ) : (
      <>
        {laneTop(c)}
        {c.items.map((p) => placed(p, c.l.id, shape))}
        {laneFoot(c)}
      </>
    );
  const dropRing = (id: BoardLaneId) => drag.dragging && drag.over === id && "bg-violet-500/10 ring-2 ring-violet-500/60";

  const fullCard = full ? all.find((p) => p.key === full) : undefined;
  useEffect(() => {
    if (full && !fullCard) setFull(undefined); // the post left the board (Don't post, Pull)
  }, [full, fullCard]);

  const body = (
    <div className="grid min-w-0 gap-3" data-testid="pipeline-board">
      <div className="flex flex-wrap items-center gap-1.5" data-testid="pipeline-toolbar">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Platform">
          {[undefined, ...platforms].map((pl) => (
            <Button key={pl ?? "all"} size="sm" variant={platform === pl ? "default" : "outline"} onClick={() => setPlatform(pl)}>
              {pl ?? "All"}
            </Button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {/* the campaign's Auto-approve toggle sits in the toolbar line, no block of its own. */}
          {approval && <ForceReviewSwitch on={approval.on} campaign={approval.campaign} src={approval.src} />}
          {view !== "week" && (
            <Button size="sm" variant="outline" aria-pressed={allOpen} onClick={() => setAll(!allOpen)} data-testid="open-all">
              {allOpen ? "Fold all" : "Open all"}
            </Button>
          )}
          <div className="inline-flex overflow-hidden rounded-md border" role="group" aria-label="View" data-testid="pipeline-view">
            {VIEWS.map(([v, label]) => (
              <Button key={v} size="sm" variant={view === v ? "default" : "ghost"} className="rounded-none" aria-pressed={view === v} onClick={() => setView(v)} data-testid={`view-${v}`}>
                {v === "board" ? <Columns3 aria-hidden /> : v === "rows" ? <Rows3 aria-hidden /> : <CalendarDays aria-hidden />}
                {label}
              </Button>
            ))}
          </div>
          <Button size="sm" variant={focus ? "default" : "outline"} aria-pressed={focus} onClick={() => setFocus(!focus)} data-testid="pipeline-focus" title={focus ? "Back to the page (Esc)" : "Use the whole screen for the Pipeline"}>
            {focus ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
            {focus ? "Exit full width" : "Full width"}
          </Button>
        </div>
      </div>
      {refused && (
        <div role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-sm text-amber-800 dark:text-amber-300" data-testid="drop-refused">
          {cardLabel(all.find((p) => p.key === refused.key))} stays where it was: {refused.text}
        </div>
      )}
      {view === "week" ? (
        many ? <WeekView sources={sources.map((s) => ({ repo: s.repo, campaign: s.campaign, social: s.social }))} /> : first && <WeekView social={first.social} />
      ) : view === "rows" ? (
        <div ref={boardRef} className="grid min-w-0 gap-3" data-testid="rows-view">
          {cols.map((c) => (
            <section key={c.l.id} className={cn("grid min-w-0 gap-1.5 rounded-xl border bg-muted/40 p-2 transition-colors", dropRing(c.l.id))} aria-label={c.l.label} data-testid={`lane-${c.l.id}`} data-drop-lane={c.l.id}>
              <div className="px-1">{laneHead(c)}</div>
              {laneBody(c, "row")}
            </section>
          ))}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1 lg:hidden" role="group" aria-label="Go to column" data-testid="lane-switch">
            {cols.map(({ l, list }) => (
              <button
                key={l.id}
                type="button"
                aria-current={lane === l.id ? "true" : undefined}
                onClick={() => showLane(l.id)}
                data-drop-lane={l.id}
                className={cn("rounded-full border px-2.5 py-1 text-xs", lane === l.id ? "bg-primary text-primary-foreground" : "hover:bg-accent", drag.dragging && drag.over === l.id && "ring-2 ring-violet-500")}
              >
                {l.label} {list.length}
              </button>
            ))}
          </div>
          <div className="relative min-w-0">
            <div
              ref={boardRef}
              className="flex min-w-0 snap-x snap-mandatory gap-3 overflow-x-auto pb-2 [scrollbar-color:hsl(var(--muted-foreground)/0.5)_transparent] [scrollbar-width:thin] lg:snap-none"
              data-testid="board-scroll"
              tabIndex={0}
              aria-label="Pipeline columns, scroll sideways for more"
            >
              {cols.map((c) => (
                <section
                  key={c.l.id}
                  className={cn("flex w-[80vw] min-w-0 max-w-[22rem] shrink-0 snap-start flex-col rounded-xl border bg-muted/50 transition-colors lg:w-auto lg:min-w-[14.5rem] lg:max-w-none lg:flex-1", dropRing(c.l.id))}
                  aria-label={c.l.label}
                  data-testid={`lane-${c.l.id}`}
                  data-drop-lane={c.l.id}
                >
                  <div className={cn("rounded-t-xl border-b border-t-4 bg-background/70 px-3 py-2", LANE_TOP[c.l.id])}>{laneHead(c)}</div>
                  <div className="grid max-h-[max(24rem,calc(100dvh-15rem))] min-h-[12rem] grid-cols-[minmax(0,1fr)] content-start gap-2 overflow-y-auto p-2" data-testid={`lane-body-${c.l.id}`}>
                    {laneBody(c, "card")}
                  </div>
                </section>
              ))}
            </div>
            {edges.left && <div className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-background to-transparent" data-testid="edge-left" aria-hidden />}
            {edges.right && (
              <div className="pointer-events-none absolute inset-y-0 right-0 flex w-12 items-center justify-end bg-gradient-to-l from-background to-transparent" data-testid="edge-right" aria-hidden>
                <ChevronRight className="mr-0.5 h-5 w-5 text-muted-foreground" />
              </div>
            )}
          </div>
          {edges.right && (
            <div className="text-xs text-muted-foreground" data-testid="scroll-cue">
              More columns to the right: scroll sideways{focus ? "" : ", or use Full width"}.
            </div>
          )}
        </>
      )}
      <div className="text-xs text-muted-foreground">
        Not on the board: {replies} replies and outreach (Responder, Engager); they go out as today, each in History.
      </div>
      <Dialog open={!!fullCard} onOpenChange={(o) => !o && setFull(undefined)}>
        <DialogContent className="flex h-[94dvh] max-h-[94dvh] w-[96vw] max-w-6xl flex-col gap-3 p-4 sm:p-6" data-testid="post-full">
          {fullCard && (
            <>
              <DialogTitle className="pr-8 text-base leading-snug">
                {cardLabel(fullCard)} · {BOARD_LANES.find((l) => l.id === fullCard.lane)?.label}
              </DialogTitle>
              <DialogDescription className="sr-only">The whole post with its image, numbers, feedback and buttons.</DialogDescription>
              <div className="min-h-0 flex-1 overflow-y-auto">{renderCard(fullCard, "full")}</div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
  if (!focus) return body;
  return (
    <div className="fixed inset-0 z-[45] overflow-auto bg-background p-3 sm:p-5" role="region" aria-label="Pipeline, full width" data-testid="pipeline-focus-layer">
      <div className="mb-3 flex items-center gap-2">
        <h1 className="text-lg font-semibold">Pipeline</h1>
        <span className="text-xs text-muted-foreground">full width · Esc to leave</span>
      </div>
      {body}
    </div>
  );
}

/** Each column's colour: a dot in its title and a band on top of the column. */
const LANE_DOT: Record<BoardLaneId, string> = { idea: "bg-slate-400", draft: "bg-violet-500", scheduled: "bg-emerald-500", posted: "bg-sky-500" };
const LANE_TOP: Record<BoardLaneId, string> = { idea: "border-t-slate-300 dark:border-t-slate-600", draft: "border-t-violet-500", scheduled: "border-t-emerald-500", posted: "border-t-sky-500" };

/** "P-0012" or "Idea I-4", for the refused drop's line. */
const cardLabel = (p: Placed | undefined) => (!p ? "The card" : p.item.kind === "post" ? (p.item.post.id ?? "The post") : `Idea ${p.item.idea.id ?? ""}`.trim());

/** the owner gave feedback on this idea and its words have not changed yet: the Scout is rewriting it (the card stays in Ideas). */
function rewordingOf(p: Placed, rewording: ReturnType<typeof usePending>): string | undefined {
  if (p.item.kind !== "idea" || !p.item.idea.id) return undefined;
  const snap = rewording.snap(p.src.repo, p.item.idea.id);
  return snap !== undefined && snap === (p.item.idea.idea ?? "") ? "The Scout is rewriting it with your feedback. Draft it comes back when the new words are in." : undefined;
}

/** Posted sorted by its numbers (newest first by default; posts without the number last). */
type NumberKey = "newest" | "impressions" | "likes" | "replies" | "score" | "comments";
const NUMBER_KEYS: [NumberKey, string][] = [
  ["newest", "Newest"],
  ["impressions", "Reads (impressions)"],
  ["replies", "Replies"],
  ["likes", "Likes"],
  ["score", "Score (Reddit)"],
  ["comments", "Comments (Reddit)"],
];
function sortPosted(list: Placed[], by: NumberKey, live: Record<string, SocialMetrics>): Placed[] {
  if (by === "newest") return list;
  const val = (p: Placed) => (p.item.kind === "post" ? numbersOf(p.item.post, live[p.src.repo])?.[by] : undefined) ?? -1;
  return [...list].sort((a, b) => val(b) - val(a));
}

/** The freshest numbers for a live post: the console's live read (X) when it has one, else the ledger's Metrics cell. */
function numbersOf(p: Post, live: SocialMetrics | undefined): PostNumbers | undefined {
  const l = live?.posts[p.id];
  if (l && live?.readAt) return { source: "live", impressions: l.impressions, likes: l.likes, reposts: l.reposts, replies: l.replies, readAt: live.readAt.replace("T", " ").slice(0, 16) };
  return ledgerNumbers(p);
}

/** A campaign name on an all-campaigns card, linking to that campaign. */
function CampaignTag({ src }: { src: BoardSource }) {
  if (!src.campaign) return null;
  const name = <span className="font-medium text-violet-700 dark:text-violet-300">{src.campaign}</span>;
  return (
    <span data-testid="card-campaign" className="max-w-full truncate">
      {src.milestoneId ? (
        <Link to={`/milestones/${encodeURIComponent(src.milestoneId)}`} className="hover:underline">
          {name}
        </Link>
      ) : (
        name
      )}
    </span>
  );
}

/** Spinner line on a card the Writer is working on (the card is not clickable meanwhile). */
function Working({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-1.5 text-xs text-violet-700 dark:text-violet-400" data-testid="card-working">
      <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
      <span>{text}</span>
    </div>
  );
}

/** a card's fold: folded ones are all the same height; a click (Enter, Space) opens one in place. */
interface Fold {
  open: boolean;
  onToggle: () => void;
  /** The reason the last drop of this card snapped back. */
  refused?: string;
  /** a card in a column, a row of the Rows view, or the full-screen copy. */
  shape?: "card" | "row" | "full";
  /** Opens the card full screen. */
  onFull?: () => void;
}

/** the Full screen button of a card (a button, so a press on it never starts a drag or folds the card). */
function FullButton({ onFull, label, chrome }: { onFull?: () => void; label: string; chrome?: boolean }) {
  if (!onFull) return null;
  return (
    <button
      type="button"
      // On an open card it is chrome like Fold (a drag starts there only from the grip anyway).
      data-fold-open={chrome ? "" : undefined}
      onClick={(e) => (e.stopPropagation(), onFull())}
      onKeyDown={(e) => e.stopPropagation()}
      aria-label={`Full screen: ${label}`}
      title="Full screen"
      className="-m-1 shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
      data-testid="card-full"
    >
      <Maximize2 className="h-3.5 w-3.5" />
    </button>
  );
}

/** The handle a touch (or a mouse) drags the card by; on a computer the whole folded card drags too. */
function Grip() {
  return (
    <span data-grip="" className="-mr-1 flex shrink-0 cursor-grab touch-none items-center rounded p-0.5 text-muted-foreground hover:bg-accent active:cursor-grabbing" title="Drag to another column" aria-hidden>
      <GripVertical className="h-4 w-4" />
    </span>
  );
}

/** a folded card: one line of tags, the title on two lines, one status line. Same height in every column. */
function FoldedCard({ label, tags, title, hint, tone, spin, working, refused, onToggle, shape, onFull }: { label: string; tags: ReactNode; title: ReactNode; hint: ReactNode; tone?: "ready" | "late"; spin?: boolean; working?: boolean; refused?: string; onToggle: () => void; shape?: Fold["shape"]; onFull?: () => void }) {
  const row = shape === "row";
  const hintTone = refused ? "text-amber-700 dark:text-amber-400" : tone === "late" ? "text-amber-700 dark:text-amber-400" : tone === "ready" || spin ? "text-violet-700 dark:text-violet-400" : "text-muted-foreground";
  if (row)
    // a row of the Rows view: tags, title and status on one line on a computer, two on the phone.
    return (
      <Card
        data-testid="lane-item"
        data-folded=""
        data-row=""
        role="button"
        tabIndex={0}
        aria-expanded={false}
        title={`Open ${label}`}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
          e.preventDefault();
          onToggle();
        }}
        className={cn("min-w-0 cursor-pointer select-none overflow-hidden transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", working && "border-dashed bg-muted/40", refused && "border-amber-500")}
      >
        <CardContent className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-3 py-2 text-sm md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)_minmax(0,16rem)_auto]">
          <div className="flex min-w-0 items-center gap-x-2 overflow-hidden whitespace-nowrap text-xs text-muted-foreground">{tags}</div>
          <div className="col-start-1 row-start-2 truncate font-medium md:col-start-2 md:row-start-1" data-testid="card-title">
            {title}
          </div>
          <div className={cn("col-start-1 row-start-3 flex min-w-0 items-center gap-1.5 text-xs md:col-start-3 md:row-start-1", hintTone)} data-testid="card-hint">
            {spin && !refused && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />}
            <span className="truncate">{refused ?? hint}</span>
          </div>
          <div className="col-start-2 row-span-3 row-start-1 flex items-center gap-2 md:col-start-4 md:row-span-1">
            <FullButton onFull={onFull} label={label} />
            <Grip />
          </div>
        </CardContent>
      </Card>
    );
  return (
    <Card
      data-testid="lane-item"
      data-folded=""
      role="button"
      tabIndex={0}
      aria-expanded={false}
      title={`Open ${label}`}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        onToggle();
      }}
      className={cn(
        "h-[7.5rem] min-w-0 cursor-pointer select-none overflow-hidden transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        working && "border-dashed bg-muted/40",
        refused && "border-amber-500",
      )}
    >
      <CardContent className="grid h-full grid-rows-[auto_minmax(0,1fr)_auto] gap-1 p-3 text-sm">
        <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <div className="flex min-w-0 flex-1 items-center gap-x-2 overflow-hidden whitespace-nowrap">{tags}</div>
          <FullButton onFull={onFull} label={label} />
          <Grip />
        </div>
        <div className={cn("line-clamp-2 break-words font-medium leading-snug", working && "text-muted-foreground")} data-testid="card-title">
          {title}
        </div>
        <div className={cn("flex min-w-0 items-center gap-1.5 text-xs", hintTone)} data-testid="card-hint">
          {spin && !refused && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />}
          <span className="truncate">{refused ?? hint}</span>
        </div>
      </CardContent>
    </Card>
  );
}

/** The top line of an open card: its tags, the grip and Fold. */
function OpenTags({ children, onToggle, shape, onFull, label }: { children: ReactNode; onToggle: () => void; shape?: Fold["shape"]; onFull?: () => void; label: string }) {
  return (
    <div className="flex items-start gap-2">
      {/* the details as calm tags, no "·" separators (a wrapped line never starts with one). */}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground">{children}</div>
      {/* the full-screen copy has no grip and no Fold (the dialog's own close button closes it). */}
      {shape !== "full" && (
        <>
          <FullButton onFull={onFull} label={label} chrome />
          <Grip />
          <button type="button" data-fold-open="" onClick={onToggle} aria-label="Fold" aria-expanded title="Fold" className="-m-1 rounded p-1 text-muted-foreground hover:bg-accent" data-testid="card-fold">
            <ChevronUp className="h-4 w-4" />
          </button>
        </>
      )}
    </div>
  );
}

/** The folded line under a post: what it waits for, or its numbers. */
function postHint(p: Post, now: Date, numbers?: PostNumbers): { hint: string; tone?: "ready" | "late" } {
  if (p.status === "held") {
    if (noFreeSlot(p, now)) return { hint: "Its slot has passed and nothing is free in the next 3 days. Open it to pick a time.", tone: "late" };
    if (slotPassed(p, now)) return { hint: "Its slot has passed. Open it to schedule it.", tone: "late" };
    return { hint: revisedAt(p) ? "New version for your note. Ready for you." : "Ready for you. Drag it to Scheduled or open it.", tone: "ready" };
  }
  if (p.status === "scheduled") {
    const missed = movedFrom(p); // the console moved it after its slot passed while the Mac was offline
    return { hint: missed ? `Missed ${slotLabel({ slot: missed, date: missed })}. Now goes out ${slotLabel(p)} UTC` : `Goes out ${slotLabel(p)}` };
  }
  if (p.status === "posted" || p.status === "measured") {
    const n = numbers;
    const bits = n ? ([["reads", n.impressions], ["likes", n.likes], ["score", n.score], ["replies", n.replies], ["comments", n.comments]] as const).filter(([, v]) => v !== undefined).map(([k, v]) => `${v!.toLocaleString("en")} ${k}`) : [];
    return { hint: `${bits.length ? bits.join(" · ") : "Numbers not read yet"}${p.feedback ? " · you gave feedback" : ""}` };
  }
  return { hint: p.status };
}

function PostCard({ post: p, src, working, now, numbers, onAct, ask, open, onToggle, refused, shape, onFull }: { post: Post; src: BoardSource; working?: string; now?: Date; numbers?: PostNumbers; onAct: () => void; ask?: CardAsk } & Fold) {
  const live = p.status === "posted" || p.status === "measured";
  const loc = useLocation();
  const write: Write = (w) => (onAct(), src.write(w));
  // a drop on Scheduled is the card's Schedule (the next free slot, as the button); Post now opens the card to ask.
  useEffect(() => {
    if (ask?.move !== "schedule" || !takeAsk(ask.n)) return;
    const reply = (p.kind ?? "").toLowerCase() === "outreach";
    void write({ action: `posts/${p.id}/approve`, body: !reply && p.nextSlot ? { slot: p.nextSlot } : {} });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask?.n]);
  const moving = !!src.busy && src.busy.startsWith(`posts/${p.id}/`);
  const tags = (
    <>
      <PostBadge p={p} />
      <span>{p.id}</span>
      <span>{p.platform}</span>
      {p.community && <span>{p.community}</span>}
      <span>{p.status === "scheduled" ? slotLabel(p) : dayLabel(p.date)}</span>
      {/* last, so a narrow folded card cuts the campaign's name, never the status. */}
      <CampaignTag src={src} />
    </>
  );
  if (!open) {
    const h = postHint(p, now ?? new Date(), numbers);
    return (
      <FoldedCard
        label={`${p.id} ${p.title}`}
        tags={tags}
        title={p.title}
        hint={moving ? "Moving…" : (working ?? h.hint)}
        tone={h.tone}
        spin={moving || !!working}
        working={!!working}
        refused={refused}
        onToggle={onToggle}
        shape={shape}
        onFull={onFull}
      />
    );
  }
  const full = shape === "full";
  const pageLink = (text: string) =>
    working ? (
      <span className="break-words text-muted-foreground">{text}</span>
    ) : (
      <Link to={postHref(src.repo, p.id)} state={{ from: `${loc.pathname}${loc.search}`, label: "Pipeline" } satisfies PostFrom} className="break-words underline-offset-2 hover:underline" data-testid="post-title">
        {text}
      </Link>
    );
  return (
    <Card data-testid={full ? "full-item" : "lane-item"} aria-busy={working ? true : undefined} className={cn("min-w-0 [overflow-wrap:anywhere]", working && "border-dashed bg-muted/40", full && "border-0 shadow-none")}>
      <CardContent className={cn("grid gap-1.5 p-3 text-sm", full && "gap-3 p-0 text-base")}>
        <OpenTags onToggle={onToggle} shape={shape} onFull={onFull} label={`${p.id} ${p.title}`}>
          {tags}
          {p.highlight && <Badge variant="gray">{p.highlight}</Badge>}
          <OutLink href={p.link} />
        </OpenTags>
        {/* Full screen shows the post in labelled parts (hook, body, call to action, image, channel, slot, status). */}
        {full ? (
          <PostDetail
            p={p}
            title={postHook(p) && pageLink(postHook(p)!)}
            page={!working && pageLink("Its own page: every version, the checks and the history")}
            images={
              postImages(src.social, p).length ? (
                <div className="grid gap-3">
                  {postImages(src.social, p).map((img) => (
                    <a key={img.id} href={img.url} target="_blank" rel="noreferrer" data-testid="post-image" tabIndex={working ? -1 : undefined}>
                      <img src={img.url} alt={`${img.id} for ${p.title}`} loading="lazy" className="max-h-[60dvh] w-auto max-w-full rounded border object-contain" />
                    </a>
                  ))}
                </div>
              ) : null
            }
          />
        ) : (
          <>
            {/* the title opens the post's own page (full text, history, every button); a card the Writer is on stays still. */}
            {working ? (
              <div className="break-words font-medium text-muted-foreground">{p.title}</div>
            ) : (
              <Link to={postHref(src.repo, p.id)} state={{ from: `${loc.pathname}${loc.search}`, label: "Pipeline" } satisfies PostFrom} className="break-words font-medium hover:underline" data-testid="post-title">
                {p.title}
              </Link>
            )}
            {p.text && p.text !== p.title && <blockquote className="line-clamp-4 whitespace-pre-wrap break-words border-l-2 pl-2 text-xs" data-testid="post-text">{p.text}</blockquote>}
            {postImages(src.social, p).map((img) => (
              <a key={img.id} href={img.url} target="_blank" rel="noreferrer" data-testid="post-image" tabIndex={working ? -1 : undefined}>
                <img src={img.url} alt={`${img.id} for ${p.title}`} loading="lazy" className="w-full rounded border" />
              </a>
            ))}
          </>
        )}
        {working ? (
          <>
            <Working text={working} />
            <div>
              <Button size="sm" className={PHONE_TAP} disabled pending pendingLabel={p.status === "scheduled" ? "Sending…" : "Writer is on it…"} data-testid="forward-spinning">
                {p.status === "scheduled" ? "Post now" : "Schedule"}
              </Button>
            </div>
            {/* L-38: the click that started the spinning shows its result here too. */}
            <ScopedNote note={src.note} scope={p.id} />
          </>
        ) : (
          <>
            {p.status === "held" && (
              <div className="line-clamp-3 text-xs text-violet-700 dark:text-violet-400" title={p.checks ?? undefined} data-testid="ready-line">
                {revisedAt(p) ? `New version (${revisedAt(p)} UTC) for your note: ${lastReviseAsk(p)}. ` : `Ready for you${p.checks ? ` (${p.checks})` : ""}. `}
                {/* a passed slot has its own line and buttons on the card. Schedule for the next free slot / Pick a new time, never Post now. */}
                {slotPassed(p, now ?? new Date()) ? "Its slot has passed. Schedule gives it the next free time, or you pick a new time." : "Schedule sends it to its slot."} Give feedback gets you a new version first. Don't post keeps it from going out.
              </div>
            )}
            {live && <Numbers n={numbers} platform={p.platform} />}
            {live && <LiveFeedback p={p} src={src} />}
            {refused && (
              <div className="text-xs text-amber-700 dark:text-amber-400" role="status">
                {refused}
              </div>
            )}
            <PostActions key={`${p.id}:${p.status}:${p.text}`} p={p} write={write} busy={src.busy} now={now} note={src.note} ask={ask?.move === "post-now" ? ask : undefined} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Give feedback on a live
 * post, typed or spoken. It lands in the row's Feedback and the campaign's Feedback log (its repo), and wakes the Writer
 * with it for the next posts, as Give feedback on a draft does. The live post itself is not changed.
 */
export function LiveFeedback({ p, src }: { p: Post; src: BoardSource }) {
  const [fb, setFb] = useState<string | null>(null);
  const busy = src.busy === `posts/${p.id}/feedback`;
  // the one box (paste, paperclip, drop): a screenshot goes with the note as a link after his words.
  const files = useChatAttach({ enabled: true, disabled: busy });
  const send = async (words = fb ?? "") => {
    if ((!words.trim() && !files.ids.length) || !files.ready) return;
    const r = await src.write({ action: `posts/${p.id}/feedback`, body: { feedback: (await wordsWithFiles(words, files.ids)).trim() } });
    if (r) (setFb(null), files.clear());
    return r;
  };
  // the one recorder (useAnswerVoice, as on every card) in place of the browser dictation (Dictate): Send sends the box.
  const voice = useAnswerVoice({
    origin: `live-feedback:${p.id}`,
    to: shortTo(`Feedback on ${p.id}`),
    page: `live post ${p.id}: feedback`,
    typed: fb ?? "",
    deliver: (reply) => send(reply).then((r) => {
      if (!r) throw new Error("the feedback did not go out, open the post to see why");
    }),
    disabled: !!src.busy,
  });
  return (
    <div className="grid gap-1.5" data-testid="live-feedback">
      {p.feedback && <div className="line-clamp-2 text-xs text-muted-foreground">You said: {p.feedback}</div>}
      {fb === null ? (
        <div>
          <Button size="sm" variant="outline" className={PHONE_TAP} disabled={!!src.busy} onClick={() => setFb("")} title="Typed or spoken: the Writer takes it into the next posts">
            <MessageSquare /> Give feedback
          </Button>
        </div>
      ) : (
        <form
          className="grid gap-1.5 rounded-md border p-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="text-sm font-medium" htmlFor={`live-fb-${src.repo}-${p.id}`}>
              Your feedback on {p.id}
            </label>
          </div>
          <WordsBox label={`Feedback on ${p.id}`} placeholder="e.g. this landed, more like it; or: too long, cut the intro" boxClassName="min-h-16" value={fb} onChange={setFb} files={files} voice={voice} testid="live-feedback-box" />
          <div className="text-xs text-muted-foreground">It is live, so it stays as it is. The Writer takes your note into the next posts, and it is kept in the campaign&apos;s Feedback log.</div>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" type="submit" className={PHONE_TAP} disabled={!!src.busy || voice.busy || !files.ready || (!fb.trim() && !files.ids.length)} pending={busy} pendingLabel="Sending to the Writer…">
              <Send /> Send to the Writer
            </Button>
            <Button size="sm" type="button" variant="ghost" className={PHONE_TAP} onClick={() => setFb(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      <ScopedNote note={src.note} scope={`${p.id}#feedback`} />
    </div>
  );
}

/** impressions, likes, replies where the platform gives them, and when they were read. */
function Numbers({ n, platform }: { n?: PostNumbers; platform: string }) {
  if (!n)
    return (
      <div className="text-xs text-muted-foreground" data-testid="post-numbers">
        Numbers not read yet: {/reddit/i.test(platform) ? "the Reporter reads Reddit's score and comments 48 h after posting." : "the Reporter reads them 48 h after posting."}
      </div>
    );
  const cells: [string, number | undefined][] = [
    ["impressions", n.impressions],
    ["likes", n.likes],
    ["score", n.score],
    ["reposts", n.reposts],
    ["replies", n.replies],
    ["comments", n.comments],
  ];
  const shown = cells.filter(([, v]) => v !== undefined);
  return (
    <div className="grid gap-0.5 rounded-md bg-muted/50 px-2 py-1.5 text-xs" data-testid="post-numbers">
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {shown.map(([k, v]) => (
          <span key={k}>
            <b className="tabular-nums">{v!.toLocaleString("en")}</b> {k}
          </span>
        ))}
        {!shown.length && <span>No numbers in the ledger row.</span>}
      </div>
      <div className="text-muted-foreground" data-testid="numbers-read">
        {n.source === "live" ? `Read live from X at ${n.readAt} UTC` : n.readAt ? `Read by the Reporter at ${n.readAt} UTC` : "Read by the Reporter (no time in the row)"}
        {/reddit/i.test(platform) && " · Reddit gives no impressions"}
      </div>
    </div>
  );
}

/**
 * a campaign's one switch, now the owner's D1 words (2026-11-08): "The auto approve I think is per
 * campaign... by default it's off... it's like a switch that should be easy to get to." One small toggle on one line;
 * what it does sits in its tooltip. Off (Force review on, the default for a new campaign): every post of this campaign
 * waits in Drafts for his Schedule, and turning it off again holds its posts scheduled without his review. On: posts that
 * pass their checks go out at their slot and he steers with feedback on Posted. The click writes the campaign's own hold
 * rule in its repo (L-45; server social/write.ts approvalEdit); the spinner and the result show at the toggle (L-38).
 * `campaign`: its code (null = the repo level); undefined = the whole repo's rule. `name`: shown on the all board.
 */
export function ForceReviewSwitch({ on, src, campaign, name }: { on: boolean; src: Pick<BoardSource, "write" | "busy" | "note">; campaign?: string | null; name?: string }) {
  const [asked, setAsked] = useState(false);
  const auto = !on;
  const saving = asked && src.busy === "approval";
  const tip = auto
    ? `Auto-approve is on${name ? ` for ${name}` : ""}: posts that pass their checks go out at their slot, and you give feedback on Posted. Switch it off to review every post before it goes out.`
    : `Auto-approve is off${name ? ` for ${name}` : ""}: every post waits in Drafts until you Schedule it. Switch it on to let posts that pass their checks go out at their slot.`;
  const set = (v: boolean) => {
    if (v === auto) return;
    setAsked(true);
    // Every view refreshes: posts that went back to Drafts show there at once (the campaign page has two boards).
    void src.write({ action: "approval", body: { on: !v, ...(campaign !== undefined ? { campaign } : {}) } }).then((r) => r && invalidate());
  };
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs" title={tip} data-testid="force-review" data-campaign={campaign ?? ""}>
      <Switch checked={auto} onCheckedChange={set} disabled={!!src.busy} aria-label={`Auto-approve${name ? ` for ${name}` : ""}`} className="h-4 w-7 [&>span]:h-3 [&>span]:w-3 [&>span]:data-[state=checked]:translate-x-3" data-testid="auto-approve" />
      <span className={auto ? "font-medium" : "text-muted-foreground"}>{name ?? "Auto-approve"}</span>
      {saving ? <Loader2 className="size-3 animate-spin" aria-label="Saving…" /> : !name && <span className="text-muted-foreground">{auto ? "on" : "off"}</span>}
      {asked && !saving && <ScopedNote note={src.note} scope="approval" />}
    </span>
  );
}

/** the switch on the campaign's own page (social skin), in its header line. */
export function CampaignForceReview() {
  const { social, write, busy, note } = useSocialScreen();
  const scope = useCampaignScope();
  if (!social) return null;
  const campaign = scope?.campaign ?? null;
  return <ForceReviewSwitch on={approvesEveryPost(social.data, campaign)} campaign={campaign} src={{ write, busy, note }} />;
}

/** One campaign's Pipeline (its tab, or /social/pipeline?repo= on the console skin). `approval`: its Force review switch (off where the page has its own). */
export function PipelinePage({ now, approval = true }: { now?: Date; approval?: boolean }) {
  const { social, error, write, busy, note, repo } = useSocialScreen();
  const scope = useCampaignScope();
  const writer = useWriterWake(social?.repo ?? repo);
  return (
    <SocialScreen title="Pipeline" intro="Every post from idea to live: Ideas, Drafts, Scheduled, Posted. Drag a card to move it, or click it to open it. With Force review on, every draft waits in Drafts until you Schedule it." social={social} error={error}>
      {(s) => {
        const src: BoardSource = { repo: s.repo ?? repo ?? "", social: s, write, busy, note, writer };
        return (
          <>
            <PageNote sources={[src]} />
            <PipelineBoard sources={[src]} now={now} addIdea approval={approval ? { on: approvesEveryPost(s.data, scope?.campaign ?? null), campaign: scope?.campaign ?? null, src } : undefined} />
          </>
        );
      }}
    </SocialScreen>
  );
}

/** The click result the cards do not show themselves: e.g. a write on a card that has left the board. */
function PageNote({ sources }: { sources: BoardSource[] }) {
  // campaigns of one repo share its note; it shows once, unless a card of that repo shows it.
  const repos = [...new Set(sources.map((s) => s.repo))];
  return (
    <>
      {repos.map((repo) => {
        const mine = sources.filter((s) => s.repo === repo);
        const note = mine[0].note;
        // Only cards still on the board show their own note; Don't post takes a card off it, so its Undo shows here.
        const on = mine.flatMap((s) => Object.values(boardLanes(s.social.data).lanes).flatMap((l) => l.flatMap((it) => (it.kind === "post" ? [it.post.id] : it.idea.id ? [it.idea.id] : []))));
        const ids = new Set(["ideas", "approval", ...on]);
        return <WriteNoteLine key={repo} note={note && ids.has(note.scope ?? "") ? undefined : note} />;
      })}
    </>
  );
}

// ----: every campaign's posts on one board (the menu's Pipeline, as Team gathers every campaign's inbox) ----

/**
 * named campaigns: a post tagged with a named campaign's code or name (its Campaign cell) is that campaign's card;
 * the rest, and the repo's ideas and topics, are the repo's own card. Retired campaigns stay off the board.
 */
export function campaignSlice(d: SocialData, card: CampaignCard, all: CampaignCard[]): SocialData {
  const keysOf = (c: CampaignCard) => [c.campaign!.code, c.campaign!.name].map((k) => k.trim().toLowerCase());
  const tag = (p: { campaign?: string | null }) => (p.campaign ?? "").trim().toLowerCase();
  if (card.campaign) {
    const keys = keysOf(card);
    return { ...d, data: { ...d.data, posts: d.data.posts.filter((p) => keys.includes(tag(p))), ideas: [], topics: [] } };
  }
  const named = new Set(all.filter((c) => c.repo === card.repo && c.campaign).flatMap(keysOf));
  return { ...d, data: { ...d.data, posts: d.data.posts.filter((p) => !named.has(tag(p))) } };
}

/** Each live campaign of the world with its social data and its own clicks (each writes to its own repo; one read per repo). */
export function useAllCampaigns(): { sources?: BoardSource[]; cards?: CampaignCard[]; error?: Error; unread?: { campaign: string; why: string }[] } {
  const { data: camps, error: campError } = useCampaigns();
  const all = camps?.campaigns;
  // one project's campaigns at a time (all of them when the world has a single project).
  const project = useProject();
  const cards = all && liveCards(all).filter((c) => !project.current || c.repo === project.current.repo);
  const repoList = [...new Set((cards ?? []).map((c) => c.repo))];
  const q = useQuery(async () => {
    if (!cards) return undefined;
    const t = await worldId();
    // A repo that cannot be read leaves the board, but the page names it and says why (never silently fewer campaigns).
    const got = await Promise.all(repoList.map((r) => api.getSocial(t, r).catch((e: Error) => e)));
    return Object.fromEntries(repoList.map((r, i) => [r, got[i]])) as Record<string, SocialData | Error>;
  }, [repoList.join(","), !!cards]);
  const { data: assignments = [] } = useQuery(() => api.listAssignments(), []);
  const { data: personas = [] } = useQuery(() => api.listPersonas(), []);
  const [fresh, setFresh] = useState<Record<string, SocialData>>({});
  const [busy, setBusy] = useState<{ repo: string; action: string }>();
  const [note, setNote] = useState<{ repo: string; note: WriteNote }>();
  useEffect(() => setFresh({}), [q.data]);

  const writeFor =
    (repo: string, tenantId: string): Write =>
    async (w: SocialWriteAction): Promise<SocialWriteResult | undefined> => {
      setBusy({ repo, action: w.action });
      setNote(undefined);
      try {
        const r = await api.socialWrite(tenantId, w, repo);
        setFresh((f) => ({ ...f, [repo]: r }));
        setNote({ repo, note: { ok: true, text: describeWrite(r), undo: undoOf(w, r, writeFor(repo, tenantId)), scope: scopeOf(w.action) } });
        invalidate("inbox");
        return r;
      } catch (e) {
        const err = e as Error & { issues?: string[] };
        setNote({ repo, note: { ok: false, text: err.message, ...(err.issues?.length ? { issues: err.issues } : {}), scope: scopeOf(w.action) } });
      } finally {
        setBusy(undefined);
      }
    };

  if (!cards || !q.data) return { cards, error: campError ?? q.error };
  const sources = cards.flatMap((c): BoardSource[] => {
    const whole = fresh[c.repo] ?? q.data![c.repo];
    if (!whole || whole instanceof Error) return [];
    const social = campaignSlice(whole, c, all!);
    return [
      {
        repo: c.repo,
        campaign: c.campaign?.name ?? campaignName(c.title),
        code: c.campaign?.code ?? null,
        milestoneId: c.milestoneId,
        social,
        write: writeFor(c.repo, social.tenantId),
        busy: busy?.repo === c.repo ? busy.action : undefined,
        note: note?.repo === c.repo ? note.note : undefined,
        writer: writerOf(c.milestoneId ?? undefined, assignments, personas, c.campaign ? [] : campaignIdsOf(c.repo, cards)),
      },
    ];
  });
  const unread = cards.flatMap((c) => {
    const d = q.data![c.repo];
    return d instanceof Error && !fresh[c.repo] ? [{ campaign: c.campaign?.name ?? campaignName(c.title), why: d.message }] : [];
  });
  return { sources, cards, error: q.error, unread };
}

export function AllPipelinePage({ now }: { now?: Date }) {
  const { sources, cards, error, unread = [] } = useAllCampaigns();
  // one Auto-approve toggle per campaign (a repo can hold several, each its own), all on one line.
  const toggles = sources ?? [];
  return (
    <>
      <PageHeader title="Pipeline" description="Every objective's posts on one board, in four columns: Ideas, Drafts, Scheduled, Posted. Drag a card to move it, click it to open it, or open it full screen. Rows lists every post one under the other; Full width uses the whole screen." />
      {toggles.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" data-testid="force-review-all">
          <span className="text-muted-foreground" title="Off: every post of the campaign waits in Drafts for you. On: posts that pass their checks go out at their slot. A new campaign starts off.">
            Auto-approve
          </span>
          {toggles.map((t) => (
            <ForceReviewSwitch key={`${t.repo}:${t.code ?? ""}`} on={approvesEveryPost(t.social.data, t.code ?? null)} campaign={t.code ?? null} src={t} name={t.campaign ?? t.repo} />
          ))}
        </div>
      )}
      {error && <ErrorBox error={error} />}
      {unread.map((u) => (
        <div key={u.campaign} role="status" className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="campaign-unread">
          Not on the board: {u.campaign} could not be read ({u.why}). It comes back on the next refresh.
        </div>
      ))}
      {!sources && !error && <Loading />}
      {cards && cards.length === 0 && (
        <div className="text-sm text-muted-foreground">
          No campaign yet. <Link to="/" className="underline">Start one from Team</Link>.
        </div>
      )}
      {sources && sources.length > 0 && (
        <>
          <PageNote sources={sources} />
          <PipelineBoard sources={sources} now={now} addIdea />
        </>
      )}
    </>
  );
}

/** the Scout's topics (what it found, ranked, heat, reply target, what used it), compact, in the Ideas lane. */
function TopicList({ topics }: { topics: SocialTopic[] }) {
  const list = [...topics].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  if (!list.length) return <div className="text-xs text-muted-foreground/70">No topics yet: the Scout writes them on its daily scan.</div>;
  return (
    <ul className="grid gap-1 text-sm" data-testid="topic-list">
      {list.map((t, i) => (
        <li key={`${t.id ?? t._line}:${i}`} className="min-w-0 rounded-md border px-2 py-1.5" data-testid="topic-row">
          <div className="break-words">{t.topic}</div>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {t.rank != null && <span>#{t.rank}</span>}
            {t.where && <span>· {t.where}</span>}
            {t.heat != null && <span>· heat {t.heat}</span>}
            {t.reply_target && <Badge variant="gray">reply target</Badge>}
            {t.used_by.length > 0 && <span>· used by {t.used_by.join(", ")}</span>}
            <OutLink href={t.link}>link</OutLink>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** one line; it lands in the campaign's ideas file and the Writer and Scout read it on their next wake. On the all-campaigns board, the owner picks the campaign. */
function AddIdea({ sources }: { sources: BoardSource[] }) {
  const [text, setText] = useState("");
  const [repo, setRepo] = useState(sources[0]?.repo);
  const src = sources.find((s) => s.repo === repo) ?? sources[0];
  if (!src) return null;
  return (
    <form
      className="grid gap-1"
      data-testid="add-idea"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim()) return;
        const r = await src.write({ action: "ideas", body: { idea: text.trim(), format: null, platform: null, link: null } });
        if (r) setText("");
      }}
    >
      {sources.length > 1 && (
        <select aria-label="Campaign for the idea" value={src.repo} onChange={(e) => setRepo(e.target.value)} className="h-8 rounded-md border bg-background px-2 text-sm">
          {sources.map((s) => (
            <option key={s.repo} value={s.repo}>
              {s.campaign ?? s.repo}
            </option>
          ))}
        </select>
      )}
      <div className="flex gap-1.5">
        <Input aria-label="Add an idea" value={text} onChange={(e) => setText(e.target.value)} placeholder="Add an idea…" className="h-8 text-sm" />
        <Button size="sm" type="submit" variant="outline" disabled={!!src.busy || !text.trim()} pending={src.busy === "ideas"} pendingLabel="Adding…">
          Add
        </Button>
      </div>
      <ScopedNote note={src.note} scope="ideas" />
    </form>
  );
}

/** the campaign's Writer assignment, for Draft it now (run-now with a note naming the idea). */
export interface WriterWake {
  assignmentId: string;
  name: string;
}
const isWriter = (p: Persona) => /^\s*pack role:\s*writer\b/im.test(p.remit ?? "") || /\b(writer|author)\b/i.test(p.name);
export function writerOf(milestoneId: string | undefined, assignments: Assignment[], personas: Persona[], campaigns: string[] = []): WriterWake | undefined {
  if (!milestoneId) return undefined;
  const writers = (ids: string[]) =>
    assignments.filter((x) => ids.includes(x.milestoneId) && personas.some((p) => p.id === x.personaId && isWriter(p))).sort((x, y) => Number(y.enabled) - Number(x.enabled));
  // an enabled Writer first (a Writer moved to a named campaign leaves a switched-off copy on the repo). Iteration 2:
  // on the repo's own card (the all-campaigns board) a switched-off copy is passed over for the Writer working on one of
  // the repo's campaigns, so Draft it there makes a row tagged with that campaign instead of one filed under.
  const own = writers([milestoneId]);
  const a = own.find((x) => x.enabled) ?? writers(campaigns).find((x) => x.enabled) ?? own[0];
  return a ? { assignmentId: a.id, name: personas.find((p) => p.id === a.personaId)!.name } : undefined;
}
/** The milestones of the repo's live named campaigns (where its moved Writer works). */
const campaignIdsOf = (repo: string | undefined, cards: CampaignCard[] | undefined) =>
  (cards ?? []).flatMap((c) => (c.repo === repo && c.campaign && !c.retired && c.milestoneId ? [c.milestoneId] : []));
function useWriterWake(repo: string | null | undefined): WriterWake | undefined {
  const scope = useCampaignScope();
  const { data: camps } = useCampaigns();
  const milestoneId = scope?.milestoneId ?? camps?.campaigns.find((c) => c.repo === repo && !c.campaign)?.milestoneId ?? undefined;
  const { data: assignments = [] } = useQuery(() => api.listAssignments(), []);
  const { data: personas = [] } = useQuery(() => api.listPersonas(), []);
  return useMemo(() => writerOf(milestoneId, assignments, personas, scope?.campaign ? [] : campaignIdsOf(repo ?? undefined, camps?.campaigns)), [milestoneId, assignments, personas, scope, repo, camps]);
}

/**
 * an open idea: Draft it, Give feedback, Park it. Draft it wakes the Writer with it and
 * moves the card into Drafts at once, spinning and not clickable, until the Writer's draft replaces it. Give feedback, typed or spoken, goes to the Scout, who rewrites the idea; the
 * card stays in Ideas with Draft it spinning until the new words are in.
 */
function IdeaCard({
  idea: i,
  src,
  working,
  forward,
  onDrafting,
  onNotDrafting,
  onFeedback,
  ask,
  open,
  onToggle,
  refused,
  shape,
  onFull,
}: {
  idea: SocialIdea;
  src: BoardSource;
  working?: string;
  forward: string;
  onDrafting: (id: string) => void;
  onNotDrafting: (id: string) => void;
  onFeedback: (id: string) => void;
  /** a drop on Drafts (the drop's number): Draft it. */
  ask?: number;
} & Fold) {
  const [fb, setFb] = useState<string | null>(null);
  // the one box (paste, paperclip, drop): a screenshot goes to the Scout with the note as a link after his words.
  const files = useChatAttach({ enabled: true, disabled: !!src.busy });
  const [wake, setWake] = useState<{ busy?: boolean; ok?: boolean; text?: string }>({});
  const { write, busy, note, writer } = src;
  const id = i.id ?? "";
  const draftNow = async () => {
    if (!writer) return;
    setWake({ busy: true });
    try {
      await mutate(() => api.runAssignmentNow(writer.assignmentId, `Draft idea ${id} now (${ownerName()} pressed Draft it on the Pipeline): ${i.idea ?? ""}`.trim()));
      setWake({ ok: true, text: `The ${writer.name} is drafting ${id}. It waits in Drafts for you to Schedule it.` });
      onDrafting(id);
    } catch (e) {
      onNotDrafting(id);
      setWake({ ok: false, text: `Not started: ${(e as Error).message}` });
    }
  };
  const sendFeedback = async (words = fb ?? "") => {
    if ((!words.trim() && !files.ids.length) || !files.ready) return;
    const r = await write({ action: `ideas/${id}/feedback`, body: { feedback: (await wordsWithFiles(words, files.ids)).trim() } });
    if (r) (setFb(null), files.clear(), onFeedback(id));
    return r;
  };
  // the one recorder (useAnswerVoice, as on every card) in place of the browser dictation (Dictate): Send sends the box.
  const voice = useAnswerVoice({
    origin: `idea-feedback:${id}`,
    to: shortTo(`Feedback on ${id}`),
    page: `idea ${id}: feedback`,
    typed: fb ?? "",
    deliver: (reply) => sendFeedback(reply).then((r) => {
      if (!r) throw new Error("the feedback did not go out, open the idea to see why");
    }),
    disabled: !!src.busy,
  });
  // dropped on Drafts: the same as Draft it.
  useEffect(() => {
    if (ask !== undefined && takeAsk(ask)) void draftNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask]);
  // ideas never expire; the platforms it was used on and those still open (approved mockup §5)
  const usedOn = (() => {
    const used = ideaUsedOn(i, src.social.data);
    return used.length > 0 ? (
      <div className="flex flex-wrap gap-1 text-xs" data-testid="idea-used-on">
        {used.map((u) => (
          <Badge key={u.platform} variant={u.posts.length ? "green" : "gray"} title={u.posts.length ? `Used on ${u.platform}: ${u.posts.map((x) => `${x.id} ${x.status}`).join(", ")}` : `Not used on ${u.platform} yet: open for it`}>
            {u.platform} {u.posts.length ? u.posts.map((x) => `${x.id}${x.status && !["posted", "measured"].includes(x.status) ? ` ${x.status}` : ""}`).join(", ") : "-"}
          </Badge>
        ))}
      </div>
    ) : null;
  })();
  const tags = (
    <>
      <Badge variant="gray">{working && forward === "Schedule" ? "drafting" : i.state}</Badge>
      <span>{i.id}</span>
      {i.from && <span>from {i.from === ownerName() ? "you" : i.from}</span>}
      {i.platform && <span>{i.platform}</span>}
      {i.format && <span>{i.format}</span>}
      <CampaignTag src={src} />
    </>
  );
  if (!open)
    return (
      <FoldedCard
        label={`idea ${id}`}
        tags={tags}
        title={i.idea}
        hint={wake.busy ? "Waking the Writer…" : (working ?? (wake.text || (writer ? "Drag it to Drafts, or open it to Draft it." : "Open it to give feedback or park it.")))}
        spin={wake.busy || !!working}
        working={!!working}
        refused={refused}
        onToggle={onToggle}
        shape={shape}
        onFull={onFull}
      />
    );
  return (
    <Card data-testid={shape === "full" ? "full-item" : "lane-item"} aria-busy={working ? true : undefined} className={cn("min-w-0 [overflow-wrap:anywhere]", working && "border-dashed bg-muted/40", shape === "full" && "border-0 shadow-none")}>
      <CardContent className={cn("grid gap-1.5 p-3 text-sm", shape === "full" && "gap-3 p-0 text-base")}>
        <OpenTags onToggle={onToggle} shape={shape} onFull={onFull} label={`idea ${id}`}>{tags}</OpenTags>
        {/* Full screen shows the idea in labelled parts (what, why, audience, how, source). */}
        {shape === "full" ? <IdeaDetail i={i} used={usedOn} /> : <div className={cn("break-words", working && "text-muted-foreground")}>{i.idea}</div>}
        {shape !== "full" && usedOn}
        {fb !== null && !working && (
          <form
            className="grid gap-1.5 rounded-md border p-2"
            data-testid="idea-feedback"
            onSubmit={(e) => {
              e.preventDefault();
              void sendFeedback();
            }}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="text-sm font-medium" htmlFor={`fb-${src.repo}-${id}`}>
                Your feedback on {id}
              </label>
            </div>
            <WordsBox label={`Feedback on ${id}`} placeholder="e.g. make it about replies, not launches" boxClassName="min-h-16" value={fb} onChange={setFb} files={files} voice={voice} testid="idea-feedback-box" />
            <div className="text-xs text-muted-foreground">The Scout rewrites the idea with it; it stays here, and Draft it comes back when the new words are in.</div>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" type="submit" className={PHONE_TAP} disabled={!!busy || voice.busy || !files.ready || (!fb.trim() && !files.ids.length)} pending={busy === `ideas/${id}/feedback`} pendingLabel="Sending to the Scout…">
                <Send /> Send to the Scout
              </Button>
              <Button size="sm" type="button" variant="ghost" className={PHONE_TAP} onClick={() => setFb(null)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
        {working ? (
          <>
            <Working text={working} />
            <div>
              <Button size="sm" className={PHONE_TAP} disabled pending pendingLabel={forward === "Schedule" ? "Writer is drafting…" : "Scout is rewriting…"} data-testid="forward-spinning">
                {forward}
              </Button>
            </div>
          </>
        ) : (
          id &&
          fb === null && (
            <div className="flex flex-wrap gap-1.5">
              {writer && (
                <Button size="sm" variant="outline" className={PHONE_TAP} disabled={wake.busy || !!busy} pending={wake.busy} pendingLabel="Waking the Writer…" onClick={draftNow} title={`Wakes the ${writer.name} now with this idea, instead of waiting for its next turn`}>
                  Draft it
                </Button>
              )}
              {/* the idea's three actions fit one row: "Feedback", still named Give feedback for a screen reader. */}
              <Button size="sm" variant="outline" className={PHONE_TAP} disabled={!!busy} onClick={() => setFb("")} title="Typed or spoken: the Scout rewrites the idea with it" aria-label="Give feedback">
                Feedback
              </Button>
              <Button size="sm" variant="ghost" className={PHONE_TAP} disabled={!!busy} pending={busy === `ideas/${id}/drop`} pendingLabel="Parking…" onClick={() => write({ action: `ideas/${id}/drop` })} title="Park it: the Writer will not pick it up (kept, never deleted)">
                Park
              </Button>
            </div>
          )
        )}
        {wake.text && (
          <div className={cn("text-xs", wake.ok ? "text-violet-700 dark:text-violet-400" : "text-destructive")} role="status" data-testid="draft-now-note">
            {wake.text}
          </div>
        )}
        <ScopedNote note={note} scope={id} />
      </CardContent>
    </Card>
  );
}
