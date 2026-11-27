import crypto from "node:crypto";
import { DEFAULT_TENANT, type DB } from "../db.js";
import type { DeskMessage, DeskView } from "../desk/session.js";
import { CALL_WHOLE_LEAD } from "../desk/requests.js";
import { tokensOf } from "./brief.js";
import { TEAM_HEAD } from "../brand.js";
import { callLines, chatLines, RECALL_HOURS, recallBlock } from "./recall.js";
import { notesMonthUsd } from "./notes.js";
import { addTokens, costOf, PRICES, PRICES_CHECKED, TRANSCRIBE_MODEL, TRANSCRIBE_PRICES, tokensOfResponse, tokensOfTranscription, zeroTokens, type Tokens } from "./prices.js";
import { KeyNotReady } from "../secretCache.js";
import { homeWorld, hostOf, isOwnerWho, keyFile, ownerName, sites, socialProduct } from "../identity.js";
import { FOCUS_MAX, INBOX_WALK_MAX, briefingRule, focusGreeting, focusPack, inboxPack, isInboxTool, isObjectiveTool, objectiveStep, pressStep, walk, yesCheck, type InboxCard, type InboxFocus, type ObjectiveCard, type ObjectiveStep, type PressStep, type WalkStep } from "./inbox.js";
import type { CallCheck } from "./afterCall.js";
import { ELEVEN_MODEL_LABEL, ELEVEN_TURN_TIMEOUT_S, type CallLang, type ElevenCalls } from "./elevenAgent.js";
import { spanishGreeting, spanishInstructions } from "./spanish.js";

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
/**
 * the call's length and when the voice says the time left. A TEST console may shorten both
 * (CONSOLE_CALL_MAX_MIN, CONSOLE_CALL_WARN_MIN, minutes, decimals allowed, never longer than the default) to hear the
 * spoken warning in a short call; production sets neither.
 */
export function callLength(env: Record<string, string | undefined> = process.env, base = CALL_MAX_MIN): { callMaxMin: number; callWarnMin: number } {
  const max = Number(env.CONSOLE_CALL_MAX_MIN);
  // `base`: the voice's own length (the onboarding call's hour); a TEST console shortens it the same way
  const callMaxMin = Number.isFinite(max) && max > 0 && max < base ? max : base;
  const warn = Number(env.CONSOLE_CALL_WARN_MIN);
  const callWarnMin = Number.isFinite(warn) && warn > 0 && warn < callMaxMin ? warn : Math.max(callMaxMin - (CALL_MAX_MIN - CALL_WARN_MIN), callMaxMin / 2);
  return { callMaxMin, callWarnMin };
}
/** the longest call any voice runs (the onboarding call: "10 minutes or as long as they like", within an hour). */
export const LONGEST_CALL_MIN = 60;
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
/** Second line of an older transcript post: a record the desk acted on nothing in (old posts still read this way). */
export const CALL_RECORD_NOTE = "Record only: already handled live. Do not act on it again.";
/**
 * Second line of the whole-call post (the owner on call_33379122: "I want that answer to become yes": every word
 * of every call reaches the desk). Every call, also one that dropped or timed out, lands here once with all its words, and
 * the desk places each point of his as it places a voice note's (one request, the call id).
 */
export { CALL_WHOLE_LEAD };
export const callWholeNote = () =>
  `${CALL_WHOLE_LEAD}, for you to place: each point ${ownerName()} made that nothing listed below already brought you goes where a voice note's point goes (matched first, his words quoted, request <the call id>), the call questions and notes passed on live are not filed again.`;
/** the client request id of a call's whole-call post (one per call: a retry or the catch-up never posts it twice). */
export const wholeCallRequestId = (callId: string) => `voice-transcript-whole-${callId}`;
/** where the whole transcript of a call reads on the console (the post links it). */
export const callTranscriptUrl = (callId: string) => `${sites().teamUrl.replace(/\/+$/, "")}/api/voice/calls/${callId}/transcript`;

