import crypto from "node:crypto";
import { DEFAULT_TENANT, type DB } from "../db.js";
import type { DeskMessage, DeskView } from "../desk/session.js";
import { tokensOf } from "./brief.js";
import { callLines, chatLines, RECALL_HOURS, recallBlock } from "./recall.js";
import { notesMonthUsd } from "./notes.js";
import { addTokens, costOf, PRICES, PRICES_CHECKED, TRANSCRIBE_MODEL, TRANSCRIBE_PRICES, tokensOfResponse, tokensOfTranscription, zeroTokens, type Tokens } from "./prices.js";
import { homeWorld, hostOf, isOwnerWho, keyFile, ownerName, sites } from "../identity.js";

/**
 * "Call the desk". the owner talks to OpenAI's realtime voice model straight from his browser (WebRTC);
 * the console only (1) mints a 1-minute client key for one call, under the caps and the off switch, so the real
 * OPENAI_API_KEY never reaches the browser, (2) answers the voice's two tools (quick status, ask the desk), (3) meters the
 * cost from the API's own usage numbers, and (4) writes the transcript into the desk chat, marked as a call.
 */

/** The console's own copy of the key (the infra repo `secret copy scrapingv1 agent-team-console OPENAI_API_KEY`), read with sudo -n. */
export const openAiStoreFile = (): string => keyFile("OPENAI_API_KEY");
export const DEFAULT_VOICE_MODEL = "gpt-realtime-2.1-mini";
export const DEFAULT_VOICE = "marin";
/** The client key lives this long: enough to open the call, useless after. */
export const KEY_TTL_S = 60;
export const MONTH_CAP_USD = 25;
/** a world's own calls (its campaign chats) have their own month budget, this much unless the platform sets one. */
export const WORLD_MONTH_CAP_USD = 5;
export const CALL_MAX_MIN = 20;
export const CALL_WARN_MIN = 18;
/**: a call with nobody speaking for this long ends by itself (setting `quiet_hangup_s`). */
export const QUIET_HANGUP_S = 60;
/** The voice warns this many seconds before the idle hang-up ("Still there? …"). */
export const QUIET_WARN_S = 10;
export const QUIET_HANGUP_MIN_S = 20;
export const QUIET_HANGUP_MAX_S = 600;
/**
 * a cap on the conversation the voice re-reads each turn (setting `history_tokens`, OpenAI's `truncation`
 * retention_ratio with token_limits.post_instructions; 0 = not sent, OpenAI's default, the whole call). Off by default:
 * on 2026-11-02 gpt-realtime-2.1-mini echoed the cap in session.created but did not truncate at 2000 even with ~5700
 * tokens of history (call_2eec04be still recalled its first message), so it saves nothing yet. Kept as a setting to
 * retry when OpenAI applies it ([e42-s12](../../../../docs/status/e42-s12-cheaper-voice.md)).
 */
export const HISTORY_TOKENS = 0;
export const HISTORY_TOKENS_MIN = 2000;
export const HISTORY_TOKENS_MAX = 28000;
export const HISTORY_RETENTION = 0.8;
/** A call whose page sent no heartbeat for this long is over (tab closed, phone locked). */
export const LOST_AFTER_MS = 3 * 60_000;
/** the end reason of a call hung up from a page that did not hold it. */
export const ENDED_ELSEWHERE = "ended_elsewhere";
/** Below this much left in the month, no new call starts (one short call costs about this). */
export const MIN_LEFT_USD = 0.5;
/** Page hint of the call's desk messages (questions and the transcript). */
export const CALL_PAGE = "voice call";
export const CALL_QUESTION_HEAD = "📞 Call question";
export const CALL_TRANSCRIPT_HEAD = "📞 Call with the desk";
/** the one message listen mode sends when he says "done": all his feedback, to be filed once. */
export const CALL_FEEDBACK_HEAD = "📞 Call feedback";
/** At most this much of his feedback goes in that message (a long monologue still fits; the head keeps the newest). */
export const FEEDBACK_WORDS_MAX = 12_000;
/** listen mode: quiet window (his voice only) and the gentle check before it, in seconds. */
export const LISTEN_QUIET_S = 180;
export const LISTEN_WARN_S = 60;
/** Second line of the transcript post: what the desk must (not) do with it. */
export const CALL_RECORD_NOTE = "Record only: already handled live. Do not act on it again.";
/**
 * the voice greets in one brief line; what it can do it says only when asked.'s
 * honesty stays: asked, or when it first relays, it says it passes things to the desk and the reply comes back here and in Chat.
 */
export const OPENING_LINE = `Hi ${ownerName()}, I'm the desk line. How can I help?`;
/**
 * the page has the voice say this line
 * in a response of its own, once per call; the instructions only tell the model it was said and never to say it again.
 */
export const GREETING_LEAD = "When the line opens, the console has you say this greeting, once:";
/** The greeting in a call's final instructions (the campaign and milestone calls re-aim the Team desk's words, greeting included). */
export function greetingOf(instructions: string): string | undefined {
  const i = instructions.indexOf(GREETING_LEAD);
  return i < 0 ? undefined : /^\s*"([^"]+)"/.exec(instructions.slice(i + GREETING_LEAD.length))?.[1];
}
/**
 * the voice used to announce every hand-off at length, give "still working" updates every 10 s
 * and read each desk reply as a speech. It went minimal. That overcorrected: an eight-word cap,
 * "at most one word ('Noted.')" and "do not read desk replies out" left it no words to pass the desk's answer on, so answers sat
 * unspoken while he waited, and it filled the gap with "Noted.", "I don't know" and "It's locked. Next?". Now: short but warm,
 * one friendly line when it hands over, and every desk answer said at once, simply.
 */
/**
 * The style block first in the instructions (the realtime model weighs it most there): short but warm, and bad/good pairs from
 * the real calls (call_3a2e181c; call_48d3a10f, the long narration; call_37f96758, the cold, withholding turns).
 */
export const STYLE_BLOCK = [
  "# Style: the most important rules on this call",
  "- Short but warm: usually one short sentence, friendly and natural, like a good colleague on the phone. Never curt, never cold, never a lecture.",
  "- When the desk's answer arrives, tell him right away, simply, in one to three short sentences.",
  "- Never talk about your own limits, and never say 'I don't know' while the desk is on it: say it's coming.",
  "- Never describe how you talk ('warm', 'brief', 'short and snappy') and never repeat back what he said: just talk.",
  "- If the desk already answered it on this call, answer again from that at once, kindly, without asking the desk again.",
  `- Bad: 'Noted.' Good: 'Sure, ${ownerName()}. I'll get the desk on that.'`,
  "- Bad: 'I don't know.' Good: 'The desk is on it. I'll tell you as soon as it answers.'",
  `- Bad: 'It's locked. Next?' Good: 'Sorry, ${ownerName()}, the desk can't post there. You can add it at ${hostOf(sites().socialUrl)}.'`,
  `- Bad: 'Here's a warm, brief update: I can keep it simple and just chat with you.' Good: 'Sure, ${ownerName()}. Let's just talk.'`,
  "- Bad: 'Got it, you're waiting for confirmation on posting. I'm checking with the desk.' Good: 'Sorry, no: the desk can't post there.'",
  "- Bad: 'Got it, let me quickly ask the desk about those voice notes while you share your weekend.' Good: 'Sure. Go on.'",
].join("\n");
export const MINIMAL_RULE =
  `Most turns are one short, friendly sentence ('Sure, go on.', 'Which one?', 'For X or Reddit?', 'Got it, ${ownerName()}.'); a short warm sentence beats a long one, and a bare word can sound cold.`;
