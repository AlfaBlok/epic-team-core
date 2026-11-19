import { createHash } from "node:crypto";

const textHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/**
 * An operational audit: a Delivery Manager's "nothing new" skip read only its repo (spines, data/, the
 * prompt), so faults outside the repo were never news. An ops repo's Delivery Manager skipped two wakes while the main
 * host's CPU pressure hit 86% and a product's WhatsApp channel was down, and another world's skipped 7 wakes with an
 * open desk note of the owner's words in its desk/inbox/.
 *
 * Now the repo's home Delivery Manager's wake fingerprint has one more part, `news`: the open faults it owns.
 * - each open note in its repo's desk/inbox/ (desk/inbox.ts), and
 * - each red key result of the servers' wheel (its wheel.json, sites().serverWheelUrl) whose `owner` is this repo:
 *   a host's CPU, memory or disk, a failing service or timer, a check that fails twice (a channel down), a data feed
 *   that did not land.
 * A fault that starts, clears or changes is news; the same faults wake by the 24 h cap only (CADENCE_SKIP_MAX_AGE_MS),
 * so a red that waits on someone else does not wake it every cadence. Numbers in a line ("86%", "44 min") do not count:
 * a fault is the same fault while its numbers move.
 */

/** One key result of wheel.json (only what the news reads). */
export interface WheelSpoke {
  id: string;
  state: string;
  must?: string;
  now?: string;
  host?: string;
  /** the repo whose Delivery Manager acts on it (the checkout folder name, e.g. ops); absent = the wheel's own repo. */
  owner?: string;
}

/** The red key results `repo` owns, one line each (`wheel:<id> red: <must> (<now>)`). `home` = the wheel's own repo. */
export function wheelFaults(spokes: WheelSpoke[] | undefined, repo: string, home: string): string[] {
  const mine = (s: WheelSpoke) => (s.owner || home).toLowerCase() === repo.toLowerCase();
  return (spokes ?? [])
    .filter((s) => s.state === "red" && mine(s))
    .map((s) => `wheel:${s.id} red: ${s.must ?? s.id}${s.host ? ` on ${s.host}` : ""}${s.now ? ` (${s.now.slice(0, 160)})` : ""}`);
}

/** The open notes of a desk inbox, one line each. */
export const deskNoteLines = (notes: { file: string; status: string; about?: string }[]): string[] =>
  notes.filter((n) => n.status === "open").map((n) => `desk note open: ${n.file}${n.about ? ` (${n.about.slice(0, 120)})` : ""}`);

/** The `news` part: "" when nothing is open; numbers left out, so a fault whose numbers move stays the same fault. */
export const newsPart = (lines: string[]): string => (lines.length ? textHash([...lines].map((l) => l.replace(/\d+(?:[.,]\d+)?/g, "#")).sort().join("\n")) : "");

/**
 * A cached reader of wheel.json (one read a minute at most; an unreadable wheel is no news, never a wake every time).
 * Undefined url: no wheel on this console.
 */
export function serverWheelReader(url: string | undefined, f: typeof fetch = fetch, ttlMs = 60_000, now = () => Date.now()) {
  let at = 0;
  let last: WheelSpoke[] | undefined;
  return async (): Promise<WheelSpoke[] | undefined> => {
    if (!url) return undefined;
    if (now() - at < ttlMs) return last;
    at = now();
    try {
      const r = await f(url, { signal: AbortSignal.timeout(10_000) });
      const j = r.ok ? ((await r.json()) as { spokes?: WheelSpoke[] }) : undefined;
      last = Array.isArray(j?.spokes) ? j!.spokes : last;
    } catch {
      /* unreadable now: keep the last reading */
    }
    return last;
  };
}