export type CallLine = { who: string; text: string; feedback?: string };
/** One note a call passed on live with its relay tool (his words, short), kept on the call (voice_calls.relays). */
export type RelayedNote = { n: number; at: string; desk: string; state?: string; requestId?: string; words: string };
/** the words of a relayed note kept for the whole-call post: enough for the desk to match the point, not the whole note. */
export const RELAY_WORDS_MAX = 240;
const relayDeskName = (desk: string) => (desk === "team" ? "the Team desk" : desk === "social" ? "the social desk" : desk === "objective" ? "the workspace's objectives" : `the ${desk} desk`);
/** the notes this call passed on live (oldest first); none on an older call or one that relayed nothing. */
export function relayedNotes(db: DB, callId: string): RelayedNote[] {
  try {
    const r = db.prepare("SELECT relays FROM voice_calls WHERE id = ?").get(callId) as { relays: string | null } | undefined;
    const list = JSON.parse(r?.relays ?? "[]");
    return Array.isArray(list) ? (list as RelayedNote[]) : [];
  } catch {
    return [];
  }
}
/** the words a relay passed (his words, else the objective it wrote), cut for the post. */
export function relayWords(args: Record<string, unknown>): string {
  const w = [args.words, args.objective, args.quote].find((x) => typeof x === "string" && x.trim()) as string | undefined;
  const t = (w ?? "").replace(/\s+/g, " ").trim().replace(/"/g, "'");
  return t.length > RELAY_WORDS_MAX ? `${t.slice(0, RELAY_WORDS_MAX - 1)}…` : t;
}

/**
 * The whole-call post: one header line (when, how long, what it cost, the call id), the what-to-do line, the link to the
 * whole transcript, then who said what. His listen-mode feedback, already sent as one message, is named, not repeated.
 */
export function wholeCallText(db: DB, c: { id: string; startedAt: string; seconds: number; costUsd: number; model: string; endReason?: string }, lines: CallLine[]): string {
  const when = `${c.startedAt.slice(0, 10)} ${c.startedAt.slice(11, 16)}Z`;
  const dur = `${Math.floor(c.seconds / 60)} min ${String(c.seconds % 60).padStart(2, "0")} s`;
  const body: string[] = [];
  const folded = new Set<string>();
  for (const l of lines.filter((x) => x.text?.trim()).slice(0, 600)) {
    if (l.feedback && isOwnerWho(l.who)) {
      if (!folded.has(l.feedback)) body.push(`· ${ownerName()}'s feedback: sent live as one message (${l.feedback}), not repeated here`);
      folded.add(l.feedback);
      continue;
    }
    body.push(`${isOwnerWho(l.who) ? `${ownerName()}:` : l.who === "tool" ? "·" : "Desk voice:"} ${l.text.replace(/\s+/g, " ").trim()}`);
  }
  const asks = db.prepare("SELECT id, answer, send_error, kind FROM voice_asks WHERE call_id = ? ORDER BY n").all(c.id) as { id: string; answer: string | null; send_error: string | null; kind: string | null }[];
  const notes = relayedNotes(db, c.id);
  const parts = [
    ...(asks.length ? [`Relayed live as call questions: ${asks.map((a) => `${a.id} (${a.kind === "feedback" ? "feedback, " : ""}${a.send_error ? "not delivered" : a.answer ? "answered" : "still open"})`).join(", ")}.`] : []),
    ...(notes.length ? [`Passed on live by the call: ${notes.map((x) => `note ${x.n} to ${relayDeskName(x.desk)}${x.requestId ? ` (request ${x.requestId})` : ""}: "${x.words}"`).join(" ; ")}.`] : []),
  ];
  const relayed = parts.length ? parts.join(" ") : "Nothing reached a desk live during this call: no call question, no note passed on.";
  const ended = c.endReason && !["hangup", "bye"].includes(c.endReason) ? ` · ended: ${c.endReason}` : "";
  const head = [`${CALL_TRANSCRIPT_HEAD} · ${when} · ${dur} · ${usd(c.costUsd)} (${c.model})${ended} · ${c.id}`, `${callWholeNote()} ${relayed}`, `Whole transcript: ${callTranscriptUrl(c.id)}`];
  // the desk's message size (TRANSCRIPT_MAX, 30,000): a longer call keeps every one of his lines and cuts the voice's first.
  const MAX = 29_000;
  let out = [...head, "", ...(body.length ? body : ["(nothing was said)"])].join("\n");
  if (out.length > MAX) {
    const short = body.map((b) => (b.startsWith("Desk voice:") && b.length > 240 ? `${b.slice(0, 237)}…` : b));
    out = [...head, "", ...short].join("\n");
    if (out.length > MAX) out = `${out.slice(0, MAX)}\n[cut here: the rest is in the whole transcript above]`;
  }
  return out;
}
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
  `- Bad: 'Noted.' Good: 'Sure, ${ownerName()}. On it.'`,
  "- Bad: 'I don't know.' Good: 'It's coming. I'll tell you as soon as it lands.'",
  `- Bad: 'It's locked. Next?' Good: 'Sorry, ${ownerName()}, the desk can't post there. You can add it at ${hostOf(sites().socialUrl)}.'`,
  `- Bad: 'Here's a warm, brief update: I can keep it simple and just chat with you.' Good: 'Sure, ${ownerName()}. Let's just talk.'`,
  "- Bad: 'Got it, you're waiting for confirmation on posting. I'm checking with the desk.' Good: 'Sorry, no: the desk can't post there.'",
  "- Bad: 'Got it, let me quickly ask the desk about those voice notes while you share your weekend.' Good: 'Sure. Go on.'",
].join("\n");
export const MINIMAL_RULE =
  `Most turns are one short, friendly sentence ('Sure, go on.', 'Which one?', 'For X or Reddit?', 'Got it, ${ownerName()}.'); a short warm sentence beats a long one, and a bare word can sound cold.`;
export const LISTENER_RULE =
  "let him finish his thought (a pause is not the end), and keep him talking ('Go on.', 'And then?', 'Why that?'). When something is unclear, ask one short clarifying question ('Which page?', 'Daily or weekly?'), one at a time. Do not summarise each point; once he has given his context, lead with your own proposal (How every call flows, below).";
export const HANDOFF_RULE =
  "When you hand over a question of his, say at most one short warm line ('Sure, on it.'), never that you pass it to the desk; something he wants done you send without a word about it. Then keep listening. No progress updates while it works. As he adds detail, send only what is new.";
export const DESK_ANSWER_RULE =
  "As soon as it arrives, tell him: the answer first, plainly, in one to three short sentences in the desk's own facts, no ids: what it dispatched and where. If it put questions on his inbox, say they are waiting there; never ask him the desk's question on the call (his voice note vn_3e39996d: the questions come formally through the inbox). If he asks while it is still working, say it's on its way and you'll tell him the moment it lands.";
/**: the warning before the idle hang-up. The goodbye before hang_up. */
export const QUIET_WARN_LINE = "Still there? I'll hang up in a few seconds.";
/**
 * He goes quiet or his microphone stops (his call_dab66f00, 27 Nov: with the phone screen off the microphone stopped and he
 * ended up talking to himself; "the agent should speak up quickly"): the voice checks in within seconds, once per silence.
 */
export const STILL_WITH_ME_LINE = "Are you still with me?";
export const MIC_LOST_LINE = "I can't hear you any more. Are you still with me?";
/**
 * Who is who on his calls (his call_065c7b6e, 27 Nov: "tiene que quedar clarísimo quién eres tú y quién son los demás.
 * Porque si hay más de una voz ... tienes que saber quién existe y qué hace cada uno"; the desk call had called itself the
 * voice line). The same names his call screen shows (web voice/whoAnswers.ts); every call's instructions carry it.
 */
export function teamRoster(social: string = socialProduct(), team: string = TEAM_HEAD.name): string {
  return [
    "Who is who on his team's calls (each its own voice, its name on his call screen):",
    "- Team desk manager: the objectives review, all his objectives, the senior-most.",
    "- Team desk partner: his OKR partner across all his objectives.",
    "- An objective's manager (named after it, like 'Get 5 testers manager'): that one objective only.",
    "- A campaign's manager: that one campaign only.",
    `- ${social} partner: ${social}'s campaigns and numbers.`,
    `- ${team} launch strategist: ${team}'s launch strategy.`,
    "- Team desk line: quick status, and passes his words to the Team desk.",
    "Your own name is the one your instructions above give you. In your first reply on this call, after answering him, add one short sentence on who you are and that the others exist (for example: 'I'm your Team desk manager; each objective's manager, the partners and the strategist have their own calls.'), once. Whenever he asks who you are or who else there is, answer from this list, never another name or 'the voice line'.",
  ].join("\n");
}
export const STILL_WITH_ME_RULE = `If he has gone quiet for a few seconds after you finished, or you are asked to go on while he says nothing, say exactly "${STILL_WITH_ME_LINE}" (in Spanish "¿Sigues conmigo?") once, and then wait; never say it twice in a row before he speaks again. If a note says his microphone stopped, the next time you speak say exactly "${MIC_LOST_LINE}" (in Spanish "Ya no te oigo. ¿Sigues conmigo?"). Never say that line otherwise.`;
/**
 * How every call flows, one rule for every call voice (his calls of 27 Nov): call_8c535b1a "I wish you didn't ask
 * me so much ... you're kind of interrupting the flow" and "phase one, where I am doing a lot of talking ... in phase two
 * ... you have to be leading a little bit more"; call_910685a3 "you say, 'I'll pass this to the desk.' You don't need to
 * tell me that so much"; call_065c7b6e "he terminado ... espero a que reacciones tú". Appended to every call's
 * instructions (createVoice's start), the still-with-me rule and the time-left line merged into it.
 *
 *   phase one: he talks ──▶ short acknowledgements only ──▶ phase two: you propose and lead ──▶ he reacts ──▶ next proposal
 *   never after a point: "Pass it?", "Want me to…?", "I'll pass this to the desk": the whole call reaches the team anyway
 */
