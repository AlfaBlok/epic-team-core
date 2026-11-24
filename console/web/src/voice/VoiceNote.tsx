import { useEffect, useRef, useState, type ReactNode } from "react";
import { Mic } from "lucide-react";
import { KEPT_FAILED_TEXT, type NoteClock, type NoteMedia, type NotesApi, type NoteStore } from "./noteShared";
import { clockOf } from "./NoteProvider";
import { useNote, type NoteState } from "./useNote";
import { SpeakRepliesSwitch } from "./ReplyVoice";
import { speakRepliesOn, unlockReplyAudio } from "./speak";
import { useDeskVoiceBase } from "./deskBase";
import { memoryName } from "@/lib/identity";
import type { NoteView } from "./noteShared";

/**
 * rework (the owner's review, 2026-11-02): voice notes in every chat (the Team desk, a milestone's or campaign's chat; one
 * ChatView). One button by the chat box: tap to start, tap Send to finish. While recording, a strip above the box
 * shows the timer, the level and what the note will cost; when it is sent, the transcript lands in the chat as his message
 * and the desk answers it like typed text. The answer is spoken only on Play, or by itself when "Speak replies" is on.
 *
 * the control is the app's one voice control (useNote): the note is the tab's, so leaving Chat
 * keeps recording and the floating pill follows; back on Chat the same note goes on.
 */

export { clockOf };
export type { NoteState };

export interface VoiceNoteDock {
  /** The one button (by Send), or undefined when this chat has no voice. */
  button?: ReactNode;
  /** The recording strip, shown above the chat box while a note is on. */
  strip?: ReactNode;
  /** When the last note was sent (ms), while "Speak replies" waits for the desk's answer. */
  speakAfter?: number;
  spoken: () => void;
  /** the note on its way, shown in the chat the moment he taps Send; its words fill in once written. */
  posting?: PostingNote;
  /** the chat shows the posted note (or he gave it up): its bubble goes. */
  landed: () => void;
}

/**
 * a voice note between Send and the chat showing it. Its audio is already safe on this phone (the outbox), so
 * the chat shows it at once ("writing out your words…"), then his words when the console has written them, until the
 * transcript holds the message (same note id). Kept: not confirmed yet, it goes by itself.
 */
export interface PostingNote {
  /** when he tapped Send (ms). */
  at: number;
  seconds: number;
  /** `safe`: Sent, its audio is on the console; his words are being written out and posted by the console. */
  state: "writing" | "safe" | "sent" | "kept" | "failed";
  id?: string;
  words?: string;
}

/** the bubble's state for the note's phase (undefined: no bubble). */
export function postingFor(prev: PostingNote | undefined, v: Pick<NoteView, "phase" | "elapsedS" | "info" | "note">, now: number): PostingNote | undefined {
  if (v.phase === "sending") return { ...(prev ?? { at: now }), seconds: v.elapsedS, state: "writing" };
  if (v.phase === "sent") {
    if (v.note?.acceptedAt && !v.note.transcript?.trim() && v.note.state !== "empty") return { at: prev?.at ?? now, seconds: v.note.seconds || v.elapsedS, state: "safe", id: v.note.id };
    if (!v.note || v.note.state === "empty" || !v.note.transcript?.trim()) return undefined;
    return { at: prev?.at ?? now, seconds: v.note.seconds, state: "sent", id: v.note.id, words: v.note.transcript.trim() };
  }
  if (v.phase === "failed") return prev && { ...prev, state: v.info === KEPT_FAILED_TEXT ? "kept" : "failed" };
  // a new note, or one he closed or threw away: a sent note's bubble stays until the chat shows it.
  return prev?.state === "sent" || prev?.state === "safe" ? prev : undefined;
}

