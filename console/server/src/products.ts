import fs from "node:fs";
import path from "node:path";
import { resolveRepo } from "./adapters/repos.js";
import { homeRepo } from "./identity.js";
import { parseProduct } from "./social/motionCompute.js";
import { readKit, readKitFile, type PursuitKitBody, type PursuitKitRef, type PursuitsBody } from "./pursuits.js";

/**
 * Products, each defined once (the owner: "does the social kit belong there? Or is the social kit more like it belongs
 * to like a product or a brand"). The one list of products is the home repo's
 * docs/scorecard/products.json (the scorecard and the company map read it too); a product there names its deck (the
 * product deck in its campaign repo, `data/product.md`: why it exists, who it is for, how it works, what it does for
 * you) and its social kit (a folder of the home repo). Nothing is copied: the page reads the deck and the kit as they
 * are, and each objective (docs/pursuits.json) names its product with `product`, so several objectives share one.
 */
export const PRODUCTS_FILE = "docs/scorecard/products.json";

export interface ProductRef {
  id: string;
  name: string;
  group?: string;
  url?: string;
  /** its product deck, a file in another repo checkout (read only). */
  deck?: { repo: string; path: string };
  kit?: PursuitKitRef;
}

/** The deck parts the Products page shows, in his order (his words: benefits, problems it solves, how it works, target audience). */
export const PRODUCT_DEF_PARTS: { part: string; label: string }[] = [
  { part: "Why it exists", label: "The problem it solves" },
  { part: "Who it is for", label: "Who it is for" },
  { part: "How it works", label: "How it works" },
  { part: "What it does for you", label: "What it does for you" },
];

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const SAFE_REL = (p: string | undefined) => !!p && /^[\w./-]+$/.test(p) && !p.includes("..") && !p.startsWith("/");

