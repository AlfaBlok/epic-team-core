import type { Context, Hono } from "hono";
import type { Milestone, Store } from "../store.js";
import type { Outcome } from "../adapters/spines.js";
import { appendDecision, sectionRange } from "../approvals.js";
import { oneLine, type SpineWriter } from "../inbox/spineWrite.js";
import type { OutcomeWord, PendingItem } from "./compute.js";
import { settleOnMark } from "./autoSettle.js";
import { currentAuth } from "../auth/identity.js";
import { isHomeOwnerDoor } from "../auth/routeScope.js";
import { ownerName, sites } from "../identity.js";

/**
 * the owner's Outcome mark. Only the owner marks (deck Q1): the console writes the spine's `## Outcome` (Verdict,
 * Outcome sentence, Closed: <date> by the owner, Risk, the `| Done means | Evidence |` table), sets Status done on
 * Accomplished (superseded on Superseded) and adds a Decisions row, through the one spine writer (same guards, lock,
 * commit + push on main). Settle is open only once the outcome is marked.
 */
export type MarkVerdict = "accomplished" | "partially" | "not_accomplished" | "superseded";
export const VERDICT_TEXT: Record<MarkVerdict, string> = {
  accomplished: "accomplished",
  partially: "partially accomplished",
  not_accomplished: "not accomplished",
  superseded: "superseded",
};
/** Outcomes the owner may settle: accomplished, partially, superseded. Reopened / ready to mark / not yet may not. */
export const SETTLE_OK: ReadonlySet<OutcomeWord> = new Set<OutcomeWord>(["accomplished", "partially", "superseded"]);
export const SETTLE_REFUSED = "not accomplished yet: mark the outcome first (Accomplished, Partially or Superseded), then settle";

/**
 * The first plain sentence of an Outcome line, for a card: up to the first ":" or ";" or ". " (links and
 * brackets dropped), cut at 200 characters on a word.
 */
export function plainFinding(sentence: string | null | undefined): string | undefined {
  let t = (sentence ?? "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/https?:\/\/\S+/g, "").replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  const cut = t.search(/[:;]|\.\s/);
  if (cut > 20) t = t.slice(0, cut);
  t = t.replace(/[\s.,;:]+$/, "");
  if (t.length > 200) t = t.slice(0, 200).replace(/\s+\S*$/, "") + "…";
  return t;
}

/** The first link in an Outcome line (its results page), for the card's Open button. */
export const findingLink = (sentence: string | null | undefined): string | undefined => /https?:\/\/[^\s)\]]+/.exec(sentence ?? "")?.[0]?.replace(/[.,;]+$/, "");

/**
 * The Ready to mark card(the owner several times: "I don't know exactly what it is to me and what I'm supposed
 * to reply to"): one plain question naming the goal, what the team found in one line, and what Yes does. Its Yes button
 * marks the goal finished; anything else he says by voice or text.
 */
export const readyToMarkItem = (milestoneId: string, _note?: string, about?: { name?: string; sentence?: string | null; done?: number; total?: number }): PendingItem => {
  const name = about?.name?.trim();
  const found = plainFinding(about?.sentence);
  const link = findingLink(about?.sentence);
  const checks = about?.total ? `${about.done === about.total ? "All" : about.done} ${about.total === 1 ? "check is" : `${about.total} checks are`} ticked. ` : "";
  return {
    id: `ready_to_mark:${milestoneId}`,
    kind: "ready_to_mark",
    state: "open",
    milestoneId,
    title: name ? `Is ${name} finished?` : "Is this goal finished?",
    detail: `${found ? `The team says it is: ${found}. ` : ""}${checks}Yes closes it and its team stops. Not yet: say what is missing.`.replace(/\s+/g, " ").trim(),
    ...(link ? { url: link } : {}),
  };
};