export function useVoiceNote(props: {
  base?: string;
  /** The chat's page hint, sent with the note like typed text. */
  page?: string;
  /** Where the note lands, for the floating pill (default "Chat"). */
  to?: string;
  onSent?: () => void;
  /** runs when he taps Send note (the chat sends its waiting files first). */
  beforeSend?: () => void;
  api?: NotesApi;
  media?: NoteMedia;
  clock?: NoteClock;
  store?: NoteStore;
  state?: () => Promise<NoteState | undefined>;
}): VoiceNoteDock {
  // no base named = this world's desk (useDeskVoiceBase).
  const deskBase = useDeskVoiceBase();
  const base = props.base ?? deskBase;
  // "Speak replies" (off by default, per device) replaces's "Read the reply aloud", whose robotic device
  // voice could not be stopped; the switch sits in the strip and in Chat's header, the reply plays through the one player.
  const [speakAfter, setSpeakAfter] = useState<number | undefined>();
  const note = useNote({
    origin: base,
    base,
    to: props.to ?? "Chat",
    page: props.page,
    tid: "note",
    idleLabel: "Voice note",
    // iPhone plays sound only after a tap: unlock the player now so the reply can be spoken when it comes.
    beforeSend: () => {
      props.beforeSend?.();
      if (speakRepliesOn()) {
        unlockReplyAudio();
        setSpeakAfter(Date.now());
      }
    },
    extra: <SpeakRepliesSwitch compact />,
    bubble: true,
    api: props.api,
    media: props.media,
    clock: props.clock,
    store: props.store,
    state: props.state,
  });
  const onSent = useRef(props.onSent);
  onSent.current = props.onSent;
  useEffect(() => {
    if (note.view.phase === "sent") onSent.current?.();
  }, [note.view.phase]);
  const [posting, setPosting] = useState<PostingNote | undefined>();
  const v = note.view;
  useEffect(() => {
    setPosting((p) => postingFor(p, v, Date.now()));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the phase (and a note's own answer) moves the bubble
  }, [v.phase, v.note, v.info]);
  return {
    button: note.button,
    strip: note.strip,
    ...(speakAfter && speakRepliesOn() ? { speakAfter } : {}),
    spoken: () => setSpeakAfter(undefined),
    ...(posting ? { posting } : {}),
    landed: () => setPosting(undefined),
  };
}


/**
 * A voice note in the chat (recorded in Chat, or sent on WhatsApp and relayed from the memory service): both arrive as the owner's message
 * headed `🎙 Voice note (<source>), <time>`; this shows the label, the recording (a player per part) or the memory service link,
 * then his words.
 */
export function parseVoiceNote(text: string): { source: string; meta: string; audio?: string; parts: number; link?: string; words: string } | undefined {
  const m = /^🎙 Voice note \(([^)]+)\),? ?([^\n]*)\n/.exec(text);
  if (!m) return undefined;
  const rest = text.slice(m[0].length);
  const lines = rest.split("\n");
  let audio: string | undefined;
  let parts = 1;
  let link: string | undefined;
  let i = 0;
  for (; i < lines.length && lines[i].trim(); i++) {
    const a = /^Audio: (\S+)(?: \((\d+) parts\))?/.exec(lines[i]);
    if (a) {
      try {
        audio = new URL(a[1], "http://x").pathname; // the same console, whichever host he opens it on
      } catch {
        audio = a[1];
      }
      parts = Number(a[2] ?? 1);
    }
    const z = new RegExp(`^${memoryName().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: .*?(https?:\\/\\/\\S+)`).exec(lines[i]);
    if (z) link = z[1];
  }
  // The label keeps length and cost; the time is under the bubble, the model and id are in the message for the desk.
  const meta = m[2]
    .replace(/ · vn_[0-9a-f]+$/, "")
    .replace(/ \([\w.-]+\)$/, "")
    .replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}Z( · )?/, "");
  return { source: m[1], meta, ...(audio ? { audio } : {}), parts, ...(link ? { link } : {}), words: lines.slice(i).join("\n").trim() };
}

export function VoiceNoteBody({ text }: { text: string }) {
  const n = parseVoiceNote(text);
  if (!n) return <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</p>;
  return (
    <div data-testid="chat-voice-note">
      <p className="mb-1 flex flex-wrap items-center gap-x-1.5 text-[11px] opacity-90" data-testid="chat-voice-note-label">
        <Mic className="h-3 w-3" aria-hidden /> <span className="font-medium">Voice note</span> · {n.source === "Chat" ? "recorded in Chat" : n.source}
        {n.meta && <span className="opacity-80">· {n.meta}</span>}
      </p>
      {n.audio && (
        <div className="mb-1.5 grid gap-1">
          {Array.from({ length: n.parts }, (_, i) => (
            <audio key={i} controls preload="none" src={n.parts > 1 ? `${n.audio}?part=${i}` : n.audio} className="h-8 w-full max-w-xs" data-testid="chat-voice-note-audio" />
          ))}
        </div>
      )}
      {n.link && (
        <a href={n.link} target="_blank" rel="noreferrer" className="mb-1 block text-[11px] underline opacity-90">
          The note in {memoryName()}
        </a>
      )}
      <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{n.words}</p>
    </div>
  );
}