export const CALL_FLOW_RULE = [
  "# How every call flows (the most important rule on this call, above anything else in these instructions)",
  "- Phase one, he gives you his context: let him talk. Short acknowledgements only ('Go on.', 'Mm-hm.', 'Got it.'). No read-back of each point, no question after each point, no proposal yet. A pause is not the end of his thought.",
  "- Phase two, once he has given his context (he stops for your view, asks what you think, says he has finished, or has made his points on the topic): you lead. Say what you gather in one sentence and propose: 'Here is what I propose: …', with its one reason, then go on to your next proposal. Have a real opinion, and surprise him if you can. He reacts; take his reaction and carry on. Never wait for his yes before going on.",
  "- Never ask permission after a point: no 'Pass it?', 'Want me to pass that?', 'Shall I?', 'File it?', 'Is that the point you want passed?', and no either-or question after each thing he says. What he says he wants or decides is his yes. Ask only when you truly cannot go on without his answer, one question, once. Pressing a button on one of his cards keeps its one read-back.",
  "- Never talk about passing things on: no 'I'll pass this to the desk', 'That's a note for the Team desk', 'Passed.', 'I'll send it all together'. The whole call reaches his team by itself when it ends. If you have a tool that passes or files his words, use it silently as he speaks. Only if he asks whether something got through, answer in one short line.",
  "- Never ask again what he already answered, on this call or in what you know below.",
  "- Bad: 'Heard: a waitlist plus credits. That's a note for the Team desk. Pass it?' Good: 'Got it. Then I'd open with the waitlist this week, because it gives every post somewhere to send people.'",
  "- Time: when a note from the call's clock comes, say its line out loud at once, then carry on where you were.",
  `- Silence: ${STILL_WITH_ME_RULE}`,
  "- Ending: the one-line recap is what you settled together, never a list of what you passed on, and never that the call is saved or sent anywhere.",
].join("\n");
export const ROLE_LINE = "I'm your Team desk line. Quick status I answer myself. The rest I pass to the desk, and I tell you its answer as soon as it lands.";
/** At most this much of the owner's own words goes with a question to the desk. */
export const ASK_WORDS_MAX = 1500;
/** The voice gives up waiting for the desk after this long ("the answer will be in Chat") but keeps checking. */
export const ASK_SPOKEN_WAIT_MS = 60_000;
/** a call starts without its briefing rather than wait longer than this for it. */
export const BRIEF_WAIT_MS = 3_000;

const parseCheck = (s: string): CallCheck | undefined => {
  try {
    return JSON.parse(s) as CallCheck;
  } catch {
    return undefined;
  }
};

export class VoiceError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 502 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** what he sees while Bitwarden is slow to give a key that is there: the page keeps connecting and tries again. */
export const KEY_WAIT_TEXT = "Connecting: the key is still coming from Bitwarden, trying again";
/** a store key read per use; one its source did not answer for (twice) is a 503 key_wait, never no_key. */
export function keyOrWait(read: () => Promise<string | undefined>): () => Promise<string | undefined> {
  return async () => {
    try {
      return await read();
    } catch (e) {
      if (e instanceof KeyNotReady) throw new VoiceError(503, "key_wait", KEY_WAIT_TEXT);
      throw e;
    }
  };
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
  // when the call's whole transcript landed on its desk for placing (; `none: <why>` when it had no words to send).
  if (!cols.has("whole_posted_at")) db.exec("ALTER TABLE voice_calls ADD COLUMN whole_posted_at TEXT");
  // the owner's own turns of a call with no stored transcript (JSON array of strings), kept the first time they are read
  // from its chat post (or back-filled from his the memory service), so a later resend never depends on reading an old desk session again.
  if (!cols.has("jordi_words")) db.exec("ALTER TABLE voice_calls ADD COLUMN jordi_words TEXT");
  // the inbox the call started with (JSON, the walk's cards) and the card he is on (1-based, 0 = not started).
  if (!cols.has("inbox")) db.exec("ALTER TABLE voice_calls ADD COLUMN inbox TEXT");
  if (!cols.has("inbox_pos")) db.exec("ALTER TABLE voice_calls ADD COLUMN inbox_pos INTEGER NOT NULL DEFAULT 0");
  // his objectives the call started with (JSON, the briefing's cards) and the one he is on (1-based, 0 = not started).
  if (!cols.has("objectives")) db.exec("ALTER TABLE voice_calls ADD COLUMN objectives TEXT");
  if (!cols.has("objective_pos")) db.exec("ALTER TABLE voice_calls ADD COLUMN objective_pos INTEGER NOT NULL DEFAULT 0");
  // the cards the call pressed on his yes (JSON array of card ids), so a yes already pressed is never pressed again.
  if (!cols.has("pressed")) db.exec("ALTER TABLE voice_calls ADD COLUMN pressed TEXT");
  // the notes the call passed on live with its relay tool (JSON array of RelayedNote), so the whole-call post tells the
  // desk which of his points already reached it and none is handled twice .
  if (!cols.has("relays")) db.exec("ALTER TABLE voice_calls ADD COLUMN relays TEXT");
}

/**
 * Where a press on a card is, from the press log (the voice says "pressed, it landed" only when the commit
 * shows): the newest press on that card since `since`, `landed` with its commit, `landing`, `failed`, or `none`.
 */
