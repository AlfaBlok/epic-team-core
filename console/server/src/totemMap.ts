import { repoKey } from "./adapters/repoNames.js";
import fs from "node:fs";
import path from "node:path";
import { homeRepo } from "./identity.js";
import { parsePursuits, PURSUITS_FILE } from "./pursuits.js";

/**
 * Root L-77 (the owner, 2026-11-16: "we also tell the personas, here
 * is like a map of all the things that you should use to create your context when you start and that you should use to
 * dump your context at the end. And we have like these totems ... nodes in the graph, which are not arbitrarily created
 * by the epics, but rather ... hard-coded, and they're part of the personas' instructions ... they have oftentimes a
 * dedicated tab on the UX").
 *
 * The map is data, one file per product in the home repo's docs/totems/ (<product>.json) plus every-product.json (what
 * every product has). This module reads it for three readers, never a second copy:
 * - every wake prompt carries `mapSection` for the milestone's product (read these totems first, write back last);
 * - every worker brief carries MAP_RULE (the same map by `scripts/totems.py for <repo>`);
 * - the objective screen shows each totem as a tab (`GET /api/totems/:product/:totem`), an empty one shown empty.
 */

export const TOTEMS_DIR = "docs/totems";
export const EVERY_FILE = "every-product.json";

export type TotemShape = "page" | "table" | "tree";
export interface TotemLives {
  repo?: string;
  path?: string;
  /** a `## <section>` of a markdown file: only that part is the totem. */
  section?: string;
  /** a product's launch board lights (scripts/launch_board.py's product id). */
  board?: string;
  /** no file: where it is in words (or why there is none yet). */
  note?: string;
  /**
   * the objective's plan: resolved from the `plan` entry of the product's objectives in the objectives file (the one
   * source the Plan tab reads too), to that campaign spine's `## Plan` section; none named: a note, shown empty.
   */
  plan?: boolean;
}
export interface Totem {
  id: string;
  name: string;
  shape: TotemShape;
  /** its tab on the objective screen (an existing tab id such as `plan`, `kit`, `table`, or its own). */
  tab: string;
  lives: TotemLives;
  /** where it shows live outside the console, when it does. */
  live?: string;
  read?: string;
  write?: string;
}
export interface Grows {
  name: string;
  from: string;
  lives: string;
}
export interface ProductMap {
  product: string;
  name: string;
  line?: string;
  repos: string[];
  objectives: string[];
  his?: string;
  /** its place in the list (the owner's order of his objectives); none: after the ordered ones. */
  order?: number;
  totems: Totem[];
  grows: Grows[];
}
export interface TotemMaps {
  statement: string;
  every: { totems: Totem[]; grows: Grows[] };
  products: ProductMap[];
}

const SHAPES = new Set(["page", "table", "tree"]);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const safePath = (p: string | undefined) => (p && !p.includes("..") && !p.startsWith("/") ? p : undefined);

function parseTotem(v: unknown): Totem[] {
  const o = obj(v);
  const id = str(o.id), name = str(o.name), shape = str(o.shape), tab = str(o.tab);
  if (!id || !name || !shape || !SHAPES.has(shape) || !tab || !/^[\w-]+$/.test(id) || !/^[\w-]+$/.test(tab)) return [];
  const l = obj(o.lives);
  const lives: TotemLives = {
    ...(str(l.repo) && /^[\w.-]+$/.test(str(l.repo)!) ? { repo: str(l.repo) } : {}),
    ...(safePath(str(l.path)) ? { path: safePath(str(l.path)) } : {}),
    ...(str(l.section) ? { section: str(l.section) } : {}),
    ...(str(l.board) ? { board: str(l.board) } : {}),
    ...(str(l.note) ? { note: str(l.note) } : {}),
    ...(l.plan ? { plan: true } : {}),
  };
  return [{ id, name, shape: shape as TotemShape, tab, lives, ...(str(o.live) ? { live: str(o.live) } : {}), ...(str(o.read) ? { read: str(o.read) } : {}), ...(str(o.write) ? { write: str(o.write) } : {}) }];
}
const parseGrows = (v: unknown): Grows[] =>
  arr(v).flatMap((g) => {
    const o = obj(g);
    const name = str(o.name);
    return name ? [{ name, from: str(o.from) ?? "", lives: str(o.lives) ?? "" }] : [];
  });