export function parseProducts(text: string): ProductRef[] {
  let doc: Record<string, unknown>;
  try {
    doc = obj(JSON.parse(text));
  } catch {
    return [];
  }
  const seen = new Set<string>();
  return (Array.isArray(doc.products) ? doc.products : []).flatMap((p): ProductRef[] => {
    const o = obj(p);
    const id = str(o.id);
    const name = str(o.name);
    if (!id || !name || !/^[\w-]+$/.test(id) || seen.has(id)) return [];
    seen.add(id);
    const d = obj(o.deck);
    const deck = str(d.repo) && SAFE_REL(str(d.path)) && /^[\w.-]+$/.test(str(d.repo)!) ? { repo: str(d.repo)!, path: str(d.path)! } : undefined;
    const k = obj(o.kit);
    const files = str(k.files);
    const kit = SAFE_REL(str(k.dir)) ? { dir: str(k.dir)!, ...(files && /^https?:\/\//.test(files) ? { files } : {}) } : undefined;
    const url = str(o.url);
    return [{ id, name, ...(str(o.group) ? { group: str(o.group) } : {}), ...(url && /^https?:\/\//.test(url) ? { url } : {}), ...(deck ? { deck } : {}), ...(kit ? { kit } : {}) }];
  });
}

/** The products of a home repo checkout; none when the file is missing or bad. */
export function productsIn(home: string): ProductRef[] {
  try {
    return parseProducts(fs.readFileSync(path.join(home, PRODUCTS_FILE), "utf8"));
  } catch {
    return [];
  }
}

/** The deck's own source marks ([home], [connect], [README]) are for the personas; the page leaves them out. */
/** The deck's slide lines (Stat:, Screen:, Features:) draw the slides; the page shows the words only. */
const unmark = (s: string) =>
  s
    .replace(/^(Stat|Screen|Features):.*$/gm, "")
    .replace(/ ?\[[^\]\n]+\](?!\()/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/\s+/g, "-");

/**
 * A part that only points elsewhere ("Read them there. They are not copied here") shows what it points at: the linked
 * section of a file beside the deck. A table with a Benefit column becomes one line per benefit (what you get, then
 * what it does), the way the deck reads; a line not working today says so.
 */
export function followPart(body: string, readBeside: (file: string) => string | undefined): { body: string; from?: string } {
  const m = /\]\(([\w.-]+\.md)#([\w-]+)\)/.exec(body);
  if (!m || body.length > 400) return { body };
  const text = readBeside(m[1]);
  if (!text) return { body };
  const clean = text.replace(/<!--[\s\S]*?-->/g, "");
  const sec = clean.split(/^## /m).slice(1).find((p) => slug(p.slice(0, p.indexOf("\n"))) === m[2]);
  if (!sec) return { body };
  const lines = sec.split("\n").slice(1);
  const rows = lines.filter((l) => /^\|.*\|\s*$/.test(l.trim())).map((l) => l.trim().slice(1, -1).split("|").map((c) => c.trim()));
  const head = rows[0]?.map((h) => h.toLowerCase()) ?? [];
  const bi = head.indexOf("benefit");
  const wi = head.indexOf("what it does");
  const si = head.indexOf("status");
  const from = `${m[1]}#${m[2]}`;
  if (bi >= 0) {
    const out = rows
      .slice(1)
      .filter((r) => !r.every((c) => /^-*:?-+:?$/.test(c) || !c))
      .map((r) => `- **${r[bi]}**${wi >= 0 && r[wi] ? ` ${r[wi]}` : ""}${si >= 0 && r[si] && !/works today/i.test(r[si]) ? ` (${r[si]})` : ""}`);
    if (out.length) return { body: out.join("\n"), from };
  }
  return { body: lines.join("\n").trim(), from };
}

export interface ProductPart {
  part: string;
  label: string;
  /** Markdown, as the deck holds it (source marks left out). */
  body: string;
  /** the file the words were read from when the part points elsewhere (brief.md#benefits). */
  from?: string;
}
export interface ProductView {
  id: string;
  name: string;
  group?: string;
  url?: string;
  tagline?: string;
  accent?: string;
  deck?: { repo: string; path: string; title: string | null; parts: ProductPart[]; missing: string[] };
  kit: boolean;
  /** the objectives that name it, in his order: several can share one product. */
  wheels: { id: string; name: string; state: string; greens: number; total: number; rank: number | null; parked?: boolean }[];
}
export interface ProductsBody {
  products: ProductView[];
}
/** GET /api/products/<id>/kit: the product's kit, the same body as an objective's (its file links use the product). */
export type ProductKitBody = Omit<PursuitKitBody, "pursuit"> & { product: { id: string; name: string } };

/** A product shown on the Products page: one with a deck, a kit or an objective naming it. */
export function productView(p: ProductRef, o: { deckText?: string; readBeside: (file: string) => string | undefined; kit?: Record<string, unknown> | null; pursuits?: PursuitsBody }): ProductView {
  const page = obj(o.kit?.page);
  const tagline = str(o.kit?.tagline);
  const accent = str(page.accent);
  const wheels = (o.pursuits?.pursuits ?? [])
    .filter((w) => w.product?.id === p.id)
    .map((w) => ({ id: w.id, name: w.name, state: w.state, greens: w.greens, total: w.total, rank: w.rank, ...((w as { parked?: boolean }).parked ? { parked: true } : {}) }));
  let deck: ProductView["deck"];
  if (p.deck) {
    const parsed = parseProduct(o.deckText ?? null, p.deck.path, PRODUCT_DEF_PARTS.map((x) => x.part));
    const parts = PRODUCT_DEF_PARTS.flatMap(({ part, label }) => {
      const s = parsed.slides.find((x) => x.title.toLowerCase() === part.toLowerCase());
      if (!s) return [];
      const f = followPart(unmark(s.body), o.readBeside);
      return [{ part, label, body: f.body, ...(f.from ? { from: f.from } : {}) }];
    });
    deck = { repo: p.deck.repo, path: p.deck.path, title: parsed.title, parts, missing: parsed.missing };
  }
  return {
    id: p.id,
    name: p.name,
    ...(p.group ? { group: p.group } : {}),
    ...(p.url ? { url: p.url } : {}),
    ...(tagline ? { tagline } : {}),
    ...(accent && /^#[0-9a-f]{3,8}$/i.test(accent) ? { accent } : {}),
    ...(deck ? { deck } : {}),
    kit: !!o.kit,
    wheels,
  };
}

/** Reads the products file, each product's deck (another repo checkout) and kit; the objectives come from the pursuits reader. */
export function createProducts(o: { reposRoot: string; pursuits: () => Promise<PursuitsBody>; home?: string }) {
  const repoDir = (name: string) => resolveRepo(o.reposRoot, name)?.path;
  const home = () => repoDir(o.home ?? homeRepo());
  const refs = () => {
    const h = home();
    return h ? { root: h, list: productsIn(h) } : null;
  };
  const read = (repo: string, rel: string) => {
    const dir = repoDir(repo);
    if (!dir || rel.includes("..")) return undefined;
    try {
      return fs.readFileSync(path.join(dir, rel), "utf8");
    } catch {
      return undefined;
    }
  };
  const view = (root: string, p: ProductRef, pursuits: PursuitsBody | undefined) =>
    productView(p, {
      deckText: p.deck ? read(p.deck.repo, p.deck.path) : undefined,
      readBeside: (file) => (p.deck ? read(p.deck.repo, path.posix.join(path.posix.dirname(p.deck.path), file)) : undefined),
      kit: p.kit ? readKit(root, p.kit) : null,
      pursuits,
    });
  return {
    /** every defined product: one with a deck, a kit or an objective naming it, in the file's order. */
    async list(): Promise<ProductsBody> {
      const r = refs();
      if (!r) return { products: [] };
      const pursuits = await o.pursuits().catch(() => undefined);
      return { products: r.list.map((p) => view(r.root, p, pursuits)).filter((v) => v.deck || v.kit || v.wheels.length) };
    },
    async one(id: string): Promise<ProductView | null> {
      const r = refs();
      const p = r?.list.find((x) => x.id === id);
      if (!r || !p) return null;
      return view(r.root, p, await o.pursuits().catch(() => undefined));
    },
    kit(id: string): ProductKitBody | null {
      const r = refs();
      const p = r?.list.find((x) => x.id === id);
      if (!r || !p?.kit) return null;
      const kit = readKit(r.root, p.kit);
      return kit ? { product: { id: p.id, name: p.name }, kit, ...(p.kit.files ? { files: p.kit.files } : {}) } : null;
    },
    kitFile(id: string, kind: "previews" | "fonts", name: string) {
      const r = refs();
      const p = r?.list.find((x) => x.id === id);
      return r && p?.kit ? readKitFile(r.root, p.kit, kind, name) : null;
    },
  };
}
