/**
 * a campaign's one
 * deck has to persuade in two minutes, so a product deck slide reads as a claim, big numbers and real screens, not a wall
 * of text. A slide body (one `## ` part of a product.md) splits into:
 *  - `lead`: its first paragraph when it is plain text (the claim, drawn large);
 *  - runs of `Stat: <number> | <label>` lines (big numbers; `live:target` is the campaign's target now, `live:<metric id>`
 *    a catalog number, both read live);
 *  - runs of `Screen: data/assets/<file> | <caption>` (or an https image) lines (real screens);
 *  - the rest as Markdown, in order.
 */
export type SlideBlock = { kind: "md"; text: string } | { kind: "stats"; items: { value: string; label: string }[] } | { kind: "screens"; items: { src: string; caption: string }[] };

const STAT = /^Stat:\s*([^|]+?)\s*\|\s*(.+)$/i;
const SCREEN = /^Screen:\s*(\S+)\s*\|\s*(.+)$/i;

export function slideBlocks(body: string): { lead: string | null; blocks: SlideBlock[] } {
  const blocks: SlideBlock[] = [];
  let md: string[] = [];
  const flush = () => {
    const text = md.join("\n").trim();
    if (text) blocks.push({ kind: "md", text });
    md = [];
  };
  for (const line of body.split("\n")) {
    const s = STAT.exec(line.trim());
    const v = SCREEN.exec(line.trim());
    if (s || v) {
      flush();
      const last = blocks[blocks.length - 1];
      if (s) {
        const item = { value: s[1].trim(), label: s[2].trim() };
        if (last?.kind === "stats") last.items.push(item);
        else blocks.push({ kind: "stats", items: [item] });
      } else if (v) {
        const item = { src: v[1].trim(), caption: v[2].trim() };
        if (last?.kind === "screens") last.items.push(item);
        else blocks.push({ kind: "screens", items: [item] });
      }
    } else md.push(line);
  }
  flush();
  let lead: string | null = null;
  const first = blocks[0];
  if (first?.kind === "md") {
    const [para, ...rest] = first.text.split(/\n\s*\n/);
    if (!/^\s*([-*+]\s|\d+\.\s|#|>|```)/.test(para) && para.trim()) {
      lead = para.replace(/\s*\n\s*/g, " ").trim();
      const remain = rest.join("\n\n").trim();
      if (remain) first.text = remain;
      else blocks.shift();
    }
  }
  return { lead, blocks };
}

/** A Stat value: `live:target` → the campaign's target now, `live:<metric id>` → the catalog's now, else as written. */
export function statValue(value: string, live: { target?: number | null; catalog: { id: string; now: number | null; source: string | null }[] }): string {
  const m = /^live:([a-z_]+)$/i.exec(value.trim());
  if (!m) return value;
  const n = m[1].toLowerCase() === "target" ? live.target : live.catalog.find((c) => c.id === m[1].toLowerCase())?.now;
  return n === null || n === undefined ? "–" : n.toLocaleString("en-US");
}

/** A Screen source as a URL: a repo asset (data/assets/…) through the console's /social/file, an https image as is. */
export function screenUrl(src: string, tenantId: string, repo: string | null): string | null {
  if (/^https:\/\//i.test(src)) return src;
  if (!repo || !/^data\/assets\/[^\s]+\.(png|jpe?g|gif|webp|svg)$/i.test(src) || src.includes("..")) return null;
  return `/api/tenants/${encodeURIComponent(tenantId)}/social/file?${new URLSearchParams({ repo, path: src })}`;
}
