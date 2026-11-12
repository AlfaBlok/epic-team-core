import fs from "node:fs";
import path from "node:path";
import { parseMonitoring } from "../adapters/monitoring.js";
import type { SpineWrite, SpineWriter } from "../inbox/spineWrite.js";
import { setStateField, stateField } from "./stateField.js";

/**
 * a run that reports `monitoring` is waiting on a time or a condition, and the
 * spine says so: its Current State `Monitoring:` line. Status reads monitoring from that line only (never from run
 * fields), so the run PATCH writes the line through the one spine writer when the spine lacks a current one, and a
 * report whose line cannot be written is refused (the run stays as it was).
 */
export interface MonitorReport {
  what: string;
  nextCheckAt?: string;
  until?: string;
}

/** A run summary's first line as a monitoring item: the outcome word and the line's separators (` · `, `; `) taken out. */
export function monitorWhat(summary: string | undefined): string {
  const first = (summary ?? "").split("\n")[0].replace(/^\s*(?:outcome:\s*)?(?:blocked|monitoring)\s*[:—-]\s*/i, "");
  const clean = first.replace(/\s+[·•|;]\s+/g, ", ").replace(/\s+/g, " ").trim();
  return (clean.length > 160 ? `${clean.slice(0, 159)}…` : clean) || "waiting for the next check";
}

/**
 * A held run's line (egress offline, out of credits): a calm wait, so it is worded without the stop
 * words (offline, down…) that would turn the line into a monitor alert for the owner; an offline egress is no action of his.
 */
export const heldWhat = (heldOn: string) =>
  heldOn === "credits" ? "held until the world has credits again" : `held until the ${heldOn.replace(/^egress:/, "")} egress is back`;

/** `<what> until <ISO> · next check <ISO>` (the grammar parseMonitoring reads). */
export function monitorValue(r: MonitorReport): string {
  const what =
    r.what
      .replace(/\s+[·•|;]\s+/g, ", ")
      .replace(/\s+(since|until)\s+\d{4}-\d{2}-\d{2}\S*/gi, "")
      .trim() || "waiting for the next check";
  return [`${what}${r.until ? ` until ${r.until}` : ""}`, ...(r.nextCheckAt ? [`next check ${r.nextCheckAt}`] : [])].join(" · ");
}

/** The spine already says it monitors: an item of its `Monitoring:` line checks next, or ends, after `now`. */
export function monitoringCurrent(text: string, now = Date.now()): boolean {
  const f = stateField(text, "Monitoring");
  if (!f) return false;
  return parseMonitoring(f.value).some((m) => (m.nextCheckAt && Date.parse(m.nextCheckAt) > now) || (m.until && Date.parse(m.until) > now));
}

/** The report's dates, when it has one in the future (a report with none has nothing to put in the spine). */
export function datedReport(r: MonitorReport, now = Date.now()): MonitorReport | undefined {
  const future = (x?: string | null) => (x && Date.parse(x) > now ? new Date(Date.parse(x)).toISOString() : undefined);
  const nextCheckAt = future(r.nextCheckAt);
  const until = future(r.until);
  return nextCheckAt || until ? { what: r.what, ...(nextCheckAt ? { nextCheckAt } : {}), ...(until ? { until } : {}) } : undefined;
}

export interface MonitorWriteDeps {
  writer: Pick<SpineWriter, "edit">;
  dir: string;
  path: string;
  runId?: string;
  now?: number;
}

/**
 * Make the spine say it monitors: written (nothing to do) when its line is already current, else the line is set to the
 * report (an old line, whose items all ended or carry no date, is replaced: git keeps it). `skipped`/`failed` = not written.
 */
export async function writeMonitoring(d: MonitorWriteDeps, r: MonitorReport): Promise<SpineWrite> {
  const now = d.now ?? Date.now();
  try {
    if (monitoringCurrent(fs.readFileSync(path.join(d.dir, d.path), "utf8"), now)) return { status: "written", reason: "the spine's Monitoring line is current", path: d.path };
  } catch {
    return { status: "skipped", reason: `${d.path} is not in the checkout`, path: d.path };
  }
  const value = monitorValue(r);
  return d.writer.edit({
    repoDir: d.dir,
    path: d.path,
    label: "Monitoring",
    edit: (text) => {
      if (monitoringCurrent(text, now)) return { text, msg: "", body: "" };
      if (!/^#{1,6}\s+current state\b/im.test(text)) return { skip: `${d.path} has no Current State to hold the Monitoring line` };
      return {
        text: setStateField(text, "Monitoring", value, ["Waiting on", "Next action"]),
        msg: `Monitoring: ${value}`.slice(0, 120),
        body:
          `A run reported monitoring${d.runId ? ` (${d.runId})` : ""}; the agent-team console wrote its Monitoring line into Current State ` +
          "(whether an epic monitors is read from this line, never from the console's run log).",
      };
    },
  });
}
