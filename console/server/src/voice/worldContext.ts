import fs from "node:fs";
import path from "node:path";
import { ownerName } from "../identity.js";

/**
 * What a social world's call knows before it starts (the owner: "I want to get myself updated, and maybe make some
 * suggestions ... a telephony guy with a good context"). The same voice and call code as the Team desk's call; this is only its preloaded context, read from the world's repo at each call's start:
 * every campaign with its plan's one line and its Goal and numbers (the key results), the newest daily briefing the world
 * received, and each campaign's newest daily line from its Strategist.
 */

export interface WorldCampaign {
  title: string;
  /** the newest daily briefing kept for this campaign (read where it is stored, never copied). */
  briefing?: { day: string; text: string };
  /** the campaign spine's text (undefined: not readable). */
  spine?: string;
}

const clip = (s: string, max: number) => {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
/** Markdown read as plain words: links as their words, no emphasis marks, tables kept as rows. */
const plain = (s: string) =>
  s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/^\|?\s*-{2,}[-|\s:]*$/gm, "")
    .replace(/\n{2,}/g, "\n")
    .trim();

/** A spine's `## Plan`: its one line and its `### Goal and numbers` part (the campaign's key results). */
export function planOf(spine: string): { line?: string; numbers?: string } {
  const m = /^## Plan\s*$([\s\S]*?)(?=^## (?!#)|(?![\s\S]))/m.exec(spine);
  if (!m) return {};
  const body = m[1];
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#") && !l.startsWith("|") && !l.startsWith(">"));
  const g = /^### Goal and numbers\s*$([\s\S]*?)(?=^###? |(?![\s\S]))/m.exec(body);
  const numbers = g ? plain(g[1]) : "";
  return { ...(line ? { line: plain(line) } : {}), ...(numbers && !/^not written yet\.?$/i.test(numbers) ? { numbers } : {}) };
}

/** Each campaign folder's newest Strategist daily line (`docs/campaigns/<c>/strategist-daily.md`, its table's last row). */
export function strategistLines(repoDir: string | undefined): string[] {
  if (!repoDir) return [];
  const root = path.join(repoDir, "docs", "campaigns");
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const d of dirs.sort()) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(root, d, "strategist-daily.md"), "utf8");
    } catch {
      continue;
    }
    const head = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? d;
    const rows = text.split("\n").filter((l) => /^\|\s*\d{4}-\d{2}-\d{2}\s*\|/.test(l));
    const cols = (/^\|(.*)\|\s*$/.exec(text.split("\n").find((l) => /^\|\s*Date\s*\|/i.test(l)) ?? "")?.[1] ?? "").split("|").map((c) => plain(c));
    const last = rows.at(-1);
    if (!last) continue;
    const cells = last.replace(/^\||\|\s*$/g, "").split("|").map((c) => plain(c));
    out.push(`${plain(head)}, ${cells[0]}: ${cells.slice(1).map((c, i) => (cols[i + 1] ? `${cols[i + 1].replace(/^[^\w]+/, "")}: ${c}` : c)).join(" | ")}`);
  }
  return out;
}

/** The block a social world's call starts with. `world` is the workspace's name as he says it. */
export function worldCallContext(o: { world: string; campaigns: WorldCampaign[]; repoDir?: string }): string {
  const who = ownerName();
  const lines: string[] = [
    `# What you already know on this call`,
    `You are ${who}'s telephony helper for this workspace's campaigns, with good context: when he calls he wants to get updated fast and maybe make suggestions. Answer from what is below at once, in short spoken sentences, numbers first, with no tool call. Everything below is yours to say as well as what your tools return. 'How are the campaigns doing', 'give me the update', 'how is <campaign> going' is each campaign's key results below (today against goal), said from here without quick_status; quick_status is only for what waits on him or is stuck right now. His suggestions and anything that needs work go to the desk with ask_the_desk (his words, which campaign); you do not do the work on the call.`,
  ];
  const cs = o.campaigns.slice(0, 12);
  lines.push("", `## The campaigns (${o.campaigns.length}) and their key results`);
  if (!cs.length) lines.push("No campaign yet.");
  cs.forEach((c, i) => {
    const p = c.spine ? planOf(c.spine) : {};
    lines.push(`${i + 1}. ${c.title}${p.line ? `: ${clip(p.line, 240)}` : ""}`);
    lines.push(p.numbers ? `Key results (today against goal): ${clip(p.numbers, 900)}` : "Key results: not written in its plan yet (say so if he asks).");
  });
  // one briefing can cover several campaigns: each is said once, under the campaigns it is about.
  const seen = new Map<string, { day: string; text: string; for: string[] }>();
  for (const c of o.campaigns) if (c.briefing) {
    const k = `${c.briefing.day}\n${c.briefing.text}`;
    const e = seen.get(k) ?? { ...c.briefing, for: [] };
    e.for.push(c.title);
    seen.set(k, e);
  }
  lines.push("", "## The latest daily briefing");
  if (!seen.size) lines.push("No daily briefing is kept for these campaigns yet (say so if he asks).");
  for (const b of [...seen.values()].sort((x, y) => y.day.localeCompare(x.day)).slice(0, 3)) lines.push(`${b.for.join(", ")}, ${b.day} (the morning briefing he received):\n${clip(b.text, 2000)}`);
  const s = strategistLines(o.repoDir);
  if (s.length) lines.push("", "## The Strategist's newest daily line per campaign (what worked, what did not, the next try)", ...s.map((l) => clip(l, 900)));
  return lines.join("\n");
}
