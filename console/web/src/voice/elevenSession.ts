/**
 * A call through ElevenLabs Agents. The console hands this
 * page a signed link for one call plus the call's own instructions and greeting; the ElevenLabs client opens the
 * microphone and the line, and this module answers the agent's tools through the console's call routes.
 *
 *   console POST /calls ──▶ signed link + instructions ──▶ ElevenLabs agent ⇄ his microphone and speaker
 *                                                             │ client tools
 *                                                             ▼
 *                             quick_status, ask_the_desk, the inbox and objective walk (console routes)
 *
 * Loaded only when a call starts on ElevenLabs (engine.ts imports it then), so the first page stays light.
 */
import { Conversation } from "@elevenlabs/client";
import { CLOCK_MARK } from "./timeLeft";

/** how long a desk question may hold the agent's turn (its tool waits up to 120 s). */
export const ELEVEN_ASK_WAIT_MS = 100_000;

export interface ElevenHooks {
  signedUrl: string;
  instructions?: string;
  greeting?: string;
  tools: Record<string, (args: Record<string, unknown>) => Promise<string>>;
  onLive(conversationId: string): void;
  onLine(who: "owner" | "voice", text: string): void;
  onMode(speaking: boolean): void;
  onEnded(reason: string): void;
  onError(message: string): void;
  /** each microphone stream the ElevenLabs client opens (at start and on a restart), so the page can watch its track. */
  onMic?(stream: MediaStream): void;
}

export interface ElevenLine {
  end(): Promise<void>;
  mute(m: boolean): void;
  id(): string | undefined;
  /** a note that makes the agent speak now (the call's clock); its own text never shows as his line. */
  say?(note: string): void;
  /** take the microphone again (a phone stopped it while the screen was off); the new stream reaches onMic. */
  restartMic(): Promise<void>;
  /** a note the agent reads without answering it (the microphone stopped or came back). */
  context(text: string): void;
}

/**
 * Every getUserMedia the ElevenLabs client makes while `fn` runs is handed to `seen` (the client keeps its stream to
 * itself; the page needs the track to see when the phone stops it).
 */
export async function catchMic<T>(seen: ((s: MediaStream) => void) | undefined, fn: () => Promise<T>): Promise<T> {
  const md = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  const orig = md?.getUserMedia;
  if (!md || !orig || !seen) return fn();
  md.getUserMedia = async (c?: MediaStreamConstraints) => {
    const s = await orig.call(md, c);
    if (c?.audio) seen(s);
    return s;
  };
  try {
    return await fn();
  } finally {
    md.getUserMedia = orig;
  }
}

export async function startEleven(h: ElevenHooks): Promise<ElevenLine> {
  let convId: string | undefined;
  const conv = await catchMic(h.onMic, () => Conversation.startSession({
    signedUrl: h.signedUrl,
    connectionType: "websocket",
    overrides: { agent: { ...(h.instructions ? { prompt: { prompt: h.instructions } } : {}), ...(h.greeting ? { firstMessage: h.greeting } : {}) } },
    clientTools: Object.fromEntries(Object.entries(h.tools).map(([k, fn]) => [k, (p: any) => fn((p ?? {}) as Record<string, unknown>)])),
    onConnect: ({ conversationId }) => {
      convId = conversationId;
      h.onLive(conversationId);
    },
    onMessage: (m) => {
      // ElevenLabs writes his silence as "...": not a line of the transcript.
      if (m.message?.startsWith(CLOCK_MARK)) return;
      if (m.message?.replace(/[.\s…]/g, "")) h.onLine(m.role === "user" ? "owner" : "voice", m.message);
    },
    onModeChange: ({ mode }) => h.onMode(mode === "speaking"),
    onDisconnect: (d) => h.onEnded(d.reason === "agent" ? "bye" : d.reason === "user" ? "hangup" : "line_dropped"),
    onError: (message) => h.onError(message),
  }));
  return {
    end: () => conv.endSession().catch(() => undefined),
    mute: (m) => (conv as { setMicMuted?: (m: boolean) => void }).setMicMuted?.(m),
    id: () => convId ?? conv.getId?.(),
    say: (note) => conv.sendUserMessage(note),
    restartMic: () => catchMic(h.onMic, () => (conv as { changeInputDevice?: (o: object) => Promise<void> }).changeInputDevice?.({}) ?? Promise.resolve()),
    context: (text) => {
      try {
        conv.sendContextualUpdate(text);
      } catch {
        /* the line is closing */
      }
    },
  };
}