export const LISTENER_RULE =
  "let him finish his thought (a pause is not the end), and keep him talking ('Go on.', 'And then?', 'Why that?'). When something is unclear, ask one short clarifying question ('Which page?', 'Daily or weekly?'), one at a time. Do not summarise him or give advice unless he asks.";
export const HANDOFF_RULE =
  "When you hand something over, say so once per question, in one short warm line ('Sure, I'll get the desk on that.', 'Got it, I'll ask the desk.'), then keep listening. No progress updates while it works. As he adds detail, send only what is new.";
export const DESK_ANSWER_RULE =
  "As soon as it arrives, tell him: the answer first, plainly, in one to three short sentences in the desk's own facts, no ids. If it asks him something, give the answer and then ask its question. If he asks while it is still working, say it's on its way and you'll tell him the moment it lands.";
/**: the warning before the idle hang-up. The goodbye before hang_up. */
export const QUIET_WARN_LINE = "Still there? I'll hang up in a few seconds.";
export const ROLE_LINE = "I'm the voice line in front of the desk. Quick status I answer myself. The rest I pass to the desk, and I tell you its answer as soon as it lands.";
/** At most this much of the owner's own words goes with a question to the desk. */
export const ASK_WORDS_MAX = 1500;
/** The voice gives up waiting for the desk after this long ("the answer will be in Chat") but keeps checking. */
export const ASK_SPOKEN_WAIT_MS = 60_000;
/** a call starts without its briefing rather than wait longer than this for it. */
export const BRIEF_WAIT_MS = 3_000;

