import { stripInline } from "../adapters/markdown.js";
import { resolveRepo } from "../adapters/repos.js";
import type { Tree, TreeNode } from "../adapters/tree.js";
import type { Store } from "../store.js";
import { gitBlame, ownerFor, type WaitingDeps, type WaitingItem } from "./waiting.js";
import { ownerName } from "../identity.js";

/**
 * the persona who asked, so an answer can wake (or steer) it. `ask` = attributed from the run whose window holds
 * the ask line's commit; `run` = the run that raised a Needs the owner row; `owner` = the milestone owner (ownerFor, as before).
 */
export interface Asker {
  assignmentId: string;
  personaId?: string;
  personaName?: string;
  via: "ask" | "run" | "owner";
}

/** the `context:` of an ask raised through the console API (inbox/raise.ts askLine) names the asking run. */
const RAISED_BY_RUN = /\braised by .*?\(run (run_[\w-]+)\) through the console API/;

/** A run still counts as the writer this long after it ended (its last commit + push lands after the report). */
export const ASK_GRACE_MS = 10 * 60_000;

const asker = (store: Store, assignmentId: string, via: Asker["via"]): Asker | undefined => {
  const a = store.getAssignment(assignmentId);
  if (!a) return undefined;
  const p = store.getPersona(a.personaId);
  return { assignmentId: a.id, personaId: a.personaId, ...(p ? { personaName: p.name } : {}), via };
};

const MEMO_READS = new Set(["listAssignments", "listRuns", "getAssignment", "getPersona", "listPersonas", "getMilestone", "getRun", "getNeedsJordi"]);

/**
 * a view of `store` whose read calls above are answered once per argument list, for one request that asks the
 * same questions per item (askerFor on every card: assignments and their last 500 runs each time). Results are shared:
 * read-only use only; never keep it past the request.
 */
export function requestReads(store: Store): Store {
  const memo = new Map<string, unknown>();
  return new Proxy(store, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function" || typeof prop !== "string" || !MEMO_READS.has(prop)) return v;
      return (...args: unknown[]) => {
        const k = `${prop}\0${JSON.stringify(args)}`;
        if (!memo.has(k)) memo.set(k, (v as (...a: unknown[]) => unknown).apply(target, args));
        return memo.get(k);
      };
    },
  });
}

/** personas that answer asks but never build or raise them: an answer or feedback never goes to them as "the asker". */
export const NEVER_ASKER = /\bunblocker\b/i;

/**
 * The assignment on the milestone (any persona, Delivery Manager included) whose run window [startedAt, endedAt + 10 min]
 * (still running: up to now) contains `at`. A run still running at `at` beats one only inside its 10 min grace; then the
 * latest start wins. Skipped wakes (no work done) and NEVER_ASKER personas (the Unblocker) never count.
 *'s line was committed at 17:47:23 by a Delivery Manager worker running since 16:51; a 26 s Unblocker wake
 * that ended at 17:44:20 started later and, inside its grace, won, so the owner's feedback was steered into the Unblocker.
 */
export function askerAt(store: Store, milestoneId: string, at: string): Asker | undefined {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return undefined;
  let best: { assignmentId: string; start: number; live: boolean } | undefined;
  for (const a of store.listAssignments({ milestoneId })) {
    if (NEVER_ASKER.test(store.getPersona(a.personaId)?.name ?? "")) continue;
    for (const r of store.listRuns({ assignmentId: a.id, limit: 500 })) {
      if (r.summary.startsWith("skipped")) continue;
      const start = Date.parse(r.startedAt);
      const ended = r.endedAt ? Date.parse(r.endedAt) : Date.now();
      const end = r.endedAt ? ended + ASK_GRACE_MS : ended;
      if (start > t || t > end) continue;
      const live = t <= ended;
      if (!best || (live && !best.live) || (live === best.live && start > best.start)) best = { assignmentId: a.id, start, live };
    }
  }
  return best ? asker(store, best.assignmentId, "ask") : undefined;
}

/**
 * Who asked `item`: a Needs the owner row → the assignment of the run that raised it; a spine ask → the run that committed
 * its line (git blame); else the milestone owner. A persona-decided FYI's line was rewritten by the decider, so a
 * reversal goes to the owner (who also gets the reversal message). Undefined = no persona to wake.
 */
