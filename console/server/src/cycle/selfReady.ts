import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ownerPattern } from "../identity.js";

const run = promisify(execFile);

/**
 * NO_SELF_READY: agents never ready their own ideas. A run whose commits turn a spine's or a row's Status from draft
 * to ready is flagged on the run ("self-readied", amber); the Delivery manager reverts the change.
 * the owner's ask is his ready stamp. A commit that readies an item AND adds, in the same file, a Decisions
 * row citing his ask (naming the owner with L-37, or quoting his words) carries out his ask: not flagged.
 */

/** A Status line or a ledger row (a markdown table line). */
const STATUS_LINE = /^\s*(?:[-*]\s+)?(?:\*\*)?Status(?:\*\*)?:/i;
const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
/** a table row citing the owner's ask: names the owner and L-37, or quotes him ("…" / “…”). */
export const citesJordisAsk = (l: string) => isRow(l) && new RegExp(String.raw`\b${ownerPattern()}\b`).test(l) && (/\bL-37\b/.test(l) || /["“][^"”|]{3,}["”]/.test(l));

/**
 * Lines of a unified diff (`git log -p`, commits split on `commit <sha>`) that turn draft into ready: each added line equal
 * to a removed one of the same hunk with one `ready` read as `draft`, unless the same commit adds a row citing the owner's ask
 * in the same file.
 */
export function selfReadiedLines(diff: string): string[] {
  const out: string[] = [];
  let removed: string[] = [];
  let file = "";
  let readied = new Map<string, string[]>();
  let cited = new Set<string>();
  const flush = () => {
    for (const [f, ls] of readied) if (!cited.has(f)) out.push(...ls);
    readied = new Map();
    cited = new Set();
  };
  for (const l of diff.split("\n")) {
    if (l.startsWith("commit ")) {
      flush();
      continue;
    }
    if (l.startsWith("+++ ")) file = l.replace(/^\+\+\+ (b\/)?/, "");
    if (l.startsWith("@@") || l.startsWith("diff ")) removed = [];
    else if (l.startsWith("-") && !l.startsWith("---")) removed.push(l.slice(1));
    else if (l.startsWith("+") && !l.startsWith("+++")) {
      const a = l.slice(1);
      if (!STATUS_LINE.test(a) && !isRow(a)) continue;
      let flagged = false;
      for (const m of a.matchAll(/\bready\b/gi)) {
        const asDraft = a.slice(0, m.index) + "draft" + a.slice(m.index! + m[0].length);
        if (removed.some((r) => r.toLowerCase() === asDraft.toLowerCase())) {
          readied.set(file, [...(readied.get(file) ?? []), `${file}: ${a.trim()}`.slice(0, 300)]);
          flagged = true;
          break;
        }
      }
      // The readied row itself never vouches for itself: the citation is another added row (the Decisions row).
      if (!flagged && citesJordisAsk(a)) cited.add(file);
    }
  }
  flush();
  return [...new Set(out)];
}

/** The run's own commits (trailer `Run: <id>`, any ref) since it started: the lines it readied, [] when none or git fails. */
export async function selfReadied(repoDir: string, runId: string, since: string): Promise<string[]> {
  const opts = { cwd: repoDir, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 };
  await run("git", ["fetch", "-q", "origin"], opts).catch(() => undefined);
  const after = new Date(Date.parse(since) - 10 * 60_000).toISOString();
  const r = await run("git", ["log", "--all", `--since=${after}`, "--fixed-strings", `--grep=Run: ${runId}`, "-p", "--unified=0", "--format=commit %H", "--", "*.md"], opts).catch(() => undefined);
  return r ? selfReadiedLines(r.stdout) : [];
}
