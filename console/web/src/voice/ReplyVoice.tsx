import { Loader2, Pause, Play, Square, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/utils";
import { replySpeaker, useSpeakReplies, useSpeakState } from "./speak";

/**
 * the reply voice's controls. Play on every desk reply; while it speaks, Pause (Resume) and Stop on that reply and
 * in a bar by the chat box, so Stop is in reach wherever he scrolled. "Speak replies" (off by default, per device) lets
 * the reply to his voice note play by itself.
 */

const BTN = "inline-flex min-h-8 items-center gap-1 rounded-full border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent";

export function ReplyPlay({ id, text }: { id: string; text: string }) {
  const s = useSpeakState();
  const mine = s.id === id && s.phase !== "idle";
  const sp = replySpeaker();
  return (
    <span className="mt-1.5 inline-flex flex-wrap items-center gap-1.5" data-speak-control data-testid="reply-voice">
      {!mine && (
        <button type="button" className={BTN} onClick={() => sp.play(id, text)} data-testid="reply-play" aria-label="Play this reply aloud">
          <Play className="h-3.5 w-3.5" aria-hidden /> Play
        </button>
      )}
      {mine && <Controls />}
    </span>
  );
}

function Controls() {
  const s = useSpeakState();
  const sp = replySpeaker();
  return (
    <>
      {s.phase === "paused" ? (
        <button type="button" className={BTN} onClick={sp.resume} data-testid="reply-resume">
          <Play className="h-3.5 w-3.5" aria-hidden /> Resume
        </button>
      ) : (
        <button type="button" className={BTN} onClick={sp.pause} data-testid="reply-pause" aria-busy={s.phase === "loading"}>
          {s.phase === "loading" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Pause className="h-3.5 w-3.5" aria-hidden />}
          {s.phase === "loading" ? "Starting…" : "Pause"}
        </button>
      )}
      <button type="button" className={BTN} onClick={sp.stop} data-testid="reply-stop">
        <Square className="h-3 w-3 fill-current" aria-hidden /> Stop
      </button>
    </>
  );
}

/** By the chat box while a reply speaks: what is on, Pause and Stop. */
export function SpeakingBar() {
  const s = useSpeakState();
  if (s.phase === "idle") return null;
  return (
    <div role="status" className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-speak-control data-testid="reply-speaking">
      <Volume2 className="h-3.5 w-3.5 text-foreground" aria-hidden />
      <span>
        {s.phase === "paused" ? "Paused" : s.phase === "loading" ? "Starting the reply…" : "Speaking the reply"}
        {s.voice === "device" && " in this device's voice"}
      </span>
      <Controls />
    </div>
  );
}

/** "Speak replies: off / on", remembered on this device. */
export function SpeakRepliesSwitch({ compact }: { compact?: boolean }) {
  const [on, set] = useSpeakReplies();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => set(!on)}
      data-speak-control
      data-testid="speak-replies"
      title={on ? "Speak replies is on: the reply to your voice note plays by itself. Tap to turn it off." : "Speak replies is off: a reply plays only when you press Play. Tap to turn it on."}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full text-sm hover:bg-accent",
        compact ? "px-1.5 py-0.5 text-xs" : "max-sm:size-11 max-sm:justify-center sm:mt-2 sm:px-2 sm:py-1",
        on ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {on ? <Volume2 className={compact ? "h-3.5 w-3.5" : "h-4 w-4 max-sm:h-[18px] max-sm:w-[18px]"} aria-hidden /> : <VolumeX className={compact ? "h-3.5 w-3.5" : "h-4 w-4 max-sm:h-[18px] max-sm:w-[18px]"} aria-hidden />}
      <span className={compact ? "" : "max-sm:sr-only"}>Speak replies: {on ? "on" : "off"}</span>
    </button>
  );
}