export async function askerFor(d: WaitingDeps, item: Partial<WaitingItem>): Promise<Asker | undefined> {
  const { store } = d;
  if (item.source === "needs_jordi") {
    const nj = item.needsJordiId ? store.getNeedsJordi(item.needsJordiId) : undefined;
    const run = nj?.runId ? store.getRun(nj.runId) : undefined;
    const byRun = run ? asker(store, run.assignmentId, "run") : undefined;
    if (byRun) return byRun;
  } else if (item.source === "ask" && !item.decidedBy && RAISED_BY_RUN.test(item.contextText ?? "")) {
    // an ask the console wrote for an API caller names its run on the line (`raised by <persona> (run <id>)`).
    const run = store.getRun(RAISED_BY_RUN.exec(item.contextText!)![1]);
    const byRun = run ? asker(store, run.assignmentId, "run") : undefined;
    if (byRun) return byRun;
  }
  if (item.source === "ask" && !item.decidedBy && item.milestoneId && item.path && item.line !== undefined && !RAISED_BY_RUN.test(item.contextText ?? "")) {
    const m = store.getMilestone(item.milestoneId);
    const repo = m ? resolveRepo(d.reposRoot, m.repo) : undefined;
    const at = repo ? (await (d.blame ?? gitBlame)(repo.path, item.path))?.[item.line] : undefined;
    const byLine = at ? askerAt(store, item.milestoneId, at) : undefined;
    if (byLine) return byLine;
  }
  if (!item.milestoneId) return undefined;
  const owner = ownerFor(store, item.milestoneId, d.homeThread, item.owner?.assignmentId);
  return owner.assignmentId ? asker(store, owner.assignmentId, "owner") : undefined;
}

/** EpicSpine run states (scripts/run_state.py): runnable = ready, or running (active / blocked). */
const RUNNABLE = new Set(["ready", "active", "blocked"]);

/** The spine node of `rel` in the tree, and whether a wake may work it; undefined = not found (treated as runnable). */
export function epicRunState(tree: Tree, rel: string): { status: string; runnable: boolean } | undefined {
  const find = (n: TreeNode): TreeNode | undefined => (n.kind === "spine" && n.path === rel ? n : n.children.map(find).find(Boolean));
  const node = find(tree.root);
  if (!node) return undefined;
  const word = /^[a-z]+/.exec(stripInline(node.status).trim().toLowerCase())?.[0] ?? "";
  return { status: word || "none", runnable: RUNNABLE.has(word) };
}

/**
 * what the asker gets (as Run now instructions, or as a steer of its running session). One template; a steer is
 * prefixed, a change says so. The pull comes first so the persona reads the spine with the `[answered]` line in it.
 */
export function answerWakeMessage(o: {
  item: Partial<WaitingItem>;
  answer: string;
  repo?: string;
  sha?: string;
  oldAnswer?: string;
  steer?: boolean;
  /** the console could not write the answer into the spine (the refusal reason): the persona writes it itself. */
  unwritten?: string;
  /** the answer is feedback (changes wanted): the note says so, and what the next round is. */
  feedback?: boolean;
  /** what the same answer also closed and may also settle (settles.ts), for this wake to judge the maybes. */
  settled?: { closed: string[]; maybe: string[]; label: string };
}): string {
  const { item } = o;
  if (o.feedback) return feedbackWakeMessage({ ...o, item });
  const code = item.code ?? (item.question ? `"${item.question.replace(/\s+/g, " ").trim().slice(0, 100)}"` : item.id ?? "your ask");
  const where = [o.repo, item.path].filter(Boolean).join("/") + (o.unwritten !== undefined && item.path && item.line !== undefined ? `:${item.line + 1}` : "");
  const head = item.decidedBy
    ? `${ownerName()} reversed the decision ${item.decidedBy} took on ${code}${where ? ` (${where})` : ""}: "${o.answer}".`
    : o.oldAnswer !== undefined
      ? `${ownerName()} changed his answer to ${code}${where ? ` (${where})` : ""}: "${o.answer}" (was "${o.oldAnswer}").`
      : `${ownerName()} answered ${code}${where ? ` (${where})` : ""}: "${o.answer}".`;
  const pull = `First run \`git pull --ff-only\` on main${o.repo ? ` in ${o.repo}` : ""} so you read the latest spine${o.sha ? ` (the [answered] line is commit ${o.sha.slice(0, 12)})` : ""}.`;
  if (o.unwritten !== undefined) {
    const line = `\`[answered${item.code ? ` ${item.code}` : ""} <YYYY-MM-DD> @${ownerName()}] … — answer: …\``;
    const write =
      `The console could not write this answer into the spine (${o.unwritten}), so it is not there yet: ` +
      `first run \`git pull --ff-only\` on main${o.repo ? ` in ${o.repo}` : ""}, then write it in yourself (flip the ask line to ${line}${item.path ? ` in ${item.path}` : ""}) ` +
      "following the repo's Integration policy (open a PR if the policy or a Deploy gate requires one; never push around it).";
    return `${o.steer ? "New answer while you are running — " : ""}${head} ${write} Then act on the answer${item.row ? ` per the ask's row ${item.row}` : ""}.`;
  }
  const act = item.decidedBy
    ? "Then undo it per the rollback on its `[answered …]` line and the reversal message in your thread."
    : `Then act on the answer${item.row ? ` per the ask's row ${item.row}` : ""}.`;
  return `${o.steer ? "New answer while you are running — " : ""}${head} ${pull} ${act}${settledNote(o.settled)}`;
}

