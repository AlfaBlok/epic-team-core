import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "@/api";
import type { SocialData, SocialWriteAction, SocialWriteResult } from "@/api/types";
import { forgetLegacyDecisions } from "@/lib/social";
import { useSocial } from "@/lib/useSocial";
import { useCampaignScope } from "@/lib/campaign";
import { useProject } from "@/lib/project";

/** What the last click did: the commit it made, or why the pack refused it (every issue line). */
export type WriteUndo = { label: string; run: () => unknown };
export type WriteNote = ({ ok: true; text: string; undo?: WriteUndo } | { ok: false; text: string; issues?: string[] }) & {
  /** which control the click came from (`scopeOf`), so the result shows next to it, not only at the page's edge. */
  scope?: string;
};

/** the card or control a write belongs to: `P-0006` (a post's actions), `P-0006#feedback` (its feedback box), `approval`, `directions`. */
export function scopeOf(action: string): string | undefined {
  const m = /^posts\/([^/]+)\/(.+)$/.exec(action);
  if (m) return m[2] === "feedback" ? `${m[1]}#feedback` : m[1];
  // a DM reply's buttons answer under the reply (`M-0002`), a chat's under the chat (`C-0003`).
  const dm = /^(?:messages|chats)\/([^/]+)\/[a-z]+$/.exec(action);
  if (dm) return dm[1];
  // the Pipeline's Ideas lane: Add idea (`ideas`), an idea's Edit and Park (`I-3`).
  const idea = /^ideas(?:\/([^/]+?))?(?:\/drop|\/feedback)?$/.exec(action);
  if (idea) return idea[1] ?? "ideas";
  return action === "approval" || action === "directions" ? action : undefined;
}

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : null);

const at = (slot: unknown) => (typeof slot === "string" && slot.length > 10 ? `${slot.slice(0, 10)} ${slot.slice(11, 16)} UTC` : String(slot || "its slot"));

/** what a post click did, in the owner's words (the action name otherwise). */
const SAID: Record<string, (id: string, r: SocialWriteResult) => string> = {
  approve: (id, r) => (r.wake && "runId" in r.wake ? `${id} goes out now: the Publisher is posting it` : `${id} is scheduled: it goes out at ${at(r.info?.slot)}`),
  "post now": (id) => `${id} goes out now: the Publisher is posting it`,
  "idea feedback": (id) => `Your feedback on ${id} is with the Scout: it rewrites the idea`,
  "approve with feedback": (id) => `${id} goes to the Writer, then out without asking you again`,
  revise: (id) => `${id} is with the Writer: a new version comes back here for your review, nothing is posted`,
  drop: (id) => `${id} won't be posted`,
  pull: (id, r) => (r.info?.effect === "unschedule" ? `${id} won't go out` : `${id} is pulled`),
  // Undo puts back what was there before, with its slot; a slot that passed meanwhile is said, never a silent hold.
  restore: (id, r) =>
    r.info?.slotPassed
      ? `${id} is back, but its slot (${at(r.info.slot)}) has passed: post it now or pick a new time on its card`
      : r.info?.status === "scheduled"
        ? `${id} is back on schedule: it goes out at ${at(r.info.slot)}`
        : r.info?.status === "draft"
          ? `${id} is back as a draft`
          : `${id} is back, waiting for your review`,
  text: (id) => `${id} now has your text, word for word`,
  // Force review: yes / no (the hold rule `Kind: post`); yes also holds posts scheduled without your review.
  "approval on": (_id, r) => {
    const held = Array.isArray(r.info?.held) ? (r.info.held as string[]) : [];
    return `Auto-approve is off: every new post waits in Drafts for you${held.length ? `. ${held.join(", ")} moved back to Drafts` : ""}`;
  },
  "approval off": () => "Auto-approve is on: posts that pass their checks go out at their slot",
  // feedback on a live post reaches the Writer for the next ones.
  feedback: (id, r) => (r.wake && "runId" in r.wake ? `Your feedback on ${id} is with the Writer for the next posts` : `Your feedback on ${id} is saved in the Feedback log`),
  // DM replies and chats (the mockup's words).
  send: (id, r) => (r.wake && "runId" in r.wake ? `Approved. The Responder sends ${id} now (dry run first)` : `Approved: ${id} goes out on the Responder's next wake`),
  "message revise": (id) => `${id} is with the Responder: a new version comes back here for your review, nothing is sent`,
  "message drop": (id) => `${id} won't be sent`,
  "message restore": (id, r) => (r.info?.was === "scheduled" ? `${id} is not sent: it waits for your Send again` : `${id} is back, waiting for your Send`),
  "message text": (id) => `${id} now has your text, word for word. It still waits for your Send`,
  "chat draft": (id) => `The Responder drafts a reply for ${id}. It comes back here for your review. Nothing is sent`,
  "chat accept": (id) => `The Responder accepts the request and drafts a reply for ${id}. Nothing is sent`,
  "chat done": () => `Done, no reply. Moved to Done`,
  "chat reopen": (id, r) => `${id} is back${r.info?.state === "left" ? " with the chats left by rule" : ""}`,
  "chat undo": (id) => `${id} is back as it was: no draft asked`,
};

