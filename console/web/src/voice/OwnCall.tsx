import { useEffect, useRef, useState } from "react";
import { Phone, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PHONE_TAP } from "@/components/common";
import { cn } from "@/lib/utils";
import type { DeskChat } from "@/api";

/**
 * the Call of a customer workspace that talks on its own
 * server and its own AI. No key of ours: the browser hears (its own speech recognition) and speaks (its own voice); each
 * thing the owner says is one chat message, answered by the workspace's own AI on its own server, and the answer is read
 * aloud, then the call listens again. The chat shows every line, as typed ones.
 */
type Phase = "idle" | "listening" | "thinking" | "speaking";
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  start(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;
export const speechRecognition = (w: Window | undefined = typeof window === "undefined" ? undefined : window): RecognitionCtor | undefined =>
  w ? ((w as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }).SpeechRecognition ?? (w as unknown as { webkitSpeechRecognition?: RecognitionCtor }).webkitSpeechRecognition) : undefined;

/** a reply worth reading aloud: links and markdown marks out. */
export const sayable = (text: string) =>
  text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "the link in the chat")
    .replace(/[*_`#>|]/g, "")
    .slice(0, 1500);

const lastReply = (c: DeskChat | undefined) => c?.messages.filter((m) => m.role === "assistant").at(-1)?.id;
const SILENT_ROUNDS = 3;
const REPLY_WAIT_MS = 6 * 60_000;

export function useOwnCall(o: { load: () => Promise<DeskChat>; send: (text: string, page?: string, clientRequestId?: string) => Promise<unknown>; onLine?: () => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [note, setNote] = useState<string | undefined>();
  const live = useRef(false);
  const rec = useRef<Recognition | undefined>(undefined);
  const silent = useRef(0);
  const Ctor = speechRecognition();

  const stop = (why?: string) => {
    live.current = false;
    try {
      rec.current?.abort();
    } catch {
      /* already stopped */
    }
    rec.current = undefined;
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    setPhase("idle");
    setNote(why);
  };
  useEffect(() => () => stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const speak = (text: string) =>
    new Promise<void>((done) => {
      const synth = typeof window === "undefined" ? undefined : window.speechSynthesis;
      if (!synth || typeof SpeechSynthesisUtterance === "undefined") return done();
      const u = new SpeechSynthesisUtterance(sayable(text));
      u.lang = navigator.language || "en-US";
      u.onend = () => done();
      u.onerror = () => done();
      synth.speak(u);
    });

  const answer = async (said: string) => {
    setPhase("thinking");
    const before = lastReply(await o.load().catch(() => undefined));
    await o.send(said, undefined, `call-${Date.now().toString(36)}`);
    o.onLine?.();
    const t0 = Date.now();
    while (live.current && Date.now() - t0 < REPLY_WAIT_MS) {
      await new Promise((r) => setTimeout(r, 2000));
      const c = await o.load().catch(() => undefined);
      const reply = c?.messages.filter((m) => m.role === "assistant").at(-1);
      if (reply && reply.id !== before) {
        o.onLine?.();
        setPhase("speaking");
        await speak(reply.text);
        return true;
      }
      if (c?.sendError && !c.working) {
        await speak("No reply came. Please try again.");
        stop(c.sendError.text);
        return false;
      }
    }
    if (live.current) stop("No reply came in time. Your message is in the chat.");
    return false;
  };

  const listen = () => {
    if (!live.current || !Ctor) return;
    const r = new Ctor();
    rec.current = r;
    r.lang = navigator.language || "en-US";
    r.interimResults = false;
    r.continuous = false;
    let heard = "";
    r.onresult = (e) => {
      heard = Array.from(e.results)
        .map((x) => x[0]?.transcript ?? "")
        .join(" ")
        .trim();
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") stop("The browser did not allow the microphone.");
    };
    r.onend = () => {
      if (!live.current) return;
      if (!heard) {
        silent.current += 1;
        if (silent.current >= SILENT_ROUNDS) return stop("Call ended: nothing was said for a while.");
        return listen();
      }
      silent.current = 0;
      void answer(heard).then((go) => go && listen());
    };
    setPhase("listening");
    try {
      r.start();
    } catch {
      stop("The browser could not start listening.");
    }
  };

  const start = () => {
    if (!Ctor) return setNote("This browser cannot listen. Use Chrome, Edge or Safari.");
    live.current = true;
    silent.current = 0;
    setNote(undefined);
    // spoken inside the tap, so a phone's browser lets the later answers speak too
    void speak("Listening.").then(listen);
  };

  const onCall = phase !== "idle";
  const words: Record<Phase, string> = {
    idle: "Talk to your team. Your browser listens and speaks; your own AI answers on your own server.",
    listening: "Listening…",
    thinking: "Your team is answering on its own server…",
    speaking: "Speaking the answer…",
  };
  const bar = (
    <section data-testid="own-call" data-on-call={onCall ? "true" : undefined} aria-label="Call your team" className={cn("mb-2 flex items-center gap-2 rounded-md border px-2.5 py-2", onCall ? "border-emerald-500/50" : "bg-card")}>
      <div className="min-w-0 flex-1 text-xs leading-snug text-muted-foreground">
        <p className={cn(onCall && "text-sm font-medium text-foreground")} data-testid="own-call-state">
          {words[phase]}
        </p>
        {note && (
          <p className="text-amber-700 dark:text-amber-400" data-testid="own-call-note">
            {note}
          </p>
        )}
      </div>
      {onCall ? (
        <Button data-testid="own-call-end" variant="destructive" className={cn(PHONE_TAP, "shrink-0 gap-1.5")} onClick={() => stop("Call ended.")}>
          <PhoneOff /> End
        </Button>
      ) : (
        <Button data-testid="own-call-start" variant="outline" className={cn(PHONE_TAP, "shrink-0 gap-1.5 border-emerald-600/50 text-emerald-800 dark:text-emerald-300")} onClick={start}>
          <Phone /> Call
        </Button>
      )}
    </section>
  );
  return { bar, onCall, phase };
}
