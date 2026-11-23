import type { Store } from "../store.js";
import type { SpineWriter } from "../inbox/spineWrite.js";
import { resolveRepo } from "../adapters/repos.js";
import { isDm } from "../inbox/waiting.js";
import { homeRepo, ownerName } from "../identity.js";
import { CLOSED_STATUS, PARKED_STATUS, TEST_REPO, editRowStatus } from "./rows.js";
import type { SentBackCard } from "./sentBack.js";
import type { ClosedCard } from "./afterClose.js";
import type { WorkerLaunchInput } from "../cycle/workerLaunch.js";

/**
 * (the owner 2026-11-23 00:29Z): "Closed by the team, it should not be possible ... I never
 * ask for this ... I don't want the things to stay in the inbox when I've already responded. What I want them is to come
 * back properly, and have a fallback mechanism so that if things get lost, they get picked up."
 *
 * Two rules, kept by the console itself, with no manager wake in between:
 *
 * 1. Only his press closes a card he sent back. `teamCloseRefusal` is the rule (the repo's pre-commit check,
 *    the pre-commit guard, refuses the commit with the same rule); a close that still reached the spine is undone
 *    here: the row is set back to `active` with his words and its next round is started.
 * 2. Every answer of his gets its next round. A card he sent back that has no worker, no claim and no round back with
 *    him PICKUP_AFTER_MIN minutes after his press is started by the console: a worker run handed to the console's one
 *    work queue (cycle/workQueue.ts), first in line, inside every cap. An ask he answered whose owner was
 *    never woken afterwards gets that wake.
 *
 * Why 15 minutes: his press wakes the Delivery Manager at once, and a wake needs 3 to 10 minutes to read the spine and
 * start a worker, so anything shorter would start a second worker beside the manager's. On 22 Nov he asked again after
 * 30 minutes with nothing visible; 15 picks a lost round up before that.
 */
export const PICKUP_AFTER_MIN = 15;
/** how often the console looks (the check costs one read of the spines it already caches). */
export const PICKUP_TICK_MS = 5 * 60_000;
/** rounds the console starts by itself for one send-back; after that the row is named as stuck instead of looping. */
export const PICKUP_MAX_ROUNDS = 3;
/** new rounds started per look, so 20 lost cards never hit the dispatcher in one burst (the queue takes the rest next look). */
export const PICKUP_PER_TICK = 5;

/** his feedback is the last word on the row: its status still carries his send-back. */
const HIS_FEEDBACK = /\brelaunched by\b/i;
/** moved to another list (`moved (to …)`): the ticket lives on there under its own status. */
const MOVED = /^moved\b/i;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hisClose = (status: string, owner: string) =>
  new RegExp(`\\b(approved|denied|declined|dropped|parked|closed|cancell?ed|snoozed) by (the owner|${esc(owner)})\\b`, "i").test(status);

/**
 * The rule: a row whose last word from him is feedback is never closed, folded or parked by the team. Returns why the
 * change from `prev` to `next` is refused, or undefined when it is allowed (still worked on, back to review, his press).
 */
export function teamCloseRefusal(prev: string, next: string, owner: string = ownerName()): string | undefined {
  if (!HIS_FEEDBACK.test(prev) || hisClose(prev, owner)) return undefined;
  const n = next.trim();
  if (!(CLOSED_STATUS.test(n) || PARKED_STATUS.test(n))) return undefined;
  // a move to another list is not a close: the ticket lives on there
  if (MOVED.test(n) || hisClose(n, owner)) return undefined;
  return `refused: ${owner} sent this card back and only his press closes it. Finish the round and set the row to review with its card; he closes it there. It read "${prev.slice(0, 120)}".`;
}

export type PickupWhat = "reopen" | "start" | "hold";

export interface PickupItem {
  card: SentBackCard;
  /** reopen: the team closed it, set it back to active and start its round. start: nobody is on it, start its round. hold: inside the first minutes, its manager may still start it. */
  what: PickupWhat;
  /** when the console starts it by itself (ISO). */
  dueAt: string;
}

