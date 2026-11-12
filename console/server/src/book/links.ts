import type { Book } from "./build.js";
import { hostOf, sites } from "../identity.js";
import { isTailnet, urlKey, type Deliverable, type LinkCheck } from "./deliverables.js";

/**
 * does each deliverable still answer? Checked in the background (never on a request), at most
 * every `ttlMs` per URL, a few at a time, and kept in memory: a restart re-checks within one tick. A tailnet preview that
 * refuses or times out is "not running" (the book names its folder so it can be served again); another page that is
 * gone (404/410) or unreachable is marked, never dropped. The console's own hosts are not fetched (they answer while the
 * console does, and a tokenless call to them would only add noise to the auth log); repo files are checked on disk at
 * build time (book/deliverables.ts).
 */
export const LINK_TTL_MS = 6 * 3600_000;
/** the console's own sites (the sites config: its team and social addresses) */
const isSelf = (url: string): boolean => {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === hostOf(sites().teamUrl) || h === hostOf(sites().socialUrl);
  } catch {
    return false;
  }
};

export type Fetcher = (url: string, init: { method: string; signal: AbortSignal; redirect: "follow" }) => Promise<{ status: number }>;

export function createLinkChecker(o: { fetch?: Fetcher; now?: () => number; ttlMs?: number; timeoutMs?: number; concurrency?: number; log?: (m: string) => void } = {}) {
  const fetcher: Fetcher = o.fetch ?? ((u, init) => fetch(u, init));
  const now = o.now ?? Date.now;
  const ttlMs = o.ttlMs ?? LINK_TTL_MS;
  const timeoutMs = o.timeoutMs ?? 8_000;
  const concurrency = o.concurrency ?? 4;
  const results = new Map<string, LinkCheck & { ms: number }>();
  let running: Promise<number> | undefined;

  const checkOne = async (url: string): Promise<LinkCheck> => {
    const at = new Date(now()).toISOString();
    const tailnet = isTailnet(url);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      let r = await fetcher(url, { method: "HEAD", signal: ctl.signal, redirect: "follow" });
      // Some servers refuse HEAD; ask once with GET before calling a page gone.
      if (r.status === 405 || r.status === 501 || r.status === 403) r = await fetcher(url, { method: "GET", signal: ctl.signal, redirect: "follow" });
      if (r.status === 404 || r.status === 410) return { state: "gone", at, detail: `HTTP ${r.status}` };
      if (r.status >= 500) return { state: tailnet ? "not running" : "down", at, detail: `HTTP ${r.status}` };
      return { state: "ok", at, detail: `HTTP ${r.status}` };
    } catch (e) {
      const why = ctl.signal.aborted ? `no answer in ${Math.round(timeoutMs / 1000)} s` : ((e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message);
      return { state: tailnet ? "not running" : "down", at, detail: String(why) };
    } finally {
      clearTimeout(t);
    }
  };

  const due = (url: string) => !isSelf(url) && /^https?:\/\//i.test(url) && now() - (results.get(urlKey(url))?.ms ?? -Infinity) >= ttlMs;

  return {
    /** The last check of a URL, if any. */
    get(url: string): LinkCheck | undefined {
      const r = results.get(urlKey(url));
      return r ? { state: r.state, at: r.at, ...(r.detail ? { detail: r.detail } : {}) } : undefined;
    },
    /** Check the URLs that are due (one run at a time); resolves to how many were checked. */
    run(urls: string[]): Promise<number> {
      if (running) return running;
      const todo = [...new Map(urls.filter(due).map((u) => [urlKey(u), u])).values()];
      if (!todo.length) return Promise.resolve(0);
      running = (async () => {
        let i = 0;
        const worker = async () => {
          while (i < todo.length) {
            const u = todo[i++];
            const c = await checkOne(u);
            results.set(urlKey(u), { ...c, ms: now() });
          }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
        return todo.length;
      })().finally(() => {
        running = undefined;
      });
      return running;
    },
    size: () => results.size,
  };
}

export type LinkChecker = ReturnType<typeof createLinkChecker>;

/** Every URL in the book's "everything made" lists (repo files are checked at build time, not here). */
export function bookUrls(book: Book): string[] {
  return book.repos.flatMap((r) => r.epics.flatMap((e) => (e.made ?? []).filter((d) => !d.check && !/^https:\/\/github\.com\//i.test(d.url)).map((d) => d.url)));
}

/** A deliverable with its last check (a build-time "gone" for a missing repo file wins). */
export const withCheck = (d: Deliverable, links?: Pick<LinkChecker, "get">): Deliverable => {
  if (d.check || !links) return d;
  const c = links.get(d.url);
  return c ? { ...d, check: c } : d;
};

/** The book with every deliverable's last check attached (a new object; the stored book is untouched). */
export function bookWithChecks(book: Book, links?: Pick<LinkChecker, "get">): Book {
  if (!links) return book;
  return { ...book, repos: book.repos.map((r) => ({ ...r, epics: r.epics.map((e) => (e.made?.length ? { ...e, made: e.made.map((d) => withCheck(d, links)) } : e)) })) };
}
