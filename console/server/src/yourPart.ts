import fs from "node:fs";
import path from "node:path";
import { sameRepoName } from "./totemMap.js";

/**
 * The owner asked whether each persona knows "which chapters they're supposed to be contributing and reading from" and
 * "the plot and the objective and the whole thing" (his voice note of 25 Nov).
 *
 * One section every wake prompt carries, in every world, for every persona: the chapters of its wheel (its product's
 * docs/totems/<product>.json `wheel.tabs`) with the ones this persona reads first and writes back into last (each tab's
 * `reads` and `writes`), the plot (the campaign's own plan, read from its spine), and its objective with every key result
 * and its light. Read from what exists; nothing is kept here.
 */

export const YOUR_PART_HEAD = "## Your part: your chapters, the plot and the objective (read first)";

export interface WheelTab {
  id?: string;
  label: string;
  kind?: string;
  holds?: string;
  lives?: string;
  knows?: string;
  reads?: string[];
  writes?: string[];
}
export interface Wheel {
  /** the product's display name. */
  product: string;
  /** what one wheel of it is called (Campaign, Objective). */
  kind: string;
  tabs: WheelTab[];
}

/** one product's wheel, from the home checkout's docs/totems/<file>.json (matched by its id or its name). */
export function readWheel(home: string | undefined, product: string | undefined): Wheel | undefined {
  if (!home || !product) return undefined;
  const dir = path.join(home, "docs", "totems");
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return undefined;
  }
  const want = product.toLowerCase();
  for (const n of names) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) as { product?: string; name?: string; wheel?: { class?: { name?: string }; tabs?: WheelTab[] } };
      const ids = [o.product, o.name, n.replace(/\.json$/, "")].filter((x): x is string => !!x).map((x) => x.toLowerCase());
      if (!ids.includes(want)) continue;
      const tabs = (o.wheel?.tabs ?? []).filter((t) => typeof t?.label === "string" && !!t.label);
      return tabs.length ? { product: o.name ?? o.product ?? n, kind: o.wheel?.class?.name ?? "Wheel", tabs } : undefined;
    } catch {
      /* a broken map file: scripts/totems.py check names it */
    }
  }
  return undefined;
}

/** "Delivery Manager · campaign manager" → "delivery manager"; "Writer, a change" → "writer". */
const base = (s: string) => s.split(/\s+·\s+|,/)[0].trim().toLowerCase();
/** a tab's reads/writes entry names this persona: its own name, or every worker. */
export function namesPersona(entry: string, persona: string): boolean {
  const e = base(entry);
  return e === base(persona) || e === "every worker" || e === "every persona";
}
/** the chapters this persona reads first and writes back into last. */
export function personaChapters(w: Wheel, persona: string): { reads: WheelTab[]; writes: WheelTab[] } {
  return {
    reads: w.tabs.filter((t) => (t.reads ?? []).some((e) => namesPersona(e, persona))),
    writes: w.tabs.filter((t) => (t.writes ?? []).some((e) => namesPersona(e, persona))),
  };
}

// ---------- the plot: the campaign's own plan, from its spine ----------

