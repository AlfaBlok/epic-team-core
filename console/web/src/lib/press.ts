/**
 * a press the console saved but could not land yet answers `202 {press: {id, state: "landing"}}`; the
 * console retries it until it lands. The page then says "Saved, landing…" at the button (L-38), asks
 * GET /api/presses/:id until the press has landed (or failed for good), and only then reports success: a press that has
 * not landed is never shown as done.
 */
export type PressNote = {
  path: string;
  state: "landing" | "landed" | "failed" | "undone";
  reason?: string;
  /** landed, from the press to its commit */ ms?: number;
  steps?: Record<string, number>;
  /** the press (Bring it back takes it back by id) and its undo window, on the first `landing` note. */
  id?: string;
  undoMs?: number;
};
type Try = { steps?: Record<string, number> };
type Press = { id: string; state: "landing" | "landed" | "failed" | "undone"; reason?: string; response?: unknown; ms?: number; tries?: Try[] };

/**
 * how long a card press that closes it waits on the console before it is written: the floating note's
 * Bring it back window (the note shows NOTE_MS, a little less, so a tap on it is always inside the window).
 */
export const UNDO_MS = 8_000;

/** a press taken back with Bring it back before it was written: the caller's wait ends quietly. */
export class PressUndone extends Error {
  constructor() {
    super("brought back before it was written");
    this.name = "PressUndone";
  }
}

/**
 * how long to wait before asking again whether a press landed: often at first (a press lands in 4 to 13 s, and
 * the page says "Done" when it has), then every 2 s, then every 10 s. Asking is one row read on the console.
 */
export const askAfterMs = (i: number) => (i < 30 ? 700 : i < 60 ? 2_000 : 10_000);

/** failed asks in a row before the card says it could not check the press (each GET already waits out a restart for ~60 s). */
export const PRESS_ASK_MISSES = 3;

const listeners = new Set<(n: PressNote) => void>();
/** Hear every press that is landing, landed or failed after landing (the card filters by its own path). */
export function onPress(fn: (n: PressNote) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
const tell = (n: PressNote) => listeners.forEach((fn) => fn(n));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The route's answer, or (a press still landing) the answer it gives once it lands. */
export async function landed<T>(first: unknown, path: string, get: (id: string) => Promise<Press>, fail: (msg: string) => Error): Promise<T> {
  const p = (first as { press?: { id?: string; state?: string; reason?: string; undoMs?: number } } | undefined)?.press;
  if (!p?.id || p.state !== "landing") return first as T;
  tell({ path, state: "landing", reason: p.reason, id: p.id, ...(p.undoMs ? { undoMs: p.undoMs } : {}) });
  let misses = 0;
  for (let i = 0; ; i++) {
    await sleep(askAfterMs(i));
    let now: Press;
    try {
      now = await get(p.id);
      misses = 0;
    } catch (e) {
      // the console refusing to say (403 world_scope on the social site, 2026-11-11) never comes right by asking
      // again: say so on the card at once instead of a "writing it to the project…" line that spins for minutes. A
      // restarting console (no status, 5xx, a timeout) is asked again, up to PRESS_ASK_MISSES times in a row.
      const status = (e as { status?: number }).status ?? 0;
      const refused = status >= 400 && status < 500 && status !== 408 && status !== 429;
      if (refused || ++misses >= PRESS_ASK_MISSES) {
        const why = `saved, but this page could not check that it reached the project (${(e as Error).message || status || "no answer"}): press it again to retry`;
        tell({ path, state: "failed", reason: why });
        throw fail(why);
      }
      continue; // the console restarting: the press is saved there, keep asking
    }
    if (now.state === "landed") {
      tell({ path, state: "landed", ...(now.ms !== undefined ? { ms: now.ms } : {}), ...(lastSteps(now) ? { steps: lastSteps(now) } : {}) });
      return now.response as T;
    }
    if (now.state === "undone") {
      tell({ path, state: "undone" });
      throw new PressUndone();
    }
    if (now.state === "failed") {
      tell({ path, state: "failed", reason: now.reason });
      throw fail(now.reason ?? "the press could not land");
    }
  }
}

/** The steps of the try that wrote it (lock wait, fetch, commit, push), when the console timed them. */
const lastSteps = (p: Press) => [...(p.tries ?? [])].reverse().find((t) => t.steps)?.steps;
