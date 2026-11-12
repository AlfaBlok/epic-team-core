import type { ReactNode } from "react";
import { safeHref } from "@/lib/mdlinks";
import { cn } from "@/lib/utils";

/**
 * the desk's replies are Markdown. A small renderer to React elements (never HTML, so nothing in a message can
 * inject markup): paragraphs, headings, bullet / numbered lists, fenced code, `code`, **bold**, [label](target) and bare
 * URLs. A link opens only if it is http(s), a T3 deep link (`t3code://threads/…`), or a `t3-thread://v1/<id>` link, which
 * becomes the `t3code://` one when `threadUrl` knows the environment (it only works inside T3 otherwise).
 *
 * the rest of GitHub-flavoured Markdown the desk writes: tables (header row, column alignment, a box that
 * scrolls sideways on a phone with the first column held in place, never the page), nested and task lists, numbered
 * lists that keep their start number, quotes, rules, heading sizes, *italic*, ~~strike~~, `\` escapes and <url>.
 */
export type ThreadUrl = (threadId: string) => string;

const T3_LINK = /^t3code:\/\/threads\/[^\s/]+\/[^\s/]+$/;
const T3_THREAD = /^t3-thread:\/\/v1\/(\S+)$/;
// Groups: 1 code, 2 escaped char, 3/4 link label/target, 5 <autolink>, 6 bare url, 7 bold+italic, 8/9 bold, 10 strike,
// 11/12 italic. No lookbehind (older iPhone Safari cannot parse it): `_italic_` checks its word boundaries in code.
const INLINE =
  /`([^`\n]+)`|\\([\\`*_{}[\]()#+\-.!|~<>])|!?\[([^\]\n]*)\]\(\s*<?((?:[^\s()<>]|\([^\s()<>]*\))*)>?(?:\s+"[^"]*")?\s*\)|<(https?:\/\/[^\s<>]+)>|(https?:\/\/[^\s<>()[\]`"']+)|\*\*\*(?!\s)([^*\n]+?)\*\*\*|\*\*(?!\s)([^\n]+?)\*\*|__(?!\s)([^_\n]+?)__|~~(?!\s)([^~\n]+?)~~|\*(?![\s*])([^*\n]+?)\*|_(?![\s_])([^_\n]+?)_/g;
const TRAILING_PUNCT = /[.,;:!?]+$/;
const WORD = /[\p{L}\p{N}_]/u;

export function chatLinkHref(target: string, threadUrl?: ThreadUrl): string | undefined {
  const t = target.trim();
  if (T3_LINK.test(t)) return t;
  const m = T3_THREAD.exec(t);
  if (m) return threadUrl ? threadUrl(m[1]) : t;
  return safeHref(t);
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  const web = /^https?:/i.test(href);
  return (
    <a href={href} className="text-primary underline [overflow-wrap:anywhere]" {...(web ? { target: "_blank", rel: "noreferrer noopener" } : {})}>
      {children}
    </a>
  );
}

export function inline(text: string, threadUrl?: ThreadUrl): ReactNode[] {
  const out: ReactNode[] = [];
  const re = new RegExp(INLINE.source, "g");
  let last = 0;
  let k = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const at = m.index;
    if (m[12] !== undefined && ((at > 0 && WORD.test(text[at - 1])) || WORD.test(text[at + m[0].length] ?? ""))) {
      // snake_case_words are not italic: keep the `_` as text and go on after it
      re.lastIndex = at + 1;
      continue;
    }
    if (at > last) out.push(text.slice(last, at));
    if (m[1] !== undefined)
      out.push(
        <code key={k++} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] [overflow-wrap:anywhere]">
          {m[1]}
        </code>,
      );
    else if (m[2] !== undefined) out.push(m[2]);
    else if (m[3] !== undefined) {
      const href = chatLinkHref(m[4], threadUrl);
      const label = m[3].trim() ? inline(m[3].trim(), threadUrl) : m[4];
      out.push(href ? <Link key={k++} href={href}>{label}</Link> : <span key={k++}>{label}</span>);
    } else if (m[5] !== undefined) {
      const href = safeHref(m[5]);
      out.push(href ? <Link key={k++} href={href}>{m[5]}</Link> : m[0]);
    } else if (m[6] !== undefined) {
      const url = m[6].replace(TRAILING_PUNCT, "");
      const href = safeHref(url);
      out.push(href ? <Link key={k++} href={href}>{url}</Link> : url);
      if (url.length < m[6].length) out.push(m[6].slice(url.length));
    } else if (m[7] !== undefined)
      out.push(
        <strong key={k++}>
          <em>{inline(m[7], threadUrl)}</em>
        </strong>,
      );
    else if (m[8] !== undefined || m[9] !== undefined) out.push(<strong key={k++}>{inline(m[8] ?? m[9], threadUrl)}</strong>);
    else if (m[10] !== undefined) out.push(<del key={k++}>{inline(m[10], threadUrl)}</del>);
    else out.push(<em key={k++}>{inline(m[11] ?? m[12], threadUrl)}</em>);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export type Align = "left" | "center" | "right" | undefined;
