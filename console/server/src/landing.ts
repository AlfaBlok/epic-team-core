import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import { credentialWorld } from "./auth/identity.js";
import { DEFAULT_TENANT } from "./db.js";
import { memoryName } from "./identity.js";
import type { SpineWriter } from "./inbox/spineWrite.js";

/**
 * the landing reports of the owner's voice notes at one stable console URL, /landing/. The pages
 * live in the code repo repo (docs/landing/, written by docs/landing/build.py from its JSON data), so a new report or a
 * score goes live with a commit and the checkout's pull, no deploy (L-45: the repo is the only source). They quote his
 * private voice notes: the home world only, another world's login gets a 404 like any other world's path.
 */
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
};

/**
 * the console page that frames a /landing/ page (web pages/GoalGraph.tsx consolePathOf): the goal graph
 * reports under /goal-graph, his the memory service memory's branches at /memory-memory. Undefined for a page the console does not frame.
 */
export function consolePathOf(landingPath: string): string | undefined {
  const p = landingPath.replace(/\/index\.html$/, "/");
  if (p === "/landing/" || p === "/landing") return "/goal-graph";
  if (p === "/landing/memory/") return `/${memoryName().toLowerCase().replace(/[^a-z0-9]+/g, "-")}-memory`;
  // the Gap finder's runs open under its main-menu page (web pages/GapFinder.tsx gapFinderPathOf).
  if (p === "/landing/gap-finder/") return "/gap-finder";
  const g = p.match(/^\/landing\/gap-finder\/(\d{4}-\d{2}-\d{2})\.html$/);
  if (g) return `/gap-finder/${g[1]}`;
  const m = p.match(/^\/landing\/notes\/([\w-]{1,80})\.html$/);
  return m ? `/goal-graph/notes/${m[1]}` : undefined;
}

export function mountLanding(app: Hono, dir: () => string | undefined): void {
  const serve = (rel: string) => {
    const root = dir();
    if (!root) return undefined;
    const base = path.resolve(root);
    // a folder path (ending in /) serves that folder's index.html, so /landing/proposals/ and /landing/gap-finder/ open.
    const file = path.resolve(base, "." + (rel === "" ? "/index.html" : rel.endsWith("/") ? `${rel}index.html` : rel));
    if (!(file.startsWith(base + path.sep)) || !TYPES[path.extname(file).toLowerCase()]) return undefined;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return undefined;
    return { body: fs.readFileSync(file), type: TYPES[path.extname(file).toLowerCase()] };
  };
  app.get("/landing", (c) => c.redirect("/landing/", 302));
  app.get("/landing/*", (c) => {
    const world = credentialWorld();
    if (world && world !== DEFAULT_TENANT) return c.text("not found", 404);
    let rel: string;
    try {
      rel = decodeURIComponent(c.req.path.slice("/landing".length));
    } catch {
      return c.text("bad path", 400);
    }
    const f = serve(rel);
    if (!f) return c.text("not found", 404);
    // opened directly (a tab, an old link), a framed page opens inside
    // the console, under the header saying which memory it shows; the console's frame (Sec-Fetch-Dest: iframe) and
    // agents (no header) get the file.
    const inConsole = c.req.header("sec-fetch-dest") === "document" ? consolePathOf(c.req.path) : undefined;
    if (inConsole) return c.redirect(inConsole, 302);
    return c.body(f.body as Uint8Array<ArrayBuffer>, 200, { "Content-Type": f.type, "Cache-Control": "no-cache" });
  });
}

/**
 * the owner marks a node of a landing report "wrong place" right on its tree (and may say where it belongs),
 * or says the rest of the tree is right. Each tap is one commit of docs/landing/marks/<note>.json in the code repo repo
 * (L-45: the repo, never the console's DB, holds his corrections); build.py reads the file into the weekly measure, and
 * the page reads it back through GET /landing/marks/<note>.json.
 */
export const MARKS_DIR = "docs/landing/marks";
const BELONGS_MAX = 200;
export type Mark = { verdict: "wrong"; belongs?: string; at: string; by: string };
export interface MarksFile {
  note: string;
  reviewed: { at: string; by: string } | null;
  marks: Record<string, Mark>;
}
export type MarkInput = { n?: number; verdict: "wrong" | "clear" | "reviewed" | "unreviewed"; belongs?: string };