export interface MarkInput {
  verdict: MarkVerdict;
  /** The Outcome sentence (one line). */
  sentence: string;
  risk?: string;
  /** the owner's note: goes to the Decisions row. */
  note?: string;
  evidence: { doneMeans: string; evidence: string }[];
}

const cell = (s: string) => oneLine(s).replace(/\|/g, "/");
const OUTCOME_H = /^outcome\b/i;
const STATE_H = /^current state\b/i;

/** The `## Outcome` section lines (no trailing blank). */
export function outcomeSection(i: MarkInput, date: string): string[] {
  const rows = i.evidence.filter((e) => e.doneMeans.trim() || e.evidence.trim());
  return [
    "## Outcome",
    "",
    `Verdict: ${VERDICT_TEXT[i.verdict]}`,
    `Outcome: ${oneLine(i.sentence)}`,
    `Closed: ${date} by ${ownerName()} (console)`,
    `Risk: ${oneLine(i.risk ?? "") || "none"}`,
    ...(rows.length ? ["", "| Done means | Evidence |", "|---|---|", ...rows.map((e) => `| ${cell(e.doneMeans) || "-"} | ${cell(e.evidence) || "-"} |`)] : []),
  ];
}

/** Spine text with the owner's mark: `## Outcome` replaced in place (else inserted after Current State), Status, Decisions. */
export function writeOutcome(text: string, i: MarkInput, date: string, chat?: string): string {
  const cr = text.includes("\r\n") ? "\r" : "";
  const raw = text.split("\n");
  const block = outcomeSection(i, date).map((l) => l + cr);
  const at = sectionRange(text, OUTCOME_H);
  if (at) {
    let end = at.end;
    while (end > at.head + 1 && raw[end - 1].trim() === "") end--;
    raw.splice(at.head, end - at.head, ...block);
  } else {
    const cs = sectionRange(text, STATE_H);
    if (cs) {
      let end = cs.end;
      while (end > cs.head + 1 && raw[end - 1].trim() === "") end--;
      raw.splice(end, 0, cr, ...block);
    } else {
      while (raw.length && raw[raw.length - 1].trim() === "") raw.pop();
      raw.push(cr, ...block, "");
    }
  }
  let out = raw.join("\n");
  const status = i.verdict === "accomplished" ? "done" : i.verdict === "superseded" ? "superseded" : undefined;
  if (status) out = setStatus(out, status);
  return appendDecision(out, {
    date,
    decision:
      `${ownerName()} via ${chat !== undefined ? "the Team desk" : "console"}: outcome marked ${VERDICT_TEXT[i.verdict]}${status ? `, Status ${status}` : ""}` +
      (chat !== undefined ? ` (desk chat: "${deskQuote(chat)}")` : ""),
    summary: i.note?.trim() || oneLine(i.sentence),
    evidence: "## Outcome",
  });
}

/** The first `Status:` line of Current State set to `status` (the text unchanged when there is none). */
export function setStatus(text: string, status: string): string {
  const cs = sectionRange(text, STATE_H);
  if (!cs) return text;
  const raw = text.split("\n");
  for (let k = cs.head + 1; k < cs.end; k++) {
    const m = /^(\s*(?:[-*]\s+)?(?:\*\*)?Status(?:\*\*)?:(?:\*\*)?\s*)(.*?)(\r?)$/i.exec(raw[k]);
    if (m) {
      raw[k] = `${m[1]}${status}${m[3]}`;
      return raw.join("\n");
    }
  }
  return text;
}

/** Origins that front the console besides its own host (the production site; CONSOLE_ORIGINS adds more, comma-separated). */
export const KNOWN_ORIGINS = (): string[] => [sites().teamUrl];
const knownOrigins = () => [...KNOWN_ORIGINS(), ...(process.env.CONSOLE_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean)].map((o) => o.replace(/\/+$/, "").toLowerCase());

