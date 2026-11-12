import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@/lib/data";

/**
 * rework (the owner 2026-11-02: /book#capabilities showed "being built", not the book): the Epic Book pages show a book
 * at once and keep it. The last answer with a book is kept in localStorage and shown while the server restarts or builds;
 * with no book yet, or one being rebuilt, the page asks again every few seconds (the 30 s poll was the only retry).
 */
export const BOOK_RETRY_MS = 3_000;
export const BOOK_REFRESHING_MS = 10_000;

function readSaved<T>(key: string): T | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function useLiveBook<T extends { book: { builtAt?: string } | null; building?: boolean }>(fn: () => Promise<T>, deps: unknown[], cacheKey: string) {
  const [round, setRound] = useState(0);
  const { data, error, loading } = useQuery(fn, [...deps, round]);
  const saved = useMemo(() => readSaved<T>(cacheKey), [cacheKey]);
  const live = data?.book ? data : undefined;

  useEffect(() => {
    if (!live) return;
    try {
      globalThis.localStorage?.setItem(cacheKey, JSON.stringify(live));
    } catch {
      // quota or private mode: the server's stored book still answers at once
    }
  }, [live, cacheKey]);

  const waiting = !data?.book || !!error;
  const building = !!data?.building;
  useEffect(() => {
    if (!waiting && !building) return;
    const t = setTimeout(() => setRound((n) => n + 1), waiting ? BOOK_RETRY_MS : BOOK_REFRESHING_MS);
    return () => clearTimeout(t);
  }, [waiting, building, data, error]);

  const shown = live ?? (saved?.book ? saved : data);
  return {
    data: shown,
    error: shown ? undefined : error,
    loading: loading && !shown,
    /** The page shows its saved copy: the server is restarting or has no book yet. */
    savedCopy: !live && !!saved?.book,
  };
}
