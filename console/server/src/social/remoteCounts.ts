import { sameRepo } from "../adapters/repoNames.js";
import type { SiteWhere } from "../siteKpisCompute.js";

/**
 * a metric can read another product's public counts. A world
 * names one in its root spine, `Metric sources: testers memory-counts#active_testers, customers memory-counts#paying_customers`.
 * Only the named sources below are read (never an address a spine writes: the console would fetch whatever a world put
 * there), so `url:<endpoint>#<field>` is taken only when the endpoint is one of them. One read an hour per source is
 * enough (the endpoint itself changes hourly); when it does not answer, the last good reading is kept and says so.
 */
export interface RemoteSourceDef {
  name: string;
  /** In plain words, where the number comes from. */
  label: string;
  url: string;
  schema: string;
  /** The fields a metric may read; `cumulative` ones only grow, so a period counts what came after its start. */
  fields: string[];
  cumulative: string[];
  /** Where a person sees the numbers and the people behind them (shown beside the number). */
  page: SiteWhere;
  /**
   * what each field counts, in plain words: a metric read from that field takes its label and unit from here,
   * so a number never wears the catalog's default words (`Tester applications` over a sign-ups count).
   */
  words?: Record<string, { label: string; counts: string }>;
  /** fields shown as their own line beside a campaign target that reads another field of this source. */
  alongside?: string[];
}

/** the named remote sources (config): none in the open core; the hosted layer sets its own (setRemoteSources). */
export const REMOTE_SOURCES: Record<string, RemoteSourceDef> = {};
/** the names a spine may write before `#<field>` */
export const remoteSourceNames = (): string[] => Object.keys(REMOTE_SOURCES);

/**
 * a product's Epic Book links the page where its numbers live, with the
 * numbers beside it. Keyed by the repo the book is about; one plain label and at most three counts each.
 */
export interface BookLivePage {
  repos: string[];
  link: { label: string; url: string };
  counts: { label: string; source: RemoteSourceId }[];
}
export const BOOK_LIVE_PAGES: BookLivePage[] = [];

/** set the named sources and the books' live pages (the hosted layer, once at load); the same objects are refilled. */
export function setRemoteSources(sources: Record<string, RemoteSourceDef>, pages: BookLivePage[] = []): void {
  for (const k of Object.keys(REMOTE_SOURCES)) delete REMOTE_SOURCES[k];
  Object.assign(REMOTE_SOURCES, sources);
  BOOK_LIVE_PAGES.splice(0, BOOK_LIVE_PAGES.length, ...pages);
}

export type RemoteSourceId = `${string}#${string}`;

/** `memory-counts#active_testers` or `url:https://cloud.memory.dev/api/public/counts#active_testers`, as `<name>#<field>`; anything else is undefined. */
export function remoteSourceId(raw: string): RemoteSourceId | undefined {
  const s = raw.trim().replace(/^`|`$/g, "");
  const m = /^(?:url:)?(.+)#([a-z_]+)$/i.exec(s);
  if (!m) return undefined;
  const where = m[1].replace(/\/+$/, "");
  const def = REMOTE_SOURCES[where.toLowerCase()] ?? Object.values(REMOTE_SOURCES).find((d) => d.url === where);
  const field = m[2].toLowerCase();
  return def && def.fields.includes(field) ? `${def.name}#${field}` : undefined;
}

export function remoteSourceOf(id: string): { def: RemoteSourceDef; field: string } | undefined {
  const [name, field] = id.split("#");
  const def = REMOTE_SOURCES[name];
  return def && field && def.fields.includes(field) ? { def, field } : undefined;
}

/** a field's own label and unit, when its source names them. */
export function remoteWords(id: string): { label: string; counts: string } | undefined {
  const src = remoteSourceOf(id);
  return src ? src.def.words?.[src.field] : undefined;
}

/** One source's last reading as the console holds it. */
export interface RemoteReading {
  /** The endpoint's last good body, or null when it never answered. */
  body: Record<string, unknown> | null;
  /** When that good body was read (ISO), and the endpoint's own time in it. */
  readAt: string | null;
  at: string | null;
  /** Set while the endpoint does not answer: since when, and why. */
  failedAt?: string;
  error?: string;
}

/** A field's value from a reading: the latest, or for a cumulative field over a period, what came after `from`. */
export function remoteValue(id: string, r: RemoteReading | undefined, from?: string | null): number | null {
  const src = remoteSourceOf(id);
  const v = r?.body?.[src?.field ?? ""];
  if (!src || typeof v !== "number") return null;
  if (!from || !src.def.cumulative.includes(src.field)) return v;
  // The day before the period's value is its start; a period older than the history counts everything.
  const hist = Array.isArray(r?.body?.history) ? (r!.body!.history as Record<string, unknown>[]) : [];
  const before = hist.filter((h) => typeof h.date === "string" && h.date < from && typeof h[src.field] === "number").sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const base = before.length ? (before[before.length - 1][src.field] as number) : 0;
  return Math.max(0, v - base);
}

const hm = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/**
 * Where the number came from, in words. `withTime` adds when it was read (the page); data/metrics.md leaves the time out
 * so the file changes only when a number or the endpoint's state does.
 */