/**
 * the call came from the console page in a browser. `Sec-Fetch-Site: same-origin` when the browser sends it (https,
 * localhost); over plain http to a tailnet IP browsers send no `Sec-Fetch-*`, so then the `Origin` (sent on every POST from a
 * page) must be the request's own origin (its host:port = `Host`) or a known console origin. No Origin, a foreign one, or
 * `Sec-Fetch-Site` other than same-origin is refused.
 */
export function fromConsolePage(header: (name: string) => string | undefined): boolean {
  const site = header("sec-fetch-site");
  if (site !== undefined) return site === "same-origin";
  const origin = header("origin")?.trim().toLowerCase();
  if (!origin || origin === "null") return false;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const own = header("host")?.trim().toLowerCase();
  return (!!own && host === own) || knownOrigins().includes(origin.replace(/\/+$/, ""));
}

/**
 * Only the owner marks: the call must come from the console page in a browser (fromConsolePage) and carry no token or run id
 * (a persona curls the API with its run). Returns why it is refused, or undefined. The console has no login (tailnet only);
 * this is the wall between personas and the mark.
 */
export function notJordi(header: (name: string) => string | undefined): string | undefined {
  if (header("authorization")) return `a token call is not ${ownerName()}: only ${ownerName()} marks an outcome, from the console page`;
  if (header("x-console-run") || header("x-run-id")) return `a persona run cannot mark an outcome: propose it with evidence (Status: review) and ${ownerName()} marks it`;
  if (!fromConsolePage(header)) return `only ${ownerName()} marks an outcome, from the console page in his browser`;
  // the person is the session. An owner session of the world passes (still from the page);
  // a member does not; a browser on legacy trust (tailnet, no login) is today's the owner on the home world and passes as before.
  const a = currentAuth();
  // the owner's own login through the door (a member session of the home world on a customer site) is him.
  if (a?.mode === "on" && a.identity.kind === "session" && a.identity.role !== "owner" && !isHomeOwnerDoor(a.identity))
    return "only the world's owner marks an outcome: this login is a member";
  if (a?.mode === "on" && a.identity.kind !== "session" && a.identity.kind !== "legacy")
    return `only ${ownerName()} marks an outcome, logged in on the console page`;
  return undefined;
}

