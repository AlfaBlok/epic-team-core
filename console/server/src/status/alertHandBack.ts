import fs from "node:fs";
import path from "node:path";
import { DESK_INBOX_DIR, readInbox, type DeskNote } from "../desk/inbox.js";
import { ownerName } from "../identity.js";
import type { SpineWrite, SpineWriter } from "../inbox/spineWrite.js";
import type { PendingItem } from "./compute.js";

/**
 * The owner, on a Monitoring line whose check was a day overdue and that asked him nothing: "I can't take action on
 * it so what's it doing there?". Blocked on you holds only items that
 * carry an open ask for him. A stopped or overdue Monitoring item that names no open ask (a monitor alert in state
 * `alarm`) leaves his inbox and goes back to its team: the console drops ONE note in the desk inbox of the alert's repo
 * (`desk/inbox/`, read by that repo's Delivery Manager on its next wake, desk/inbox.ts), which either writes a real
 * coded ask for him (then the alert is his, counted, with that ask's card) or clears the item. Once per alert: a note
 * naming the alert (`alert: <id>`), open or answered, is the hand-back already made.
 */
export const ALERT_KIND = "monitor-alert";

/** The alerts that name no open ask for the owner: the team's, never his inbox. */
export const alarmAlerts = (items: PendingItem[]): PendingItem[] => items.filter((i) => i.kind === "monitor_alert" && i.state === "alarm");

export interface HandBackInput {
  /** The world the alert's milestone is in (its id goes in `from`). */
  world: string;
  /** The repo's `owner/name` (the note's `reply-to`: the world's own matter, so its desk closes it, no answer back). */
  replyTo: string;
  milestoneTitle: string;
  alert: PendingItem;
  /** today, `YYYY-MM-DD` (the note's name). */
  day: string;
}

const what = (a: PendingItem) => a.title.replace(/^Monitor alert:\s*/, "");
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The note file (path inside the repo) and its text. */
export function handBackNote(i: HandBackInput): { rel: string; text: string } {
  const item = oneLine(what(i.alert));
  const short = item.length > 120 ? `${item.slice(0, 119)}…` : item;
  const rel = `${DESK_INBOX_DIR}/${i.day}-console-alert-${slug(i.alert.id)}-${slug(short) || "monitoring"}.md`;
  const why = i.alert.monitor?.why?.includes("stop") ? "stopped" : "check overdue";
  const text = [
    "---",
    `from: ${i.world}`,
    `about: Monitoring item with no ask for ${ownerName()} (${why}): ${short.replace(/\n/g, " ")}`,
    `reply-to: ${i.replyTo}`,
    "status: open",
    `kind: ${ALERT_KIND}`,
    `alert: ${i.alert.id}`,
    "---",
    `${i.milestoneTitle}: the Monitoring item "${item}" is ${why}${i.alert.detail ? ` (${i.alert.detail})` : ""}, and it names no open ask for ${ownerName()}.`,
    "",
    `The console took it out of his Blocked on you: he can act only on an ask, and this item has none. It is this team's to settle, in this wake:`,
    `- if it needs him, write ONE real coded ask under \`## Waiting on\` (a question he can answer in a glance) and name its code on the Monitoring line: the alert then shows in his inbox with that ask's card;`,
    `- else clear it: run the check and set the line's next check date, close the item, or drop the line if it is stale.`,
    "",
    `Then close this note with what you did (\`desk_note.py close <this note> --note "…"\`), no answer back.`,
    "",
  ].join("\n");
  return { rel, text };
}

/** The hand-back note already made for this alert (any status), if any. */
export function handedBack(checkoutDir: string, alertId: string): DeskNote | undefined {
  return readInbox(checkoutDir).find((n) => n.alert === alertId);
}

export type HandBackResult = { state: "handed" | "already"; rel: string; sha?: string } | { state: "skipped" | "failed"; reason: string };

/** Drop the note in the alert's repo (one commit through the spine writer), once. */
export async function handBackAlert(i: HandBackInput, target: { checkout: string; policyPath: string }, writer: Pick<SpineWriter, "scaffold">): Promise<HandBackResult> {
  const have = handedBack(target.checkout, i.alert.id);
  if (have) return { state: "already", rel: have.file };
  const note = handBackNote(i);
  const w: SpineWrite = await writer.scaffold({
    repoDir: target.checkout,
    path: target.policyPath,
    label: `monitor alert ${i.alert.id} back to its team`,
    scaffold: async (dir) => {
      // the clone may know a note the shared checkout does not yet: never twice
      const there = handedBack(dir, i.alert.id);
      if (there) return { ok: false, error: `already handed: ${there.file}` };
      const abs = path.join(dir, note.rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, note.text);
      return { ok: true, files: [note.rel] };
    },
    msg: `Desk note: a Monitoring item with no ask goes back to its team, not ${ownerName()}'s inbox (console)`,
    body: `${i.milestoneTitle}: "${oneLine(what(i.alert))}" names no open ask for ${ownerName()}, so it left his Blocked on you. Its Delivery Manager asks him one real question or clears it: ${note.rel}.`,
  });
  if (w.status === "written") return { state: "handed", rel: note.rel, ...(w.sha ? { sha: w.sha } : {}) };
  const m = /already handed: (\S+)/.exec(w.reason ?? "");
  if (m) return { state: "already", rel: m[1] };
  return { state: w.status === "skipped" ? "skipped" : "failed", reason: w.reason ?? w.status };
}

export interface AlertHandBackDeps {
  /** Every open-or-alarm status item of the console (the status batch). */
  items: () => Promise<PendingItem[]>;
  /** Where the alert's milestone lives: its world, repo checkout, `owner/name` and a spine path in it; undefined to skip. */
  target: (milestoneId: string) => { world: string; checkout: string; replyTo: string; policyPath: string; milestoneTitle: string } | undefined;
  writer: Pick<SpineWriter, "scaffold">;
  now?: () => number;
  log?: (line: string) => void;
}

/** One pass: every alarm alert not handed back yet gets its note (an alert handed in this process is not retried). */
export function createAlertHandBack(d: AlertHandBackDeps) {
  const done = new Set<string>();
  let running = false;
  const tick = async (): Promise<HandBackResult[]> => {
    if (running) return [];
    running = true;
    try {
      const out: HandBackResult[] = [];
      for (const a of alarmAlerts(await d.items())) {
        if (done.has(a.id)) continue;
        const t = d.target(a.milestoneId);
        if (!t) continue;
        const day = new Date(d.now?.() ?? Date.now()).toISOString().slice(0, 10);
        const r = await handBackAlert({ world: t.world, replyTo: t.replyTo, milestoneTitle: t.milestoneTitle, alert: a, day }, t, d.writer).catch(
          (e): HandBackResult => ({ state: "failed", reason: e instanceof Error ? e.message : String(e) }),
        );
        if (r.state === "handed" || r.state === "already") done.add(a.id);
        if (r.state === "handed") d.log?.(`alert hand-back: ${a.id} → ${t.replyTo} ${r.rel}`);
        if (r.state === "failed") d.log?.(`alert hand-back failed for ${a.id}: ${r.reason}`);
        out.push(r);
      }
      return out;
    } finally {
      running = false;
    }
  };
  return { tick };
}