const flat = (s: string) => s.replace(/\s+/g, " ").trim();
/** a sentence that already ends in a stop gets none added. */
const stop = (s: string) => s.replace(/[.\s]+$/, "");
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** the body of `<level> <heading>` up to the next heading of that level or higher, or undefined. */
function section(md: string, heading: string, level = 2): string | undefined {
  const lines = md.split("\n");
  const hashes = "#".repeat(level);
  const at = lines.findIndex((l) => new RegExp(`^${hashes}\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i").test(l.trim()));
  if (at < 0) return undefined;
  const end = lines.findIndex((l, i) => i > at && new RegExp(`^#{1,${level}}\\s`).test(l));
  return lines.slice(at + 1, end < 0 ? undefined : end).join("\n").trim();
}
/** the `### ` parts of a section, in order, each with its text (first lines only). */
function parts(body: string): { part: string; text: string }[] {
  const out: { part: string; text: string }[] = [];
  for (const chunk of body.split(/^###\s+/m).slice(1)) {
    const [head, ...rest] = chunk.split("\n");
    const text = flat(rest.map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, "")).join(" "));
    out.push({ part: head.trim(), text });
  }
  return out;
}
const PLOT_PARTS = ["Why this campaign", "The bet", "Goal and numbers", "Messages", "Who", "Frame"];
const NOT_LIVE = /^Status:\s*(done|superseded|dropped|deferred|parked)/im;
export interface Plot {
  /** where it lives: `<spine> § <section>`. */
  where: string;
  lines: string[];
}
/** a spine's own plot: its `## Campaign plan` (the one-pager parts) or else its eight-part `## Plan`; undefined when it has neither. */
export function spinePlot(md: string, rel: string): Plot | undefined {
  for (const h of ["Campaign plan", "Plan"]) {
    const body = section(md, h);
    if (body === undefined) continue;
    const ps = parts(body).filter((p) => p.text && !/^not written|^tbd\b|^todo\b/i.test(p.text));
    const pick = PLOT_PARTS.map((n) => ps.find((p) => p.part.toLowerCase().startsWith(n.toLowerCase()))).filter((p): p is { part: string; text: string } => !!p);
    const use = (pick.length ? pick : ps).slice(0, 2);
    if (use.length) return { where: `${rel} § ${h}`, lines: use.map((p) => `${p.part}: ${cut(p.text, 260)}`) };
  }
  return undefined;
}
/**
 * the plot this wake works to: its spine's own plan; for a world's root spine with none, the live campaigns under it, one
 * line each (the root holds them all). Undefined when nothing is written.
 */
export function readPlot(repoDir: string | undefined, rel: string | undefined): Plot | undefined {
  if (!repoDir || !rel) return undefined;
  let md: string;
  try {
    md = fs.readFileSync(path.join(repoDir, rel), "utf8");
  } catch {
    return undefined;
  }
  const own = spinePlot(md, rel);
  if (own) return own;
  if (!/^Parent spine:\s*none\b/im.test(md) && !/(^|\/)root\.md$/i.test(rel)) return undefined;
  const dir = path.join(repoDir, path.dirname(rel));
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && path.join(path.dirname(rel), f) !== rel).sort();
  } catch {
    return undefined;
  }
  const lines: string[] = [];
  for (const f of files) {
    const child = path.join(path.dirname(rel), f);
    let t: string;
    try {
      t = fs.readFileSync(path.join(repoDir, child), "utf8");
    } catch {
      continue;
    }
    if (NOT_LIVE.test(t)) continue;
    const p = spinePlot(t, child);
    if (!p) continue;
    const title = /^#\s+(?:EPIC-\d+:\s*)?(.+)$/m.exec(t)?.[1]?.trim() ?? f;
    lines.push(`${cut(title, 60)} (${p.where}): ${cut(p.lines[0], 200)}`);
    if (lines.length >= 4) break;
  }
  return lines.length ? { where: `the live campaigns under ${rel}`, lines } : undefined;
}

// ---------- the objective: which one a campaign serves ----------

interface PursuitRaw {
  id: string;
  name?: string;
  greenWhen?: string;
  active?: boolean;
  done?: boolean;
  parked?: boolean;
  epics?: { repo: string; path: string }[];
  plan?: { repo: string; path: string };
  watch?: { repo: string; paths?: string[] }[];
  numbers?: { campaign?: string };
}
/** the owner's objectives file (docs/pursuits.json in the home checkout, a link into his workspace data repo). */
export function readPursuits(home: string | undefined): PursuitRaw[] {
  if (!home) return [];
  try {
    const f = JSON.parse(fs.readFileSync(path.join(home, "docs", "pursuits.json"), "utf8")) as { pursuits?: PursuitRaw[] } | PursuitRaw[];
    return (Array.isArray(f) ? f : (f.pursuits ?? [])).filter((p) => p && typeof p.id === "string");
  } catch {
    return [];
  }
}
const live = (p: PursuitRaw) => p.active !== false && !p.done && !p.parked;
/**
 * the objective a campaign serves, beyond its epics and plan: an objective that watches this very spine, else one that
 * names this repo as its campaign (`numbers.campaign`). Undefined when none names it.
 */