/** The marks file after one tap (pure: the route and the tests share it). */
export function applyMark(text: string, note: string, m: MarkInput, at: string, by: string): MarksFile {
  let cur: MarksFile = { note, reviewed: null, marks: {} };
  try {
    const j = JSON.parse(text || "{}") as Partial<MarksFile>;
    cur = { note, reviewed: j.reviewed ?? null, marks: j.marks && typeof j.marks === "object" ? j.marks : {} };
  } catch {
    /* an unreadable file starts again empty (git keeps the old one) */
  }
  if (m.verdict === "reviewed") cur.reviewed = { at, by };
  else if (m.verdict === "unreviewed") cur.reviewed = null;
  else if (m.verdict === "clear") delete cur.marks[String(m.n)];
  else cur.marks[String(m.n)] = { verdict: "wrong", ...(m.belongs ? { belongs: m.belongs } : {}), at, by };
  const sorted: Record<string, Mark> = {};
  for (const k of Object.keys(cur.marks).sort((a, b) => Number(a) - Number(b))) sorted[k] = cur.marks[k];
  return { ...cur, marks: sorted };
}

export function mountLandingMarks(api: Hono, o: { writer?: SpineWriter; repo: () => string | undefined; who: () => string; wrote?: (dir: string) => void }): void {
  api.post("/landing/marks/:note", async (c) => {
    const world = credentialWorld();
    if (world && world !== DEFAULT_TENANT) return c.json({ error: { code: "not_found", message: "no such report" } }, 404);
    const note = c.req.param("note");
    if (!/^[\w-]{1,80}$/.test(note)) return c.json({ error: { code: "bad_note", message: "not a report id" } }, 400);
    const dir = o.repo();
    if (!dir || !o.writer) return c.json({ error: { code: "no_spine_writer", message: "the console cannot write the repo here; nothing saved" } }, 503);
    const dataFile = path.join(dir, "docs", "landing", "data", `${note}.json`);
    if (!fs.existsSync(dataFile)) return c.json({ error: { code: "not_found", message: `no landing report ${note}` } }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Partial<MarkInput>;
    const verdict = body.verdict;
    if (!verdict || !["wrong", "clear", "reviewed", "unreviewed"].includes(verdict)) return c.json({ error: { code: "bad_verdict", message: "verdict is wrong, clear, reviewed or unreviewed" } }, 400);
    let n: number | undefined;
    if (verdict === "wrong" || verdict === "clear") {
      n = Number(body.n);
      const items = (JSON.parse(fs.readFileSync(dataFile, "utf8")) as { items?: { n: number }[] }).items ?? [];
      if (!Number.isInteger(n) || !items.some((i) => i.n === n)) return c.json({ error: { code: "bad_item", message: `no item ${body.n} in ${note}` } }, 400);
    }
    const belongs = typeof body.belongs === "string" ? body.belongs.replace(/\s+/g, " ").trim().slice(0, BELONGS_MAX) : undefined;
    const by = o.who();
    const rel = `${MARKS_DIR}/${note}.json`;
    let saved: MarksFile | undefined;
    const what = verdict === "wrong" ? `item ${n} wrong place${belongs ? ` (belongs: ${belongs})` : ""}` : verdict === "clear" ? `item ${n} back to right place` : verdict === "reviewed" ? "the rest of the tree is right" : "tree not reviewed yet";
    const w = await o.writer.edit({
      repoDir: dir,
      path: rel,
      label: `landing report ${note}`,
      verify: false,
      fetchFreshMs: 30_000,
      edit: (text) => {
        saved = applyMark(text, note, { n, verdict, ...(belongs ? { belongs } : {}) }, new Date().toISOString(), by);
        const out = JSON.stringify(saved, null, 1) + "\n";
        return out === text ? { skip: "already saved" } : { text: out, msg: `${by} marked ${note}: ${what}`, body: `${by} marked the landing report ${note} from its tree (/landing/notes/${note}.html): ${what}. Read by docs/landing/build.py into the weekly measure.` };
      },
    });
    if (w.status === "skipped" && w.reason === "already saved") return c.json({ ok: true, marks: saved });
    if (w.status !== "written") return c.json({ error: { code: w.status === "skipped" ? "write_skipped" : "write_failed", message: `not saved: ${w.reason ?? "unknown"}` } }, w.status === "skipped" ? 409 : 502);
    o.wrote?.(dir);
    return c.json({ ok: true, marks: saved, ...(w.sha ? { sha: w.sha } : {}) });
  });
}