export function pressLanding(db: DB, cardId: string, since: string): { state: "landed" | "landing" | "failed" | "none"; sha?: string; reason?: string } {
  let p: { state: string; sha: string | null; reason: string | null } | undefined;
  try {
    p = db
      .prepare("SELECT state, sha, reason FROM presses WHERE at >= ? AND (target = ? OR route LIKE ?) ORDER BY at DESC LIMIT 1")
      .get(since, cardId, `%/${encodeURIComponent(cardId)}/%`) as typeof p;
  } catch {
    return { state: "none" };
  }
  if (!p) return { state: "none" };
  if (p.state === "landed" && p.sha) return { state: "landed", sha: p.sha.slice(0, 9) };
  if (p.state === "failed" || p.state === "undone") return { state: "failed", ...(p.reason ? { reason: p.reason.slice(0, 160) } : {}) };
  // landed with no commit yet (an answer job still writing) is still landing for the voice: no "it landed" without a commit.
  return { state: "landing" };
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
  /** the after-call check (what he asked, what the call did, gaps, the transcript's memory link), once it ran. */
  afterCheck?: CallCheck;
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
  /** an ElevenLabs Agents call: the page talks over this signed link, with these instructions and greeting. */
  provider?: "elevenlabs";
  signedUrl?: string;
  agentId?: string;
  instructions?: string;
}
export interface Limits {
  callMaxMin: number;
  callWarnMin: number;
  quietHangupS: number;
  quietWarnS: number;
  checkInS: number;
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
  /** voice calls are off (voice notes still work): the Call button is gone. */
  callsOff?: true;
  /** who carries the calls: ElevenLabs Agents on the grant or OpenAI's realtime voice. */
  provider: "elevenlabs" | "openai";
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
  /** who is who on this call (default: teamRoster, his own team's calls); a customer's call names its own. */
  roster?: () => string;
  mint: Minter;
  desk?: DeskPort;
  quickStatus: () => Promise<QuickStatus>;
  /** the briefing appended to the instructions at each call's start (root tree + Epic Book summary); "" = none. */
  brief?: () => Promise<string> | string;
  /** CONSOLE_VOICE=off forces the switch off, whatever the setting says. */
  envOff?: boolean;
  /**
   * calls through ElevenLabs Agents (the grant). With it the calls go there unless the `call_provider` setting
   * says openai; their own switch `calls:elevenlabs` is on unless set off (the 22 Nov switch-off held OpenAI's paid calls).
   */
  eleven?: ElevenCalls;
  /** Model name override (CONSOLE_VOICE_MODEL); the setting wins when set. */
  envModel?: string;
  /**
   * whether
   * voice calls are on when the `calls` setting is unset. The console sets it off; voice notes stay on either way.
   */
  callsDefault?: "on" | "off";
  now?: () => number;
  /** a call has ended (its transcript stored and posted when there is one): it goes to the owner's the memory service. */
  onEnded?: (id: string) => void;
  /** his inbox (review cards, then open asks, in his inbox's order), loaded at each call's start for the walk. */
  inbox?: () => Promise<InboxCard[]> | InboxCard[];
  /** his objectives in his order, one per line, loaded with the inbox. */
  objectives?: () => Promise<string> | string;
  /** his objectives one by one (light, key results, where it stands, his newest words), for the briefing walk. */
  objectiveCards?: () => Promise<ObjectiveCard[]> | ObjectiveCard[];
  /**
   * what this call knows before it starts, besides the briefing (a social world's call: every campaign, its key
   * results and the newest daily briefing). Read at each call's start, inside the same context wait.
   */
  context?: () => Promise<string> | string;
  /** how long a call's start waits for `context` (default BRIEF_WAIT_MS); a call whose context reads live sources waits longer. */
  contextWaitMs?: number;
  /**
   * the rule for his objectives on this call, in place of the briefing walk's (the objectives coach's: read only, his words
   * relayed); with it the walk's own tools are not added (the call's tools carry what it needs).
   */
  walkRule?: (total: number) => string;
  /** the coach's relay_to_desk: his words to the Team desk or the social desk (POST …/calls/:cid/relay). */
  relay?: (callId: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** the briefer's read-only lookups during a call: exact rows from one source, as text (POST …/calls/:cid/lookup). */
  lookup?: (callId: string, name: string, args: Record<string, unknown>) => Promise<string>;
  /**
   * this voice's own per-call limit in minutes (default CALL_MAX_MIN); the onboarding call runs up to an hour
   * ("10 minutes or as long as they like"), its warning two minutes before.
   */
  callMaxMin?: number;
  /** this voice's own world switch in place of the `enabled:<world>` setting (the onboarding call is on for every new team). */
  worldOn?: () => boolean;
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
    `You are the Team desk line (the name he sees on the call screen; never call yourself the voice line), in front of ${ownerName()}'s Team desk, on a live call with him (he owns the team). You are not the desk: the desk is the agent with the team's tools. You answer quick status yourself and pass everything else to the desk, so its chat stays clean. Answer in the language he speaks (English or Spanish).`,
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
    `He always has priority: never talk over him, and when he is giving you feedback or a long thought, let him finish it all before you say anything (his words, call_a3e08f34: "If I speak, you listen, please, always. Don't speak over me, ever").`,
    "Listen mode: when he says he wants to give feedback, or asks you not to interrupt ('I want to give feedback', 'feedback time', 'just listen', 'don't interrupt me', 'let me finish', 'quiero darte feedback'), call listen_for_feedback at once and say nothing yourself (the console may already have switched it on: then say nothing). From then on the console holds his words, now and then answers a pause with one short acknowledgement ('Mm-hm', 'Got it') and otherwise waits, and sends everything to the desk in one message when he says done; never call ask_the_desk with any of it, before or after.",
    "The whole call is saved to Chat when he hangs up, as a record; there is nothing to send the desk about it.",
    `Ending the call: when he clearly says he is done ('hang up', 'bye', 'goodbye', 'that's all', 'that's it, thanks', 'nothing else', 'adiós', 'cuelga'), say one short goodbye ('Bye, ${ownerName()}.') and call hang_up in the same turn. Only when the phrase closes the call: never on a phrase inside a request ('that's all I wanted to ask about the release, and…', 'tell the desk bye to that idea'), never while he is still asking something, and never on your own initiative. If unsure, ask 'Hang up?' and hang up only on his yes.`,
    `If a system message says the line has been quiet, say exactly: "${QUIET_WARN_LINE}" and nothing else.`,
    "The call has a 20-minute limit; when a system message says time is nearly up, tell him in a few words that he can call again.",
  ].join("\n");
}

