import { useContext, useMemo, useSyncExternalStore } from "react";
import { UNSAFE_LocationContext } from "react-router-dom";
import { Mic, SendHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NoteClock, NoteMedia, NotesApi, NoteStore, NoteView } from "./noteEngine";
import { noteOn, useNoteTab } from "./NoteProvider";
import { useVoiceState, type NoteState } from "./useNote";

/** Where a note from the top bar says it goes (the pill's "to:" line and its "sent" line). */
export const TOP_BAR_TO = "Team desk";

/**
 * A microphone next to the Chat
 * icon: one tap starts a voice note to the Team desk on whatever page he is on, and the page stays. It is the same note as Chat's
 * (the tab's note for the desk's route), so nothing new records or posts: the top bar never docks it, so the
 * floating pill (NoteWidget) shows the time, the level, Send and Cancel at once, sends on Send, says "Voice note sent to Team
 * desk" for a few seconds and goes; nothing ever navigates. While a note is on, the mic turns into a red Send (one tap sends);
 * while it is on its way it waits. Voice off, or this month's cap reached: no mic. First use asks for the microphone once (the
 * browser's own prompt, Safari on iPhone too); a "no" shows on the pill as the engine's usual microphone message.
 */
export function TopBarVoice(props: {
  /** The desk's note routes: `/api/voice` (the home world's Team desk) or a world's `/api/tenants/<id>/desk/voice`. */
  base?: string;
  className?: string;
  api?: NotesApi;
  media?: NoteMedia;
  clock?: NoteClock;
  store?: NoteStore;
  state?: () => Promise<NoteState | undefined>;
}) {
  const base = props.base ?? "/api/voice";
  const tab = useNoteTab();
  useSyncExternalStore(tab.subscribe, tab.snapshot, tab.snapshot);
  const held = tab.get(base, props.api);
  const sub = useMemo(() => (held ? (fn: () => void) => held.engine.subscribe(fn) : () => () => undefined), [held]);
  const idle = (): NoteView | undefined => undefined;
  const v = useSyncExternalStore(sub, held ? held.engine.view : idle, held ? held.engine.view : idle);
  const loc = useContext(UNSAFE_LocationContext)?.location;

  // asked again while the console could not be reached (a phone page waking up), read again after a sent note
  const st = useVoiceState(base, props.state, v?.phase === "sent" ? "sent" : undefined);

  const phase = v?.phase ?? "idle";
  const on = noteOn(phase);
  const sending = phase === "sending";
  if (!st?.enabled) return null;
  const cap = st.limits?.monthCapUsd;
  const capped = cap !== undefined && (st.monthUsd ?? 0) >= cap;
  if (capped && !on && !sending) return null;

  const start = () => {
    const h = tab.note(base, { base, to: TOP_BAR_TO, api: props.api, media: props.media, clock: props.clock, store: props.store });
    // Chat may have named it "Chat"; from the top bar it says where it really lands.
    if (!noteOn(h.engine.view().phase)) h.to = TOP_BAR_TO;
    const route = loc ? loc.pathname + loc.search : undefined;
    tab.started(h, route);
    void h.engine.start(route ? `voice note from the top bar, on ${route}`.slice(0, 200) : undefined);
  };
  const label = on ? `Send the voice note to the ${TOP_BAR_TO}` : sending ? "Sending the voice note…" : `Record a voice note to the ${TOP_BAR_TO}`;
  return (
    <button
      type="button"
      className={cn(
        "flex min-h-[40px] min-w-[40px] items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs md:min-h-0 md:min-w-0",
        on ? "bg-red-600 text-white hover:bg-red-700" : "text-muted-foreground hover:bg-accent hover:text-foreground",
        (sending || phase === "starting") && "opacity-60",
        props.className,
      )}
      aria-label={label}
      title={on ? "Tap to send the note" : `Tap to start a voice note to the ${TOP_BAR_TO}; this page stays open`}
      data-testid="topbar-voice"
      data-phase={phase}
      disabled={sending || phase === "starting"}
      onClick={() => (on ? void held?.engine.finish() : start())}
    >
      {on ? <SendHorizontal className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
      <span className="hidden md:inline">{on ? "Send" : sending ? "Sending…" : "Voice note"}</span>
    </button>
  );
}