export function campaignObjective(pursuits: PursuitRaw[], repo: string | undefined, rel: string): string | undefined {
  if (!repo) return undefined;
  const ps = pursuits.filter(live);
  return (
    ps.find((p) => (p.watch ?? []).some((w) => sameRepoName(w.repo, repo) && (w.paths ?? []).includes(rel)))?.id ??
    ps.find((p) => !!p.numbers?.campaign && sameRepoName(p.numbers.campaign, repo))?.id
  );
}

export interface ObjectiveView {
  id: string;
  name: string;
  greenWhen?: string;
  keyResults: { label?: string; state?: string; value?: string; target?: string }[];
  /** how this wake was tied to it (its epics, the objective's watch, its product's first live objective). */
  how: string;
}

// ---------- the section ----------

const DOT: Record<string, string> = { green: "🟢", amber: "🟡", red: "🔴" };
/** a tab's place names its product's template repo; a wheel in another repo of the same product reads its own repo there. */
const where = (t: WheelTab, repo?: string, template?: string) =>
  t.lives ? (repo && template && repo !== template ? t.lives.split(template).join(repo) : t.lives) : "";
const tabLine = (t: WheelTab, repo?: string, template?: string) => `${t.label}${t.lives ? ` (${cut(where(t, repo, template), 120)})` : ""}${t.knows ? `: ${stop(cut(t.knows, 110))}` : ""}`;

export interface YourPartInput {
  persona: string;
  milestone: string;
  /** the repo's short name, so a tab's place in its product's template repo reads as this wheel's own repo. */
  repo?: string;
  /** the product's template repo (the first of its repos), named in each tab's place. */
  template?: string;
  wheel?: Wheel;
  plot?: Plot;
  objective?: ObjectiveView;
}
export function yourPartSection(i: YourPartInput): string {
  const out = [YOUR_PART_HEAD];
  const kind = (i.wheel?.kind ?? "wheel").toLowerCase();
  if (i.wheel) {
    const mine = personaChapters(i.wheel, i.persona);
    out.push(
      `You are ${i.persona} on "${i.milestone}", one ${i.wheel.product} ${kind}. Every ${kind} has the same ${i.wheel.tabs.length} chapters (docs/totems/<product>.json \`wheel.tabs\`): ${i.wheel.tabs.map((t) => t.label).join(", ")}.`,
    );
    out.push(mine.reads.length ? `Chapters you read first: ${mine.reads.map((t) => tabLine(t, i.repo, i.template)).join(" ; ")}.` : `No chapter names ${i.persona} as a reader yet: a gap, say so in your summary; read Context first meanwhile.`);
    out.push(mine.writes.length ? `Chapters you write back into last: ${mine.writes.map((t) => t.label).join(", ")}.` : `No chapter names ${i.persona} as a writer: write only your trace (Context), and hand anything else to that chapter's writer.`);
    out.push("Another chapter: read it when your step needs it; write into it only through its writer (a ledger row or a desk note), never by hand.");
  } else out.push(`You are ${i.persona} on "${i.milestone}". Its product has no chapter list (docs/totems/<product>.json \`wheel.tabs\`): a gap, say so in your summary.`);
  if (i.plot) out.push(`The plot (${i.plot.where}): ${i.plot.lines.join(" · ")}`);
  else out.push(`The plot: none written for this ${kind} (no \`## Campaign plan\` or \`## Plan\` in its spine): a gap. Do not invent one: say so in your summary and History line.`);
  if (i.objective) {
    const o = i.objective;
    const krs = o.keyResults.map((k) => `${DOT[k.state ?? ""] ?? "⚪"} ${k.label ?? "key result"}${k.value ? ` (now ${cut(k.value, 40)}${k.target ? `, target ${cut(k.target, 30)}` : ""})` : ""}`);
    out.push(`The objective (${o.how}): ${o.name}${o.greenWhen ? `. Green when: ${stop(cut(flat(o.greenWhen), 220))}` : ""}.`);
    out.push(krs.length ? `Its key results: ${krs.join(" · ")}.` : "Its key results: none written yet.");
    out.push("Your plan and report open with `Objective: <its name>: how this step moves it`.");
  } else out.push(`The objective: none names this ${kind} (no objective's epics, plan or watch hold its spine): a gap. Say so in your summary; the Delivery Manager places it.`);
  return out.join("\n");
}