/** the inbox walk's two tools (a call that has his inbox only); the console answers them (POST …/calls/:cid/tool). */
export const INBOX_TOOLS = [
  {
    type: "function",
    name: "next_card",
    description: `Go to the next card in ${ownerName()}'s inbox and get it in full, with its place ('card 3 of 12'). The console keeps which card he is on. Use it for 'next', 'next card', 'let's go through my inbox', 'skip it'.`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "read_card",
    description: `Read one card of ${ownerName()}'s inbox in full: the one he is on (no number), card N of the list (number: N), or back (number: -1 for the one before). It becomes the card he is on.`,
    parameters: { type: "object", properties: { number: { type: "integer", description: "The card's number in his inbox list (1 = first), or -1 to go back one. Leave out for the card he is on." } }, additionalProperties: false },
  },
];

/** on every call that walks his inbox (the whole inbox or one section), the voice presses his own button on a card after his spoken yes. */
export const PRESS_TOOL = {
  type: "function",
  name: "press_card",
  description: `Press one of ${ownerName()}'s own buttons on a card (only a button the card lists as yours to press), ONLY after you said back what you will press and he said yes. The page presses it as he would. Leave number out for the card he is on.`,
  parameters: {
    type: "object",
    properties: {
      button: { type: "string", description: "The button's label exactly as the card lists it." },
      words: { type: "string", description: "His words, for a button ending in … (Changes wanted…, Answer in words…)." },
      number: { type: "integer", description: "The card's number in the list; leave out for the card he is on." },
      confirmed: { type: "boolean", description: "true only after his spoken yes to what you said back." },
    },
    required: ["button", "confirmed"],
    additionalProperties: false,
  },
};