/** one answer closes many: what the console closed with the same answer, and the maybes this wake judges. */
export function settledNote(s?: { closed: string[]; maybe: string[]; label: string }): string {
  if (!s || (!s.closed.length && !s.maybe.length)) return "";
  const closed = s.closed.length ? ` The same answer also closed ${s.closed.join(", ")} (the console wrote their \`[answered …]\` lines, quoting him).` : "";
  const maybe = s.maybe.length
    ? ` It may also settle ${s.maybe.join(", ")}: judge each against his words and close it as \`[answered <code> <date> @${ownerName()}] … — answer: via ${s.label}: “<his words>”\` only when his answer clearly settles it (same target, same decision; never a money or permission ask, never on a no); otherwise leave it open.`
    : "";
  return closed + maybe;
}

/**
 * what the builder gets when the owner gives feedback on an ask (never an approval). The console wrote the ask line as
 * `[feedback …]` and set the row it names back to `active` with his words; the builder makes the next round and brings it
 * back to the owner as a new ask (or a review card), then marks the feedback line done.
 */
export function feedbackWakeMessage(o: { item: Partial<WaitingItem>; answer: string; repo?: string; sha?: string; steer?: boolean; unwritten?: string; oldAnswer?: string }): string {
  const { item } = o;
  const code = item.code ?? (item.question ? `"${item.question.replace(/\s+/g, " ").trim().slice(0, 100)}"` : item.id ?? "your ask");
  const where = [o.repo, item.path].filter(Boolean).join("/");
  // he changed an answer he had given (an approval) to this feedback: the earlier answer no longer stands.
  const was = o.oldAnswer !== undefined ? ` He changed his earlier answer ("${o.oldAnswer}") to this feedback: that answer no longer stands, stop acting on it.` : "";
  const head = `${ownerName()} gave feedback on ${code}${where ? ` (${where})` : ""}: "${o.answer}". This is NOT an approval: he wants changes.${was}`;
  const pull = `First run \`git pull --ff-only\` on main${o.repo ? ` in ${o.repo}` : ""} so you read the latest spine${o.sha ? ` (the [feedback] line is commit ${o.sha.slice(0, 12)})` : ""}.`;
  const write =
    o.unwritten !== undefined
      ? ` The console could not write it into the spine (${o.unwritten}): write it in yourself, flipping the ask line to \`[feedback${item.code ? ` ${item.code}` : ""} <YYYY-MM-DD> @${ownerName()}] … — feedback: <his words>\`${item.row ? ` and setting row ${item.row} back to \`active (feedback … : his words)\`` : ""}, following the repo's Integration policy.`
      : item.row
        ? ` Row ${item.row} is active again with his words in its status.`
        : "";
  const act =
    `Then make the next round now (dispatch a worker if it is a build): apply his feedback, and bring the result back to ${ownerName()} as a NEW ask (a new code, e.g. the next -A number) or a review card, never as done. ` +
    `Add a Decisions row citing ${item.code ?? "the ask"} as feedback, and when the new round is posted mark the feedback line \`· done <YYYY-MM-DD> <sha> round <n> <new code>\`.`;
  return `${o.steer ? "New feedback while you are running — " : ""}${head}${write} ${pull} ${act}`;
}
