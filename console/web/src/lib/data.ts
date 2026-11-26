import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, apiMode, type ReviewItem } from "@/api";
import { foldAsks, rememberJoined } from "@/lib/sameTopic";
import { inboxHeld, onInboxRelease } from "@/lib/inboxHold";
import { forgetParked, gateAnswer, type Source } from "@/lib/inboxNew";
import { onFreshFromWorker } from "@/lib/savedCopy";

// Tiny fetch-and-refresh layer: every mutation bumps a global version, all queries refetch.
/** a query may carry a tag; `invalidate(tag)` refreshes only those (a snooze refetches the inbox, not ~15 lists). */
/** `counts` (the pills) also refresh with the inbox: an answer or a snooze changes the red pill. */
export type QueryTag = "inbox" | "counts";
/** `own`: what he just did (it shows at once); `background`: a poll or a push (new cards wait behind the "N new" line, lib/inboxNew). */
const listeners = new Set<{ refresh: (source?: Source) => void; tag?: QueryTag }>();
export const invalidate = (tag?: QueryTag, source: Source = "own") =>
  listeners.forEach((l) => (!tag || l.tag === tag || (tag === "inbox" && l.tag === "counts")) && l.refresh(source));
api.subscribe?.(() => invalidate(undefined, "background"));
// the service worker's fresh answer arrived after it drew a saved copy: read again now, not at the next poll
onFreshFromWorker(() => invalidate(undefined, "background"));

/** inbox lists and counts hold still while a card box is in use (lib/inboxHold); others always update. */
const holds = (tag?: QueryTag) => (tag === "inbox" || tag === "counts") && inboxHeld();

/** Poll interval: real server data changes behind our back (runs, spines). */
const POLL_MS = apiMode === "real" ? 30_000 : 0;

type VisibilityDoc = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
const pageDoc = (): VisibilityDoc | undefined => (typeof document === "undefined" ? undefined : document);

/**
 * `refresh` every `ms` while the tab is in view only.
 * the owner's Mac kept ~8 console tabs open, each polling ~25 lists every 30 s hidden or not (~330 requests a minute through
 * Traefik), and after a restart all of them hit the cold console at once. A hidden tab now skips its ticks and refreshes
 * once when it is shown again (when a tick was skipped or a whole period passed). Returns the stop function; `ms` 0 = no polling.
 */
export function pollWhileVisible(refresh: () => void, ms: number, doc: VisibilityDoc | undefined = pageDoc(), win: ShownWin | undefined = pageWin(doc)): () => void {
  if (!ms) return () => undefined;
  let missed = false;
  let last = Date.now();
  const run = () => ((last = Date.now()), (missed = false), refresh());
  const timer = setInterval(() => (doc?.visibilityState === "hidden" ? (missed = true) : run()), ms);
  // the installed app on his phone is frozen in the background (iOS stops its timers, so no tick is ever
  // "missed"); back on screen it showed the chat from two hours before. Shown again after a full period, it reads at once.
  const seen = () => {
    if (doc?.visibilityState === "hidden") return;
    if (missed || Date.now() - last >= ms) run();
  };
  doc?.addEventListener("visibilitychange", seen);
  // the app brought back from the app switcher or the back-forward cache: iOS may send pageshow or focus, not visibilitychange
  win?.addEventListener("pageshow", seen);
  win?.addEventListener("focus", seen);
  return () => {
    clearInterval(timer);
    doc?.removeEventListener("visibilitychange", seen);
    win?.removeEventListener("pageshow", seen);
    win?.removeEventListener("focus", seen);
  };
}
type ShownWin = Pick<Window, "addEventListener" | "removeEventListener">;
/** the real window only alongside the real document (a test's fake document brings its own window or none). */
const pageWin = (doc: VisibilityDoc | undefined): ShownWin | undefined =>
  typeof window !== "undefined" && typeof document !== "undefined" && doc === document ? window : undefined;