/** his objectives one by one on the same call; the console answers them, the page files his words. */
export const OBJECTIVE_TOOLS = [
  {
    type: "function",
    name: "next_objective",
    description: `Go to ${ownerName()}'s next objective in his order and get it in full (its light, key results, where it stands, his newest words), with its place ('objective 2 of 13'). The console keeps which one he is on. Use it for 'brief me', 'go through my objectives', 'next objective'.`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "read_objective",
    description: `Read one of ${ownerName()}'s objectives in full: the one he is on (no number), objective N in his order (number: N), or back (number: -1). It becomes the one he is on.`,
    parameters: { type: "object", properties: { number: { type: "integer", description: "The objective's place in his order (1 = first), or -1 to go back one. Leave out for the one he is on." } }, additionalProperties: false },
  },
  {
    type: "function",
    name: "file_objective_words",
    description: `File what ${ownerName()} said about an objective on it (his words file and its epic, where its owner reads them), as soon as he decides it: his decision is his yes, so never read it back or ask 'File it?'. Leave number out for the one he is on.`,
    parameters: {
      type: "object",
      properties: {
        words: { type: "string", description: "His words about it, as he said them (never your summary)." },
        number: { type: "integer", description: "The objective's place in his order; leave out for the one he is on." },
        confirmed: { type: "boolean", description: "true when he decided or said he wants it (his words are his yes)." },
      },
      required: ["words", "confirmed"],
      additionalProperties: false,
    },
  },
];

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
          // semantic, low eagerness(his call_a3e08f34: "If I speak, you listen, please, always. Don't speak over
          // me, ever"): the voice answers when he has finished his thought, not at the first pause.
          turn_detection: { type: "semantic_vad", eagerness: "low", create_response: true, interrupt_response: true },
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
  const worldOn = () => (d.worldOn ? d.worldOn() : !worldKey || setting(worldKey) === "on");
  const callMax = d.callMaxMin ?? CALL_MAX_MIN;
  const enabled = () => platformOn() && worldOn();
  /** calls are the platform's own switch (every world), off unless set on; notes never read it. */
  const provider = (): "elevenlabs" | "openai" => (d.eleven && setting("call_provider") !== "openai" ? "elevenlabs" : "openai");
  const callsKey = () => (provider() === "elevenlabs" ? "calls:elevenlabs" : "calls");
  const callsOn = () => (provider() === "elevenlabs" ? (setting(callsKey()) ?? "on") === "on" : (setting("calls") ?? d.callsDefault ?? "on") === "on");
  const CALLS_OFF = "Calls are off. Send a voice note instead: it is written out free on our own server.";
  const offWhy = () => (platformOn() ? "Voice is not switched on for this workspace." : "Voice is switched off in the console.");
  const historyTokens = () => {
    const v = setting("history_tokens");
    return v === undefined || !Number.isFinite(Number(v)) ? HISTORY_TOKENS : Number(v);
  };
  const capKey = world === DEFAULT_TENANT ? "month_cap_usd" : `month_cap_usd:${world}`;
  const monthCap = () => Number(setting(capKey)) || (world === DEFAULT_TENANT ? MONTH_CAP_USD : WORLD_MONTH_CAP_USD);
  const limits = (): Limits => ({
    ...callLength(process.env, callMax),
    quietHangupS: Number(setting("quiet_hangup_s")) || QUIET_HANGUP_S,
    quietWarnS: QUIET_WARN_S,
    checkInS: ELEVEN_TURN_TIMEOUT_S,
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
      ...(r.after_check ? { afterCheck: parseCheck(r.after_check) } : {}),
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
    // the longest any voice of this world may run the onboarding call's hour), so a short voice never closes a long one
    const tooOld = iso(now() - (Math.max(callMax, LONGEST_CALL_MIN) + 2) * 60_000);
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
    if (!callsOn()) return { code: "calls_off", message: CALLS_OFF };
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
    const why = enabled() ? (!callsOn() ? CALLS_OFF : m.usd >= limits().monthCapUsd - MIN_LEFT_USD ? refusal()?.message : undefined) : offWhy();
    const mdl = provider() === "elevenlabs" ? ELEVEN_MODEL_LABEL : model();
    return {
      available: enabled() && !why,
      enabled: enabled(),
      provider: provider(),
      ...(callsOn() ? {} : { callsOff: true as const }),
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
  async function inTime<T>(what: string, fn: () => Promise<T> | T, none: T, waitMs = BRIEF_WAIT_MS): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(fn), new Promise<T>((ok) => (timer = setTimeout(() => ok(none), waitMs)))]);
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

  /**
   * the call page opened: the next call's ElevenLabs link is made now (key fetched, used, dropped), so his
   * press does not wait on Bitwarden and ElevenLabs. Nothing when calls cannot start or a call is on.
   */
  function warm(lang: CallLang = "en"): { warming: boolean } {
    if (refusal() || active() || provider() !== "elevenlabs" || !d.eleven?.warm) return { warming: false };
    void d.eleven.warm(lang);
    return { warming: true };
  }

  /** `lang`: the language he picked on the call screen: Spanish runs on the Spanish agent and voice. */
  async function start(focus?: InboxFocus, lang: CallLang = "en"): Promise<CallStart> {
    const no = refusal();
    if (no) throw new VoiceError(409, no.code, no.message);
    const mdl = model();
    const t0 = Date.now();
    // the ElevenLabs call link is asked for while the context is read, not after it (a press once waited
    // ~60 s on "Connecting...": the context's wait, then the agent's update and the link, one after the other).
    let linkMs: number | undefined;
    let ctxMs: number | undefined;
    const linkP = provider() === "elevenlabs" && d.eleven ? d.eleven.link(lang).then((l) => ((linkMs = Date.now() - t0), l)) : undefined;
    linkP?.catch(() => undefined); // awaited below; a refusal surfaces there
    // a call started from an inbox section holds that section's cards (as the page showed them), not the whole inbox.
    const [brief, recall, cards, objectives, context, objectiveCards] = await Promise.all([
      briefNow(),
      recallNow().catch(() => ""),
      focus ? focus.cards.slice(0, FOCUS_MAX) : d.inbox ? inTime("inbox", d.inbox, undefined as InboxCard[] | undefined) : undefined,
      d.objectives ? inTime("objectives", d.objectives, "") : "",
      d.context ? inTime("context", d.context, "", d.contextWaitMs) : "",
      d.objectiveCards ? inTime("objective cards", d.objectiveCards, [] as ObjectiveCard[]) : ([] as ObjectiveCard[]),
    ]);
    ctxMs = Date.now() - t0;
    // a call whose inbox could not be read in time starts as before (no inbox, no walk tools).
    const walkCards = cards?.slice(0, INBOX_WALK_MAX);
    const pack = focus && walkCards ? focusPack({ section: focus.section, cards: walkCards }, objectives) : walkCards ? inboxPack(walkCards, objectives) : "";
    // a call that holds his objectives walks them one by one too (the briefing), on the whole-inbox call and a section's.
    const briefing = objectiveCards.length ? (d.walkRule ?? briefingRule)(objectiveCards.length) : "";
    const instructionsEn = (d.instructions ?? voiceInstructions)() + `\n${CALL_FLOW_RULE}\n${(d.roster ?? teamRoster)()}` + (pack ? `\n\n${pack}` : "") + (briefing ? `\n\n${briefing}` : "") + (context ? `\n\n${context}` : "") + (brief ? `\n\n${brief}` : "") + (recall ? `\n\n${recall}` : "");
    const tools = d.tools?.() ?? VOICE_TOOLS;
    // the voice presses his button on every card it walks, the whole inbox's as a section's.
    const walkTools = [...(walkCards ? [...INBOX_TOOLS, PRESS_TOOL] : []), ...(objectiveCards.length && !d.walkRule ? OBJECTIVE_TOOLS : [])];
    const greetingEn = focus && walkCards ? focusGreeting({ section: focus.section, cards: walkCards }) : greetingOf(instructionsEn);
    // a Spanish call: its greeting in Spanish, its prompt led by the Spanish rule (the same facts and tools below it)
    const greeting = lang === "es" ? spanishGreeting(greetingEn) : greetingEn;
    const instructions = lang === "es" ? spanishInstructions(instructionsEn, greetingEn, greeting!) : instructionsEn;
    const cfg = sessionConfig(mdl, instructions, [...tools, ...walkTools] as unknown as typeof VOICE_TOOLS, historyTokens());
    if (provider() === "elevenlabs" && d.eleven) {
      // ElevenLabs Agents on the grant: a signed link for one call, the same instructions and greeting per call.
      const link = await (linkP ?? d.eleven.link(lang));
      const id = `call_${crypto.randomBytes(4).toString("hex")}`;
      const t = iso();
      if (active()) throw new VoiceError(409, "one_call", "A call is already on (one call at a time). Hang it up first.");
      db.prepare("INSERT INTO voice_calls (id, started_at, last_beat_at, model, session_id, tenant_id, milestone_id, brief_tokens, recall_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, t, t, ELEVEN_MODEL_LABEL, link.agentId, world, ms, brief ? tokensOf(brief) : null, recall ? tokensOf(recall) : null);
      if (walkCards) db.prepare("UPDATE voice_calls SET inbox = ? WHERE id = ?").run(JSON.stringify(walkCards), id);
      if (objectiveCards.length) db.prepare("UPDATE voice_calls SET objectives = ? WHERE id = ?").run(JSON.stringify(objectiveCards), id);
      // each step's time in the log, so a slow start names its part (key and link, or the context read)
      console.log(`[voice] ${id} starts on ElevenLabs Agents (${link.agentId}${lang === "es" ? ", Spanish" : ""}) in ${Date.now() - t0} ms: link ${(link as { warm?: boolean }).warm ? "made when the page opened" : `${linkMs ?? "?"} ms`}, context ${ctxMs} ms`);
      return { call: must(id), clientSecret: "", expiresAt: Math.floor(now() / 1000) + 15 * 60, model: ELEVEN_MODEL_LABEL, limits: limits(), turnDetection: cfg.session.audio.input.turn_detection, ...(greeting ? { greeting } : {}), provider: "elevenlabs", signedUrl: link.signedUrl, agentId: link.agentId, instructions };
    }
    const key = await d.mint(cfg);
    const id = `call_${crypto.randomBytes(4).toString("hex")}`;
    const t = iso();
    // A second Call pressed while the key was being minted: the first one wins.
    if (active()) throw new VoiceError(409, "one_call", "A call is already on (one call at a time). Hang it up first.");
    db.prepare("INSERT INTO voice_calls (id, started_at, last_beat_at, model, session_id, tenant_id, milestone_id, brief_tokens, recall_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, t, t, mdl, key.session?.id ?? null, world, ms, brief ? tokensOf(brief) : null, recall ? tokensOf(recall) : null);
    if (walkCards) {
      db.prepare("UPDATE voice_calls SET inbox = ? WHERE id = ?").run(JSON.stringify(walkCards), id);
      console.log(`[voice] ${id} starts with ${focus ? `the section "${focus.section}"` : "his inbox"}: ${walkCards.length} cards (~${tokensOf(pack)} tokens with the objectives)`);
    }
    if (objectiveCards.length) db.prepare("UPDATE voice_calls SET objectives = ? WHERE id = ?").run(JSON.stringify(objectiveCards), id);
    if (context) console.log(`[voice] ${id} starts with its context (~${tokensOf(context)} tokens)`);
    if (recall) console.log(`[voice] ${id} starts with ${recall.split("\n").length - 1} lines of earlier conversation (~${tokensOf(recall)} tokens)`);
    return { call: must(id), clientSecret: key.value, expiresAt: key.expires_at, model: mdl, limits: limits(), turnDetection: cfg.session.audio.input.turn_detection, greeting };
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
    if (!callsOn()) return "calls_off";
    if (c.seconds >= callMax * 60) return "call_limit";
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

  /** The whole call as it lands on its desk (wholeCallText). */
  const transcriptText = (c: VoiceCall, lines: CallLine[]) => wholeCallText(db, c, lines);

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
      await d.desk.send(transcriptText(c, lines), CALL_PAGE, wholeCallRequestId(id));
      db.prepare("UPDATE voice_calls SET transcript_posted_at = ?, whole_posted_at = COALESCE(whole_posted_at, ?), transcript_error = NULL WHERE id = ?").run(iso(), iso(), id);
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

  /** the card his inbox walk is on, so "this one" in his words names a card the desk can find. */
  function walkLine(id: string): string[] {
    const r = db.prepare("SELECT inbox, inbox_pos FROM voice_calls WHERE id = ?").get(id) as { inbox: string | null; inbox_pos: number } | undefined;
    if (!r?.inbox || !r.inbox_pos) return [];
    try {
      const cards = JSON.parse(r.inbox) as InboxCard[];
      const c = cards[r.inbox_pos - 1];
      return c ? [`On his inbox walk he is on card ${r.inbox_pos} of ${cards.length}: ${c.kind === "ask" ? "the question" : "the review card"} ${c.code ? `${c.code} ` : ""}"${c.title}" (id ${c.id}).`] : [];
    } catch {
      return [];
    }
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
      ...walkLine(id),
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

  /**
   * a tool the console answers itself (the inbox walk). The call's inbox is the one it started with; the card he
   * is on is kept on the call row, so the voice never has to count.
   */
  function tool(id: string, name: string, args: Record<string, unknown> = {}): WalkStep & { press?: PressStep["press"] } & Partial<Pick<ObjectiveStep, "objective" | "file">> {
    open(id);
    if (isObjectiveTool(name)) {
      const o = db.prepare("SELECT objectives, objective_pos FROM voice_calls WHERE id = ?").get(id) as { objectives: string | null; objective_pos: number };
      let list: ObjectiveCard[];
      try {
        list = JSON.parse(o.objectives ?? "null");
      } catch {
        list = [];
      }
      if (!Array.isArray(list) || !list.length) throw new VoiceError(409, "no_objectives", "this call started without his objectives");
      const step = objectiveStep(list, o.objective_pos ?? 0, name, args);
      db.prepare("UPDATE voice_calls SET objective_pos = ? WHERE id = ?").run(step.pos, id);
      if (step.file) console.log(`[voice] ${id} files his words on his yes: objective ${step.file.id}`);
      return step;
    }
    // the page's own checks (never the voice's tools): his yes on a card, and whether a press has landed.
    if (name === "press_landing") {
      const cardId = String(args.cardId ?? "");
      const since = typeof args.since === "string" && args.since ? args.since : (db.prepare("SELECT started_at FROM voice_calls WHERE id = ?").get(id) as { started_at: string }).started_at;
      return pressLanding(db, cardId, since) as never;
    }
    if (!isInboxTool(name) && name !== "yes_check") throw new VoiceError(404, "unknown_tool", `no console tool ${name}`);
    const r = db.prepare("SELECT inbox, inbox_pos FROM voice_calls WHERE id = ?").get(id) as { inbox: string | null; inbox_pos: number };
    if (!r.inbox) throw new VoiceError(409, "no_inbox", "this call started without his inbox");
    let cards: InboxCard[];
    try {
      cards = JSON.parse(r.inbox);
    } catch {
      throw new VoiceError(409, "no_inbox", "this call's inbox could not be read");
    }
    const pressed = (): string[] => {
      try {
        return JSON.parse((db.prepare("SELECT pressed FROM voice_calls WHERE id = ?").get(id) as { pressed: string | null }).pressed ?? "[]");
      } catch {
        return [];
      }
    };
    if (name === "yes_check") return yesCheck(cards, String(args.cardId ?? ""), String(args.words ?? ""), pressed()) as never;
    if (name === "press_card") {
      const p = pressStep(cards, r.inbox_pos ?? 0, args);
      db.prepare("UPDATE voice_calls SET inbox_pos = ? WHERE id = ?").run(p.pos, id);
      if (p.press) db.prepare("UPDATE voice_calls SET pressed = ? WHERE id = ?").run(JSON.stringify([...new Set([...pressed(), p.press.id])]), id);
      if (p.press) console.log(`[voice] ${id} press on his yes: ${p.press.button} on ${p.press.kind} ${p.press.id}`);
      return p;
    }
    const step = walk(cards, r.inbox_pos ?? 0, name, args);
    db.prepare("UPDATE voice_calls SET inbox_pos = ? WHERE id = ?").run(step.pos, id);
    return step;
  }

  /** the objectives coach's relay: his words to a desk, on a call of this Voice that is still on or just ended. */
  async function relay(id: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const c = must(id);
    if (!d.relay) throw new VoiceError(404, "unknown_tool", "this call has no relay");
    if (c.endedAt && now() - Date.parse(c.endedAt) > 60_000) throw new VoiceError(409, "call_ended", `call ${id} has ended`);
    try {
      const out = await d.relay(id, args);
      // keep what reached a desk live, so the whole-call post lists it and the desk never handles it twice.
      const list = relayedNotes(db, id);
      const note: RelayedNote = { n: list.length + 1, at: new Date(now()).toISOString(), desk: String(out?.desk ?? "team"), words: relayWords(args) };
      if (typeof out?.state === "string") note.state = out.state;
      if (typeof out?.requestId === "string") note.requestId = out.requestId;
      db.prepare("UPDATE voice_calls SET relays = ? WHERE id = ?").run(JSON.stringify([...list, note]), id);
      return out;
    } catch (e) {
      if (e instanceof VoiceError) throw e;
      throw new VoiceError(400, "validation_error", (e as Error).message);
    }
  }

  /** the briefer's lookup: one read-only source, read now, on a call of this Voice that is still on or just ended. */
  async function lookup(id: string, name: string, args: Record<string, unknown>): Promise<{ name: string; result: string }> {
    const c = must(id);
    if (!d.lookup) throw new VoiceError(404, "unknown_tool", "this call has no lookups");
    if (c.endedAt && now() - Date.parse(c.endedAt) > 60_000) throw new VoiceError(409, "call_ended", `call ${id} has ended`);
    try {
      return { name, result: await d.lookup(id, name, args) };
    } catch (e) {
      if (e instanceof VoiceError) throw e;
      throw new VoiceError(400, "validation_error", (e as Error).message);
    }
  }

  /** where the walk is (for the page and the tests): the card he is on and how many. */
  function walkState(id: string): { pos: number; total: number } | undefined {
    must(id);
    const r = db.prepare("SELECT inbox, inbox_pos FROM voice_calls WHERE id = ?").get(id) as { inbox: string | null; inbox_pos: number };
    if (!r.inbox) return undefined;
    try {
      return { pos: r.inbox_pos ?? 0, total: (JSON.parse(r.inbox) as unknown[]).length };
    } catch {
      return undefined;
    }
  }

  function list(limit = 50): VoiceCall[] {
    closeLost();
    return (db.prepare(`SELECT * FROM voice_calls WHERE ${inScope} ORDER BY started_at DESC LIMIT @n`).all({ ...sc, n: Math.min(500, Math.max(1, limit)) }) as any[]).map(rowTo);
  }

  return {
    state,
    warm,
    start,
    beat,
    usage,
    end,
    endActive,
    status,
    ask,
    askState,
    tool,
    relay,
    lookup,
    walkState,
    list,
    get,
    model,
    enabled,
    callsOn,
    /** calls on or off for every world (the owner's to turn on; anyone may turn them off). */
    setCalls: (on: boolean) => put(callsKey(), on ? "on" : "off"),
    /** The platform's switch on the home world's Voice; on another world's Voice, that world's own switch. */
    setEnabled: (on: boolean) => put(worldKey ?? "enabled", on ? "on" : "off"),
    setModel: (m: string) => put("model", m),
    setMonthCap: (v: number) => put(capKey, String(v)),
    scope: { world, ...(ms ? { milestoneId: ms } : {}) } as VoiceScope,
    /** a call's whole transcript as plain text (the whole-call post's link); any of this console's calls by id. */
    wholeText: (id: string): string | undefined => {
      const r = db.prepare("SELECT * FROM voice_calls WHERE id = ?").get(id) as any;
      if (!r) return undefined;
      let lines: CallLine[] = [];
      try {
        lines = r.transcript ? JSON.parse(r.transcript) : [];
      } catch {
        /* unreadable: the header still says which call */
      }
      return wholeCallText(db, rowTo(r), lines).split("\n").filter((l, i) => i !== 1 && i !== 2).join("\n");
    },
    /** 0 = no cap (OpenAI's default); otherwise clamped to HISTORY_TOKENS_MIN..HISTORY_TOKENS_MAX. */
    setHistoryTokens: (t: number) => put("history_tokens", String(t <= 0 ? 0 : Math.round(Math.min(HISTORY_TOKENS_MAX, Math.max(HISTORY_TOKENS_MIN, t))))),
    setQuietHangup: (s: number) => put("quiet_hangup_s", String(Math.round(Math.min(QUIET_HANGUP_MAX_S, Math.max(QUIET_HANGUP_MIN_S, s))))),
  };
}

export type Voice = ReturnType<typeof createVoice>;

/**
 * the desk's tag on its reply to a call question(his calls of 18 Nov: q1 of call_c83e51e8 got no answer, q7 of
 * call_a3e08f34 was answered inside the q8 reply, q6 took a half sentence the desk wrote between tool calls): the desk
 * starts each reply with `↩ <ask id>:` (several: `↩ <id>, <id>:`), so an answer lands on the question it answers.
 */
export const ANSWER_TAG = "↩";
const ASK_ID_IN_HEAD = /\(([^()\s]+-q\d+)\)\s*$/;
const TAG_LINE = /^\s*↩[^\n:]*:\s*/;
/** the ask ids a reply's tag names (its first line, `↩ id, id:`). */
export function taggedIds(text: string): string[] {
  const m = /^\s*↩([^\n:]*):/.exec(text);
  return m ? (m[1].match(/[^\s,;]+-q\d+/g) ?? []) : [];
}
/** a reply without its tag, as the voice says it. */
export const untag = (text: string) => text.replace(TAG_LINE, "").trim();

/**
 * In the desk view: the question by its head, then its answer. First the desk's reply tagged with the question's id
 * (anywhere after it: a reply that answers two questions lands on both); with no tag, the desk's messages after it up to
 * his next message, the last one once the desk's turn is over (a reply tagged only for another question is not this one's).
 */
export function answerIn(v: Pick<DeskView, "messages" | "working">, head: string): { state: "queued" | "working" | "answered"; answer?: string; partial?: string } {
  const msgs: DeskMessage[] = v.messages;
  const i = msgs.findIndex((m) => m.role === "user" && m.text.startsWith(head));
  if (i < 0) return { state: "queued" };
  const askId = ASK_ID_IN_HEAD.exec(head)?.[1];
  if (askId) {
    const t = msgs.findIndex((m, k) => k > i && m.role === "assistant" && taggedIds(m.text).includes(askId));
    if (t >= 0) {
      // the tagged reply is the answer (its final words for that question), once the desk has finished writing it.
      const m = msgs[t];
      const nextAny = msgs.length > t + 1;
      if ((!v.working || nextAny) && m.status === "completed") return { state: "answered", answer: untag(m.text) };
      return { state: "working", partial: untag(m.text).slice(0, 600) };
    }
  }
  const after: DeskMessage[] = [];
  for (const m of msgs.slice(i + 1)) {
    if (m.role === "user") break;
    after.push(m);
  }
  const last = after.filter((m) => m.text.trim()).at(-1);
  // a reply tagged for other questions only answers those: this one still waits for its own.
  if (askId && last && taggedIds(last.text).length) return { state: "working" };
  // with no tag the desk's turn must be over (the thread idle): a later question steered into a running turn (q7 at
  // 04:26:08 in call_a3e08f34) no longer makes a half sentence the desk wrote between tool calls the answer.
  const done = !v.working && !!last && last.status === "completed";
  if (done) return { state: "answered", answer: untag(last!.text) };
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