export type ListItem = { text: string; checked?: boolean; children?: Block[] };
export type Block =
  | { kind: "p" | "code"; text: string }
  | { kind: "h"; text: string; level: number }
  | { kind: "ul" | "ol"; items: ListItem[]; start?: number }
  | { kind: "quote"; children: Block[] }
  | { kind: "hr" }
  | { kind: "table"; head: string[]; align: Align[]; rows: string[][] };

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** A table row's cells: outer pipes dropped, split on pipes that are not escaped (`\|` stays a pipe inside a cell). */
export function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (s[i] === "|") {
      out.push(cur.trim());
      cur = "";
    } else cur += s[i];
  }
  out.push(cur.trim());
  return out;
}

function isTableStart(lines: string[], i: number): boolean {
  const head = lines[i];
  const delim = lines[i + 1];
  if (delim === undefined || !head.includes("|") || !DELIM.test(delim) || !delim.includes("-")) return false;
  // GitHub needs a pipe in the delimiter row unless the table has one column, and the same count of cells as the header
  return (delim.includes("|") || cells(head).length === 1) && cells(head).length === cells(delim).length;
}

const indentOf = (line: string) => (line.match(/^\s*/)?.[0] ?? "").replace(/\t/g, "    ").length;

export function blocks(src: string): Block[] {
  const out: Block[] = [];
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: "p", text: para.join("\n") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      flush();
      const fence = FENCE.exec(line)![1];
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence); i++) body.push(lines[i]);
      out.push({ kind: "code", text: body.join("\n") });
    } else if (!line.trim()) flush();
    else if (HEADING.test(line)) {
      flush();
      const h = HEADING.exec(line)!;
      out.push({ kind: "h", text: h[2], level: h[1].length });
    } else if (RULE.test(line)) {
      flush();
      out.push({ kind: "hr" });
    } else if (QUOTE.test(line)) {
      flush();
      const body: string[] = [];
      for (; i < lines.length && QUOTE.test(lines[i]); i++) body.push(lines[i].replace(QUOTE, ""));
      i--;
      out.push({ kind: "quote", children: blocks(body.join("\n")) });
    } else if (isTableStart(lines, i)) {
      flush();
      const head = cells(line);
      const align: Align[] = cells(lines[i + 1]).map((d) =>
        d.startsWith(":") && d.endsWith(":") ? "center" : d.endsWith(":") ? "right" : d.startsWith(":") ? "left" : undefined,
      );
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes("|"); i++) {
        const r = cells(lines[i]).slice(0, head.length);
        while (r.length < head.length) r.push("");
        rows.push(r);
      }
      i--;
      out.push({ kind: "table", head, align, rows });
    } else if (ITEM.test(line)) {
      flush();
      i = list(lines, i, out) - 1;
    } else para.push(line);
  }
  flush();
  return out;
}

/** One list from `lines[from]` into `out`; returns the index after it. Deeper lines (nested lists, more text) belong to the item above. */
function list(lines: string[], from: number, out: Block[]): number {
  const first = ITEM.exec(lines[from])!;
  const base = indentOf(first[1]);
  const ordered = /\d/.test(first[2]);
  const items: ListItem[] = [];
  let sub: string[] = [];
  const close = () => {
    const item = items[items.length - 1];
    if (item && sub.some((l) => l.trim())) item.children = blocks(sub.join("\n"));
    sub = [];
  };
  let i = from;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const m = ITEM.exec(line);
    if (m && indentOf(m[1]) <= base + 1) {
      if (/\d/.test(m[2]) !== ordered) break;
      close();
      const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3]);
      items.push(task ? { text: task[2], checked: task[1] !== " " } : { text: m[3] });
    } else if (!line.trim()) {
      // a blank line ends the list unless the list (or the item's own text) goes on after it
      const next = lines.slice(i + 1).find((l) => l.trim());
      const nm = next !== undefined ? ITEM.exec(next) : null;
      if (next === undefined) break;
      if (nm && indentOf(nm[1]) <= base + 1 ? /\d/.test(nm[2]) !== ordered : indentOf(next) <= base) break;
      sub.push("");
    } else if (indentOf(line) > base) sub.push(line.slice(Math.min(indentOf(line), base + 2 + (ordered ? 1 : 0))));
    else break;
  }
  close();
  // an item's text that just goes on (no list, no gap) stays the item's text
  for (const it of items) {
    if (it.children?.[0]?.kind === "p") {
      it.text = `${it.text}\n${(it.children.shift() as { text: string }).text}`;
      if (!it.children.length) delete it.children;
    }
  }
  const start = ordered ? Number.parseInt(first[2], 10) : undefined;
  out.push({ kind: ordered ? "ol" : "ul", items, ...(start !== undefined && start !== 1 ? { start } : {}) });
  return i;
}

