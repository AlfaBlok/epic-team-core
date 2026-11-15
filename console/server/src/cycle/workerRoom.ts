/**
 * the per-milestone worker ceiling follows the room the servers have. Up to ROOMY (14) child workers at once
 * while the seat broker has free seats (`status` available > 0) and the worker server's memory has room for the extra
 * workers over its floor; back to the flat ceiling (10) when either is short or unreadable. The broker's own limits
 * (memory floor and load cap at every pick, the owner's seat) stay the hard limits: this only sets what a wake may try.
 */
import { DEFAULT_MAX_WORKERS } from "../wakePrompt.js";

/** the ceiling while seats and memory have room (CONSOLE_MAX_WORKERS_WITH_ROOM overrides). */
export const ROOMY_MAX_WORKERS = 14;
/** the worker server's pick floor (its dispatcher client, DISPATCH_MEM_FLOOR_MB) and what one launch takes there. */
export const WORKER_MEM_FLOOR_MB = 3000;
export const MB_PER_WORKER = 600;
/** one status read per minute however many wakes ask (a status is an ssh call to the worker server and a broker call). */
export const ROOM_TTL_MS = 60_000;

export interface Room {
  /** the ceiling this wake allows. */
  max: number;
  base: number;
  roomy: number;
  /** free seats the broker reports (null = unreadable). */
  seatsFree: number | null;
  /** the worker server's MemAvailable in MB (null = unreadable). */
  memMb: number | null;
  /** memory the extra workers need: the floor plus one launch's share for each worker over the flat ceiling. */
  memNeedMb: number;
}

export function roomyMaxFromEnv(raw = process.env.CONSOLE_MAX_WORKERS_WITH_ROOM, base = DEFAULT_MAX_WORKERS): number {
  const n = Number(raw);
  return raw && Number.isInteger(n) && n > 0 ? Math.max(n, base) : Math.max(ROOMY_MAX_WORKERS, base);
}

/** the pure rule: roomy only when both readings are known and both have room. */
export function roomFor(o: { base: number; roomy: number; seatsFree: number | null; memMb: number | null; floorMb?: number }): Room {
  const memNeedMb = (o.floorMb ?? WORKER_MEM_FLOOR_MB) + MB_PER_WORKER * Math.max(0, o.roomy - o.base);
  const room = o.seatsFree !== null && o.seatsFree > 0 && o.memMb !== null && o.memMb >= memNeedMb;
  return { max: room ? o.roomy : o.base, base: o.base, roomy: o.roomy, seatsFree: o.seatsFree, memMb: o.memMb, memNeedMb };
}

/** the wake prompt's line: the number allowed now and why. */
export function roomLine(r: Room): string {
  if (r.roomy <= r.base) return "";
  const seats = r.seatsFree === null ? "seats unreadable" : `${r.seatsFree} free seat${r.seatsFree === 1 ? "" : "s"}`;
  const mem = r.memMb === null ? "worker server memory unreadable" : `worker server memory ${r.memMb} MB (room line ${r.memNeedMb} MB)`;
  return r.max > r.base
    ? `Room now: ${r.max} workers allowed for this milestone (${seats}, ${mem}); back to ${r.base} when seats or memory run short. pick's memory floor and load cap still refuse a launch.`
    : `Room now: ${r.max} workers allowed for this milestone (${seats}, ${mem}); up to ${r.roomy} when the broker has free seats and memory is over the room line.`;
}

/** MemAvailable (MB) from /proc/meminfo text. */
export function memAvailableMb(meminfo: string): number | null {
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(meminfo);
  return m ? Math.floor(Number(m[1]) / 1024) : null;
}

/** a cached reader: each part that fails reads as null (= no room), never an error. */
export function createWorkerRoom(o: {
  base: number;
  roomy: number;
  seatsFree?: () => Promise<number>;
  memMb?: () => Promise<number | null>;
  floorMb?: number;
  ttlMs?: number;
  now?: () => number;
}): () => Promise<Room> {
  let cached: { at: number; room: Promise<Room> } | undefined;
  const now = o.now ?? Date.now;
  const read = async (): Promise<Room> => {
    const [seats, mem] = await Promise.all([
      o.seatsFree ? o.seatsFree().then((n) => (Number.isFinite(n) ? n : null)).catch(() => null) : Promise.resolve(null),
      o.memMb ? o.memMb().catch(() => null) : Promise.resolve(null),
    ]);
    return roomFor({ base: o.base, roomy: o.roomy, seatsFree: seats, memMb: mem, floorMb: o.floorMb });
  };
  return () => {
    const t = now();
    if (!cached || t - cached.at >= (o.ttlMs ?? ROOM_TTL_MS)) cached = { at: t, room: read() };
    return cached.room;
  };
}