export class VoiceError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 502 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function ensureVoiceTables(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS voice_calls (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      last_beat_at TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT,
      model TEXT NOT NULL,
      text_in INTEGER NOT NULL DEFAULT 0,
      text_cached_in INTEGER NOT NULL DEFAULT 0,
      audio_in INTEGER NOT NULL DEFAULT 0,
      audio_cached_in INTEGER NOT NULL DEFAULT 0,
      text_out INTEGER NOT NULL DEFAULT 0,
      audio_out INTEGER NOT NULL DEFAULT 0,
      tr_in INTEGER NOT NULL DEFAULT 0,
      tr_out INTEGER NOT NULL DEFAULT 0,
      responses INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      session_id TEXT,
      transcript_posted_at TEXT,
      transcript_error TEXT
    );
    CREATE INDEX IF NOT EXISTS voice_calls_started ON voice_calls (started_at);
    CREATE TABLE IF NOT EXISTS voice_usage (
      call_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      at TEXT NOT NULL,
      usage TEXT NOT NULL,
      PRIMARY KEY (call_id, event_id)
    );
    CREATE TABLE IF NOT EXISTS voice_asks (
      id TEXT PRIMARY KEY,
      call_id TEXT NOT NULL,
      n INTEGER NOT NULL,
      request TEXT NOT NULL,
      head TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      send_error TEXT,
      answered_at TEXT,
      answer TEXT
    );
  `);
  // a call belongs to a world (its budget) and, for a campaign chat's call, to that campaign; older rows are the home world's Team desk.
  const cols = new Set((db.prepare("PRAGMA table_info(voice_calls)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("tenant_id")) db.exec("ALTER TABLE voice_calls ADD COLUMN tenant_id TEXT");
  if (!cols.has("milestone_id")) db.exec("ALTER TABLE voice_calls ADD COLUMN milestone_id TEXT");
  // a call's one feedback message (listen mode) is a voice_asks row of kind 'feedback'.
  const askCols = new Set((db.prepare("PRAGMA table_info(voice_asks)").all() as { name: string }[]).map((c) => c.name));
  if (!askCols.has("kind")) db.exec("ALTER TABLE voice_asks ADD COLUMN kind TEXT");
  // the briefing's size per call (estimated tokens), to measure what it adds.
  if (!cols.has("brief_tokens")) db.exec("ALTER TABLE voice_calls ADD COLUMN brief_tokens INTEGER");
  // the call's own transcript (JSON lines, as the page sent them), for the next call's earlier conversation; and its size.
  if (!cols.has("transcript")) db.exec("ALTER TABLE voice_calls ADD COLUMN transcript TEXT");
  if (!cols.has("recall_tokens")) db.exec("ALTER TABLE voice_calls ADD COLUMN recall_tokens INTEGER");
  // the owner's own turns of a call with no stored transcript (JSON array of strings), kept the first time they are read
  // from its chat post (or back-filled from his the memory service), so a later resend never depends on reading an old desk session again.
  if (!cols.has("jordi_words")) db.exec("ALTER TABLE voice_calls ADD COLUMN jordi_words TEXT");
}

export interface VoiceCall {
  id: string;
  startedAt: string;
  lastBeatAt: string;
  endedAt?: string;
  endReason?: string;
  model: string;
  seconds: number;
  tokens: Tokens;
  responses: number;
  costUsd: number;
  /** US$ per minute of this call (null under 10 s: too short to mean anything). */
  usdPerMin: number | null;
  sessionId?: string;
  transcriptPostedAt?: string;
  transcriptError?: string;
  /** estimated tokens the briefing added to this call's instructions (each turn's input carries them). */
  briefTokens?: number;
  /** estimated tokens of earlier conversation (the last 24 h of chat and calls) this call started with. */
  recallTokens?: number;
}

/** What the browser needs to open the call: the 1-minute key and the limits the page enforces. */
export interface CallStart {
  call: VoiceCall;
  clientSecret: string;
  expiresAt: number;
  model: string;
  limits: Limits;
  /** The session's turn detection, which the page puts back when listen mode ends. */
  turnDetection: Record<string, unknown>;
  /** the one greeting line, which the page has the voice say once when the line opens (never the model's own choice). */
  greeting?: string;
}
export interface Limits {
  callMaxMin: number;
  callWarnMin: number;
  quietHangupS: number;
  quietWarnS: number;
  listenQuietS: number;
  listenWarnS: number;
  monthCapUsd: number;
  /** tokens of conversation the voice keeps after its instructions (0 = no cap). */
  historyTokens: number;
}

export interface VoiceState {
  /** the owner's world with the switch on and a key: the Call button shows. */
  available: boolean;
  enabled: boolean;
  /** the platform's switch is on but this world's own is not (another world than the home world has voice only when the owner switched it on). */
  worldOff?: true;
  reason?: string;
  model: string;
  monthUsd: number;
  monthMinutes: number;
  monthCalls: number;
  /** rework: voice notes recorded in Chat this month (their cost is in monthUsd too). */
  monthNotes: number;
  monthNotesUsd: number;
  monthNotesMinutes: number;
  limits: Limits;
  activeCall?: VoiceCall;
  lastCall?: VoiceCall;
  prices: { checked: string; perMillion: (typeof PRICES)[string]; transcribe: typeof TRANSCRIBE_PRICES & { model: string } };
}

/** Mint a client key: the console's call to OpenAI with the real key (tests fake it). */
export type Minter = (body: unknown) => Promise<{ value: string; expires_at: number; session?: { id?: string } }>;

export interface DeskPort {
  send(text: string, page?: string, clientRequestId?: string): Promise<{ threadId: string; pending: boolean }>;
  view(): Promise<DeskView>;
}

export interface QuickStatus {
  text: string;
  waiting: number;
  stuck: number;
  working: number;
  /** milestones listed, in priority order (big roots first). */
  milestones?: number;
}

/**
 * whose calls one Voice serves. The Team desk's is the home world's, no milestone (the default); a campaign chat's is its
 * world's and that milestone's. Every read and write keeps to the scope's rows (a call of another campaign or world is a 404),
 * the month budget and "one call at a time" are per world, and the world's cap is its own (`month_cap_usd:<world>`).
 */
export interface VoiceScope {
  world: string;
  milestoneId?: string;
}

export interface VoiceDeps {
  db: DB;
  scope?: VoiceScope;
  /** The session's standing instructions (default: the Team desk's voiceInstructions). */
  instructions?: () => string;
  /** The voice's tools (default: VOICE_TOOLS, the Team desk's). */
  tools?: () => typeof VOICE_TOOLS;
  mint: Minter;
  desk?: DeskPort;
  quickStatus: () => Promise<QuickStatus>;
  /** the briefing appended to the instructions at each call's start (root tree + Epic Book summary); "" = none. */
  brief?: () => Promise<string> | string;
  /** CONSOLE_VOICE=off forces the switch off, whatever the setting says. */
  envOff?: boolean;
  /** Model name override (CONSOLE_VOICE_MODEL); the setting wins when set. */
  envModel?: string;
  now?: () => number;
  /** a call has ended (its transcript stored and posted when there is one): it goes to the owner's the memory service. */
  onEnded?: (id: string) => void;
}

/**
 * The voice's standing instructions: minimal, a listener, and never acting on its own.
 * short turns, no progress updates,
 * clarifying questions that keep him talking. Short but warm, one line when it hands over, and every
 * desk answer said at once.
 */
export function voiceInstructions(): string {
  return [
    STYLE_BLOCK,
    "",
    `You are the voice line in front of ${ownerName()}'s Team desk, on a live call with him (he owns the team). You are not the desk: the desk is the agent with the team's tools. You answer quick status yourself and pass everything else to the desk, so its chat stays clean. Answer in the language he speaks (English or Spanish).`,
    `${GREETING_LEAD} "${OPENING_LINE}" That is the only greeting on this call: never greet him again or say that line again yourself, even if he talks over it or you hear only noise; then just listen, or answer what he said. Do not list what you can do unless he asks.`,
    `If he asks what you are or what you can do: "${ROLE_LINE}"`,
    `Keep it short and warm. ${MINIMAL_RULE} Longer (one to three short sentences) when you pass on the desk's answer, or when he asks for detail. Never repeat back what he said, no lists read aloud, no ids unless he asks. He can interrupt you at any time.`,
    `Be a good listener: ${LISTENER_RULE}`,
    "You know nothing about the team except the briefing and the earlier conversation at the end of these instructions (when there are any) and what your tools return:",
    `- quick_status: his milestones in priority order, what is waiting on ${ownerName()}, what is stuck and what is working now, in about a second. Use it for 'what are my priorities', 'what's waiting on me', 'what's stuck', 'what's going on', and answer from it yourself, in a few words.`,
    `- ask_the_desk: passes his request to the Team desk as a chat message marked as a call. Use it for every other question and for anything he wants done. ${HANDOFF_RULE} Put his request in his terms; the console also sends the desk his exact words, so never turn it into something else.`,
    `The desk's reply comes later as a system message. ${DESK_ANSWER_RULE}`,
    "Send each thing to the desk once. If he adds to a request, send only what is new.",
    "Never say something is done, started, answered or changed unless the desk said so. Never answer a question for the desk yourself: if you have no answer, pass it to the desk; while one is with the desk, say it is coming, never 'I don't know', and never list what you or the desk cannot do.",
    "Do not ask permission you do not need. Questions and lookups: just ask the desk. When he says he wants something built, changed or filed ('I want…', 'we need…', 'file it', 'yes, do it'), that is his yes: send it with confirmed=true, without reading it back. Read back only when you are unsure what he wants changed, in a few words, once.",
    "Listen mode: when he says he wants to give feedback ('I want to give feedback', 'feedback time', 'just listen', 'quiero darte feedback'), call listen_for_feedback at once and say nothing yourself. From then on the console holds his words, now and then answers a pause with one short acknowledgement ('Mm-hm', 'Got it') and otherwise waits, and sends everything to the desk in one message when he says done; never call ask_the_desk with any of it, before or after.",
    "The whole call is saved to Chat when he hangs up, as a record; there is nothing to send the desk about it.",
    `Ending the call: when he clearly says he is done ('hang up', 'bye', 'goodbye', 'that's all', 'that's it, thanks', 'nothing else', 'adiós', 'cuelga'), say one short goodbye ('Bye, ${ownerName()}.') and call hang_up in the same turn. Only when the phrase closes the call: never on a phrase inside a request ('that's all I wanted to ask about the release, and…', 'tell the desk bye to that idea'), never while he is still asking something, and never on your own initiative. If unsure, ask 'Hang up?' and hang up only on his yes.`,
    `If a system message says the line has been quiet, say exactly: "${QUIET_WARN_LINE}" and nothing else.`,
    "The call has a 20-minute limit; when a system message says time is nearly up, tell him in a few words that he can call again.",
  ].join("\n");
}

