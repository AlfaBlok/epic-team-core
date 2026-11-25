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
}

export interface ElevenLine {
  end(): Promise<void>;
  mute(m: boolean): void;
  id(): string | undefined;
}

export async function startEleven(h: ElevenHooks): Promise<ElevenLine> {
  let convId: string | undefined;
  const conv = await Conversation.startSession({
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
      if (m.message?.replace(/[.\s…]/g, "")) h.onLine(m.role === "user" ? "owner" : "voice", m.message);
    },
    onModeChange: ({ mode }) => h.onMode(mode === "speaking"),
    onDisconnect: (d) => h.onEnded(d.reason === "agent" ? "bye" : d.reason === "user" ? "hangup" : "line_dropped"),
    onError: (message) => h.onError(message),
  });
  return {
    end: () => conv.endSession().catch(() => undefined),
    mute: (m) => (conv as { setMicMuted?: (m: boolean) => void }).setMicMuted?.(m),
    id: () => convId ?? conv.getId?.(),
  };
}