const ALIGN: Record<string, string> = { left: "text-left", center: "text-center", right: "text-right" };

/** A table's cell: words wrap inside a width that keeps them readable; a `<br>` the desk wrote is a line break. */
function Cell({ text, threadUrl, wide, first }: { text: string; threadUrl?: ThreadUrl; wide: boolean; first: boolean }) {
  const parts = text.split(/<br\s*\/?>/i);
  return (
    <div className={cn(first ? "max-w-[9.5rem] sm:max-w-[16rem]" : "max-w-[18rem]", wide && (first ? "min-w-[6rem]" : "min-w-[8rem]"))}>
      {parts.map((p, i) => (
        <span key={i} className="block">
          {inline(p, threadUrl)}
        </span>
      ))}
    </div>
  );
}

function Table({ b, threadUrl }: { b: Extract<Block, { kind: "table" }>; threadUrl?: ThreadUrl }) {
  // A short column (#, a date, a time) keeps its natural width; a column of words gets a readable minimum.
  const wide = b.head.map((h, c) => Math.max(h.length, ...b.rows.map((r) => r[c].length)) > 12);
  const sticky = "sticky left-0 z-[1] shadow-[inset_-1px_0_0_hsl(var(--border))]";
  return (
    <div className="max-w-full overflow-x-auto overscroll-x-contain rounded-md border" role="region" aria-label="Table" tabIndex={0} data-testid="chat-md-table">
      <table className="min-w-full border-collapse text-[13px] leading-snug [overflow-wrap:break-word]">
        <thead>
          <tr>
            {b.head.map((h, c) => (
              <th key={c} scope="col" className={cn("border-b bg-muted px-2.5 py-1.5 text-left align-bottom font-semibold", ALIGN[b.align[c] ?? ""], c === 0 && sticky)}>
                <Cell text={h} threadUrl={threadUrl} wide={wide[c]} first={c === 0} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {b.rows.map((r, j) => (
            <tr key={j} className="border-b last:border-b-0">
              {r.map((v, c) => (
                <td key={c} className={cn("bg-card px-2.5 py-1.5 text-left align-top", ALIGN[b.align[c] ?? ""], c === 0 && cn(sticky, "font-medium"))}>
                  <Cell text={v} threadUrl={threadUrl} wide={wide[c]} first={c === 0} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const HEADING_SIZE = ["", "text-lg", "text-base", "text-[0.95rem]", "", "", ""];

function render(bs: Block[], threadUrl?: ThreadUrl): ReactNode[] {
  return bs.map((b, i) => {
    switch (b.kind) {
      case "ul":
      case "ol": {
        const L = b.kind;
        return (
          <L key={i} start={b.kind === "ol" ? b.start : undefined} className={cn("grid gap-0.5 pl-5", L === "ul" ? "list-disc" : "list-decimal")}>
            {b.items.map((it, j) => (
              <li key={j} className={cn("min-w-0", it.checked !== undefined && "-ml-5 list-none")}>
                {it.checked !== undefined && (
                  <input type="checkbox" checked={it.checked} disabled readOnly className="mr-1.5 h-3.5 w-3.5 translate-y-0.5 accent-primary" aria-label={it.checked ? "done" : "not done"} />
                )}
                <span className="whitespace-pre-line">{inline(it.text, threadUrl)}</span>
                {it.children && <div className="mt-1 grid grid-cols-[minmax(0,1fr)] gap-1">{render(it.children, threadUrl)}</div>}
              </li>
            ))}
          </L>
        );
      }
      case "code":
        return (
          <pre key={i} className="max-w-full overflow-x-auto rounded bg-muted p-2 font-mono text-xs [overflow-wrap:normal]">
            {b.text}
          </pre>
        );
      case "h":
        return (
          <p key={i} role="heading" aria-level={Math.min(b.level + 2, 6)} className={cn("font-semibold", HEADING_SIZE[b.level], b.level <= 2 && "mt-1")}>
            {inline(b.text, threadUrl)}
          </p>
        );
      case "hr":
        return <hr key={i} className="my-1 border-border" />;
      case "quote":
        return (
          <blockquote key={i} className="grid grid-cols-[minmax(0,1fr)] gap-2 border-l-2 pl-3 text-muted-foreground">
            {render(b.children, threadUrl)}
          </blockquote>
        );
      case "table":
        return <Table key={i} b={b} threadUrl={threadUrl} />;
      default:
        return (
          <p key={i} className="whitespace-pre-wrap">
            {inline(b.text, threadUrl)}
          </p>
        );
    }
  });
}

/** True when the text holds a Markdown table (a view that shows plain text can switch to ChatMarkdown for it). */
export function hasTable(text: string): boolean {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return lines.some((_, i) => isTableStart(lines, i));
}

export function ChatMarkdown({ text, threadUrl }: { text: string; threadUrl?: ThreadUrl }) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 [overflow-wrap:anywhere]" data-testid="chat-md">
      {render(blocks(text), threadUrl)}
    </div>
  );
}
