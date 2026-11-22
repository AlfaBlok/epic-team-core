import fs from "node:fs";
import path from "node:path";
import { DESK_INBOX_DIR, readInbox } from "../desk/inbox.js";
import { ownerName } from "../identity.js";
import type { SpineWriter } from "../inbox/spineWrite.js";

/**
 * (the owner, 2026-11-18 03:43Z: "are these requests that I'm sending about this landing somewhere? Because it
 * feels like they're landing on a bottomless pit"): a Chat voice note shown as sent that is not in the desk's chat
 * DELIVER_CHECK_MS later is re-sent, and its world's Delivery Manager gets one desk-inbox note naming it (once when it
 * first misses, once more if its tries run out), so a dropped note is never silent.
 */
export const UNDELIVERED_KIND = "voice-undelivered";

export interface UndeliveredInput {
  id: string;
  world: string;
  replyTo: string;
  postedAt: string;
  tries: number;
  gaveUp: boolean;
  words: string;
  /** today, `YYYY-MM-DD`. */
  day: string;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const alertId = (i: Pick<UndeliveredInput, "id" | "gaveUp">) => `voice-${i.id}${i.gaveUp ? "-gave-up" : ""}`;

export function undeliveredNote(i: UndeliveredInput): { rel: string; text: string } {
  const rel = `${DESK_INBOX_DIR}/${i.day}-console-${alertId(i)}.md`;
  const words = oneLine(i.words);
  const quote = words.length > 600 ? `${words.slice(0, 599)}…` : words;
  const state = i.gaveUp ? `still not in the chat after ${i.tries} re-sends: the console keeps re-sending it each minute` : "not in the Team desk chat 2 minutes after it showed as sent: the console is re-sending it each minute";
  const text = [
    "---",
    `from: ${i.world}`,
    `about: ${ownerName()}'s Chat voice note ${i.id} did not reach the desk${i.gaveUp ? " (still stuck after its first tries)" : ""}`,
    `reply-to: ${i.replyTo}`,
    "status: open",
    `kind: ${UNDELIVERED_KIND}`,
    `alert: ${alertId(i)}`,
    "---",
    `${ownerName()}'s voice note ${i.id} (posted ${i.postedAt}) is ${state}. His Chat shows it as "not delivered yet, retrying".`,
    "",
    `His words: "${quote}"`,
    "",
    `In this wake: check that the desk has it and has answered him (its head line carries ${i.id}); if not, place his words on their rows yourself and answer him. Then close this note (\`desk_note.py close <this note> --note "…"\`).`,
    "",
  ].join("\n");
  return { rel, text };
}

/** Drop the note in the world's home repo (one commit through the spine writer), once per alert id. */
export async function writeUndeliveredNote(i: UndeliveredInput, target: { checkout: string; policyPath: string }, writer: Pick<SpineWriter, "scaffold">): Promise<string> {
  const id = alertId(i);
  if (readInbox(target.checkout).some((n) => n.alert === id)) return "already";
  const note = undeliveredNote(i);
  const w = await writer.scaffold({
    repoDir: target.checkout,
    path: target.policyPath,
    label: `voice note ${i.id} not delivered`,
    scaffold: async (dir) => {
      if (readInbox(dir).some((n) => n.alert === id)) return { ok: false, error: "already" };
      const abs = path.join(dir, note.rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, note.text);
      return { ok: true, files: [note.rel] };
    },
    msg: `Desk note: ${ownerName()}'s Chat voice note ${i.id} did not reach the desk (console)`,
    body: `${note.rel}: the Delivery Manager checks the desk has it and answers him.`,
  });
  return w.status === "written" ? note.rel : (w.reason ?? w.status);
}
