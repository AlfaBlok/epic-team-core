/**
 * Ask gate rule 14 (the owner: "cards are being duplicated ... similar things but slightly different ... really
 * annoying"): one outage, one card.
 *
 * One revoked GitHub sign-in once made six asks for the same token in five worlds. The console's GitHub sign-in alarm
 * (POST /api/notify/git-auth) is the single owner of a GitHub-auth incident: while it is open, any new open ask
 * in any world whose subject is that incident (a GitHub token, sign-in, login or key) is held and points at the one
 * alarm; when the alarm closes (he signed in again, the server wheel posts `resolved`), every ask held under it stays
 * held as closed with it, so none of them reaches him afterwards.
 *
 * The incidents come from the hosted notifier (wa_meta `git-auth:incidents`), registered with setOutageIncidents; the
 * core default is none, so the rule is quiet wherever no alarm runs.
 */

export interface OutageIncident {
  /** ISO time the alarm opened. */
  incident: string;
  /** ISO time it closed (sign-in works again); undefined = open. */
  closed?: string;
  /** The one place he acts (the sign-in page). */
  link?: string;
}

let source: () => OutageIncident[] = () => [];
export function setOutageIncidents(fn: () => OutageIncident[]): void {
  source = fn;
}
export const outageIncidents = (): OutageIncident[] => {
  try {
    return source();
  } catch {
    return [];
  }
};

const GH = String.raw`(?:git ?hub|\bgh\b|GH_TOKEN|GITHUB_TOKEN)`;
const AUTH = String.raw`(?:tokens?|sign[- ]?ins?|signed (?:in|out)|log[- ]?ins?|logged (?:in|out)|keys?|credentials?|auth(?:entication|ori[sz]ation|ori[sz]e)?|re-?authori[sz]e|device (?:code|login)|PAT|bad credentials|401)`;
/** The subject of a GitHub-auth incident: GitHub near a token, sign-in, login or key, either order. */
export const GITHUB_AUTH_SUBJECT = new RegExp(String.raw`${GH}[^.;—\n]{0,60}?\b${AUTH}\b|\b${AUTH}\b[^.;—\n]{0,40}?${GH}`, "i");

export interface OutageAsk {
  state?: string;
  question: string;
  contextText?: string | null;
  context?: string | null;
  steps?: string | null;
  why?: string | null;
  /** undefined = a new ask (now); else the ISO time or date it was raised. */
  since?: string | null;
}

const day = (iso: string) => iso.slice(0, 10);
const hm = (iso: string) => /T(\d\d:\d\d)/.exec(iso)?.[1];

/** Why this ask is held as a duplicate of the one GitHub alarm; undefined when it is not one. */
export function outageProblem(a: OutageAsk, incidents: OutageIncident[] = outageIncidents(), now = new Date()): string | undefined {
  if ((a.state && a.state !== "open") || !incidents.length) return undefined;
  const text = [a.question, a.contextText, a.context, a.steps, a.why].filter(Boolean).join(" — ");
  if (!GITHUB_AUTH_SUBJECT.test(text)) return undefined;
  const raised = a.since ? String(a.since) : now.toISOString();
  // the incident this ask belongs to: raised on or after the day it opened, and while it was still open
  const hit = [...incidents]
    .sort((x, y) => y.incident.localeCompare(x.incident))
    .find((i) => day(raised) >= day(i.incident) && (!i.closed || day(raised) <= day(i.closed)));
  if (!hit) return undefined;
  const opened = `${day(hit.incident)}${hm(hit.incident) ? ` ${hm(hit.incident)} UTC` : ""}`;
  return hit.closed
    ? `closed with the one GitHub sign-in alarm of ${opened} (signed in again ${day(hit.closed)}${hm(hit.closed) ? ` ${hm(hit.closed)} UTC` : ""}): one outage makes one card, drop this line`
    : `held under the one GitHub sign-in alarm of ${opened}${hit.link ? ` (${hit.link})` : ""}: one outage makes one card, never ask him again for a GitHub token, sign-in or key while it is open`;
}