export function useQuery<T>(fn: () => Promise<T>, deps: unknown[] = [], opts: { tag?: QueryTag } = {}) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const has = useRef(false);
  const parked = useRef<{ d: T } | undefined>(undefined);

  const me = useRef({}).current;
  const load = useCallback((source: Source = "background") => {
    let alive = true;
    fnRef
      .current()
      .then((d) => {
        if (!alive) return;
        const show = (v: T) => {
          has.current = true;
          parked.current = undefined;
          setData(v);
          setError(undefined);
        };
        // the Inbox open: a card he has not seen waits behind the "N new" line (lib/inboxNew), even while a box holds
        const g = gateAnswer(me, d, has.current ? source : "first", opts.tag, () => show(d));
        if (g === "park") return;
        // held: park the answer until the card box lets go (the first answer always shows)
        if (has.current && holds(opts.tag)) return void (parked.current = { d: g.show });
        show(g.show);
      })
      .catch((e: Error) => alive && setError(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    // new deps: their first answer shows even while held
    has.current = false;
    parked.current = undefined;
    forgetParked(me);
    let cancel = load();
    const refresh = (source?: Source) => {
      cancel();
      cancel = load(source);
    };
    const l = { refresh, tag: opts.tag };
    listeners.add(l);
    const stopPoll = pollWhileVisible(() => refresh("background"), POLL_MS);
    const stopRelease = onInboxRelease(() => {
      const p = parked.current;
      if (!p) return;
      parked.current = undefined;
      // what came while a box was in use: new cards still wait behind the line
      const g = gateAnswer(me, p.d, "background", opts.tag, () => (setData(p.d), setError(undefined)));
      if (g === "park") return;
      setData(g.show);
      setError(undefined);
    });
    return () => {
      cancel();
      forgetParked(me);
      listeners.delete(l);
      stopPoll();
      stopRelease();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading };
}

/** Run a mutation, then refresh every query (only the `tag`ged ones when given). Errors surface via the returned promise. */
export async function mutate<T>(fn: () => Promise<T>, tag?: QueryTag): Promise<T> {
  try {
    return await fn();
  } finally {
    invalidate(tag);
  }
}

/**
 * one fetch per key for every component that shows it, so a
 * count and the list it counts read the same answer at the same moment. Before, the sidebar pill, the phone top bar and
 * the Team home section each fetched and polled on their own clock, up to 30 s apart: a pill said 1 while the list was
 * already empty. Same refresh rules as useQuery (tag, poll); the entry is dropped when its last reader unmounts.
 */
type Shared = {
  data?: unknown;
  parked?: { d: unknown };
  error?: Error;
  loading: boolean;
  /** the data is the first draw's part (`first`); the whole answer is on its way (`loadRest`). */
  partial: boolean;
  loadRest: () => void;
  version: number;
  seq: number;
  readers: number;
  subs: Set<() => void>;
  stop: () => void;
  refresh: (source?: Source) => void;
};
const shared = new Map<string, Shared>();

/**
 * The owner chose "Yes: trim the asks next" after the slow-phone fix (the phone downloaded all 423 asks, 115 KB, for
 * about 20 open): how long after the first draw's part lands the whole answer is asked for, so it never competes with
 * the first screen's other calls on a slow phone line. Opening a folded history section asks for it at once.
 */
export const REST_AFTER_MS = 1500;

type SharedOpts = { tag?: QueryTag; first?: () => Promise<unknown> };

function openShared(key: string, fn: () => Promise<unknown>, opts: SharedOpts = {}): Shared {
  const { tag, first } = opts;
  const found = shared.get(key);
  if (found) return found;
  const e: Shared = { loading: true, partial: false, loadRest: () => undefined, version: 0, seq: 0, readers: 0, subs: new Set(), stop: () => undefined, refresh: () => undefined };
  const bump = () => {
    e.version++;
    e.subs.forEach((s) => s());
  };
  let restTimer: ReturnType<typeof setTimeout> | undefined;
  e.loadRest = () => {
    if (restTimer) clearTimeout(restTimer);
    restTimer = undefined;
    if (e.partial) e.refresh("rest");
  };
  e.refresh = (source: Source = "background") => {
    const n = ++e.seq;
    let park = false;
    // the first answer of a query with a `first` part is that part; every later one (a poll, an answer) is whole
    const part = !!first && e.loading && source === "first";
    // while the data is only the part, the whole answer's extra items are history already seen, never "N new"
    const src: Source = e.loading ? "first" : source !== "own" && e.partial ? "rest" : source;
    (part ? first : fn)()
      .then((d) => {
        if (n !== e.seq) return;
        const whole = () => {
          e.partial = part;
          if (part && !restTimer) restTimer = setTimeout(e.loadRest, REST_AFTER_MS);
        };
        // the Inbox open: a card he has not seen waits behind the "N new" line (lib/inboxNew), even while a box holds
        const g = gateAnswer(e, d, src, tag, () => {
          e.parked = undefined;
          e.data = d;
          e.error = undefined;
          whole();
          bump();
        });
        if (g === "park") return void (park = true);
        // held: park the answer until the card box lets go (the first answer always shows)
        if (!e.loading && holds(tag)) return void ((park = true), (e.parked = { d: g.show }));
        e.parked = undefined;
        e.data = g.show;
        e.error = undefined;
        whole();
      })
      .catch((err: Error) => {
        if (n !== e.seq) return;
        e.error = err;
        // a part that failed: the whole answer next, at once (an older console without the part answers whole anyway)
        if (part) setTimeout(() => e.refresh("first"), 0);
      })
      .finally(() => n === e.seq && !park && ((e.loading = false), bump()));
  };
  const l = { refresh: (source?: Source) => e.refresh(source), tag };
  listeners.add(l);
  const stopPoll = pollWhileVisible(() => e.refresh("background"), POLL_MS);
  const stopRelease = onInboxRelease(() => {
    if (!e.parked) return;
    const d = e.parked.d;
    e.parked = undefined;
    // what came while a box was in use: new cards still wait behind the line
    // a parked answer is always whole (the first answer, the part, is never held)
    const g = gateAnswer(e, d, e.partial ? "rest" : "background", tag, () => {
      e.data = d;
      e.error = undefined;
      e.partial = false;
      bump();
    });
    if (g === "park") return;
    e.data = g.show;
    e.error = undefined;
    e.partial = false;
    bump();
  });
  e.stop = () => {
    if (restTimer) clearTimeout(restTimer);
    forgetParked(e);
    listeners.delete(l);
    stopPoll();
    stopRelease();
    e.seq++;
  };
  shared.set(key, e);
  e.refresh("first");
  return e;
}

export function useSharedQuery<T>(key: string, fn: () => Promise<T>, opts: { tag?: QueryTag; first?: () => Promise<T> } = {}) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const firstRef = useRef(opts.first);
  firstRef.current = opts.first;
  const [, setVersion] = useState(0);
  const [entry, setEntry] = useState<Shared | undefined>(() => shared.get(key));
  useEffect(() => {
    const e = openShared(key, () => fnRef.current(), { tag: opts.tag, ...(opts.first ? { first: () => firstRef.current!() } : {}) });
    e.readers++;
    const sub = () => setVersion(e.version);
    e.subs.add(sub);
    setEntry(e);
    setVersion(e.version);
    return () => {
      e.subs.delete(sub);
      if (--e.readers === 0) {
        e.stop();
        shared.delete(key);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const e = entry && shared.get(key) === entry ? entry : shared.get(key);
  return { data: e?.data as T | undefined, error: e?.error, loading: e ? e.loading : true, partial: !!e?.partial, loadRest: () => e?.loadRest() };
}

/**
 * the owner's inbox list, one fetch and one poll for every reader with the same filter (the Team home's
 * page, its Blocked section and its later folds read the one answer; before, each fetched and polled its own copy).
 */
export function useWaitingList(f: Parameters<typeof api.listWaitingOnOwner>[0] = { includeSuperseded: true }) {
  const key = `waiting:${JSON.stringify(f ?? {})}`;
  // the open asks first (what the top sections draw), the answered and done ones right after (`partial` till then)
  const q = useSharedQuery(key, () => api.listWaitingOnOwner(f), { tag: "inbox", first: () => api.listWaitingOnOwner({ ...f, scope: "open" }) });
  // E948-S183: before any ask shows, one on the same ticket, page or topic as an open review card folds into it
  // (the same shared fetch as the review list, lib/inbox.ts useReviewList)
  const reviews = useSharedQuery<ReviewItem[]>("review-items", () => api.listReviewItems(), { tag: "inbox" }).data;
  const data = useMemo(() => foldAsks(q.data, reviews), [q.data, reviews]);
  // E948-S187: an answer on an ask a review card joined answers that card too (api respondToWaiting)
  useEffect(() => rememberJoined(data), [data]);
  return { ...q, data };
}
/** E948-S187: the inbox asks as the console sends them, unfolded (the review list folds its cards into older asks with them). */
export const useRawWaiting = () => {
  const f = { includeSuperseded: true };
  return useSharedQuery(`waiting:${JSON.stringify(f)}`, () => api.listWaitingOnOwner(f), { tag: "inbox", first: () => api.listWaitingOnOwner({ ...f, scope: "open" }) });
};