/** The first 120 characters of the owner's desk message, on one line, safe in a table cell. */
export const deskQuote = (t: string) => t.replace(/\s+/g, " ").trim().replace(/\|/g, "/").replace(/"/g, "'").slice(0, 120);

/**
 * does the owner's desk message ask for this outcome mark? Accomplished: done / accomplished / finished / complete / close;
 * partially: partial; not accomplished: "not accomplished" / failed / reopen; superseded: superseded / replaced. A mark word
 * ("mark", "outcome", "verdict") alone is not enough: the verdict must be in his words.
 */
export function asksForMark(text: string, verdict: MarkVerdict): boolean {
  const t = text.toLowerCase();
  switch (verdict) {
    case "accomplished":
      return !/\bnot (done|accomplished|finished|complete)/.test(t) && /\b(done|accomplished|finished|complete[d]?|close it|closed?)\b/.test(t);
    case "partially":
      return /\bpartial(ly)?\b/.test(t);
    case "not_accomplished":
      return /\bnot (done|accomplished|finished|complete)|\bfailed\b|\breopen/.test(t);
    case "superseded":
      return /\bsuperseded?\b|\breplaced\b/.test(t);
  }
}

/** does the owner's desk message ask to settle (settle / archive / put away / stop working) or to unsettle (unsettle / reopen / bring back)? */
export function asksForSettle(text: string, settled: boolean): boolean {
  const t = text.toLowerCase();
  return settled ? !/\bunsettle/.test(t) && /\bsettle|\barchive|\bput (it )?away\b|\bstop working\b/.test(t) : /\bunsettle|\breopen|\bbring (it )?back\b|\bun-settle/.test(t);
}

export function markIn(raw: unknown, prev?: Outcome | null): MarkInput | string {
  const b = (raw ?? {}) as Record<string, unknown>;
  if (typeof b.verdict !== "string" || !(b.verdict in VERDICT_TEXT)) return `verdict must be one of ${Object.keys(VERDICT_TEXT).join(", ")}`;
  const str = (v: unknown, max: number, what: string) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") return `${what} must be text`;
    if (v.length > max) return `keep ${what} under ${max} characters`;
    return v.trim();
  };
  const sentence = str(b.sentence, 600, "the outcome sentence");
  const risk = str(b.risk, 600, "the risk");
  const note = str(b.note, 600, "the note");
  for (const v of [sentence, risk, note]) if (v?.startsWith("keep ") || v?.endsWith("must be text")) return v;
  const s = sentence || prev?.sentence || "";
  if (!s) return "write the outcome sentence: one line of what was achieved";
  let evidence: MarkInput["evidence"];
  if (b.evidence === undefined) evidence = (prev?.evidence ?? []).map((e) => ({ doneMeans: e.doneMeans, evidence: e.links.join(", ") }));
  else if (!Array.isArray(b.evidence) || b.evidence.length > 50) return "evidence must be a list of { doneMeans, evidence } (at most 50)";
  else {
    evidence = [];
    for (const e of b.evidence as Record<string, unknown>[]) {
      if (!e || typeof e !== "object" || typeof e.doneMeans !== "string" || (e.evidence !== undefined && typeof e.evidence !== "string"))
        return "evidence must be a list of { doneMeans, evidence }";
      evidence.push({ doneMeans: e.doneMeans, evidence: (e.evidence as string | undefined) ?? "" });
    }
  }
  return { verdict: b.verdict as MarkVerdict, sentence: s, ...(risk !== undefined ? { risk } : prev?.risk ? { risk: prev.risk } : {}), ...(note ? { note } : {}), evidence };
}

export interface MarkOptions {
  store: Store;
  spine: SpineWriter;
  /** Repo checkout + spine path + the current `## Outcome` of the milestone. */
  locate: (m: Milestone) => Promise<{ repoDir?: string; rel?: string; outcome?: Outcome | null }>;
  invalidate: (repoDir: string) => void;
  /** The milestone's status after the write (its outcome word decides the settle). */
  status: (m: Milestone) => Promise<{ outcome: { word: OutcomeWord } }>;
  /** the owner's newest desk message containing `chat` (or why not); absent = no desk mark route. */
  deskAsk?: (chat: string) => Promise<{ text: string; at: string } | string>;
  /** settle through the team repo's state/milestones.json first; a write that fails leaves it unsettled. */
  settle?: (id: string) => Promise<Milestone | undefined>;
}

