import { createHash } from "node:crypto";
import type { DB } from "../db.js";
import type { Store } from "../store.js";
import { isDm } from "../inbox/waiting.js";
import type { RelaunchCycle, ReviewItem } from "./review.js";
import { homeRepo, ownerName } from "../identity.js";

/**
 * a row in review that is not a card for the owner goes back to the agents: it closes itself (no `confirm: yes`,
 * its ask answered, its next steps already run, an example for another card), it needs evidence (GitHub only, a dry run, a
 * dead link) or its card needs rewriting (the plain-language gate). the owner never sees these. The milestone's Delivery
 * manager is woken once per new item (deduped here, `review_agent_wake`, ops) with every such item of its milestone, so it
 * fixes the card fields or closes the row in the spine. A switched-off or paused Delivery manager is never woken (L-10);
 * its items wait for its next wake.
 */
export interface AgentWakeDeps {
  db: DB;
  store: Pick<Store, "listAssignments" | "getPersona" | "getMilestone">;
  agents: () => Promise<ReviewItem[]>;
  /** close the rows that close themselves in the spine first (the rest still wake the Delivery manager). */
  closeSelf?: () => Promise<unknown>;
  cycle?: RelaunchCycle;
  log?: (m: string) => void;
}

export function ensureAgentWake(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_agent_wake (
      item_key TEXT PRIMARY KEY,
      milestone_id TEXT NOT NULL,
      run_id TEXT,
      seen_at TEXT NOT NULL
    );
  `);
}

/** One line per item: what the agents must do with it. */
export function agentLine(i: ReviewItem): string {
  const v = i.verdict;
  const what =
    v.kind === "closes-itself"
      ? `closes itself (${v.reason}): set its status \`done (no confirm: <why, plain words>)\``
      : v.kind === "needs-evidence"
        ? `needs evidence: ${v.reason}. Put the live thing or an evidence page in its card's \`evidence:\` (never GitHub, never a dry run)`
        : v.kind === "needs-rewriting"
          ? `card needs rewriting: ${(v.problems ?? [v.reason ?? ""]).join("; ")}`
          : i.state === "pending_live"
            ? `its evidence link is being checked${i.liveError ? `: ${i.liveError}` : ""}`
            : v.reason ?? v.kind;
  return `${i.ref} (${i.repo} ${i.path}${i.cardPath ? `, card ${i.cardPath}` : ""}): ${what}`;
}

const keyOf = (i: ReviewItem) => createHash("sha1").update([i.repo, i.path, i.ref, i.verdict.kind, i.verdict.reason ?? "", ...(i.verdict.problems ?? [])].join("\0")).digest("hex").slice(0, 24);

export function createAgentWake(d: AgentWakeDeps) {
  ensureAgentWake(d.db);
  const seen = (k: string) => !!d.db.prepare("SELECT 1 FROM review_agent_wake WHERE item_key = ?").get(k);
  const mark = (k: string, mid: string, run: string | undefined) =>
    d.db.prepare("INSERT OR IGNORE INTO review_agent_wake (item_key, milestone_id, run_id, seen_at) VALUES (?, ?, ?, ?)").run(k, mid, run ?? null, new Date().toISOString());

  function dmOf(milestoneId: string): string | undefined {
    const m = d.store.getMilestone(milestoneId);
    if (!m || m.paused) return undefined;
    const a = d.store.listAssignments({ milestoneId }).find((x) => x.enabled && !x.parkedAt && isDm(d.store.getPersona(x.personaId)?.name));
    return a?.id;
  }

  /** Wake each milestone's Delivery manager that has new items (once per item). Returns the milestones woken. */
  async function sweep(): Promise<string[]> {
    if (d.closeSelf) await d.closeSelf().catch((e) => d.log?.(`review gate: closing rows failed: ${e instanceof Error ? e.message : String(e)}`));
    if (!d.cycle) return [];
    // an evidence link not checked yet is not a problem yet
    const items = (await d.agents()).filter((i) => i.verdict.kind !== "card" && i.verdict.kind !== "test" && i.milestoneId);
    const by = new Map<string, ReviewItem[]>();
    for (const i of items) by.set(i.milestoneId!, [...(by.get(i.milestoneId!) ?? []), i]);
    const woken: string[] = [];
    for (const [mid, list] of by) {
      const fresh = list.filter((i) => !seen(keyOf(i)));
      if (!fresh.length) continue;
      const dm = dmOf(mid);
      if (!dm) continue;
      const text = [
        `Review gate: ${list.length} row(s) in review are not cards for ${ownerName()}, so he does not see them. Fix each one in the spine and its card file (format: docs/review-cards.md in ${homeRepo()}), or close it:`,
        ...list.map((i) => `- ${agentLine(i)}`),
        "A row becomes his card again once its card fields pass the gate; nothing here needs his answer.",
      ]
        .join("\n")
        .slice(0, 4000);
      try {
        const r = await d.cycle.runNowRequest(dm, { instructions: text, instructionsBy: "review gate" }, `review-gate:${createHash("sha1").update(fresh.map(keyOf).join(",")).digest("hex").slice(0, 16)}`);
        for (const i of fresh) mark(keyOf(i), mid, r.run.id);
        woken.push(mid);
      } catch (e) {
        d.log?.(`review gate: wake of ${dm} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return woken;
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  let closer: ReturnType<typeof setInterval> | undefined;
  return {
    sweep,
    /** `closeEveryMs`: rows that close themselves are written done this often, between sweeps. */
    start(everyMs: number, closeEveryMs?: number) {
      if (timer) return;
      timer = setInterval(() => void sweep().catch((e) => d.log?.(`review gate sweep: ${e instanceof Error ? e.message : String(e)}`)), everyMs);
      timer.unref?.();
      if (d.closeSelf && closeEveryMs) {
        closer = setInterval(() => void d.closeSelf!().catch((e) => d.log?.(`review gate: closing rows failed: ${e instanceof Error ? e.message : String(e)}`)), closeEveryMs);
        closer.unref?.();
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      if (closer) clearInterval(closer);
      timer = closer = undefined;
    },
  };
}
