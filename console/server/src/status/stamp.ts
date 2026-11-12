import type { Context, Hono } from "hono";
import type { Milestone, Store } from "../store.js";
import { appendDecision, sectionRange } from "../approvals.js";
import { statusWordOf } from "../adapters/tree.js";
import type { SpineWriter } from "../inbox/spineWrite.js";
import { deskQuote, notJordi, setStatus } from "./mark.js";
import { normSaid, VOICE_NOTE_MAX_MS } from "../desk/desk.js";
import type { MemoryEntry, MemoryLookup } from "../plug/memory.js";
import { memoryName, memoryPattern, ownerName } from "../identity.js";

/**
 * only the owner stamps a Planning (draft) epic ready for delivery, and only he moves it back.
 * (root L-37): his ask is also his stamp, so a ready Add (status/add.ts) and an agent readying what he asked for, with a
 * Decisions row citing his words (cycle/selfReady.ts), are his stamp too; agents never ready their own ideas.
 * The console writes `Status: ready` (or `draft`) in Current State and a Decisions row through the one spine writer;
 * the same the owner-only wall as the Outcome mark: browser page only, 403 with a token or a run id.
 */
export type StampTo = "ready" | "draft";

/** The first Current State `Status:` value, or undefined when there is none. */
export function currentStatus(text: string): string | undefined {
  const cs = sectionRange(text, /^current state\b/i);
  if (!cs) return undefined;
  const raw = text.split("\n");
  for (let k = cs.head + 1; k < cs.end; k++) {
    const m = /^\s*(?:[-*]\s+)?(?:\*\*)?Status(?:\*\*)?:(?:\*\*)?\s*(.*?)\r?$/i.exec(raw[k]);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Spine text stamped `to`, or why not: ready needs a draft spine, draft needs a ready one. `chat` = the owner's desk message,
 * or with `note` his words quoted from that voice note.
 */
export function writeStamp(text: string, to: StampTo, date: string, chat?: string, note?: string): string | { skip: string } {
  const cur = currentStatus(text);
  if (cur === undefined) return { skip: "the spine has no Current State Status line" };
  const word = statusWordOf(cur);
  const from: StampTo = to === "ready" ? "draft" : "ready";
  if (word !== from) return { skip: `Status is ${cur || "empty"}, not ${from}: ${to === "ready" ? "only a Planning (draft) epic is stamped ready" : "only a ready epic moves back to Planning"}` };
  return appendDecision(setStatus(text, to), {
    date,
    decision: (to === "ready" ? `stamped ready by ${ownerName()} ${date}` : `moved back to Planning (draft) by ${ownerName()} ${date}`) + (chat === undefined ? "" : note ? ` (voice note ${note}: "${deskQuote(chat)}")` : ` (desk chat: "${deskQuote(chat)}")`),
    summary:
      to === "ready"
        ? `${ownerName()} released it for delivery ${how(chat, note)}: the next standing wake may start it`
        : `${ownerName()} took it back to Planning ${how(chat, note)}: no wake works it`,
  });
}

const how = (chat?: string, note?: string) => (chat === undefined ? "from the console" : note ? "in his voice note" : "by asking the Team desk");

export { deskQuote };

/** does the owner's message ask for this stamp? Ready: "ready" / "go"; back: "planning" / "draft" / "back" / "not ready". */
export function asksFor(text: string, to: StampTo): boolean {
  return to === "ready" ? /\bready\b|\bgo\b/i.test(text) : /\bplanning\b|\bdraft\b|\bback\b|\bnot ready\b|\bunready\b/i.test(text);
}

/**
 * does `text` hold a stamp REQUEST, not just the word? A note says "ready" for many things ("the landing pages ready",
 * "this article is ready for you"); only an ask to release (or take back) the work counts.
 */
const OBJ = String.raw`(?:(?:it|them|this|these|that|those|us|everything|all(?: of)?(?: (?:this|these|them|it))?)\s+)?`;
const REQUEST: Record<StampTo, RegExp[]> = {
  ready: [
    /\bready for (?:work|delivery|development|dev|implementation)\b/,
    new RegExp(String.raw`\b(?:mark|put|make|set|stamp|move|switch|turn)\s+${OBJ}(?:(?:in|as|to|into)\s+)?ready\b`),
    /\bgo ahead\b/,
  ],
  draft: [
    new RegExp(String.raw`\b(?:put|move|take|send|set|mark)\s+${OBJ}(?:back\s+)?(?:(?:in|into|to|as)\s+)?(?:a\s+)?(?:draft|planning)\b`),
    /\bback (?:in|into|to) (?:draft|planning)\b/,
    /\b(?:un-?ready|unstamp)\b/,
  ],
};
/** "Don't put it in draft" asks for ready; otherwise a negated clause ("don't mark it ready", "it's not ready for work") asks for nothing. */
const DONT_DRAFT = /\b(?:don'?t|do not|never)\s+(?:put|leave|keep)\s+(?:(?:it|them|this|these|that|those)\s+)?(?:in|as)\s+(?:a\s+)?drafts?\b/;
const NEGATED = /\b(?:don'?t|do not|never|not)\s+(?:(?:yet|be)\s+)?(?:put|move|take|send|set|mark|make|stamp|leave|keep|go|ready)\b[^.!?;,]*/g;
export function requestsStamp(text: string, to: StampTo): boolean {
  const t = normSaid(text);
  if (to === "ready" && DONT_DRAFT.test(t)) return true;
  const plain = t.replace(NEGATED, " ");
  return REQUEST[to].some((r) => r.test(plain));
}

/** the memory service sources only the owner captures (his WhatsApp number); never `mcp` / `cli` / `web`, which an agent could have written. */
export const JORDI_NOTE_SOURCES = ["whatsapp"];
/** An evidenceRef names one entry of a log note (`Log/<date>.md#^e-<id>`), never a whole note. */
const EVIDENCE_REF = /^[\w./ -]+\.md#\^e-[0-9a-z]+$/i;

/** may the owner's voice note `entry` stamp `to` with `chat` (his words from it)? undefined = yes, else why not. */
export function noteRefusal(entry: MemoryEntry, ref: string, chat: string, to: StampTo, now: number): string | undefined {
  if (entry.evidenceRef !== undefined && entry.evidenceRef !== ref) return `${memoryName()} returned ${entry.evidenceRef}, not ${ref}`;
  if (!JORDI_NOTE_SOURCES.includes(entry.source ?? ""))
    return `${ref} is not ${ownerName()}'s own capture (source ${entry.source ?? "unknown"}; only ${JORDI_NOTE_SOURCES.join(", ")} counts, never an entry an agent wrote)`;
  const at = Date.parse(entry.capturedAt ?? "");
  if (!Number.isFinite(at)) return `${ref} has no capture time`;
  if (now - at > VOICE_NOTE_MAX_MS) return `${ref} was captured ${entry.capturedAt}, more than ${VOICE_NOTE_MAX_MS / 3_600_000} h ago`;
  const want = normSaid(chat);
  if (want.length < 8) return `chat (${ownerName()}'s words from the note, verbatim) is required`;
  if (!normSaid(entry.content ?? "").includes(want)) return `chat is not in ${ref}`;
  if (!requestsStamp(chat, to))
    return to === "ready"
      ? `"${deskQuote(chat)}" is not a ready request (e.g. "put it in ready for work", "mark them ready"); a bare "ready" does not stamp`
      : `"${deskQuote(chat)}" does not ask to move it back to Planning (e.g. "put it back in draft")`;
  return undefined;
}

const voiceNoteTalk = () => new RegExp(`\\bvoice ?notes?\\b|\\b${memoryPattern().toLowerCase()}\\b|\\bmemory\\b|\\bthe note\\b`);

export interface StampOptions {
  store: Store;
  spine: SpineWriter;
  /** The milestone's checkout and spine path. */
  locate: (m: Milestone) => Promise<{ repoDir?: string; rel?: string }>;
  /** Repo-relative spine paths in the milestone's tree (a child epic is stamped from its Tree row). */
  treePaths: (m: Milestone) => Promise<Set<string>>;
  invalidate: (repoDir: string) => void;
  /** the owner's newest desk message containing `chat` (or why not); absent = no desk stamp route. */
  deskAsk?: (chat: string) => Promise<{ text: string; at: string } | string>;
  /** read the memory service entry by evidenceRef (absent = the voice-note route is off). */
  memory?: MemoryLookup;
  now?: () => number;
}

export function mountStamp(api: Hono, o: StampOptions) {
  const err = (c: Context, status: 400 | 403 | 404 | 409 | 502, code: string, message: string) => c.json({ error: { code, message } }, status);
  const body = async (c: Context) => {
    try {
      return ((await c.req.json()) ?? {}) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  };
  /** Validate `to` / `path`, then write Status + a Decisions row through the one spine writer. */
  const stamp = async (c: Context, m: Milestone, b: Record<string, unknown>, chat?: string, note?: string) => {
    if (b.to !== "ready" && b.to !== "draft") return err(c, 400, "validation_error", "to must be ready or draft");
    if (b.path !== undefined && typeof b.path !== "string") return err(c, 400, "validation_error", "path must be a repo-relative spine path");
    const to = b.to as StampTo;
    if (chat !== undefined && !note && !asksFor(chat, to))
      return err(c, 403, "not_asked", `${ownerName()}'s newest desk message does not ask for ${to === "ready" ? "ready" : "Planning"}: he says it here, or taps it on the console page`);
    const { repoDir, rel } = await o.locate(m);
    if (!repoDir || !rel) return err(c, 409, "conflict", "the milestone has no spine file in a checkout: nothing written");
    const path = (b.path as string | undefined)?.trim().replace(/^\.\//, "") || rel;
    if (path !== rel && !(await o.treePaths(m)).has(path)) return err(c, 400, "validation_error", `${path} is not a spine in this milestone's tree`);
    const via = chat === undefined ? "via console" : note ? "his voice note" : "asking the Team desk";
    const w = await o.spine.edit({
      repoDir,
      path,
      label: "stamp",
      edit: (text, date) => {
        const out = writeStamp(text, to, date, chat, note);
        if (typeof out !== "string") return out;
        return {
          text: out,
          msg: to === "ready" ? `Stamped ready for delivery (${ownerName()}, ${via})` : `Moved back to Planning (${ownerName()}, ${via})`,
          body: `${ownerName()} ${to === "ready" ? "stamped the epic ready" : "moved the epic back to Planning"} (${via}): Status ${to} and a Decisions row in ${path}.`,
        };
      },
    });
    if (w.status !== "written") return err(c, w.status === "failed" ? 502 : 409, w.status === "failed" ? "git_failed" : "conflict", `nothing written: ${w.reason ?? w.status}`);
    o.invalidate(repoDir);
    return c.json({ to, path, ...(w.sha ? { sha: w.sha } : {}) }, 201);
  };

  api.post("/milestones/:id/stamp", async (c) => {
    const m = o.store.getMilestone(c.req.param("id"));
    if (!m) return err(c, 404, "not_found", `milestone ${c.req.param("id")} not found`);
    const refused = notJordi((n) => c.req.header(n));
    if (refused) return err(c, 403, "jordi_only", refused.replace(/marks? an outcome/g, "stamps ready").replace(/marks it/, "stamps it"));
    const b = await body(c);
    if (!b) return err(c, 400, "invalid_json", "request body must be valid JSON");
    return stamp(c, m, b);
  });

  /**
   * the Team desk stamps on the owner's own chat request. Only the desk's header (X-Console-Run: team-desk), never a
   * token, a run id or another caller; and only when the owner's newest desk message (under 15 min old) holds `chat` and asks for it.
   */
  api.post("/desk/stamp", async (c) => {
    if (c.req.header("authorization") || c.req.header("x-run-id") || (c.req.header("x-console-run") ?? "").trim().toLowerCase() !== "team-desk")
      return err(c, 403, "desk_only", `only the Team desk stamps from chat (on ${ownerName()}'s own request); personas never stamp ready, ${ownerName()} taps it on the console page`);
    if (!o.deskAsk) return err(c, 403, "desk_only", "the Team desk is not available on this console");
    const b = await body(c);
    if (!b) return err(c, 400, "invalid_json", "request body must be valid JSON");
    if (typeof b.milestoneId !== "string") return err(c, 400, "validation_error", "milestoneId is required");
    if (typeof b.chat !== "string") return err(c, 400, "validation_error", `chat (${ownerName()}'s words from his desk message, verbatim) is required`);
    const m = o.store.getMilestone(b.milestoneId);
    if (!m) return err(c, 404, "not_found", `milestone ${b.milestoneId} not found`);
    if (b.source !== undefined) {
      // the owner's own voice note is his stamp, verified here (never trusted from the desk): his capture, < 24 h, a request.
      const ref = (b.source as { memory?: unknown } | null)?.memory;
      if (typeof ref !== "string" || !EVIDENCE_REF.test(ref.trim()))
        return err(c, 400, "validation_error", "source is {memory: \"<evidenceRef>\"}, e.g. Log/2026-11-01.md#^e-876431 (one entry, not a whole note)");
      if (b.to !== "ready" && b.to !== "draft") return err(c, 400, "validation_error", "to must be ready or draft");
      if (!o.memory) return err(c, 403, "not_asked", `${memoryName()} is not wired on this console: the desk stamps only on ${ownerName()}'s chat message here`);
      const got = await o.memory(ref.trim());
      if ("error" in got)
        return got.unreachable
          ? err(c, 502, "memory_unavailable", `${got.error}: the console could not read the voice note, nothing written (try again, or ${ownerName()} says it in the desk chat)`)
          : err(c, 403, "not_asked", `${got.error}: nothing written`);
      const refused = noteRefusal(got.entry, ref.trim(), b.chat, b.to, (o.now ?? Date.now)());
      if (refused) return err(c, 403, "not_asked", `${refused}: nothing written`);
      return stamp(c, m, b, b.chat, ref.trim());
    }
    const ask = await o.deskAsk(b.chat);
    if (typeof ask === "string") return err(c, 403, "not_asked", `${ask}: the desk stamps only on ${ownerName()}'s own newest message`);
    // "read my voice note and go" is an ask to act on the note, not a stamp: the note's words (source.memory) or a real request here
    if (voiceNoteTalk().test(normSaid(ask.text)) && (b.to === "ready" || b.to === "draft") && !requestsStamp(ask.text, b.to))
      return err(c, 403, "not_asked", `${ownerName()}'s message asks to act on a voice note, which is not a stamp by itself: cite the note (source.memory with his words from it), or he asks for it here`);
    return stamp(c, m, b, ask.text);
  });
}
