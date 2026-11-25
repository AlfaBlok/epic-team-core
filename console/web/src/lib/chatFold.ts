import type { DeskMessage } from "@/api/types";
import { passedHead } from "@/lib/passed";

/**
 * E942-S173 (found by the E942-S141 audit, not his words): his desk chat holds his words and the answers to them, not machine
 * lines. Of 778 lines in 72 h only 157 were his; one alert came back 58 times in 50 minutes, each a console line written as
 * his and a one-line desk reply; the desk also posted its working steps ("Reading his long note now").
 *
 * The Chat shows:
 * - his words and the desk's answers as before;
 * - every run of console lines (relay receipts, held batches, note-touch lists, steps), with the desk's short replies to
 *   them, as ONE folded row (`console`), its newest reply as the summary;
 * - a turn's earlier short messages before its answer (its working steps) folded above the answer (`steps`).
 * A long desk message is never folded: it is meant for him.
 */
export type ChatItem =
  | { kind: "message"; m: DeskMessage }
  | { kind: "console"; id: string; lines: DeskMessage[] }
  | { kind: "steps"; id: string; msgs: DeskMessage[] };

/** A desk message short enough to be an echo or a working step: at most 3 lines and 320 characters. */
export const SHORT_REPLY = 320;
export const isShort = (text: string) => text.trim().length <= SHORT_REPLY && text.trim().split("\n").filter((l) => l.trim()).length <= 3;

/** A user-role line the console wrote: marked by the server, else (an older server) a relay receipt it passed in. */
export function isConsole(m: DeskMessage): boolean {
  if (m.role !== "user" || m.kind !== "message") return false;
  if (m.from === "console") return true;
  const p = passedHead(m.text);
  return p?.kind === "to";
}

export function foldChat(messages: DeskMessage[]): ChatItem[] {
  const out: ChatItem[] = [];
  let group: Extract<ChatItem, { kind: "console" }> | undefined;
  let run: DeskMessage[] = []; // the desk's messages since the last line of his (or the last console group)
  const flushRun = () => {
    if (!run.length) return;
    const last = run[run.length - 1];
    const before = run.slice(0, -1);
    let steps: DeskMessage[] = [];
    const pushSteps = () => {
      if (steps.length) out.push({ kind: "steps", id: `steps-${steps[0].id}`, msgs: steps });
      steps = [];
    };
    for (const m of before) {
      if (isShort(m.text)) steps.push(m);
      else {
        pushSteps();
        out.push({ kind: "message", m });
      }
    }
    pushSteps();
    out.push({ kind: "message", m: last });
    run = [];
  };
  for (const m of messages) {
    if (isConsole(m)) {
      flushRun();
      if (!group) {
        group = { kind: "console", id: `console-${m.id}`, lines: [] };
        out.push(group);
      }
      group.lines.push(m);
      continue;
    }
    if (m.role === "assistant" && m.kind === "message") {
      // the desk's short reply to a console line belongs to it; a long one is for him and ends the group
      if (group && run.length === 0 && isShort(m.text)) {
        group.lines.push(m);
        continue;
      }
      group = undefined;
      run.push(m);
      continue;
    }
    // his own words, or a session divider
    group = undefined;
    flushRun();
    out.push({ kind: "message", m });
  }
  flushRun();
  return out;
}

/**
 * The folded console row's summary: the newest desk reply's first line, else where a relay receipt says it went, else
 * nothing (the row then reads just "Console, N lines": a held batch's own words are instructions to the desk, not to him).
 */
export function consoleSummary(lines: DeskMessage[]): string {
  const reply = [...lines].reverse().find((m) => m.role === "assistant" && m.text.trim());
  const p = reply ? undefined : passedHead(lines[lines.length - 1].text);
  const first = (reply ? reply.text.trim().split("\n")[0] : p ? `Passed on to your ${p.desk} desk: ${p.about}` : "").replace(/\*\*/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, "").trim();
  return first.length > 140 ? `${first.slice(0, 138).replace(/\s+\S*$/, "")}…` : first;
}