/** a product file's text → its map (null when it is not one). */
export function parseProductMap(text: string): ProductMap | null {
  let o: Record<string, unknown>;
  try {
    o = obj(JSON.parse(text));
  } catch {
    return null;
  }
  const product = str(o.product), name = str(o.name);
  if (!product || !name || !/^[\w-]+$/.test(product)) return null;
  return {
    product,
    name,
    ...(str(o.line) ? { line: str(o.line) } : {}),
    repos: arr(o.repos).flatMap((r) => (str(r) ? [str(r)!] : [])),
    objectives: arr(o.objectives).flatMap((r) => (str(r) ? [str(r)!] : [])),
    ...(str(o.his) ? { his: str(o.his) } : {}),
    ...(typeof o.order === "number" ? { order: o.order } : {}),
    totems: arr(o.totems).flatMap(parseTotem),
    grows: parseGrows(o.grows),
  };
}

/** Product order: each file's `order` (the owner's order of his objectives), then by name. */

/** every map in `<home>/docs/totems/`; none (no dir) → no products. */
export function readMaps(homeDir: string | undefined): TotemMaps {
  const empty: TotemMaps = { statement: "", every: { totems: [], grows: [] }, products: [] };
  if (!homeDir) return empty;
  const dir = path.join(homeDir, TOTEMS_DIR);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return empty;
  }
  let every = empty.every, statement = "";
  const products: ProductMap[] = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    if (f === EVERY_FILE) {
      try {
        const o = obj(JSON.parse(text));
        statement = str(o.statement) ?? "";
        every = { totems: arr(o.totems).flatMap(parseTotem), grows: parseGrows(o.grows) };
      } catch {
        /* a broken shared file: products still read */
      }
      continue;
    }
    const m = parseProductMap(text);
    if (m) products.push(m);
  }
  products.sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.name.localeCompare(b.name));
  // a plan totem: where its objective's `plan` entry points (one source with the Plan tab), never a copy in the map file
  let plans = new Map<string, { repo: string; path: string }>();
  try {
    plans = new Map(parsePursuits(fs.readFileSync(path.join(homeDir, PURSUITS_FILE), "utf8")).pursuits.flatMap((p) => (p.plan ? [[p.id, p.plan] as const] : [])));
  } catch {
    /* no objectives file: plan totems stay unnamed */
  }
  for (const p of products)
    p.totems = p.totems.map((t) => {
      if (!t.lives.plan) return t;
      const at = p.objectives.map((o) => plans.get(o)).find(Boolean);
      return { ...t, lives: at ? { repo: at.repo, path: at.path, section: "Plan", plan: true } : { note: "no plan named yet (its objective has no plan entry in docs/pursuits.json)", plan: true } };
    });
  return { statement, every, products };
}

/** the product whose map holds this objective, else the first whose repos hold the milestone's repo. */
export function productFor(maps: TotemMaps, o: { objective?: string; repo?: string }): ProductMap | undefined {
  return (o.objective ? maps.products.find((p) => p.objectives.includes(o.objective!)) : undefined) ?? (o.repo ? maps.products.find((p) => p.repos.some((r) => sameRepoName(r, o.repo!))) : undefined);
}

/** a milestone names its repo in full (`Owner/name`, the renamed name too), the map files and the objectives
 * file by its short name: the same repo either way. Compared letter for letter, no wake prompt ever got its map. */
export function sameRepoName(a: string, b: string): boolean {
  return repoKey(a.split("/").pop()!) === repoKey(b.split("/").pop()!);
}