const sinceMs = (s?: string) => {
  const t = s ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s) : NaN;
  return Number.isFinite(t) ? t : 0;
};
/** a round that came back to him as a question: the row is blocked on an ask code, which is his card now. */
const BACK_AS_ASK = /^blocked\b.*\b[A-Z][\w.]*-A\d+\b/i;

/** What the fallback does with each sent-back card now. A card with a worker, a timed check ahead or an ask back with him is left alone. */
export function pickupPlan(cards: SentBackCard[], now: Date, afterMin: number = PICKUP_AFTER_MIN): PickupItem[] {
  const out: PickupItem[] = [];
  for (const c of cards) {
    if (TEST_REPO.test(c.repo) || c.state === "in_progress") continue;
    if (c.state === "closed_by_team") {
      out.push({ card: c, what: "reopen", dueAt: now.toISOString() });
      continue;
    }
    const check = c.checkAt ? Date.parse(c.checkAt.replace(/T(\d\d:\d\d)Z$/, "T$1:00Z")) : NaN;
    if (Number.isFinite(check) && check > now.getTime()) continue;
    if (c.status && BACK_AS_ASK.test(c.status)) continue;
    const due = sinceMs(c.since) + afterMin * 60_000;
    out.push({ card: c, what: due <= now.getTime() ? "start" : "hold", dueAt: new Date(due).toISOString() });
  }
  // a card the team closed first (it is the one he cannot see at all), then the oldest answer: he has waited longest for it
  const first = (x: PickupItem) => (x.what === "reopen" ? 0 : 1);
  return out.sort((a, b) => first(a) - first(b) || sinceMs(a.card.since) - sinceMs(b.card.since));
}

/** the status a row the team closed goes back to: active, his send-back and his words in it, and what the console undid. */
export function reopenedCell(c: Pick<SentBackCard, "iteration" | "since" | "words">, was: string, today: string, owner: string = ownerName()): string {
  const day = (c.since ?? today).slice(0, 10);
  const words = (c.words ?? "").replace(/\r?\n+/g, " ").replace(/\|/g, "/").replace(/[()]/g, (x) => (x === "(" ? "[" : "]")).replace(/\s+/g, " ").trim().slice(0, 300);
  const undone = was.replace(/\|/g, "/").replace(/[()]/g, (x) => (x === "(" ? "[" : "]")).replace(/\s+/g, " ").trim().slice(0, 100);
  return `active (iteration ${Math.max(2, c.iteration)}, reopened by the console ${today}: the team had closed it without his press, it read "${undone}"; relaunched by ${owner} ${day}: ${words || "his words are in his card notes"})`;
}

