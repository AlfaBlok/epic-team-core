import { useEffect, useState } from "react";

/**
 * the inbox drawn from a saved copy says so. The app's service worker (public/sw.js) answers a read with the
 * copy it kept when the console is slow (6 s) or there is no connection; that answer carries `x-saved-copy: <when it was
 * kept>`. Each read's path is noted here: saved while its last answer was a saved copy, cleared by the first fresh one.
 * The Inbox shows one quiet line ("Saved copy from 14:02, refreshing") while any current read is a saved copy.
 */
export const SAVED_HEADER = "x-saved-copy";

/**
 * a page polls every 30 s while in view; a path not read again for this long belongs to a page no longer open, so its
 * saved mark no longer speaks for the screen.
 */
export const SAVED_CURRENT_MS = 75_000;

type Entry = { keptAt?: number; readAt: number };
const saved = new Map<string, Entry>();
const subs = new Set<() => void>();
const tell = () => subs.forEach((s) => s());

/** one read's answer: `header` is its x-saved-copy value (a saved copy) or empty (fresh from the console). */
export function noteRead(path: string, header: string | null | undefined, now = Date.now()) {
  if (header) {
    const t = Date.parse(header);
    saved.set(path, { keptAt: Number.isFinite(t) ? t : undefined, readAt: now });
    return tell();
  }
  if (saved.delete(path)) tell();
}

/** the oldest saved copy the screen draws now (undefined: every read is fresh). `keptAt` undefined: its time is unknown. */
export function savedCopy(now = Date.now()): { keptAt?: number } | undefined {
  let out: { keptAt?: number } | undefined;
  for (const e of saved.values()) {
    if (now - e.readAt > SAVED_CURRENT_MS) continue;
    if (!out || (e.keptAt ?? -Infinity) < (out.keptAt ?? -Infinity)) out = { keptAt: e.keptAt };
  }
  return out;
}

const two = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Saved copy from 14:02, refreshing"; from another day "Saved copy from 23 Nov 14:02, refreshing". */
export function savedCopyLabel(keptAt: number | undefined, now = Date.now()): string {
  if (keptAt === undefined) return "Saved copy, refreshing";
  const k = new Date(keptAt);
  const n = new Date(now);
  const time = `${two(k.getHours())}:${two(k.getMinutes())}`;
  const sameDay = k.getFullYear() === n.getFullYear() && k.getMonth() === n.getMonth() && k.getDate() === n.getDate();
  return `Saved copy from ${sameDay ? time : `${k.getDate()} ${MONTHS[k.getMonth()]} ${time}`}, refreshing`;
}

/** the saved copy the screen draws now; re-renders on each read and as old marks age out. */
export function useSavedCopy(): { keptAt?: number } | undefined {
  const [, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    subs.add(bump);
    const timer = setInterval(bump, 15_000);
    return () => {
      subs.delete(bump);
      clearInterval(timer);
    };
  }, []);
  return savedCopy();
}

/**
 * the service worker answered with a saved copy and the console's fresh answer has now arrived (it keeps it): `refresh`
 * reads again, so the screen and its note move to fresh data at once instead of at the next 30 s poll.
 */
export function onFreshFromWorker(refresh: () => void): () => void {
  const sw = typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
  if (!sw?.addEventListener) return () => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const on = (e: MessageEvent) => {
    if (e.data?.type !== "saved-copy-fresh") return;
    // several reads land together after a slow spell: one refresh for all of them
    clearTimeout(timer);
    timer = setTimeout(refresh, 300);
  };
  sw.addEventListener("message", on);
  // back online after an offline spell: read again now, so a saved copy's note clears with the first fresh answer
  const online = () => saved.size > 0 && refresh();
  if (typeof window !== "undefined") window.addEventListener("online", online);
  return () => {
    sw.removeEventListener("message", on);
    if (typeof window !== "undefined") window.removeEventListener("online", online);
  };
}

/** tests only. */
export const resetSavedCopy = () => (saved.clear(), tell());