const whereOf = (t: Totem): string =>
  t.lives.board
    ? `launch board lights of ${t.lives.board} (GET /api/launch-board)`
    : t.lives.repo && t.lives.path
    ? `${t.lives.repo} ${t.lives.path}${t.lives.section ? ` § ${t.lives.section}` : ""}${t.lives.plan ? " (its objective's plan entry in docs/pursuits.json)" : ""}`
    : t.lives.note ?? "not placed yet";

export const MAP_HEAD = "## The map: read these totems first, write back into them last (root L-77)";

/**
 * the wake prompt's map section for one product: its hardwired totems and where each lives, what to read, what to write,
 * and what grows from his words. A product with no map file: nothing (the section is left out).
 */
export function mapSection(maps: TotemMaps, p: ProductMap | undefined): string {
  if (!p) return "";
  const line = (t: Totem) => `- ${t.name} (${t.shape}, tab ${t.tab}): ${whereOf(t)}${t.read ? `. Read: ${t.read}` : ""}${t.write ? `. Write back: ${t.write}` : ""}.`;
  return [
    MAP_HEAD,
    maps.statement || "Each product's data graph is the known map its personas read from at the start and write back to at the end.",
    `This milestone is ${p.name}'s. Start: read every totem below that touches your step (an empty one is a gap: name it). ` +
      "End: write what you learned or changed back into the totem it belongs to (a section, a row, a line), in the same commit as your work; another world's totem gets a desk note, never an edit.",
    `${p.name}'s totems (hardwired: they always exist, each is a tab on its objective's screen):`,
    ...p.totems.map(line),
    "Every product's totems:",
    ...maps.every.totems.map(line),
    `What grows from his words: ${[...maps.every.grows, ...p.grows].map((g) => `${g.name} (${g.lives})`).join("; ")}.`,
  ].join("\n");
}

/** the worker brief's rule: one line, the same map by its script (the brief is plain text, its row's product varies). */
export const MAP_RULE =
  `Read the map before you plan, write back into it when you finish (root L-77): \`python3 ~/github/${homeRepo()}/scripts/totems.py for <your row's repo>\` prints your product's totems ` +
  "(the hardwired nodes of its data graph: marketing plan, pricing, launch board and the others, each with where it lives and its tab). Read the ones your step touches first; " +
  "at the end write what you learned or changed back into the totem it belongs to, in the same commit (another world's totem: a desk note, never an edit). A totem that is empty is a gap: say so on your row.";

// ---------- a totem's content, for its tab ----------

export interface TotemView {
  product: string;
  id: string;
  name: string;
  shape: TotemShape;
  where: string;
  live?: string;
  read?: string;
  write?: string;
  /** nothing written there yet (the tab shows it empty, with where it will live). */
  empty: boolean;
  markdown?: string;
  headers?: string[];
  rows?: string[][];
  tree?: { label: string; children: { id: string; label: string; status: string }[] }[];
}