export function mountMark(api: Hono, o: MarkOptions) {
  const err = (c: Context, status: 400 | 403 | 404 | 409 | 502, code: string, message: string) => c.json({ error: { code, message } }, status);
  /** Write ## Outcome, Status and a Decisions row; `chat` = the owner's desk message when the Team desk marks for him. */
  const mark = async (c: Context, m: Milestone, body: unknown, chat?: string) => {
    const { repoDir, rel, outcome } = await o.locate(m);
    const input = markIn(body, outcome);
    if (typeof input === "string") return err(c, 400, "validation_error", input);
    if (chat !== undefined && !asksForMark(chat, input.verdict))
      return err(c, 403, "not_asked", `${ownerName()}'s newest desk message does not ask for ${VERDICT_TEXT[input.verdict]}: he says it here, or marks it on the console page`);
    const via = chat !== undefined ? "asking the Team desk" : "via console";
    if (!repoDir || !rel) return err(c, 409, "conflict", "the milestone has no spine file in a checkout: nothing written");
    const w = await o.spine.edit({
      repoDir,
      path: rel,
      label: "outcome",
      edit: (text, date) => ({
        text: writeOutcome(text, input, date, chat),
        msg: `Outcome marked ${VERDICT_TEXT[input.verdict]} (${ownerName()}, ${via})`,
        body: `${oneLine(input.sentence).slice(0, 300)}\n\n${ownerName()} marked the outcome ${chat !== undefined ? "by asking the Team desk" : "on the console milestone page"}; the console wrote ## Outcome${input.verdict === "accomplished" ? ", Status done" : input.verdict === "superseded" ? ", Status superseded" : ""} and a Decisions row in ${rel}.`,
      }),
    });
    if (w.status !== "written") return err(c, w.status === "failed" ? 502 : 409, w.status === "failed" ? "git_failed" : "conflict", `nothing written: ${w.reason ?? w.status}`);
    o.invalidate(repoDir);
    const st = await o.status(m);
    // the owner's mark of Accomplished / Partially / Superseded also settles, so its personas stop waking (Unsettle in Settings).
    // a settle the team repo refused leaves it unsettled (the mark itself is written); Settle in Settings retries.
    const settled = await settleOnMark(o.store, m, input.verdict, st.outcome?.word, o.settle).catch((e) => (console.warn(`mark ${m.id}: not settled: ${(e as Error).message}`), false));
    return c.json({ verdict: input.verdict, path: rel, ...(w.sha ? { sha: w.sha } : {}), settled, status: st }, 201);
  };
  const json = async (c: Context) => {
    try {
      return { ok: true as const, body: (await c.req.json()) as unknown };
    } catch {
      return { ok: false as const };
    }
  };

  api.post("/milestones/:id/mark", async (c) => {
    const m = o.store.getMilestone(c.req.param("id"));
    if (!m) return err(c, 404, "not_found", `milestone ${c.req.param("id")} not found`);
    const refused = notJordi((n) => c.req.header(n));
    if (refused) return err(c, 403, "jordi_only", refused);
    const b = await json(c);
    if (!b.ok) return err(c, 400, "invalid_json", "request body must be valid JSON");
    return mark(c, m, b.body);
  });

  /**
   * the Team desk marks an outcome on the owner's own chat request, the same check as the desk stamp:
   * only the desk's header (never a token, a run id, a milestone chat), and only when his newest desk message (under 15 min)
   * holds `chat` and names the verdict. Milestone chats keep refusing.
   */
  api.post("/desk/mark", async (c) => {
    const refused = deskOnly((n) => c.req.header(n));
    if (refused) return err(c, 403, "desk_only", refused);
    if (!o.deskAsk) return err(c, 403, "desk_only", "the Team desk is not available on this console");
    const b = await json(c);
    if (!b.ok) return err(c, 400, "invalid_json", "request body must be valid JSON");
    const { milestoneId, chat, ...rest } = (b.body ?? {}) as Record<string, unknown>;
    if (typeof milestoneId !== "string") return err(c, 400, "validation_error", "milestoneId is required");
    if (typeof chat !== "string") return err(c, 400, "validation_error", `chat (${ownerName()}'s words from his desk message, verbatim) is required`);
    const m = o.store.getMilestone(milestoneId);
    if (!m) return err(c, 404, "not_found", `milestone ${milestoneId} not found`);
    const ask = await o.deskAsk(chat);
    if (typeof ask === "string") return err(c, 403, "not_asked", `${ask}: the desk marks only on ${ownerName()}'s own newest message`);
    return mark(c, m, rest, ask.text);
  });
}

/** why a call is not the Team desk's own (header X-Console-Run: team-desk, no token, no run id), or undefined. */
export function deskOnly(header: (name: string) => string | undefined): string | undefined {
  if (header("authorization") || header("x-run-id") || (header("x-console-run") ?? "").trim().toLowerCase() !== "team-desk")
    return `only the Team desk acts from chat on ${ownerName()}'s own request (header X-Console-Run: team-desk); a milestone chat or a persona never does: ${ownerName()} does it on the console page`;
  return undefined;
}
