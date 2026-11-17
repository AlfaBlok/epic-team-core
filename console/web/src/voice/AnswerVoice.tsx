import type { ReactNode } from "react";
import type { NoteClock, NoteMedia, NotesApi } from "./noteEngine";
import { clearNoteState, useNote, type NoteState } from "./useNote";
import { useInboxHold } from "@/lib/inboxHold";

/**
 * (the owner 2026-11-08: "In a card pane (answer, new iteration with feedback) the owner can record a voice note as his answer,
 * transcribed into the reply"): a voice note beside every card box that takes his words (Answer on a question, Changes wanted,
 * Decline with a reason, a held post's Changes wanted). It records like Chat's voice note (the same engine, parts and
 * gpt-4o-mini-transcribe); the reply names the note (its vn_ id) and keeps the link to its recording.
 *
 * the same control as Chat (useNote), and Send sends the answer straight away
 * through the card's own button (the press), no words to confirm and no second press. The note is the tab's: he can
 * leave the page while he talks, and Send in the floating pill still lands it on this card.
 */

export { withVoiceNote } from "./useNote";
export const clearAnswerVoiceState = clearNoteState;

/**
 * a campaign's (milestone's) voice routes. The social world's boxes (a Product or Brief slide's note, the Brief's
 * feedback chat) record on them, never on the Team desk's `/api/voice`, which is the home world's only (another world gets world_scope).
 */
export const campaignVoiceBase = (milestoneId: string) => `/api/milestones/${encodeURIComponent(milestoneId)}/voice`;

/** A card in a few words, for the voice note's floating pill ("to: …"). */
export const shortTo = (t: string | undefined) => {
  const s = (t ?? "").replace(/\s+/g, " ").trim();
  return !s ? "this card" : s.length > 60 ? `${s.slice(0, 57)}…` : s;
};

/**
 * the page a card's note names: the card and its question or title, so the console's check (voice/spill.ts) can tell
 * what in his note is about this card and hand the rest to the Team desk. The console keeps 200 characters.
 */
export const cardPage = (ref: string, title: string | undefined) => {
  const t = (title ?? "").replace(/\s+/g, " ").trim();
  return (t ? `card ${ref}: ${t}` : `card ${ref}`).slice(0, 200);
};

export interface AnswerVoice {
  /** The microphone (Send while recording), or undefined when voice is off or this month's cap is reached. */
  button?: ReactNode;
  /** The line under the box while recording, on its way, sent, or on an error. */
  strip?: ReactNode;
  /** True while a note is on or on its way: the card's own buttons wait for it. */
  busy: boolean;
}

export function useAnswerVoice(props: {
  /** The note's origin: one per card box (`card:<id>`), so the floating pill sends it to that card. */
  origin: string;
  /** The card, in his words, for the pill ("to: <title>"). */
  to: string;
  /** Which card it answers (kept with the note on the console). */
  page: string;
  /** What is typed in the box now: it goes out before the spoken words. */
  typed: string;
  /** The card's own press with the reply (his typed words, the spoken words, the note's id and recording). Rejects if it failed. */
  deliver: (reply: string) => Promise<unknown>;
  base?: string;
  api?: NotesApi;
  media?: NoteMedia;
  clock?: NoteClock;
  state?: () => Promise<NoteState | undefined>;
  disabled?: boolean;
  /** E948-S60: the card feedback block's big, labelled microphone. */
  big?: boolean;
}): AnswerVoice {
  // E948-S131: the card row's button is Voice (one tap records, the next sends); a box's own microphone stays Speak.
  const n = useNote({ ...props, tid: "answer-voice", idleLabel: props.big ? "Voice" : "Speak" });
  // while the owner records or types here the inbox holds still, and this card is marked (index.css)
  const holding = useInboxHold(props.origin, { recording: n.busy, typed: props.typed });
  const mark = holding ? <span hidden data-inbox-hold="" data-testid="inbox-hold" /> : null;
  return {
    button: n.button,
    strip: mark || n.strip ? <>{mark}{n.strip}</> : undefined,
    busy: n.busy,
  };
}