/** the body of `## <heading>` (to the next `## `), or undefined. */
export function sectionOf(md: string, heading: string): string | undefined {
  const lines = md.split("\n");
  const at = lines.findIndex((l) => l.replace(/^##\s+/, "").trim().toLowerCase() === heading.toLowerCase() && /^##\s/.test(l));
  if (at < 0) return undefined;
  const end = lines.findIndex((l, i) => i > at && /^##\s/.test(l));
  return lines.slice(at + 1, end < 0 ? undefined : end).join("\n").trim();
}

/** the first markdown table in a text → headers and rows. */
export function tableOf(md: string): { headers: string[]; rows: string[][] } | undefined {
  const t = md.split("\n").filter((l) => /^\s*\|/.test(l));
  if (t.length < 2) return undefined;
  const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  return { headers: cells(t[0]), rows: t.slice(2).map(cells) };
}

export function csvOf(text: string): { headers: string[]; rows: string[][] } {
  const row = (l: string) => {
    const out: string[] = [];
    let cur = "", q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      else if (ch === "," && !q) (out.push(cur), (cur = ""));
      else cur += ch;
    }
    out.push(cur);
    return out.map((c) => c.trim());
  };
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  return { headers: lines.length ? row(lines[0]) : [], rows: lines.slice(1).map(row) };
}

const MAX_ROWS = 200;

export function totemView(o: {
  maps: TotemMaps;
  product: string;
  totem: string;
  repoDir: (repo: string) => string | undefined;
  board?: () => { products: { id: string; lights: { label: string; state: string; fix?: string }[] }[] } | null;
}): TotemView | null {
  const p = o.maps.products.find((x) => x.product === o.product);
  const t = p?.totems.find((x) => x.id === o.totem) ?? (p ? o.maps.every.totems.find((x) => x.id === o.totem) : undefined);
  if (!p || !t) return null;
  const base: TotemView = { product: p.product, id: t.id, name: t.name, shape: t.shape, where: whereOf(t), ...(t.live ? { live: t.live } : {}), ...(t.read ? { read: t.read } : {}), ...(t.write ? { write: t.write } : {}), empty: true };
  if (t.lives.board) {
    const b = o.board?.()?.products.find((x) => x.id === t.lives.board);
    if (!b) return base;
    return { ...base, empty: !b.lights.length, headers: ["Light", "State", "What turns it green"], rows: b.lights.map((l) => [l.label, l.state, l.fix ?? ""]) };
  }
  const dir = t.lives.repo ? o.repoDir(t.lives.repo) : undefined;
  if (!dir || !t.lives.path) return base;
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, t.lives.path), "utf8");
  } catch {
    return base;
  }
  const part = t.lives.section ? sectionOf(text, t.lives.section) : text;
  if (part === undefined || !part.trim()) return base;
  if (t.lives.path.endsWith(".csv")) {
    const c = csvOf(part);
    return { ...base, empty: !c.rows.length, headers: c.headers, rows: c.rows.slice(0, MAX_ROWS) };
  }
  if (t.lives.path.endsWith(".json")) {
    let j: Record<string, unknown> = {};
    try {
      j = obj(JSON.parse(part));
    } catch {
      return base;
    }
    // a feature list: groups of features → one row each
    if (Array.isArray(j.groups)) {
      const rows = arr(j.groups).flatMap((g) => arr(obj(g).features).map((f) => [str(obj(g).title) ?? "", str(obj(f).title) ?? "", str(obj(f).text) ?? ""]));
      return { ...base, empty: !rows.length, headers: ["Group", "Feature", "What it does"], rows: rows.slice(0, MAX_ROWS) };
    }
    // the lean core: its kernel and parts as a page
    if (Array.isArray(j.parts)) {
      const md = [
        ...arr(j.kernel).map((k) => `**${str(obj(k).name) ?? ""}**: ${str(obj(k).line) ?? ""}`),
        "",
        ...arr(j.parts).map((k) => `- **${str(obj(k).name) ?? ""}**: ${str(obj(k).what) ?? ""}`),
      ].join("\n");
      return { ...base, empty: false, markdown: md };
    }
    return base;
  }
  if (t.shape === "tree") {
    const tb = tableOf(sectionOf(text, "Issue Ledger") ?? "");
    const title = /^#\s+(.+)$/m.exec(text)?.[1] ?? t.name;
    const children = (tb?.rows ?? []).filter((r) => /^E\d+-S\d+/.test(r[0] ?? "")).map((r) => ({ id: r[0], label: (r[3] ?? "").split(":")[0].slice(0, 140), status: (r[4] ?? "").split(/[ (]/)[0] }));
    return { ...base, empty: !children.length, tree: [{ label: title, children }] };
  }
  if (t.shape === "table") {
    const tb = tableOf(part);
    if (tb) return { ...base, empty: !tb.rows.length, headers: tb.headers, rows: tb.rows.slice(0, MAX_ROWS) };
  }
  return { ...base, empty: false, markdown: part };
}

/** the home repo's directory, for callers that only know the repos root. */
export const homeDirOf = (resolve: (repo: string) => string | undefined) => resolve(homeRepo());
