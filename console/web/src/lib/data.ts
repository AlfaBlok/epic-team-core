import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiMode } from "@/api";

// Tiny fetch-and-refresh layer: every mutation bumps a global version, all queries refetch.
/** a query may carry a tag; `invalidate(tag)` refreshes only those (a snooze refetches the inbox, not ~15 lists). */
/** `counts` (the pills) also refresh with the inbox: an answer or a snooze changes the red pill. */
export type QueryTag = "inbox" | "counts";
const listeners = new Set<{ refresh: () => void; tag?: QueryTag }>();
export const invalidate = (tag?: QueryTag) => listeners.forEach((l) => (!tag || l.tag === tag || (tag === "inbox" && l.tag === "counts")) && l.refresh());
api.subscribe?.(() => invalidate());

/** Poll interval: real server data changes behind our back (runs, spines). */
const POLL_MS = apiMode === "real" ? 30_000 : 0;

type VisibilityDoc = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
const pageDoc = (): VisibilityDoc | undefined => (typeof document === "undefined" ? undefined : document);

/**
 * `refresh` every `ms` while the tab is in view only.
 * the owner's Mac kept ~8 console tabs open, each polling ~25 lists every 30 s hidden or not (~330 requests a minute through
 * Traefik), and after a restart all of them hit the cold console at once. A hidden tab now skips its ticks and refreshes
 * once when it is shown again (only when a tick was skipped). Returns the stop function; `ms` 0 = no polling.
 */
export function pollWhileVisible(refresh: () => void, ms: number, doc: VisibilityDoc | undefined = pageDoc()): () => void {
  if (!ms) return () => undefined;
  let missed = false;
  const timer = setInterval(() => (doc?.visibilityState === "hidden" ? (missed = true) : refresh()), ms);
  const seen = () => {
    if (doc?.visibilityState === "hidden" || !missed) return;
    missed = false;
    refresh();
  };
  doc?.addEventListener("visibilitychange", seen);
  return () => {
    clearInterval(timer);
    doc?.removeEventListener("visibilitychange", seen);
  };
}

export function useQuery<T>(fn: () => Promise<T>, deps: unknown[] = [], opts: { tag?: QueryTag } = {}) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const load = useCallback(() => {
    let alive = true;
    fnRef
      .current()
      .then((d) => alive && (setData(d), setError(undefined)))
      .catch((e: Error) => alive && setError(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let cancel = load();
    const refresh = () => {
      cancel();
      cancel = load();
    };
    const l = { refresh, tag: opts.tag };
    listeners.add(l);
    const stopPoll = pollWhileVisible(refresh, POLL_MS);
    return () => {
      cancel();
      listeners.delete(l);
      stopPoll();
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
type Shared = { data?: unknown; error?: Error; loading: boolean; version: number; seq: number; readers: number; subs: Set<() => void>; stop: () => void; refresh: () => void };
const shared = new Map<string, Shared>();

function openShared(key: string, fn: () => Promise<unknown>, tag?: QueryTag): Shared {
  const found = shared.get(key);
  if (found) return found;
  const e: Shared = { loading: true, version: 0, seq: 0, readers: 0, subs: new Set(), stop: () => undefined, refresh: () => undefined };
  const bump = () => {
    e.version++;
    e.subs.forEach((s) => s());
  };
  e.refresh = () => {
    const n = ++e.seq;
    fn()
      .then((d) => n === e.seq && ((e.data = d), (e.error = undefined)))
      .catch((err: Error) => n === e.seq && (e.error = err))
      .finally(() => n === e.seq && ((e.loading = false), bump()));
  };
  const l = { refresh: () => e.refresh(), tag };
  listeners.add(l);
  const stopPoll = pollWhileVisible(() => e.refresh(), POLL_MS);
  e.stop = () => {
    listeners.delete(l);
    stopPoll();
    e.seq++;
  };
  shared.set(key, e);
  e.refresh();
  return e;
}

export function useSharedQuery<T>(key: string, fn: () => Promise<T>, opts: { tag?: QueryTag } = {}) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const [, setVersion] = useState(0);
  const [entry, setEntry] = useState<Shared | undefined>(() => shared.get(key));
  useEffect(() => {
    const e = openShared(key, () => fnRef.current(), opts.tag);
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
  return { data: e?.data as T | undefined, error: e?.error, loading: e ? e.loading : true };
}