export function remoteSourceText(id: string, r: RemoteReading | undefined, withTime = false): string {
  const src = remoteSourceOf(id);
  if (!src) return `not a source: ${id}`;
  const base = `${src.def.label}, ${src.field}, read hourly from ${src.def.url.replace(/^https:\/\//, "")}`;
  if (r?.failedAt && r.body) return `${base}. It is not answering${withTime ? ` since ${hm(r.failedAt)}` : ""}: the last good reading${withTime && r.readAt ? ` from ${hm(r.readAt)}` : ""} is shown`;
  if (!r?.body) return `${base}. It has not answered yet, so no number`;
  return withTime && r.readAt ? `${base}, last read ${hm(r.readAt)}` : base;
}

type Fetch = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const REMOTE_TTL_MS = 60 * 60 * 1000;
/** After a failed read, try again this soon (not every page load). */
export const REMOTE_RETRY_MS = 5 * 60 * 1000;

/** The console's one cache of remote counts: read at most once an hour per source, the last good body kept. */
export function createRemoteCounts(o: { fetch?: Fetch; now?: () => number; timeoutMs?: number } = {}) {
  const doFetch: Fetch = o.fetch ?? ((url, init) => fetch(url, init));
  const now = o.now ?? Date.now;
  const held = new Map<string, RemoteReading & { triedAt: number }>();
  const inflight = new Map<string, Promise<RemoteReading>>();

  async function read(def: RemoteSourceDef): Promise<RemoteReading> {
    const prev = held.get(def.name);
    const t = now();
    const fresh = prev && (prev.failedAt ? t - prev.triedAt < REMOTE_RETRY_MS : t - prev.triedAt < REMOTE_TTL_MS);
    if (prev && fresh) return prev;
    const going = inflight.get(def.name);
    if (going) return going;
    const p = (async (): Promise<RemoteReading> => {
      const iso = new Date(t).toISOString();
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 8000);
        let res;
        try {
          res = await doFetch(def.url, { signal: ctl.signal, headers: { accept: "application/json" } });
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as Record<string, unknown>;
        if (!body || typeof body !== "object" || body.schema !== def.schema) throw new Error(`not ${def.schema}`);
        const r = { body, readAt: iso, at: typeof body.at === "string" ? body.at : null, triedAt: t };
        held.set(def.name, r);
        return r;
      } catch (e) {
        const r = { body: prev?.body ?? null, readAt: prev?.readAt ?? null, at: prev?.at ?? null, failedAt: prev?.failedAt ?? iso, error: e instanceof Error ? e.message : String(e), triedAt: t };
        held.set(def.name, r);
        return r;
      } finally {
        inflight.delete(def.name);
      }
    })();
    inflight.set(def.name, p);
    return p;
  }

  return {
    /** The readings of the named sources (each `<name>#<field>` id names its source). */
    async readings(ids: Iterable<string>): Promise<Record<string, RemoteReading>> {
      const names = new Set<string>();
      for (const id of ids) {
        const s = remoteSourceOf(id);
        if (s) names.add(s.def.name);
      }
      const out: Record<string, RemoteReading> = {};
      await Promise.all([...names].map(async (n) => (out[n] = await read(REMOTE_SOURCES[n]))));
      return out;
    },
  };
}
export type RemoteCounts = ReturnType<typeof createRemoteCounts>;

/** One count as a page shows it: the number (null when never read), where it came from, when it was read. */
export interface LiveCount {
  label: string;
  /** `<source>#<field>`. */
  source: string;
  value?: number | null;
  sourceText?: string;
  note?: string;
  page?: SiteWhere;
}

/** The counts with their numbers read now (each remote source at most once an hour; a failed read says so). */
export async function readCounts(counts: { label: string; source: string }[], remote: RemoteCounts): Promise<LiveCount[]> {
  const known = counts.filter((c) => remoteSourceOf(c.source));
  if (!known.length) return [];
  const got = await remote.readings(known.map((c) => c.source));
  return known.map((c) => {
    const src = remoteSourceOf(c.source)!;
    const r = got[src.def.name];
    const note = r?.failedAt ? `not answering since ${hm(r.failedAt)}${r.readAt ? `, last good reading ${hm(r.readAt)}` : ""}` : r?.readAt ? `read ${hm(r.readAt)}` : undefined;
    return { ...c, value: remoteValue(c.source, r), sourceText: remoteSourceText(c.source, r), ...(note ? { note } : {}), page: src.def.page };
  });
}

/** the live page of the repo a book is about, its counts read now; undefined for a repo with none. */
export async function bookLivePage(repo: string | undefined, remote: RemoteCounts): Promise<{ link: BookLivePage["link"]; counts: LiveCount[] } | undefined> {
  const p = repo ? BOOK_LIVE_PAGES.find((x) => x.repos.some((r) => sameRepo(r, repo))) : undefined;
  return p && { link: p.link, counts: await readCounts(p.counts, remote) };
}

/** The console's shared cache (one per process). */
export const remoteCounts = createRemoteCounts();
