import type { DB } from "../db.js";
import { CALL_PAGE, wholeCallRequestId, wholeCallText, type CallLine, type DeskPort } from "./voice.js";

/**
 * Every call's whole transcript lands on its desk once . The owner on his strategy call (call_33379122), asked whether
 * the desk sees the full call: "I want that answer to become yes."
 *
 *   call ends ──▶ the page sends its lines ──▶ whole-call post on the call's desk (voice.ts end)
 *        │
 *        └─ drop / timeout / closed tab (no lines came) ──▶ this catch-up, every minute:
 *              lines kept on the call, else ElevenLabs' own transcript of it ──▶ the same post, once (its request id)
 *
 * The desk is the call's scope: a campaign's chat, a world's desk, else the Team desk (objective and product calls too).
 * A test call (`test…` end reason) never posts. A call with no words after WHOLE_GIVE_UP_MS is marked `none: …` and left.
 */
export const WHOLE_SINCE = "2026-11-27T00:00:00.000Z";
/** a call ended this long ago and still without its post is caught up (the page's own end posts at once). */
export const WHOLE_SETTLE_MS = 45_000;
/** ElevenLabs may need a little while to hold a dropped call's transcript; after this, a call with no words is left. */
export const WHOLE_GIVE_UP_MS = 30 * 60_000;

export type ElevenRead = (agentId: string, startedAt: string) => Promise<{ conversationId: string; lines: CallLine[] } | undefined>;

type Row = { id: string; tenant_id: string | null; milestone_id: string | null; started_at: string; ended_at: string; end_reason: string | null; model: string; session_id: string | null; cost_usd: number; transcript: string | null };

export function createWholeCall(o: { db: DB; deskOf: (call: { tenant_id: string | null; milestone_id: string | null }) => DeskPort | undefined; eleven?: ElevenRead; onRecovered?: (id: string) => void; now?: () => number; since?: string }) {
  const { db } = o;
  const now = () => o.now?.() ?? Date.now();
  let running = false;
  async function tick(): Promise<string[]> {
    if (running) return [];
    running = true;
    const posted: string[] = [];
    try {
      const due = db
        .prepare(
          `SELECT id, tenant_id, milestone_id, started_at, ended_at, end_reason, model, session_id, cost_usd, transcript FROM voice_calls
             WHERE ended_at IS NOT NULL AND whole_posted_at IS NULL AND ended_at >= ? AND ended_at <= ? AND COALESCE(end_reason, '') NOT LIKE 'test%'
             ORDER BY ended_at LIMIT 10`,
        )
        .all(o.since ?? WHOLE_SINCE, new Date(now() - WHOLE_SETTLE_MS).toISOString()) as Row[];
      for (const r of due) {
        let lines: CallLine[] = [];
        try {
          lines = r.transcript ? (JSON.parse(r.transcript) as CallLine[]) : [];
        } catch {
          lines = [];
        }
        let recovered = false;
        if (!lines.length && o.eleven && r.session_id?.startsWith("agent_")) {
          try {
            const got = await o.eleven(r.session_id, r.started_at);
            if (got?.lines.length) {
              lines = got.lines;
              recovered = true;
              db.prepare("UPDATE voice_calls SET transcript = ? WHERE id = ? AND transcript IS NULL").run(JSON.stringify(lines.slice(0, 600)), r.id);
              console.log(`[voice] ${r.id} (${r.end_reason}): ${lines.length} lines read back from ElevenLabs (${got.conversationId})`);
            }
          } catch (e) {
            console.warn(`[voice] ${r.id}: ElevenLabs transcript not read yet (${(e as Error).message.slice(0, 120)})`);
          }
        }
        const asked = (db.prepare("SELECT COUNT(*) n FROM voice_asks WHERE call_id = ?").get(r.id) as { n: number }).n;
        if (!lines.length && !asked) {
          if (now() - Date.parse(r.ended_at) >= WHOLE_GIVE_UP_MS) db.prepare("UPDATE voice_calls SET whole_posted_at = ? WHERE id = ?").run(`none: no words (${r.end_reason ?? "ended"})`, r.id);
          continue;
        }
        const desk = o.deskOf(r);
        if (!desk) continue;
        const seconds = Math.max(0, Math.round((Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000));
        try {
          await desk.send(wholeCallText(db, { id: r.id, startedAt: r.started_at, seconds, costUsd: r.cost_usd, model: r.model, endReason: r.end_reason ?? undefined }, lines), CALL_PAGE, wholeCallRequestId(r.id));
        } catch (e) {
          db.prepare("UPDATE voice_calls SET transcript_error = ? WHERE id = ?").run((e as Error).message.slice(0, 300), r.id);
          continue;
        }
        const t = new Date(now()).toISOString();
        db.prepare("UPDATE voice_calls SET whole_posted_at = ?, transcript_posted_at = COALESCE(transcript_posted_at, ?), transcript_error = NULL WHERE id = ?").run(t, t, r.id);
        console.log(`[voice] ${r.id} (${r.end_reason}): whole transcript on its desk (${lines.length} lines)`);
        if (recovered) o.onRecovered?.(r.id);
        posted.push(r.id);
      }
    } finally {
      running = false;
    }
    return posted;
  }
  return { tick };
}
