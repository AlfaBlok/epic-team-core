import type { Hono } from "hono";
import { credentialWorld } from "./auth/identity.js";
import { DEFAULT_TENANT } from "./db.js";
import type { SpineWriter } from "./inbox/spineWrite.js";
import { PAGES_FILE, RESERVED_SLUGS } from "./pagesIndex.js";

/**
 * A pinned page has a short plain name a person understands ("Scorecard", "Engine"), never an
 * epic or row code. The owner pins, renames and unpins a page on the Pages list; each press is one commit to
 * docs/pages/registry.json of the home repo (the repo is the record, root L-45), the same fields `scripts/pages.py pin`
 * writes (`pinned`, `name`, `slug`). The page's own bar (pages.py header) then leads with the name too.
 */

/** an epic, row, learning, voice-note or run code: never in a pinned page's name (scripts/pages.py CODE_RE). */
export const CODE_RE = /\b(?:EPIC-\d+|E\d+-[A-Z]+\d+|[A-Z]{1,4}\d*-[A-Z]?\d+|L\d+|vn_\w+|run_\w+)\b/;
export const NAME_MAX = 40;

/** why `name` cannot be a pinned page's name, or "" when it can. */
export function nameProblem(name: string | undefined): string {
  const n = (name ?? "").trim();
  if (!n) return "a pinned page needs a name";
  if (n.length > NAME_MAX) return `keep the name short: ${NAME_MAX} characters at most`;
  if (CODE_RE.test(n)) return "a name in plain words, never an epic or row code";
  return "";
}

/** a short address from a name: "Server health" -> "server-health" (empty when it would take a console screen's). */
export function slugOf(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return s.length >= 2 && !RESERVED_SLUGS.has(s) ? s : "";
}

export type PinChange = { port?: number; url?: string; pinned: boolean; name?: string };
type Entry = { port?: number; url?: string; name?: string; pinned?: boolean; slug?: string; [k: string]: unknown };

/**
 * the registry text after pinning, renaming or unpinning one page; an Error names why not. A new pin gets a short
 * address from its name when that one is free; a rename keeps the address it has (links already shared keep working).
 */
export function pinText(text: string, ch: PinChange): string {
  const doc = JSON.parse(text) as { pages?: Entry[] };
  const pages = Array.isArray(doc.pages) ? doc.pages : [];
  const p = pages.find((x) => (ch.port !== undefined ? x.port === ch.port : !!ch.url && x.url === ch.url));
  if (!p) throw new Error("that page is not on the list");
  if (!ch.pinned) {
    delete p.pinned;
  } else {
    const name = (ch.name ?? p.name ?? "").trim().replace(/\s+/g, " ");
    const why = nameProblem(name);
    if (why) throw new Error(why);
    p.name = name;
    p.pinned = true;
    if (!p.slug) {
      const s = slugOf(name);
      if (s && !pages.some((x) => x !== p && x.slug === s)) p.slug = s;
    }
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function mountPagePins(api: Hono, o: { writer?: SpineWriter; repo: () => string | undefined; who: () => string }): void {
  api.post("/pages/pin", async (c) => {
    const world = credentialWorld();
    if (world && world !== DEFAULT_TENANT) return c.json({ error: { code: "not_found", message: "no pages here" } }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { port?: unknown; url?: unknown; pinned?: unknown; name?: unknown };
    const port = typeof body.port === "number" && Number.isInteger(body.port) ? body.port : undefined;
    const url = typeof body.url === "string" && body.url.length < 500 ? body.url : undefined;
    if ((port === undefined && !url) || typeof body.pinned !== "boolean" || (body.name !== undefined && typeof body.name !== "string")) {
      return c.json({ error: { code: "bad_pin", message: "port (or url), pinned true or false, and a name to pin" } }, 400);
    }
    const ch: PinChange = { port, url, pinned: body.pinned, name: body.name as string | undefined };
    if (ch.pinned && ch.name !== undefined && nameProblem(ch.name)) return c.json({ error: { code: "bad_name", message: nameProblem(ch.name) } }, 400);
    const dir = o.repo();
    if (!dir || !o.writer) return c.json({ error: { code: "no_spine_writer", message: "the console cannot write the repo here; nothing saved" } }, 503);
    const by = o.who();
    let refused = "";
    const what = !ch.pinned ? "unpinned" : ch.name ? `pinned as "${ch.name.trim()}"` : "pinned";
    const w = await o.writer.edit({
      repoDir: dir,
      path: PAGES_FILE,
      label: `page pin ${port ?? url}`,
      verify: false,
      fetchFreshMs: 30_000,
      edit: (text) => {
        let out: string;
        try {
          out = pinText(text, ch);
        } catch (e) {
          refused = (e as Error).message;
          return { skip: refused };
        }
        return out === text
          ? { skip: "already saved" }
          : { text: out, msg: `${by}: page ${port ? `:${port}` : url} ${what}`, body: `${by} ${what} this page on the console's Pages list; the list, the menu and the page's own bar show the name (scripts/pages.py header).` };
      },
    });
    if (refused) return c.json({ error: { code: "bad_pin", message: refused } }, 400);
    if (w.status === "skipped" && w.reason === "already saved") return c.json({ ok: true });
    if (w.status !== "written") return c.json({ error: { code: w.status === "skipped" ? "write_skipped" : "write_failed", message: `not saved: ${w.reason ?? "unknown"}` } }, w.status === "skipped" ? 409 : 502);
    return c.json({ ok: true, ...(w.sha ? { sha: w.sha } : {}) });
  });
}