export const VOICE_TOOLS = [
  {
    type: "function",
    name: "quick_status",
    description:
      `Read-only facts from the console in about a second: ${ownerName()}'s milestones in priority order (his big roots first, numbered: 1 is the top priority) with each one's state and what in it waits on him; what waits on ${ownerName()} (asks, reviews); what is stuck; what is working now. Use it for 'what are my priorities', 'what are the milestones', 'how is <milestone> going'.`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "ask_the_desk",
    description:
      `Pass ${ownerName()}'s request to the Team desk (it has all the team's tools) as a chat message marked as a call. Returns at once with an ask id; the desk's reply arrives later as a system message. For an action, confirmed=true when he told you to do it. Say one short warm line as you call it ('Sure, I'll get the desk on that.'); its answer is yours to tell him the moment it arrives.`,
    parameters: {
      type: "object",
      properties: {
        request: { type: "string", description: `${ownerName()}'s request in his words, complete enough for the desk to act on without the call.` },
        confirmed: { type: "boolean", description: `true when it changes state and ${ownerName()} told you to do it (or said yes to your read-back).` },
      },
      required: ["request"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "listen_for_feedback",
    description:
      `Listen mode: ${ownerName()} said he wants to give feedback. The console then holds everything he says, now and then answers a pause with one short acknowledgement ('Mm-hm', 'Got it') and otherwise waits, reads nothing from the desk, and sends it all to the desk as one message when he says done. Say nothing before calling it.`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "hang_up",
    description:
      `End the call. Only when ${ownerName()} clearly says he is done ('hang up', 'bye', 'that's all', 'nothing else'), never on such a phrase inside a request. Say one short goodbye in the same turn first; the line closes once it has been heard.`,
    parameters: {
      type: "object",
      properties: { said: { type: "string", description: "His words that ended the call." } },
      additionalProperties: false,
    },
  },
];

/** The session the client key is minted for (model, voice, instructions, tools, transcription for captions). */
export function sessionConfig(model: string, instructions: string = voiceInstructions(), tools: typeof VOICE_TOOLS = VOICE_TOOLS, historyTokens: number = HISTORY_TOKENS) {
  const truncation =
    historyTokens > 0 ? { truncation: { type: "retention_ratio" as const, retention_ratio: HISTORY_RETENTION, token_limits: { post_instructions: historyTokens } } } : {};
  return {
    expires_after: { anchor: "created_at", seconds: KEY_TTL_S },
    session: {
      type: "realtime",
      model,
      instructions,
      output_modalities: ["audio"],
      audio: {
        input: {
          transcription: { model: TRANSCRIBE_MODEL },
          noise_reduction: { type: "near_field" },
          turn_detection: { type: "server_vad", silence_duration_ms: 600, create_response: true, interrupt_response: true },
        },
        output: { voice: DEFAULT_VOICE },
      },
      tools,
      tool_choice: "auto",
      ...truncation,
    },
  };
}

/** The default minter: OpenAI's client-secret endpoint, with the console's own key (env first, then the secret store). */
export function openAiMinter(key: () => Promise<string | undefined>, f: typeof fetch = fetch): Minter {
  return async (body) => {
    const k = await key();
    if (!k) throw new VoiceError(503, "no_key", "the console has no OPENAI_API_KEY (secret store agent-team-console/OPENAI_API_KEY)");
    const r = await f("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: { authorization: `Bearer ${k}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await r.json().catch(() => ({}))) as any;
    if (!r.ok || typeof j.value !== "string") throw new VoiceError(502, "openai_refused", `OpenAI refused the call key (${r.status}): ${String(j?.error?.message ?? "no message").slice(0, 200)}`);
    return j;
  };
}

const minutes = (s: number) => Math.round((s / 60) * 10) / 10;
const usd = (v: number) => `$${v < 1 ? v.toFixed(3) : v.toFixed(2)}`;

export function createVoice(d: VoiceDeps) {
  const { db } = d;
  ensureVoiceTables(db);
  const now = d.now ?? Date.now;
  const iso = (t = now()) => new Date(t).toISOString();
  const world = d.scope?.world ?? DEFAULT_TENANT;
  const ms = d.scope?.milestoneId ?? null;
  /** SQL: this world's calls (budget, one at a time) / this scope's calls (the Team desk's, or one campaign's). */
  const inWorld = `COALESCE(tenant_id, '${homeWorld()}') = @w`;
  const inScope = `${inWorld} AND milestone_id IS @m`;
  const sc = { w: world, m: ms };

  const setting = (k: string) => (db.prepare("SELECT value FROM voice_settings WHERE key = ?").get(k) as { value: string } | undefined)?.value;
  const put = (k: string, v: string) => db.prepare("INSERT INTO voice_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, v);

  const model = () => setting("model") || d.envModel || DEFAULT_VOICE_MODEL;
  const platformOn = () => !d.envOff && setting("enabled") !== "off";
  // a world other than the home world has voice (calls and notes) only when its own switch is on: the owner turns it on for his
  // worlds (a social world repo), every other world's people stay without voice unless their setting says so.
  const worldKey = world === DEFAULT_TENANT ? undefined : `enabled:${world}`;
  const worldOn = () => !worldKey || setting(worldKey) === "on";
  const enabled = () => platformOn() && worldOn();
  const offWhy = () => (platformOn() ? "Voice is not switched on for this workspace." : "Voice is switched off in the console.");
  const historyTokens = () => {
    const v = setting("history_tokens");
    return v === undefined || !Number.isFinite(Number(v)) ? HISTORY_TOKENS : Number(v);
  };
  const capKey = world === DEFAULT_TENANT ? "month_cap_usd" : `month_cap_usd:${world}`;
  const monthCap = () => Number(setting(capKey)) || (world === DEFAULT_TENANT ? MONTH_CAP_USD : WORLD_MONTH_CAP_USD);
  const limits = (): Limits => ({
    callMaxMin: CALL_MAX_MIN,
    callWarnMin: CALL_WARN_MIN,
    quietHangupS: Number(setting("quiet_hangup_s")) || QUIET_HANGUP_S,
    quietWarnS: QUIET_WARN_S,
    listenQuietS: LISTEN_QUIET_S,
    listenWarnS: LISTEN_WARN_S,
    monthCapUsd: monthCap(),
    historyTokens: historyTokens(),
  });

  const rowTo = (r: any): VoiceCall => {
    const end = Date.parse(r.ended_at ?? r.last_beat_at);
    const seconds = Math.max(0, Math.round((end - Date.parse(r.started_at)) / 1000));
    const tokens: Tokens = { textIn: r.text_in, textCachedIn: r.text_cached_in, audioIn: r.audio_in, audioCachedIn: r.audio_cached_in, textOut: r.text_out, audioOut: r.audio_out, trIn: r.tr_in, trOut: r.tr_out };
    return {
      id: r.id,
      startedAt: r.started_at,
      lastBeatAt: r.last_beat_at,
      ...(r.ended_at ? { endedAt: r.ended_at } : {}),
      ...(r.end_reason ? { endReason: r.end_reason } : {}),
      model: r.model,
      seconds,
      tokens,
      responses: r.responses,
      costUsd: r.cost_usd,
      usdPerMin: seconds >= 10 ? Math.round((r.cost_usd / (seconds / 60)) * 10_000) / 10_000 : null,
      ...(r.session_id ? { sessionId: r.session_id } : {}),
      ...(r.transcript_posted_at ? { transcriptPostedAt: r.transcript_posted_at } : {}),
      ...(r.transcript_error ? { transcriptError: r.transcript_error } : {}),
      ...(r.brief_tokens != null ? { briefTokens: r.brief_tokens } : {}),
      ...(r.recall_tokens != null ? { recallTokens: r.recall_tokens } : {}),
    };
  };
  const get = (id: string): VoiceCall | undefined => {
    const r = db.prepare(`SELECT * FROM voice_calls WHERE id = @id AND ${inScope}`).get({ id, ...sc });
    return r ? rowTo(r) : undefined;
  };
  const must = (id: string): VoiceCall => {
    const c = get(id);
    if (!c) throw new VoiceError(404, "not_found", `no call ${id}`);
    return c;
  };

  const monthStart = () => {
    const t = new Date(now());
    return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1)).toISOString();
  };
  const month = () => {
    const rows = (db.prepare(`SELECT * FROM voice_calls WHERE started_at >= @s AND ${inWorld}`).all({ s: monthStart(), w: world }) as any[]).map(rowTo);
    // rework: voice notes recorded in this world's chats count in the same month budget.
    const notes = notesMonthUsd(db, world, monthStart());
    const callsUsd = rows.reduce((a, c) => a + c.costUsd, 0);
    return { usd: Math.round((callsUsd + notes.usd) * 1e6) / 1e6, seconds: rows.reduce((a, c) => a + c.seconds, 0), calls: rows.length, notes: notes.notes, notesUsd: Math.round(notes.usd * 1e6) / 1e6, notesMinutes: minutes(notes.seconds) };
  };

  /** Calls the page stopped beating for (tab closed, phone locked) or past the hard limit are over. */
  function closeLost() {
    const lostBefore = iso(now() - LOST_AFTER_MS);
    const tooOld = iso(now() - (CALL_MAX_MIN + 2) * 60_000);
    for (const r of db.prepare(`SELECT id, last_beat_at FROM voice_calls WHERE ended_at IS NULL AND (last_beat_at < @l OR started_at < @o) AND ${inWorld}`).all({ l: lostBefore, o: tooOld, w: world }) as any[])
      db.prepare("UPDATE voice_calls SET ended_at = ?, end_reason = 'lost' WHERE id = ? AND ended_at IS NULL").run(r.last_beat_at, r.id);
  }
  const active = (): VoiceCall | undefined => {
    closeLost();
    const r = db.prepare(`SELECT * FROM voice_calls WHERE ended_at IS NULL AND ${inWorld} ORDER BY started_at DESC LIMIT 1`).get({ w: world });
    return r ? rowTo(r) : undefined;
  };
  const open = (id: string): VoiceCall => {
    const c = must(id);
    if (c.endedAt) throw new VoiceError(409, "call_ended", `call ${id} has ended (${c.endReason ?? "ended"})`);
    return c;
  };

  /** Why no call may start now, or undefined. */
  function refusal(): { code: string; message: string } | undefined {
    if (!enabled()) return { code: "voice_off", message: offWhy() };
    const m = month();
    const cap = limits().monthCapUsd;
    if (m.usd >= cap - MIN_LEFT_USD) return { code: "month_cap", message: `Voice paused until the 1st: this month's calls reached the ${usd(cap)} cap. Chat still works.` };
    if (active()) return { code: "one_call", message: "A call is already on (one call at a time). Hang it up first." };
    return undefined;
  }

  function state(): VoiceState {
    const m = month();
    const act = active();
    const last = db.prepare(`SELECT * FROM voice_calls WHERE ended_at IS NOT NULL AND ${inScope} ORDER BY started_at DESC LIMIT 1`).get(sc);
    const why = enabled() ? (m.usd >= limits().monthCapUsd - MIN_LEFT_USD ? refusal()?.message : undefined) : offWhy();
    const mdl = model();
    return {
      available: enabled() && !why,
      enabled: enabled(),
      ...(platformOn() && !worldOn() ? { worldOff: true as const } : {}),
      ...(why ? { reason: why } : {}),
      model: mdl,
      monthUsd: m.usd,
      monthMinutes: minutes(m.seconds),
      monthCalls: m.calls,
      monthNotes: m.notes,
      monthNotesUsd: m.notesUsd,
      monthNotesMinutes: m.notesMinutes,
      limits: limits(),
      ...(act ? { activeCall: act } : {}),
      ...(last ? { lastCall: rowTo(last) } : {}),
      prices: { checked: PRICES_CHECKED, perMillion: PRICES[mdl] ?? PRICES["gpt-realtime-2.1"], transcribe: { ...TRANSCRIBE_PRICES, model: TRANSCRIBE_MODEL } },
    };
  }

  /** the briefing, never in the way of a call: a slow or failing one (book not built yet) is left out. */
  async function briefNow(): Promise<string> {
    return d.brief ? inTime("briefing", d.brief, "") : "";
  }

  /** At most BRIEF_WAIT_MS for `fn`; slow or failing: `none` (a call never waits longer for its context). */
  async function inTime<T>(what: string, fn: () => Promise<T> | T, none: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(fn), new Promise<T>((ok) => (timer = setTimeout(() => ok(none), BRIEF_WAIT_MS)))]);
    } catch (e) {
      console.warn(`voice: ${what} failed: ${(e as Error).message}`);
      return none;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * the earlier conversation of this desk (the last RECALL_HOURS): its earlier calls' stored transcripts and its
   * chat (a desk that cannot be read in time still gives the calls). "" = nothing in the window.
   */
  async function recallNow(): Promise<string> {
    const since = now() - RECALL_HOURS * 3_600_000;
    const rows = db.prepare(`SELECT id, started_at, transcript FROM voice_calls WHERE ${inScope} AND started_at >= @s AND transcript IS NOT NULL ORDER BY started_at`).all({ ...sc, s: iso(since) }) as {
      id: string;
      started_at: string;
      transcript: string;
    }[];
    const calls = rows.flatMap((r) => {
      try {
        const lines = JSON.parse(r.transcript);
        return Array.isArray(lines) ? [{ id: r.id, startedAt: r.started_at, lines }] : [];
      } catch {
        return [];
      }
    });
    const msgs = d.desk ? await inTime("recall chat", async () => ((v) => (v.available === false ? [] : v.messages))(await d.desk!.view()), [] as DeskMessage[]) : [];
    const lines = [...callLines(calls), ...chatLines(msgs, since, { transcriptHead: CALL_TRANSCRIPT_HEAD, known: new Set(calls.map((c) => c.id)) })];
    return recallBlock(lines, { now: iso() });
  }

  async function start(): Promise<CallStart> {
    const no = refusal();
    if (no) throw new VoiceError(409, no.code, no.message);
    const mdl = model();
    const [brief, recall] = await Promise.all([briefNow(), recallNow().catch(() => "")]);
    const instructions = (d.instructions ?? voiceInstructions)() + (brief ? `\n\n${brief}` : "") + (recall ? `\n\n${recall}` : "");
    const cfg = sessionConfig(mdl, instructions, d.tools?.() ?? VOICE_TOOLS, historyTokens());
    const key = await d.mint(cfg);
    const id = `call_${crypto.randomBytes(4).toString("hex")}`;
    const t = iso();
    // A second Call pressed while the key was being minted: the first one wins.
    if (active()) throw new VoiceError(409, "one_call", "A call is already on (one call at a time). Hang it up first.");
    db.prepare("INSERT INTO voice_calls (id, started_at, last_beat_at, model, session_id, tenant_id, milestone_id, brief_tokens, recall_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, t, t, mdl, key.session?.id ?? null, world, ms, brief ? tokensOf(brief) : null, recall ? tokensOf(recall) : null);
    if (recall) console.log(`[voice] ${id} starts with ${recall.split("\n").length - 1} lines of earlier conversation (~${tokensOf(recall)} tokens)`);
    return { call: must(id), clientSecret: key.value, expiresAt: key.expires_at, model: mdl, limits: limits(), turnDetection: cfg.session.audio.input.turn_detection, greeting: greetingOf(instructions) };
  }

  /** Recompute a call's totals from its stored usage events (each counted once by event id). */
  function retotal(id: string) {
    const c = must(id);
    let t = zeroTokens();
    let responses = 0;
    for (const u of db.prepare("SELECT kind, usage FROM voice_usage WHERE call_id = ?").all(id) as { kind: string; usage: string }[]) {
      const raw = JSON.parse(u.usage);
      if (u.kind === "transcription") t = addTokens(t, tokensOfTranscription(raw));
      else {
        t = addTokens(t, tokensOfResponse(raw));
        responses++;
      }
    }
    db.prepare(
      "UPDATE voice_calls SET text_in = ?, text_cached_in = ?, audio_in = ?, audio_cached_in = ?, text_out = ?, audio_out = ?, tr_in = ?, tr_out = ?, responses = ?, cost_usd = ? WHERE id = ?",
    ).run(t.textIn, t.textCachedIn, t.audioIn, t.audioCachedIn, t.textOut, t.audioOut, t.trIn, t.trOut, responses, costOf(c.model, t), id);
  }

  /** Why the page must hang up now, or undefined (per-call limit, month cap, switch off). */
  function stopWhy(c: VoiceCall): string | undefined {
    if (!enabled()) return "voice_off";
    if (c.seconds >= CALL_MAX_MIN * 60) return "call_limit";
    if (month().usd >= limits().monthCapUsd) return "month_cap";
    return undefined;
  }

  function beat(id: string) {
    // hung up from another page (endActive): the page that still holds it hangs up too and posts its transcript.
    const c0 = must(id);
    if (c0.endedAt && c0.endReason === ENDED_ELSEWHERE) return { call: c0, monthUsd: month().usd, stop: ENDED_ELSEWHERE };
    open(id);
    db.prepare("UPDATE voice_calls SET last_beat_at = ? WHERE id = ? AND ended_at IS NULL").run(iso(), id);
    const c = must(id);
    const stop = stopWhy(c);
    return { call: c, monthUsd: month().usd, ...(stop ? { stop } : {}) };
  }

  /** The browser forwards each `response.done` / transcription usage it receives; an event id counts once. */
  function usage(id: string, ev: { eventId: string; kind: "response" | "transcription"; usage: unknown }) {
    const c = must(id);
    if (!ev.eventId || typeof ev.usage !== "object" || ev.usage === null) throw new VoiceError(400, "validation_error", "eventId and usage (object) are required");
    // Usage may still arrive just after the hang-up (the last response.done): accept it for a minute after the end.
    if (c.endedAt && now() - Date.parse(c.endedAt) > 60_000) throw new VoiceError(409, "call_ended", `call ${id} has ended`);
    db.prepare("INSERT OR IGNORE INTO voice_usage (call_id, event_id, kind, at, usage) VALUES (?, ?, ?, ?, ?)").run(id, ev.eventId.slice(0, 120), ev.kind, iso(), JSON.stringify(ev.usage).slice(0, 4000));
    retotal(id);
    if (!c.endedAt) db.prepare("UPDATE voice_calls SET last_beat_at = ? WHERE id = ?").run(iso(), id);
    const after = must(id);
    const stop = after.endedAt ? undefined : stopWhy(after);
    return { call: after, monthUsd: month().usd, ...(stop ? { stop } : {}) };
  }

  /** The transcript as it lands in Chat: one header line (when, how long, what it cost), then who said what. */
  function transcriptText(c: VoiceCall, lines: { who: string; text: string; feedback?: string }[]): string {
    const when = `${c.startedAt.slice(0, 10)} ${c.startedAt.slice(11, 16)}Z`;
    const dur = `${Math.floor(c.seconds / 60)} min ${String(c.seconds % 60).padStart(2, "0")} s`;
    // his words held in listen mode already went to the desk as one feedback message: one line names it, the words
    // are not repeated here (the record must never be a second copy of the feedback to file).
    const body: string[] = [];
    const folded = new Set<string>();
    for (const l of lines.filter((x) => x.text?.trim()).slice(0, 400)) {
      if (l.feedback && isOwnerWho(l.who)) {
        if (!folded.has(l.feedback)) body.push(`· ${ownerName()}'s feedback: sent live as one message (${l.feedback}), not repeated here`);
        folded.add(l.feedback);
        continue;
      }
      body.push(`${isOwnerWho(l.who) ? `${ownerName()}:` : l.who === "tool" ? "·" : "Desk voice:"} ${l.text.replace(/\s+/g, " ").trim().slice(0, 2000)}`);
    }
    // Marked as a record on its second line, with every question the desk already had live listed by id, so the desk
    // (seed v17) notes it and acts on nothing in it a second time (the owner's review of).
    const asks = db.prepare("SELECT id, answer, send_error, kind FROM voice_asks WHERE call_id = ? ORDER BY n").all(c.id) as { id: string; answer: string | null; send_error: string | null; kind: string | null }[];
    const relayed = asks.length
      ? `Relayed live as call questions: ${asks.map((a) => `${a.id} (${a.kind === "feedback" ? "feedback, " : ""}${a.send_error ? "not delivered" : a.answer ? "answered" : "still open"})`).join(", ")}.`
      : "No question was relayed to the desk during this call.";
    return [
      `${CALL_TRANSCRIPT_HEAD} · ${when} · ${dur} · ${usd(c.costUsd)} (${c.model}) · ${c.id}`,
      `${CALL_RECORD_NOTE} ${relayed}`,
      "",
      ...(body.length ? body : ["(nothing was said)"]),
    ].join("\n");
  }

  async function end(id: string, o: { reason?: string; transcript?: { who: string; text: string; feedback?: string }[] }) {
    const c0 = must(id);
    if (!c0.endedAt) db.prepare("UPDATE voice_calls SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL").run(iso(), (o.reason || "hangup").slice(0, 40), id);
    const c = must(id);
    if (!c0.endedAt) console.log(`[voice] ${id} ended: ${c.endReason} after ${c.seconds} s, ${usd(c.costUsd)}`);
    const lines = (o.transcript ?? []).filter((l) => l && typeof l.text === "string" && l.text.trim());
    // kept for the next call's earlier conversation (the chat copy may still be queued when he calls again).
    if (lines.length) db.prepare("UPDATE voice_calls SET transcript = ? WHERE id = ? AND transcript IS NULL").run(JSON.stringify(lines.slice(0, 400)), id);
    // A call that never connected (no credit, refused microphone…) said nothing: no transcript in Chat for it.
    const asked = (db.prepare("SELECT COUNT(*) n FROM voice_asks WHERE call_id = ?").get(id) as { n: number }).n;
    if (c.transcriptPostedAt || !d.desk || (!lines.length && !asked && c.responses === 0)) {
      if (lines.length) d.onEnded?.(id);
      return { call: c, monthUsd: month().usd };
    }
    try {
      await d.desk.send(transcriptText(c, lines), CALL_PAGE, `voice-transcript-${id}`);
      db.prepare("UPDATE voice_calls SET transcript_posted_at = ?, transcript_error = NULL WHERE id = ?").run(iso(), id);
    } catch (e) {
      db.prepare("UPDATE voice_calls SET transcript_error = ? WHERE id = ?").run((e as Error).message.slice(0, 300), id);
    }
    d.onEnded?.(id);
    return { call: must(id), monthUsd: month().usd };
  }

  /**
   * Hang up on a page that finds its world's call on without holding it (an orphaned tab, another tab or phone):
   * ends that call, the one `active` reports for this world (any of its desks), only while `id` is still it. No transcript
   * here (the lines are in the page that held it; if that page still runs, its next beat hangs up and posts them).
   */
  function endActive(id: string): { ended: boolean; call?: VoiceCall; state: VoiceState } {
    const act = active();
    if (!act || act.id !== id) return { ended: false, state: state() };
    db.prepare(`UPDATE voice_calls SET ended_at = @t, end_reason = @r WHERE id = @id AND ended_at IS NULL AND ${inWorld}`).run({ t: iso(), r: ENDED_ELSEWHERE, id, w: world });
    console.log(`[voice] ${id} ended from another page`);
    return { ended: true, call: rowTo(db.prepare("SELECT * FROM voice_calls WHERE id = ?").get(id)), state: state() };
  }

  // ---- the two tools ----

  async function status(id: string): Promise<QuickStatus> {
    open(id);
    return d.quickStatus();
  }

  async function ask(id: string, request: string, confirmed = false, words?: string, kind?: "feedback"): Promise<{ askId: string; head: string; pending: boolean }> {
    open(id);
    const text = request.trim();
    if (!text) throw new VoiceError(400, "validation_error", "request is required");
    if (!d.desk) throw new VoiceError(503, "desk_unavailable", "the Team desk needs the console's T3 connection");
    const n = ((db.prepare("SELECT COUNT(*) n FROM voice_asks WHERE call_id = ?").get(id) as { n: number }).n ?? 0) + 1;
    const askId = `${id}-q${n}`;
    const head = `${kind === "feedback" ? CALL_FEEDBACK_HEAD : CALL_QUESTION_HEAD} (${askId})`;
    // How to answer (for speech, 1-3 sentences) is in the desk's seed (v16).
    // His own words (the captions since the last question) travel with the voice's summary, so the desk acts on what he
    // said, not on a paraphrase (call_283d1c45: the summary of his layout feedback said the opposite of his words).
    if (kind === "feedback") return sendFeedback(id, n, askId, head, (words ?? "").trim() || text);
    const said = (words ?? "").replace(/\s+/g, " ").trim();
    const his = said.length > ASK_WORDS_MAX ? `…${said.slice(-ASK_WORDS_MAX)}` : said;
    const msg = [
      head,
      `${ownerName()}, live on a voice call${confirmed ? " (he said yes to the read-back)" : ""}: ${text.slice(0, 4000)}`,
      ...(his ? [`His words (call captions): "${his}"`] : []),
    ].join("\n");
    db.prepare("INSERT INTO voice_asks (id, call_id, n, request, head, sent_at) VALUES (?, ?, ?, ?, ?, ?)").run(askId, id, n, text.slice(0, 4000), head, iso());
    try {
      const r = await d.desk.send(msg, CALL_PAGE, `voice-ask-${askId}`);
      return { askId, head, pending: r.pending };
    } catch (e) {
      db.prepare("UPDATE voice_asks SET send_error = ? WHERE id = ?").run((e as Error).message.slice(0, 300), askId);
      throw new VoiceError(502, "desk_send_failed", `the desk did not take the question: ${(e as Error).message.slice(0, 200)}`);
    }
  }

  /**
   * the one message listen mode sends on "done". It carries all his words (one part per pause, as he said them) and
   * says what to do with it, so any desk (the Team desk, a campaign chat's) files it once and confirms in one spoken line.
   */
  async function sendFeedback(id: string, n: number, askId: string, head: string, words: string) {
    const parts = words.split(/\n+/).map((w) => w.replace(/\s+/g, " ").trim()).filter(Boolean);
    let body = parts.map((p) => `- ${p}`).join("\n");
    if (body.length > FEEDBACK_WORDS_MAX) body = `…${body.slice(-FEEDBACK_WORDS_MAX)}`;
    const msg = [
      head,
      `${ownerName()} gave feedback live on a voice call. The voice line only listened (a short \"Mm-hm\" now and then) and relayed none of it before: this message is all of it, in one go. File it once, the way you file his chat feedback, all in this one go; the call transcript that follows later is a record and must not be filed again. Then reply in one short spoken sentence saying what you filed and where (e.g. \"Filed: three points as row E957-S2 in EPIC-957\").`,
      `His words (call captions, ${parts.length} part${parts.length === 1 ? "" : "s"}):`,
      body,
    ].join("\n");
    db.prepare("INSERT INTO voice_asks (id, call_id, n, request, head, sent_at, kind) VALUES (?, ?, ?, ?, ?, ?, 'feedback')").run(askId, id, n, body.slice(0, 4000), head, iso());
    try {
      const r = await d.desk!.send(msg, CALL_PAGE, `voice-ask-${askId}`);
      return { askId, head, pending: r.pending };
    } catch (e) {
      db.prepare("UPDATE voice_asks SET send_error = ? WHERE id = ?").run((e as Error).message.slice(0, 300), askId);
      throw new VoiceError(502, "desk_send_failed", `the desk did not take the feedback: ${(e as Error).message.slice(0, 200)}`);
    }
  }

  /**
   * Where a question to the desk is: `queued` (not in the thread yet: the desk is busy), `working` (the desk is on it,
   * `partial` = its newest words so far), `answered` (its turn is over: `answer` = its last message after the question).
   */
  async function askState(id: string, askId: string): Promise<{ state: "queued" | "working" | "answered" | "failed"; answer?: string; partial?: string; waitedMs: number; spokenWaitMs: number }> {
    must(id); // another scope's call is not found here
    const a = db.prepare("SELECT * FROM voice_asks WHERE id = ? AND call_id = ?").get(askId, id) as any;
    if (!a) throw new VoiceError(404, "not_found", `no question ${askId} on call ${id}`);
    const waitedMs = now() - Date.parse(a.sent_at);
    const base = { waitedMs, spokenWaitMs: ASK_SPOKEN_WAIT_MS };
    if (a.answer) return { state: "answered", answer: a.answer, ...base };
    if (a.send_error) return { state: "failed", answer: a.send_error, ...base };
    if (!d.desk) return { state: "failed", answer: "no desk", ...base };
    const v = await d.desk.view();
    const r = answerIn(v, a.head);
    if (r.state === "answered") db.prepare("UPDATE voice_asks SET answered_at = ?, answer = ? WHERE id = ?").run(iso(), r.answer!, askId);
    return { ...r, ...base };
  }

  function list(limit = 50): VoiceCall[] {
    closeLost();
    return (db.prepare(`SELECT * FROM voice_calls WHERE ${inScope} ORDER BY started_at DESC LIMIT @n`).all({ ...sc, n: Math.min(500, Math.max(1, limit)) }) as any[]).map(rowTo);
  }

  return {
    state,
    start,
    beat,
    usage,
    end,
    endActive,
    status,
    ask,
    askState,
    list,
    get,
    model,
    enabled,
    /** The platform's switch on the home world's Voice; on another world's Voice, that world's own switch. */
    setEnabled: (on: boolean) => put(worldKey ?? "enabled", on ? "on" : "off"),
    setModel: (m: string) => put("model", m),
    setMonthCap: (v: number) => put(capKey, String(v)),
    scope: { world, ...(ms ? { milestoneId: ms } : {}) } as VoiceScope,
    /** 0 = no cap (OpenAI's default); otherwise clamped to HISTORY_TOKENS_MIN..HISTORY_TOKENS_MAX. */
    setHistoryTokens: (t: number) => put("history_tokens", String(t <= 0 ? 0 : Math.round(Math.min(HISTORY_TOKENS_MAX, Math.max(HISTORY_TOKENS_MIN, t))))),
    setQuietHangup: (s: number) => put("quiet_hangup_s", String(Math.round(Math.min(QUIET_HANGUP_MAX_S, Math.max(QUIET_HANGUP_MIN_S, s))))),
  };
}

export type Voice = ReturnType<typeof createVoice>;

/** In the desk view: the question by its head, then the desk's messages after it (up to the owner's next message). */
export function answerIn(v: Pick<DeskView, "messages" | "working">, head: string): { state: "queued" | "working" | "answered"; answer?: string; partial?: string } {
  const msgs: DeskMessage[] = v.messages;
  const i = msgs.findIndex((m) => m.role === "user" && m.text.startsWith(head));
  if (i < 0) return { state: "queued" };
  const after: DeskMessage[] = [];
  for (const m of msgs.slice(i + 1)) {
    if (m.role === "user") break;
    after.push(m);
  }
  const last = after.filter((m) => m.text.trim()).at(-1);
  const nextUser = msgs.slice(i + 1).some((m) => m.role === "user");
  // The desk's turn is over when the thread is idle, or when it already moved on to a later message.
  const done = (!v.working || nextUser) && !!last && last.status === "completed";
  if (done) return { state: "answered", answer: last!.text.trim() };
  return { state: "working", ...(last ? { partial: last.text.trim().slice(0, 600) } : {}) };
}

/** one milestone as quick status names it; the caller lists them in priority order (inbox/priority milestoneRanks). */
export interface QuickMilestone {
  title: string;
  /** the owner's big-root position (state/big-roots.json): 1 is his top priority. */
  bigRoot?: number;
  /** Flow word from the status (needs_you, working, stalled, …). */
  word: string;
  /** Share of the tree done, 0..100. */
  pct?: number;
  /** Open items waiting on the owner in it, first few (code or title). */
  waits?: string[];
  needsYou?: number;
}

const FLOW_SAID: Record<string, string> = {
  needs_you: "waits on you",
  working: "being worked on now",
  planning: "a draft, not started",
  parked: "parked",
  paused: "paused",
  monitoring: "monitoring",
  queued: "queued for the next wake",
  stalled: "stuck: no one is moving it",
  nothing_to_do: "nothing ready to do",
  settled: "settled",
};

/** Quick status as the voice reads it: milestones in the given (priority) order, then counts and the top items, in plain words. */
export function quickStatusText(o: {
  milestones?: QuickMilestone[];
  waiting: { title: string; code?: string; milestone?: string }[];
  stuck: { title: string; milestone?: string; why?: string }[];
  working: { milestone: string; what?: string }[];
}): string {
  const top = <T,>(xs: T[], n: number) => xs.slice(0, n);
  // Long row titles cost the voice tokens and say nothing more aloud: the first 110 characters.
  const cut = (t: string) => (t.length > 110 ? `${t.slice(0, 107).trimEnd()}…` : t);
  const lines: string[] = [];
  if (o.milestones?.length) {
    const roots = o.milestones.filter((m) => m.bigRoot != null);
    const rest = o.milestones.filter((m) => m.bigRoot == null);
    const one = (m: QuickMilestone) => {
      const bits = [FLOW_SAID[m.word] ?? m.word.replace(/_/g, " "), ...(m.pct != null ? [`${m.pct}% done`] : [])];
      const waits = m.waits?.length ? `; waits on ${ownerName()}: ${m.waits.map(cut).join("; ")}${(m.needsYou ?? 0) > m.waits.length ? ` and ${m.needsYou! - m.waits.length} more` : ""}` : "";
      return `${cut(m.title)}: ${bits.join(", ")}${waits}`;
    };
    if (roots.length) {
      lines.push(`Priorities (${ownerName()}'s focus milestones, in his order, 1 = top priority): ${roots.length}.`);
      roots.forEach((m, i) => lines.push(`${i + 1}. ${one(m)}`));
    }
    if (rest.length) {
      lines.push(roots.length ? `Other milestones (not in focus, after the focus milestones): ${rest.length}.` : `Milestones (no priority set): ${rest.length}.`);
      for (const m of top(rest, 10)) lines.push(`- ${one(m)}`);
      if (rest.length > 10) lines.push(`- and ${rest.length - 10} more`);
    }
  }
  lines.push(`Waiting on ${ownerName()}: ${o.waiting.length}.`);
  for (const w of top(o.waiting, 6)) lines.push(`- ${w.code ? `${w.code}: ` : ""}${cut(w.title)}${w.milestone ? ` (${w.milestone})` : ""}`);
  lines.push(`Stuck: ${o.stuck.length}.`);
  for (const s of top(o.stuck, 5)) lines.push(`- ${s.milestone ? `${s.milestone}: ` : ""}${cut(s.title)}${s.why ? ` (${cut(s.why)})` : ""}`);
  lines.push(`Working now: ${o.working.length}.`);
  for (const w of top(o.working, 6)) lines.push(`- ${w.milestone}${w.what ? `: ${cut(w.what)}` : ""}`);
  return lines.join("\n");
}