/** One line for a write that went through: what it did, commit, push, and the persona it woke. */
export function describeWrite(r: SocialWriteResult): string {
  const parts = [r.commit ? `saved as ${short(r.commit)}` : "nothing changed"];
  if (r.commit && r.push.state !== "skipped") parts.push(r.push.state === "failed" ? `push failed${r.push.detail ? `: ${r.push.detail}` : ""}` : r.push.state);
  if (r.wake) {
    const role = "runId" in r.wake ? (r.wake.role ?? "Publisher") : /\bWriter\b/.test(r.wake.error) ? "Writer" : /\bScout\b/.test(r.wake.error) ? "Scout" : /\bResponder\b/.test(r.wake.error) ? "Responder" : "Publisher";
    if (!("runId" in r.wake)) parts.push(`${role} not woken: ${r.wake.error}`);
    else parts.push(role !== "Publisher" ? `${role} woken` : /(^|\/)pull$/.test(r.action) ? "Publisher woken to delete the live post" : "Publisher woken");
  }
  const said = r.commit && SAID[r.action];
  return `${said ? said(r.id, r) : r.action}: ${parts.join(" · ")}`;
}

/** Don't post gets an Undo on the line that says it is done; so does Pull of a post that never went out. */
export const undoOf = (w: SocialWriteAction, r: SocialWriteResult, write: (w: SocialWriteAction) => unknown): WriteUndo | undefined => {
  // Don't send and Send (until it is sent) undo to the draft; a chat's Done and draft asks undo to where it was.
  const dm = /^(messages|chats)\/([^/]+)\/(send|drop|done|draft|accept)$/.exec(w.action);
  if (dm && r.commit) {
    const back = dm[1] === "messages" ? (`messages/${dm[2]}/restore` as const) : dm[3] === "done" ? (`chats/${dm[2]}/reopen` as const) : (`chats/${dm[2]}/undo` as const);
    return { label: "Undo", run: () => write({ action: back }) };
  }
  const m = /^posts\/([^/]+)\/(drop|pull)$/.exec(w.action);
  const id = m && (m[2] === "drop" || r.info?.effect === "unschedule") ? m[1] : undefined;
  return id && r.commit ? { label: "Undo", run: () => write({ action: `posts/${id}/restore` }) } : undefined;
};

/** the export with only the campaign's rows (its code, any case, or its name in the Campaign cell), as the server's `?campaign=`. */
export function narrowToCampaign<T extends SocialData>(d: T, code: string, name?: string): T {
  const keys = [code, name].filter(Boolean).map((k) => k!.trim().toLowerCase());
  return { ...d, data: { ...d.data, posts: d.data.posts.filter((p) => keys.includes((p.campaign ?? "").trim().toLowerCase())) } };
}

/**
 * a social screen's data and its clicks. Reads the world's social data (`?repo=` in the URL picks the repo,
 * the console skin's way in) and writes through the one write API; a write answers with the fresh export,
 * which the screen shows at once. No approval anywhere (C1); this also drops's stored local decisions.
 */
export function useSocialScreen() {
  const [params] = useSearchParams();
  // a campaign tab names its repo; `?repo=` stays the console skin's way in (a repo's Spines card).
  const scope = useCampaignScope();
  // no repo named: the selected project's (its writes go to that repo too).
  const project = useProject();
  const repo = scope?.repo ?? (params.get("repo") || undefined) ?? project.current?.repo;
  const q = useSocial(repo);
  const [fresh, setFreshAll] = useState<SocialData>();
  // a write answers with the repo's whole export; a named campaign's screen keeps showing only its rows.
  const setFresh = (r: SocialData | undefined) => setFreshAll(r && scope?.campaign ? narrowToCampaign(r, scope.campaign, q.data?.campaign?.name) : r);
  const [busy, setBusy] = useState<string>();
  const [note, setNote] = useState<WriteNote>();
  useEffect(() => forgetLegacyDecisions(), []);
  useEffect(() => setFresh(undefined), [q.data]);
  const social = fresh ?? q.data;

  async function write(w: SocialWriteAction): Promise<SocialWriteResult | undefined> {
    if (!social) {
      // never a silent no-op: say why nothing happened, at the control.
      setNote({ ok: false, text: "Not sent: the social data has not loaded yet. Reload the page and try again.", scope: scopeOf(w.action) });
      return;
    }
    setBusy(w.action);
    setNote(undefined);
    try {
      const r = await api.socialWrite(social.tenantId, w, repo ?? social.repo ?? undefined);
      setFresh(r);
      setNote({ ok: true, text: describeWrite(r), undo: undoOf(w, r, write), scope: scopeOf(w.action) });
      return r;
    } catch (e) {
      // ApiError (api/real.ts) carries a 422's issue lines.
      const err = e as Error & { issues?: string[] };
      setNote({ ok: false, text: err.message, ...(err.issues?.length ? { issues: err.issues } : {}), scope: scopeOf(w.action) });
    } finally {
      setBusy(undefined);
    }
  }

  return { social, error: q.error, repo, write, busy, note };
}