/** the brief of a round the console starts itself (the console adds the worker rules and the report protocol). */
export function pickupBrief(c: SentBackCard, o: { reopened: boolean; afterMin: number; owner?: string }): string {
  const owner = o.owner ?? ownerName();
  const repo = c.repo.split("/").pop()!;
  return [
    `You are a Ticket worker for row ${c.ref} in ${c.repo}, spine ${c.path}. Bound epic: ${c.path}. Your console run id is <child run id>.`,
    o.reopened
      ? `${owner} sent this card back and the team then closed it without his press. That is never allowed: only his press closes a card he sent back. The console set the row back to active and started you to build the round he asked for.`
      : `${owner} sent this card back${c.since ? ` (${c.since.slice(0, 16).replace("T", " ")}Z)` : ""} and no worker and no new round followed within ${o.afterMin} minutes. The console started you so his answer is not lost.`,
    c.words ? `His words when he sent it back: "${c.words}"` : "His words are in his card notes (next line).",
    `Before you plan, read every note he left on it, newest first: \`python3 ~/github/${homeRepo()}/scripts/card_notes.py words ${c.ref} --repo ${repo}=<your checkout>\`, then the row itself and its card docs/cards/${c.ref}.md. His newest word wins.`,
    c.continuesIn ? `The row was folded into ${c.continuesIn}: read that row too and say on the card what of his ask it already delivered.` : "",
    "If the work he asked for is already live under another row, do not close this one: check it live, show him where it is on this row's card, and set this row to review so he closes it himself.",
    `Done = live where ${owner} uses it. Then set row ${c.ref} back to \`review\` with its card (docs/cards/${c.ref}.md) and the live link in Latest Evidence, so it returns to his inbox as the next round. Never close, fold or park this row yourself.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export interface PickupRun {
  id: string;
  outcome?: string;
  clientRequestId?: string | null;
  startedAt?: string;
  endedAt?: string | null;
  parentRunId?: string | null;
}

export interface PickupDeps {
  store: Pick<Store, "listMilestones" | "listAssignments" | "getPersona" | "listRuns">;
  /** take a queued run out of the work queue (its card came back, or a worker is on it): the run ends, nothing starts. */
  cancel?: (runId: string, why: string) => void;
  reposRoot: string;
  list: () => Promise<SentBackCard[]>;
  /** his answered asks (afterClose.recent), newest first. */
  recent?: (o: { days: number; limit: number }) => ClosedCard[];
  writer?: Pick<SpineWriter, "edit">;
  wrote?: (dir: string) => void;
  /** hand one worker run to the console's work queue for the assignment (cycle.launchPickup). */
  launch?: (assignmentId: string, i: WorkerLaunchInput) => Promise<{ run: { id: string; outcome?: string }; replayed: boolean }>;
  /** wake a persona with instructions (cycle.runNowRequest). */
  wake?: (assignmentId: string, o: { instructions: string; instructionsBy: string }, key: string) => Promise<unknown>;
  now?: () => Date;
  afterMin?: number;
  log?: (msg: string) => void;
}

export interface PickupWaiting {
  ref: string;
  repo: string;
  title: string;
  since?: string;
  /** the one thing holding it, in plain words (Hosts shows it). */
  why: string;
  /** when the console starts it by itself, when that is still ahead. */
  startsAt?: string;
}

export interface PickupReport {
  at: string;
  reopened: string[];
  started: string[];
  woken: string[];
  stuck: string[];
  /** queued rounds taken out because their card is no longer waiting. */
  cancelled: string[];
  errors: string[];
}

const sameRepo = (a: string, b: string) => a === b || a.split("/").pop() === b.split("/").pop();
/** the day he sent it back (a row keeps only the day once his press is old, so the key must not depend on the minute). */
const stamp = (s?: string) => (s ?? "").replace(/[^0-9]/g, "").slice(0, 8) || "0";
/** a run the fallback started: `<row>-pickup-<day he sent it back>-<n>`. */
const PICKUP_RUN = /^(.+)-pickup-\d+-\d+$/;

export function createPickup(d: PickupDeps) {
  const now = () => d.now?.() ?? new Date();
  const afterMin = d.afterMin ?? PICKUP_AFTER_MIN;
  const log = d.log ?? ((m: string) => console.log(m));
  let busy = false;
  let last: PickupReport | undefined;
  let waiting: PickupWaiting[] = [];

  /** the assignment that owns a card: its milestone's Delivery manager (the one named, else the spine's, else the repo's root). */
  function ownerOf(c: { repo: string; path: string; milestoneId?: string }): string | undefined {
    const ms = d.store.listMilestones({ includeSettled: true });
    const mine = ms.filter((x) => sameRepo(x.repo, c.repo));
    const m = (c.milestoneId ? mine.find((x) => x.id === c.milestoneId) : undefined) ?? mine.find((x) => x.path === c.path) ?? mine.find((x) => /root\.md$/.test(x.path ?? "")) ?? mine[0];
    if (!m) return undefined;
    const as = d.store.listAssignments({ milestoneId: m.id });
    return (as.find((a) => isDm(d.store.getPersona(a.personaId)?.name)) ?? as[0])?.id;
  }

  /** the rounds the console already started for this send-back (their request ids open `<row>-pickup-<day>`; older ones carried the minute). */
  function rounds(assignmentId: string, c: SentBackCard): PickupRun[] {
    const key = `${c.ref}-pickup-${stamp(c.since)}`;
    return (d.store.listRuns({ assignmentId, limit: 2000 }) as PickupRun[]).filter((r) => r.clientRequestId?.startsWith(key) && PICKUP_RUN.test(r.clientRequestId));
  }

  async function reopen(c: SentBackCard): Promise<boolean> {
    const dir = resolveRepo(d.reposRoot, c.repo)?.path;
    if (!d.writer || !dir) return false;
    const today = now().toISOString().slice(0, 10);
    const owner = ownerName();
    const w = await d.writer.edit({
      repoDir: dir,
      path: c.path,
      label: c.ref,
      group: true,
      fetchFreshMs: 30_000,
      edit: (text) => {
        const e = editRowStatus(text, c.ref, (status) => {
          const s = status.trim();
          // only a close the team made: a row he closed since, or one being worked on again, is left alone
          if (!(CLOSED_STATUS.test(s) || PARKED_STATUS.test(s)) || MOVED.test(s) || hisClose(s, owner)) return { skip: `row ${c.ref} is not closed by the team any more (it reads "${s.slice(0, 80)}")` };
          return reopenedCell(c, s, today, owner);
        });
        if ("skip" in e) return e;
        return {
          text: e.text,
          msg: `${c.ref}: reopened by the console, the team had closed a card ${owner} sent back`,
          body: `${owner} sent "${c.title}" back${c.since ? ` on ${c.since}` : ""} and the row was then closed without his press (it read "${e.status.slice(0, 200)}"). Only his press closes a card he sent back : row ${c.ref} in ${c.path} is active again with his words, and the console starts its next round.${c.words ? `\n\nHis words: ${c.words}` : ""}`,
        };
      },
    });
    if (w.status !== "written") {
      log(`pickup: ${c.ref} not reopened: ${w.status} ${w.reason ?? ""}`);
      return false;
    }
    d.wrote?.(dir);
    return true;
  }

  async function tick(): Promise<PickupReport> {
    const rep: PickupReport = { at: now().toISOString(), reopened: [], started: [], woken: [], stuck: [], cancelled: [], errors: [] };
    if (busy) return last ?? rep;
    busy = true;
    try {
      const cards = await d.list();
      const plan = pickupPlan(cards, now(), afterMin);
      const wait: PickupWaiting[] = [];
      // a round still queued for a card that is no longer waiting (it is back in his review, he closed it, or a worker
      // took it) is taken out of the queue: it would only start a second worker
      if (d.cancel) {
        const waits = new Set(plan.map((x) => x.card.ref));
        const since = new Date(now().getTime() - 3 * 86_400_000).toISOString();
        for (const r of d.store.listRuns({ since, limit: 5000 }) as PickupRun[]) {
          const ref = r.outcome === "deferred" ? PICKUP_RUN.exec(r.clientRequestId ?? "")?.[1] : undefined;
          if (!ref || waits.has(ref)) continue;
          d.cancel(r.id, `${ref} not started: its card is no longer waiting (back in review, closed by him, or a worker is on it)`);
          rep.cancelled.push(ref);
        }
      }
      let fresh = 0;
      for (const it of plan) {
        const c = it.card;
        const base = { ref: c.ref, repo: c.repo, title: c.title, ...(c.since ? { since: c.since } : {}) };
        if (it.what === "hold") {
          wait.push({ ...base, why: `its manager's first ${afterMin} minutes after your answer. The console starts it by itself at ${it.dueAt.slice(11, 16)}Z.`, startsAt: it.dueAt });
          continue;
        }
        const a = ownerOf(c);
        if (!a || !d.launch) {
          wait.push({ ...base, why: "no persona on its goal to run it." });
          rep.errors.push(`${c.ref}: no assignment to start a worker on`);
          continue;
        }
        const mine = rounds(a, c);
        const open = mine.find((r) => r.outcome === "running" || r.outcome === "deferred");
        if (open) continue; // queued or starting: Hosts shows it from the queue itself
        // a round that just ended without bringing the card back gets the same minutes before the next one
        const lastEnd = Math.max(0, ...mine.map((r) => Date.parse(r.endedAt ?? r.startedAt ?? "") || 0));
        if (lastEnd && lastEnd + afterMin * 60_000 > now().getTime()) {
          wait.push({ ...base, why: `the wait after its last round, which ended without coming back to you. The console starts the next one at ${new Date(lastEnd + afterMin * 60_000).toISOString().slice(11, 16)}Z.`, startsAt: new Date(lastEnd + afterMin * 60_000).toISOString() });
          continue;
        }
        if (mine.length >= PICKUP_MAX_ROUNDS) {
          wait.push({ ...base, why: `${mine.length} rounds the console started that did not come back to you. It needs its manager.` });
          rep.stuck.push(c.ref);
          continue;
        }
        if (fresh >= PICKUP_PER_TICK) {
          wait.push({ ...base, why: "the console's next look, within 5 minutes." });
          continue;
        }
        let reopened = false;
        if (it.what === "reopen") {
          reopened = await reopen(c).catch((e) => (rep.errors.push(`${c.ref}: ${e instanceof Error ? e.message : String(e)}`), false));
          if (!reopened) {
            wait.push({ ...base, why: "a write to its ticket that did not land yet. The console tries again within 5 minutes." });
            continue;
          }
          rep.reopened.push(c.ref);
        }
        try {
          const r = await d.launch(a, {
            ticket: c.ref,
            title: `Sent back by you: ${c.title}`.slice(0, 200),
            brief: pickupBrief(c, { reopened: reopened || /reopened by the console/.test(c.status ?? ""), afterMin }),
            clientRequestId: `${c.ref}-pickup-${stamp(c.since)}-${mine.length + 1}`,
          });
          if (!r.replayed) fresh++;
          rep.started.push(c.ref);
          log(`pickup: ${c.ref} ${reopened ? "reopened and " : ""}handed to the work queue as ${r.run.id} (${r.run.outcome ?? ""})`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          rep.errors.push(`${c.ref}: ${msg.slice(0, 200)}`);
          wait.push({ ...base, why: `a start that failed: ${msg.slice(0, 120)}` });
        }
      }
      // an ask he answered whose owner never ran afterwards: wake the owner with his answer
      if (d.recent && d.wake) {
        const cutoff = now().getTime() - 3 * 86_400_000;
        for (const p of d.recent({ days: 3, limit: 200 })) {
          if (p.kind !== "ask" || TEST_REPO.test(p.repo)) continue;
          const at = Date.parse(p.at);
          if (!(at > cutoff) || at + afterMin * 60_000 > now().getTime()) continue;
          const a = ownerOf(p);
          if (!a) continue;
          // any run of the owner started since his answer has read it (every wake reads the answered asks first)
          if (d.store.listRuns({ assignmentId: a, since: new Date(at - 60_000).toISOString(), limit: 1 }).length) continue;
          try {
            await d.wake(
              a,
              {
                instructions: `${ownerName()} answered ${p.ref} ("${p.title.slice(0, 200)}") at ${p.at} and no wake of yours ran since. Read his answer on the ask's answered line in ${p.path} and act on it now: start the work it unblocks, or bring the next round back to his inbox.`,
                instructionsBy: "the console fallback",
              },
              `pickup:ask:${p.repo}:${p.ref}:${p.at.replace(/[^0-9]/g, "").slice(0, 12)}`,
            );
            rep.woken.push(p.ref);
            log(`pickup: woke the owner of ${p.ref}, answered ${p.at} with no wake since`);
          } catch (e) {
            rep.errors.push(`${p.ref}: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
          }
        }
      }
      waiting = wait;
      last = rep;
      return rep;
    } finally {
      busy = false;
    }
  }

  return {
    tick,
    /** sent-back cards no worker is on and the queue does not hold yet, each with the one thing holding it (Hosts). */
    waiting: () => waiting,
    last: () => last,
    afterMin,
  };
}

export type Pickup = ReturnType<typeof createPickup>;
