import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Link, useInRouterContext, useNavigate, useSearchParams } from "react-router-dom";
import { briefingHref, isBriefMe } from "@/lib/briefing";
import { ArrowDown, ExternalLink, Loader2, Mic, Phone, RefreshCw, Send, X } from "lucide-react";
import { api, type ChatRead, type DeskChat, type DeskMessage } from "@/api";
import { useOwnCall } from "@/voice/OwnCall";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Empty, ErrorBox, Loading, PHONE_TAP, RelTime, ThreadLink, threadHref } from "@/components/common";
import { INBOX_PATH } from "@/components/inboxLine";
import { ChatMarkdown } from "@/lib/chatMarkdown";
import { invalidate, pollWhileVisible, useQuery } from "@/lib/data";
import { SavedCopyLine } from "@/components/SavedCopyLine";
import { refreshApp } from "@/components/NewBuild";
import { knownWorld, worldId } from "@/lib/useSocial";
import { useCallDock } from "@/voice/CallPanel";
import { clockOf, parseVoiceNote, useVoiceNote, VoiceNoteBody, type PostingNote } from "@/voice/VoiceNote";
import { ReplyPlay, ReplyVoiceNote, SpeakingBar, SpeakRepliesSwitch } from "@/voice/ReplyVoice";
import { replySpeaker, stopOnTapOutside } from "@/voice/speak";
import { SentFiles, splitAttachments, useChatAttach } from "@/components/ChatAttach";
import { WordsBox } from "@/components/WordsBox";
import { usePushToggle } from "@/components/PushToggle";
import { deskVoiceBase } from "@/voice/deskBase";
import { passedHead, passedReply } from "@/lib/passed";
import { consoleSummary, foldChat } from "@/lib/chatFold";
import { PassedBubble } from "@/components/PassedBubble";
import { homeWorld, socialProduct } from "@/lib/identity";
import { MARKETING_BASE } from "@/voice/Marketing";
import { STRATEGY_BASE } from "@/voice/Strategy";

/**
 * (the owner, 26 Nov: "a Call button at each level ... with the right context"): each product desk's senior
 * partner, an OKR expert briefed with the product's objectives, key results, where we are, his words and open asks.
 * The Team desk calls the team product's partner (its strategy call), a world's desk the social product's (its briefer).
 */
export const deskPartner = (team: boolean) => (team ? { base: STRATEGY_BASE, name: "EpicTeam" } : { base: MARKETING_BASE, name: socialProduct() });

/** Poll the transcript while the desk works or a send is in flight, slowly otherwise. */
export const CHAT_POLL_FAST_MS = 2_500;
export const CHAT_POLL_IDLE_MS = 15_000;
/** a posted voice note's bubble waits at most this long for the transcript to show it back. */
export const POSTED_SHOW_MS = 120_000;
/** The page hint a "Chat about this" link carries: `/chat?page=<hint>`. */
export const chatHref = (hint: string) => `/chat?page=${encodeURIComponent(hint)}`;

/** a chat opens with its newest this many messages; scrolling up loads older ones, this many at a time (20, was 30). */
export const CHAT_PAGE = 20;
/** the console answered from its last good read (T3 was slow): ask again this soon for the fresh one. */
export const CHAT_POLL_STALE_MS = 1_000;
/** the first read failed (console restarting, network gone): try again this soon, saying so, never a dead page. */
export const CHAT_RETRY_MS = 3_000;
/** the workspace's chat waits for its own server (409 world_needs_box): not an outage, so look again only this often. */
export const CHAT_WAIT_BOX_MS = 180_000;
/** the console said the chat waits for the workspace's own server. */
export const waitsForBox = (e: unknown) => (e as { code?: string } | undefined)?.code === "world_needs_box";
/** the chat's own state when it has nothing to show (never a blank panel). */
export const CHAT_EMPTY = {
  loading: "Loading the chat…",
  empty: "No messages yet. Write to the desk below.",
} as const;
/** the quiet line while the desk's host cannot be reached. */
export const unreachableLine = (host: string) => `Can't reach ${host}, retrying… The messages below are the last ones read.`;
/** within this many px of the top of the history, the next older page loads. */
export const OLDER_PX = 300;
/** an older page the console is still reading (T3 slow) or that failed: ask again this soon, by itself. */
export const OLDER_RETRY_MS = 1_500;
/** failed older-page reads retried quietly before the error shows. */
export const OLDER_RETRIES = 5;
/** the quiet line while an older page is still on its way. */
export const OLDER_SLOW = "Older messages are still loading…";
/**
 * the last read of each chat in this tab (key: the chat's voice root or milestone), so opening Chat again paints
 * at once while the fresh read runs. Memory only: gone on reload.
 */
export const chatCache = new Map<string, DeskChat>();
/**
 * the same, kept in this browser (localStorage, the newest CHAT_PAGE messages), so a reload or a new tab paints
 * the chat at once even while the console is slow; the fresh read replaces it a moment later.
 */
const STORE_PREFIX = "console.chat:";
/**
 * a call's note opens "📞 Call question (call_ab12-q10)"; the bubble shows "Call question" as its
 * heading and drops the emoji and the raw call id. Anything else: undefined (the text shows as written).
 */
export function callHead(text: string): { head: string; rest: string } | undefined {
  const m = text.match(/^\s*(?:📞\s*)?(Call (?:question|answer|note|feedback))\s*\(call_[^)]*\)[ \t]*:?[ \t]*\n?/u);
  return m ? { head: m[1], rest: text.slice(m[0].length) } : undefined;
}

export function cachedChat(key: string): DeskChat | undefined {
  const mem = chatCache.get(key);
  if (mem) return mem;
  try {
    const raw = localStorage.getItem(STORE_PREFIX + key);
    return raw ? (JSON.parse(raw) as DeskChat) : undefined;
  } catch {
    return undefined;
  }
}
function keepChat(key: string, c: DeskChat) {
  chatCache.set(key, c);
  try {
    const { sendError: _e, queued: _q, stale: _s, ...rest } = c;
    localStorage.setItem(STORE_PREFIX + key, JSON.stringify({ ...rest, sending: 0, working: false, messages: c.messages.slice(-CHAT_PAGE) }));
  } catch {
    /* full or private mode: memory only */
  }
}
/** the newest message position a chat shows (-Infinity: none). */
export const newestAt = (c: DeskChat): number => c.messages.reduce((m, x) => (typeof x.position === "number" && x.position > m ? x.position : m), -Infinity);


/**
 * his phone opened the chat drawn from the copy it kept at 19:00, with no sign it was old, while its
 * network (Tailscale waking up) had not answered yet; he took it for the current chat. The kept copy still paints at once,
 * but after this long without a fresh answer the chat says how old it is, with a Refresh beside it.
 */
export const CHAT_FRESH_WAIT_MS = 1_500;
/** a chat whose last fresh answer is older than this (polls every 15 s) is out of date and says so. */
export const CHAT_OUT_OF_DATE_MS = 60_000;

const hhmm = (t: number, now = Date.now()) => {
  const d = new Date(t);
  const n = new Date(now);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === n.toDateString() ? time : `${d.getDate()} ${d.toLocaleString("en", { month: "short" })} ${time}`;
};

/**
 * what the chat's freshness line says (undefined: nothing, the chat is current). `freshAt`: this page's last fresh answer;
 * `newestAt`: when the newest line on screen was written; `openedAt`: when the page opened; `failing`: the last read failed.
 */
export function chatFreshText(o: { freshAt?: number; newestAt?: number; openedAt: number; failing?: boolean; now?: number }): string | undefined {
  const now = o.now ?? Date.now();
  const upTo = o.newestAt !== undefined ? `Showing the chat up to ${hhmm(o.newestAt, now)}` : "Showing a saved chat";
  if (o.freshAt === undefined) {
    if (!o.failing && now - o.openedAt < CHAT_FRESH_WAIT_MS) return undefined;
    return o.failing ? `${upTo}. Can't reach the team, retrying.` : `${upTo}. Getting the newest…`;
  }
  if (o.failing || now - o.freshAt >= CHAT_OUT_OF_DATE_MS) return `${upTo}. Can't reach the team, retrying.`;
  return undefined;
}

/** when the newest line a chat shows was written (undefined: no dated line). */
export const newestLineAt = (c: DeskChat | undefined): number | undefined => {
  let t: number | undefined;
  for (const m of c?.messages ?? []) {
    const at = Date.parse((m as { at?: string }).at ?? "");
    if (Number.isFinite(at) && (t === undefined || at > t)) t = at;
  }
  return t;
};

/** Tests: forget every kept chat. */
export function forgetChats() {
  chatCache.clear();
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(STORE_PREFIX)) localStorage.removeItem(k);
  } catch {
    /* none */
  }
}

/** reads closer together than this on coming back (focus, pageshow and visibilitychange often fire together) are one. */
export const SHOWN_AGAIN_GAP_MS = 2_000;
/**
 * `fn` each time the page is on screen again: shown after hidden, the window focused, restored from the back-forward
 * cache, back online, or the service worker's fresh answer after it drew a saved copy. Returns the stop function.
 */
export function onShownAgain(fn: () => void, win: Window | undefined = typeof window === "undefined" ? undefined : window): () => void {
  if (!win) return () => undefined;
  const doc = win.document;
  let last = 0;
  const go = () => {
    if (doc?.visibilityState === "hidden") return;
    const now = Date.now();
    if (now - last < SHOWN_AGAIN_GAP_MS) return;
    last = now;
    fn();
  };
  const fromWorker = (e: MessageEvent) => e.data?.type === "saved-copy-fresh" && go();
  const sw = (win.navigator as Navigator | undefined)?.serviceWorker;
  doc?.addEventListener("visibilitychange", go);
  win.addEventListener("pageshow", go);
  win.addEventListener("focus", go);
  win.addEventListener("online", go);
  sw?.addEventListener?.("message", fromWorker);
  return () => {
    doc?.removeEventListener("visibilitychange", go);
    win.removeEventListener("pageshow", go);
    win.removeEventListener("focus", go);
    win.removeEventListener("online", go);
    sw?.removeEventListener?.("message", fromWorker);
  };
}

/** within this many px of the page bottom counts as "at the latest line" (sticks to new lines). */
export const STICK_PX = 80;

/**
 * rework: the height the Team desk page may fill. iOS Safari keeps `100dvh` (and the layout viewport) full height when the
 * keyboard opens, so the page would run under the keyboard and Safari would pan it, pushing the call bar off the top. The visual
 * viewport is what is really on screen: track its height in `--vvh` and keep the page pinned to the top while typing. Android
 * already shrinks the layout viewport (`interactive-widget=resizes-content`), where this changes nothing.
 */
export function useVisibleHeight(): string | undefined {
  const [h, setH] = useState<number | undefined>(() => (typeof window !== "undefined" ? window.visualViewport?.height : undefined));
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const on = () => {
      setH(vv.height);
      // The page fits the visible part: undo Safari's pan so the call bar stays at the top.
      if (vv.offsetTop > 0 || window.scrollY > 0) window.scrollTo?.(0, 0);
    };
    vv.addEventListener("resize", on);
    vv.addEventListener("scroll", on);
    return () => {
      vv.removeEventListener("resize", on);
      vv.removeEventListener("scroll", on);
    };
  }, []);
  return h ? `${Math.round(h)}px` : undefined;
}

/**
 * the chat's scroller. A milestone's Chat tab scrolls the page (window), its composer sticky at the bottom of the column.
 * the Team desk page passes its history panel, which scrolls by itself between the header and the bottom dock (call bar +
 * chat box). An object so tests (jsdom has no layout) can stub it.
 */
export const chatScroll = {
  atBottom(panel?: HTMLElement | null): boolean {
    if (panel) return panel.scrollHeight - (panel.scrollTop + panel.clientHeight) <= STICK_PX;
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollHeight - (window.scrollY + window.innerHeight) <= STICK_PX;
  },
  toBottom(panel?: HTMLElement | null): void {
    if (panel) return void panel.scrollTo?.({ top: panel.scrollHeight, behavior: "auto" });
    const el = document.scrollingElement ?? document.documentElement;
    window.scrollTo?.({ top: el.scrollHeight, behavior: "auto" });
  },
};

/** a touch keyboard (no Shift to reach a newline): there Enter is a newline and the Send button sends. */
export const touchKeyboard = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches && !window.matchMedia?.("(hover: hover)").matches;

/**
 * does this key press send? Enter sends, Shift+Enter is a newline, Cmd/Ctrl+Enter sends everywhere (also on a touch
 * keyboard), and nothing sends while an IME is composing (Enter there picks the candidate).
 */
export function sendsOnKey(e: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey"> & { nativeEvent?: { isComposing?: boolean; keyCode?: number } }, touch = touchKeyboard()): boolean {
  if (e.key !== "Enter" || e.shiftKey || e.altKey) return false;
  if (e.nativeEvent?.isComposing || e.nativeEvent?.keyCode === 229) return false;
  if (e.metaKey || e.ctrlKey) return true;
  return !touch;
}

/** elapsed time as the working line shows it: 0:42, 3:15, 1:02:10. */
export function formatElapsed(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

// Stable (module-level) so the view's loader never changes identity; late-bound so tests can spy on `api`.
const loadDesk = (read?: ChatRead) => api.getDeskChat(read);
const sendDesk = (text: string, page?: string, id?: string, files?: string[]) => (files?.length ? api.sendDeskMessage(text, page, id, files) : api.sendDeskMessage(text, page, id));
/** the world's desk was opened (the home world's Team desk or a world's team desk: the server knows which from the login). */
const markDeskSeen = () => api.markChatSeen({ chat: "desk" });

/**
 * the owner's one chat with the Team desk. A view on the desk's T3 thread: the console stores nothing, so what is shown is
 * read back from T3 (user + assistant text only, never tool output) and survives restarts and compaction.
 */
export function ChatPage() {
  // the Team desk is the platform's (the home world's) one thread; another world's chats are its campaigns' own (the Repo desk,
  // tenant-safe since), so its Chat page is a campaign's desk and never calls /api/desk/messages (403 world_scope there).
  // the world this tab already knows opens the chat at once (the query still asks /api/me, and wins when it answers).
  const [known] = useState(knownWorld);
  const world = useQuery(() => worldId(), []);
  const w = world.data ?? known;
  if (w === undefined && world.loading) return <Loading />;
  // an unknown world (failing /api/me) is not the home world: show the error (the query retries), not the platform's desk.
  if (w === undefined && world.error) return <ErrorBox error={world.error} />;
  // through the door (the owner on a customer site) the home world's Chat is his Team desk, with its history.
  return w && w !== homeWorld() ? <WorldDesk world={w} /> : <TeamDeskChat />;
}

/**
 * (the owner 2026-11-02: "the social top-level Chat is the social team desk, like the console's Team desk"; L-5):
 * a world's Chat page is that world's team desk: no campaign picker, one desk across every campaign and job of the world, on
 * its own thread (GET/POST /api/tenants/:id/desk/messages), with its own Call and voice notes (/api/tenants/:id/desk/voice).
 * The same DeskPage as the home world's Team desk (desk parity, deskParity.test.tsx). Each campaign's own chat is its page's Chat tab.
 * Replaces's campaign picker.
 */
function WorldDesk({ world }: { world: string }) {
  const load = useCallback((read?: ChatRead) => api.getWorldDeskChat(world, read), [world]);
  const send = useCallback((text: string, page?: string, id?: string, files?: string[]) => (files?.length ? api.sendWorldDeskMessage(world, text, page, id, files) : api.sendWorldDeskMessage(world, text, page, id)), [world]);
  const [params, setParams] = useSearchParams();
  const hint = params.get("page")?.trim() || "";
  return (
    <DeskPage
      partner={deskPartner(false)}
      description="The team desk: new ideas and which campaign they belong to, answers, and starting, steering or stopping runs. One chat for every campaign."
      who="Team desk"
      callBase={deskVoiceBase(world)}
      load={load}
      sendMessage={send}
      hint={hint}
      clearHint={() => setParams({}, { replace: true })}
      placeholder="Tell the desk an idea, ask what is open…"
    />
  );
}

/**
 * a paid EpicTeam workspace's chat on its Home, under its one first objective, Get set up (homeView.tsx; the owner 17 Nov:
 * "one objective and several key results"): the workspace's team desk, which works each key result to green.
 */
export function GettingGoingChat({ world, fresh, clean }: { world: string; fresh: boolean; /** a new workspace with no Get set up */ clean?: boolean }) {
  const load = useCallback((read?: ChatRead) => api.getWorldDeskChat(world, read), [world]);
  const send = useCallback((text: string, page?: string, id?: string, files?: string[]) => (files?.length ? api.sendWorldDeskMessage(world, text, page ?? "home", id, files) : api.sendWorldDeskMessage(world, text, page ?? "home", id)), [world]);
  const [params, setParams] = useSearchParams();
  const hint = params.get("page")?.trim() || "";
  return (
    <DeskPage
      title="Chat with your team"
      description={clean ? "Tell your team what this workspace is for and its first objective." : "Your team works here to turn each key result green."}
      who="Team desk"
      callBase={deskVoiceBase(world)}
      load={load}
      sendMessage={send}
      hint={hint}
      clearHint={() => setParams({}, { replace: true })}
      placeholder={fresh ? (clean ? "What is this workspace for?" : "Say hello, or what you want your team to get done first…") : "Ask the team, or say what is next…"}
    />
  );
}

function TeamDeskChat() {
  const [params, setParams] = useSearchParams();
  const hint = params.get("page")?.trim() || "";
  return (
    <DeskPage
      partner={deskPartner(true)}
      description="The Team desk: new ideas and where they fit, answers, and starting, steering or stopping runs. One chat for every repo."
      who="Team desk"
      load={loadDesk}
      sendMessage={sendDesk}
      hint={hint}
      clearHint={() => setParams({}, { replace: true })}
      placeholder="Tell the desk an idea, ask what is open…"
    />
  );
}

/**
 * the desk page, one component for every desk the owner talks to: the home world's Team desk and a world's team desk
 * (the social skin's Chat). Every desk upgrade lands here, so both skins carry it (desk parity: deskParity.test.tsx fails when the
 * Team desk shows something a world's desk does not). Call the desk; rework (the owner's review): call controls on
 * top, the chat box alone at the bottom, the history panel between them; the call's live lines end the history.
 */
export function DeskPage({
  description,
  who,
  callBase,
  load,
  sendMessage,
  hint,
  clearHint,
  placeholder,
  markSeen = markDeskSeen,
  title = "Chat",
  partner,
}: {
  /** the product desk's senior partner call (its own routes): one more Call in the header, only where it can call. */
  partner?: { base: string; name: string };
  description: string;
  /** the page's heading (default Chat). */
  title?: string;
  who: string;
  /** The call routes' root (default `/api/voice`, the Team desk's). */
  callBase?: string;
  load: (read?: ChatRead) => Promise<DeskChat>;
  /** `attachments` = uploaded file ids (only when `attach` is on). */
  sendMessage: (text: string, page?: string, clientRequestId?: string, attachments?: string[]) => Promise<{ threadId: string; pending: boolean }>;
  hint: string;
  clearHint: () => void;
  placeholder: string;
  /** marks this chat read (default: the world's desk). */
  markSeen?: () => Promise<unknown>;
}) {
  const [threadId, setThreadId] = useState<{ threadId?: string; environmentId?: string; ownServer?: boolean }>({});
  const call = useCallDock(callBase ? { base: callBase } : {});
  const mate = useCallDock(
    partner
      ? { base: partner.base, callee: `the ${partner.name} partner`, label: "Partner", where: `${partner.name} desk`, wide: true, hideUnavailable: true, hint: "Key results, where we are, what waits on you." }
      : { base: "/api/voice/none", state: async () => undefined, hideUnavailable: true },
  );
  // a workspace on its own server and AI calls with the browser's own speech (never our voice key)
  const own = useOwnCall({ load: () => load(), send: (t, page, id) => sendMessage(t, page, id) });
  const ownServer = !!threadId.ownServer;
  const push = usePushToggle(); // phone notifications (the installed app)
  const vvh = useVisibleHeight();
  return (
    // the page is exactly one screen tall (under the top bar: 52px phone, 2.75rem desktop since; main's py-6 is 3rem), so the header, the call
    // bar, the history panel (its own scroller) and the chat box are all in view, on a call and while typing (`--vvh`).
    <div
      className="flex h-[calc(var(--vvh,100dvh)-6rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] min-h-[16rem] min-w-0 flex-col md:h-[calc(var(--vvh,100dvh)-5.75rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] [&>div:first-child]:mb-3 sm:[&>div:first-child]:mb-4"
      style={vvh ? ({ "--vvh": vvh } as CSSProperties) : undefined}
      data-testid="chat-page"
    >
      {/* one header row on a phone too (Chat, Open in T3 as an icon, the compact Call), so the history gets the screen.
          Desktop keeps PageHeader's look: title and description left, the actions right. */}
      <div className="flex items-center justify-between gap-3 sm:items-start" data-testid="chat-header">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight [overflow-wrap:anywhere] sm:text-2xl">{title}</h1>
          <div className="mt-1 text-sm text-muted-foreground max-sm:hidden">{description}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1 sm:gap-3">
          {threadId.threadId && (
            <ThreadLink
              threadId={threadId.threadId}
              environmentId={threadId.environmentId}
              className="inline-flex shrink-0 items-center gap-1 text-sm text-muted-foreground underline max-sm:size-11 max-sm:justify-center max-sm:rounded-full max-sm:no-underline max-sm:hover:bg-accent sm:mt-2"
              title="Open the desk's thread in T3"
            >
              <ExternalLink className="h-3.5 w-3.5 max-sm:h-[18px] max-sm:w-[18px]" /> <span className="max-sm:sr-only">Open in T3</span>
            </ThreadLink>
          )}
          {push.bell}
          <SpeakRepliesSwitch />
          {!ownServer && !call.onCall && mate.button && <span data-testid="desk-partner-call">{mate.button}</span>}
          {!ownServer && !mate.onCall && call.button}
        </div>
      </div>
      {push.banner && <div className="mb-2">{push.banner}</div>}
      <ChatView
        panel
        voiceBase={ownServer ? "" : (callBase ?? deskVoiceBase(undefined))}
        top={ownServer ? own.bar : mate.onCall ? mate.bar : call.bar}
        live={ownServer ? undefined : mate.onCall ? mate.live : call.live}
        liveKey={ownServer ? own.phase : mate.onCall ? mate.liveKey : call.liveKey}
        who={who}
        load={load}
        cacheKey={callBase ?? deskVoiceBase(undefined)}
        sendMessage={sendMessage}
        markSeen={markSeen}
        hint={hint}
        clearHint={clearHint}
        placeholder={placeholder}
        onThread={setThreadId}
        attach
      />
    </div>
  );
}

/** the quiet line while T3 is down, by why (the server checks the maintenance markers). */
export const T3_DOWN_MESSAGE = {
  restarting: "T3 is restarting, reconnecting…",
  maintenance: "T3 is down for planned maintenance, reconnecting…",
} as const;
/** the text of the files sent just before a voice note (the note follows in the next message). */
export const VOICE_FILES_NOTE = "Files for my voice note, which follows in the next message: read both, then answer once.";
/**
 * under a send the console holds while T3 is down or slow: it is sent (the console has it and delivers it by itself),
 * never worded as a doubt (the owner, 18 Nov: "queued" read as not sent while the desk had his message).
 */
export const QUEUED_NOTE = "✓ Sent · the desk gets it as soon as T3 answers";
/**
 * his typed message the desk's thread does not show minutes after he sent it (22 Nov: three sat in T3's queue for two
 * hours and his screen said nothing): said plainly on the message itself, like a voice note's.
 */
export const MSG_NOT_DELIVERED = "Not delivered to the desk yet";
/** what his message says once the console has it (it delivers to the desk by itself; a failure comes back on it). */
export const SENT_NOTE = "✓ Sent";
/** his voice note the desk does not have yet: said plainly on the note itself. */
export const NOTE_RETRYING = "Voice note not delivered yet, retrying";
export const NOTE_NOT_DELIVERED = "Voice note not delivered. Its words are kept and the team has been told";
/**
 * why a note is not in the desk's chat yet, from the console's last try (the owner saw only "retrying" for
 * an hour while T3 restarted, and his newest bubble at the bottom looked failed): said in plain words under the note.
 */
export function noteWhy(error: string | undefined, t3?: "restarting" | "maintenance"): string {
  const inner = /\((.+)\)\s*$/.exec(error ?? "")?.[1];
  if (inner) return inner.charAt(0).toUpperCase() + inner.slice(1);
  if (t3) return t3 === "maintenance" ? "T3 is down for planned maintenance" : "T3 is restarting";
  return "The desk's chat has not taken it yet";
}
type UndeliveredNoteItem = NonNullable<DeskChat["undeliveredNotes"]>[number];

/**
 * his voice note the desk's chat does not hold yet, where he sent it: what is wrong in plain words, since when, and
 * Send again (one re-send now under the note's one id; the console also re-sends it each minute by itself).
 */
function UndeliveredNote({ n, t3, base, onSent }: { n: UndeliveredNoteItem; t3?: "restarting" | "maintenance"; base?: string; onSent: () => void }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | undefined>();
  const again = async () => {
    setBusy(true);
    setSaid(undefined);
    try {
      const r = await fetch(`${base || "/api/voice"}/notes/${encodeURIComponent(n.id)}/redeliver`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const j = (await r.json().catch(() => ({}))) as { delivered?: boolean; error?: { message?: string } };
      if (!r.ok) setSaid(`Could not send it again: ${j.error?.message ?? `the console answered ${r.status}`}`);
      else if (j.delivered) setSaid(SENT_MARK);
      else setSaid("Sent again: the desk's chat has not taken it yet, the console keeps trying");
      onSent();
    } catch (e) {
      setSaid(`Could not send it again: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex justify-end" data-testid="chat-undelivered-note">
      <div className="min-w-0 max-w-[92%] rounded-lg border border-destructive bg-primary/60 px-3 py-2 text-sm text-primary-foreground sm:max-w-[85%]">
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{n.text}</p>
        <div className="mt-1.5 rounded bg-background px-2 py-1.5 text-xs text-destructive" role="alert">
          <span className="block" data-testid="chat-undelivered-state">{n.state === "failed" ? NOTE_NOT_DELIVERED : NOTE_RETRYING}</span>
          <span className="block text-muted-foreground" data-testid="chat-undelivered-why">
            {noteWhy(n.error, t3)} · sent <RelTime iso={n.at} />
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" className={cn(PHONE_TAP, "h-8")} disabled={busy} pending={busy} pendingLabel="Sending…" onClick={() => void again()} data-testid="chat-undelivered-retry">
              Send again
            </Button>
            {said && <span className="text-muted-foreground" data-testid="chat-undelivered-said">{said}</span>}
          </span>
        </div>
      </div>
    </li>
  );
}

type UndeliveredMessageItem = NonNullable<DeskChat["undelivered"]>[number];
/** his typed message T3 took that the desk's thread does not show yet: what is wrong and since when, on the message. */
function UndeliveredMessage({ m }: { m: UndeliveredMessageItem }) {
  return (
    <li className="flex justify-end" data-testid="chat-undelivered-message">
      <div className="min-w-0 max-w-[92%] rounded-lg border border-destructive bg-primary/60 px-3 py-2 text-sm text-primary-foreground sm:max-w-[85%]">
        {m.page && <p className="mb-1 text-[11px] opacity-80 [overflow-wrap:anywhere]">about: {m.page}</p>}
        <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{splitAttachments(m.text).text}</p>
        <SentFiles files={splitAttachments(m.text).files} />
        <div className="mt-1.5 rounded bg-background px-2 py-1.5 text-xs text-destructive" role="alert">
          <span className="block" data-testid="chat-undelivered-message-state">{MSG_NOT_DELIVERED}</span>
          <span className="block text-muted-foreground" data-testid="chat-undelivered-message-why">
            {m.why} · sent <RelTime iso={m.at} />
          </span>
        </div>
      </div>
    </li>
  );
}

/** his own message the desk's chat holds: the mark under it (pasted images included). */
export const SENT_MARK = "✓ Sent";
/** the undelivered notes placed in time among the messages: key = the id of the message each follows ("" = before all). */
export function notesInTime<N extends { at: string }>(notes: N[] | undefined, messages: { id: string; at?: string }[]): Map<string, N[]> {
  const out = new Map<string, N[]>();
  for (const n of notes ?? []) {
    const t = Date.parse(n.at);
    let after = "";
    for (const m of messages) if (m.at && Date.parse(m.at) <= t) after = m.id;
    out.set(after, [...(out.get(after) ?? []), n]);
  }
  return out;
}
/** the same quiet lines in a customer's workspace, which never names our T3. */
export const CUSTOMER_T3_DOWN_MESSAGE = { restarting: "The chat is reconnecting…", maintenance: "The chat is down for planned maintenance, reconnecting…" } as const;
export const CUSTOMER_QUEUED_NOTE = "✓ Sent · the team gets it as soon as the chat is back";

/**
 * a message he sent that the transcript does not show yet. It shows at once ("sending…"), the console's reply
 * comes later; a failure stays on its own bubble with Retry. It leaves when the transcript (or the T3-down queue) holds it.
 */
export type OutboxItem = { crid: string; text: string; page?: string; ids?: string[]; state: "sending" | "sent" | "failed"; error?: string; seen: string[] };
/** the words of a message as the transcript shows them back (his files ride as a block under the words). */
const wordsOf = (t: string) => splitAttachments(t).text.trim();
/** the transcript (or the T3-down queue) holds this message: a user line not there when he sent it, with his words. */
export function landed(o: OutboxItem, messages: DeskMessage[], queued: { text: string }[] = []): boolean {
  const want = o.text.trim();
  const seen = new Set(o.seen);
  const same = (t: string) => (want ? wordsOf(t) === want || wordsOf(t).endsWith(want) : true);
  return messages.some((m) => m.role === "user" && m.kind !== "seed" && !seen.has(m.id) && same(m.text)) || queued.some((q) => same(q.text));
}

/**
 * the chat itself (transcript, working…, sending, composer), shared by the Team desk page and every milestone's Chat tab:
 * a view on one T3 thread read back through `load`, sent to through `sendMessage`.
 */
/** where "brief me" goes: the router's navigate, or a page load where the chat has no router (an embed, a test). */
function useBriefingDoor(): (to: string) => void {
  const inRouter = useInRouterContext();
  // eslint-disable-next-line react-hooks/rules-of-hooks -- inRouter never changes for a mounted chat
  return inRouter ? useNavigate() : (to: string) => window.location.assign(to);
}

export function ChatView({
  who,
  load: fetchChat,
  sendMessage,
  hint = "",
  hintLabel,
  clearHint,
  placeholder,
  onThread,
  panel = false,
  top,
  dock,
  live,
  liveKey = "",
  voiceBase,
  voiceNote,
  markSeen,
  cacheKey,
  attach = true,
}: {
  /** The persona's name as the chat shows it ("Team desk", "Repo desk"). */
  who: string;
  /** the newest `limit` messages, or (with `before`) the older page (only `messages` and `hasEarlier` are read). */
  load: (read?: ChatRead) => Promise<DeskChat>;
  /** `attachments` = uploaded file ids (only when `attach` is on). */
  sendMessage: (text: string, page?: string, clientRequestId?: string, attachments?: string[]) => Promise<{ threadId: string; pending: boolean }>;
  hint?: string;
  /** what the hint chip says ("About · <title>"); default "About: <hint>". */
  hintLabel?: string;
  clearHint?: () => void;
  placeholder: string;
  onThread?: (t: { threadId?: string; environmentId?: string; ownServer?: boolean }) => void;
  /** the history scrolls inside its own panel and the composer docks under it (the Team desk page fills one screen). */
  panel?: boolean;
  /** rework: shown above the history panel (the Team desk's call bar). */
  top?: ReactNode;
  /** Shown in the dock right above the chat box. */
  dock?: ReactNode;
  /** extra newest lines at the end of the history (a call's live lines); `liveKey` changes as they grow. */
  live?: ReactNode;
  liveKey?: string;
  /** rework: this chat's voice routes (`/api/voice`, `/api/milestones/<id>/voice`): the voice-note button by Send. */
  voiceBase?: string;
  /** Tests: the voice note's console, microphone and clock. */
  voiceNote?: Omit<Parameters<typeof useVoiceNote>[0], "base" | "page" | "onSent">;
  /** marks this chat read (its unread pill goes to 0): on open, and on each new line while it is open and in view. */
  markSeen?: () => Promise<unknown>;
  /** keeps this chat's last read for the next open in this tab (chatCache). */
  cacheKey?: string;
  /** the paperclip by the voice note: screenshots and files go with the message (sendMessage's `attachments`). On in every chat since round 2 (the same box everywhere); false only for a chat whose send takes no files. */
  attach?: boolean;
}) {
  const [chat, setChat] = useState<DeskChat | undefined>(() => (cacheKey ? cachedChat(cacheKey) : undefined));
  /** messages older than the newest page: loaded by scrolling up, or slid out of it while the chat was open. */
  const [older, setOlder] = useState<{ messages: DeskMessage[]; hasEarlier: boolean } | undefined>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | undefined>();
  /** the console is still reading the older page (or a read failed): the chat asks again by itself, saying so quietly. */
  const [olderSlow, setOlderSlow] = useState(false);
  const olderFails = useRef(0);
  const olderRetry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(olderRetry.current), []);
  const chatRef = useRef(chat);
  const olderRef = useRef(older);
  /** the history's height before an older page was put on top (the scroll position is kept across it). */
  const anchor = useRef<number | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>();
  /** this page's last fresh answer from the console (undefined: only the kept copy is drawn so far). */
  const [freshAt, setFreshAt] = useState<number | undefined>();
  const [openedAt] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const [, setClock] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setClock((n) => n + 1), 1_000);
    return () => clearInterval(t);
  }, []);
  // what he typed stays while he visits other pages (this tab only), like the voice note he is recording.
  const draftKey = cacheKey ? `chat-draft:${cacheKey}` : undefined;
  const [text, setText] = useState(() => {
    try {
      return (draftKey && sessionStorage.getItem(draftKey)) || "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    if (!draftKey) return;
    try {
      if (text) sessionStorage.setItem(draftKey, text);
      else sessionStorage.removeItem(draftKey);
    } catch {
      /* storage off */
    }
  }, [draftKey, text]);
  // his messages not in the transcript yet (shown at once; the console's work runs after its reply).
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const outboxRef = useRef(outbox);
  outboxRef.current = outbox;
  /** his sends go to the console one after another, in the order he wrote them. */
  const sendChain = useRef<Promise<unknown>>(Promise.resolve());
  const [sendFailed, setSendFailed] = useState<string | undefined>();
  const alive = useRef(true);
  /** the owner is at the latest line, so new lines keep him there; false once he scrolls up to read. */
  const stuck = useRef(true);
  const [away, setAway] = useState(false);
  const [unseen, setUnseen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = () => chatScroll.atBottom(panel ? scroller.current : undefined);
  const toBottom = () => chatScroll.toBottom(panel ? scroller.current : undefined);

  const load = useCallback(async () => {
    try {
      const c = await fetchChat({ limit: CHAT_PAGE });
      if (!alive.current) return;
      // a read that ends before what is on screen (the console catching up after a restart) never replaces it
      const shownNow = chatRef.current;
      if (shownNow && shownNow.threadId === c.threadId && newestAt(c) < newestAt(shownNow)) {
        setError(undefined);
        return;
      }
      // what slid out of the newest page while the chat was open stays shown, above it
      const prev = chatRef.current;
      let o = olderRef.current;
      if (!prev || prev.threadId !== c.threadId) o = undefined;
      else {
        const first = c.messages[0]?.position;
        if (first !== undefined) {
          const seen = new Set(o?.messages.map((m) => m.id));
          const slid = prev.messages.filter((m) => m.position !== undefined && m.position < first && !seen.has(m.id));
          const kept = [...(o?.messages ?? []), ...slid].filter((m) => m.position! < first).sort((a, b) => a.position! - b.position!);
          o = kept.length || o ? { messages: kept, hasEarlier: o ? o.hasEarlier : prev.hasEarlier } : undefined;
        }
      }
      chatRef.current = c;
      olderRef.current = o;
      setChat(c);
      setOlder(o);
      if (cacheKey && c.available) keepChat(cacheKey, c);
      if (!c.stale) setFreshAt(Date.now());
      setError(undefined);
    } catch (e) {
      if (alive.current) setError(e as Error);
    }
  }, [fetchChat, cacheKey]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  useEffect(() => {
    // a customer's workspace shows no way into our T3 (no Open in T3)
    onThread?.(chat?.customer ? (chat?.ownServer ? { ownServer: true } : {}) : { threadId: chat?.threadId, environmentId: chat?.environmentId });
  }, [chat?.threadId, chat?.environmentId, chat?.customer, chat?.ownServer, onThread]);

  // the owner has this chat open, so what it shows is read: mark it on the first read, on every new or finished line,
  // and when the tab comes back into view; then the pills refresh.
  const newest = chat?.messages.at(-1);
  const seenKey = chat?.available ? `${chat.threadId ?? ""}|${newest?.id ?? ""}|${newest?.status ?? ""}` : undefined;
  useEffect(() => {
    if (!markSeen || seenKey === undefined) return;
    const mark = () => {
      if (document.visibilityState !== "hidden") void markSeen().then(() => invalidate("counts"), () => undefined);
    };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [seenKey, markSeen]);

  const posting = outbox.some((o) => o.state !== "failed");
  const busy = !!chat?.working || (chat?.sending ?? 0) > 0 || posting || !!chat?.queued?.length || !!chat?.undelivered?.length;
  // a message leaves the outbox once the transcript shows it; a failure the console found after its reply lands on its bubble.
  useEffect(() => {
    if (!chat?.available || !outbox.length) return;
    const all = older ? [...older.messages, ...chat.messages] : chat.messages;
    const err = chat.sendError;
    const next = outbox
      // his message the console reports not delivered yet gets its own bubble from the console (every device shows it)
      .filter((o) => o.state === "failed" || !(landed(o, all, chat.queued) || chat.undelivered?.some((u) => u.id === o.crid)))
      .map((o) => (err?.clientRequestId === o.crid && o.state !== "failed" ? { ...o, state: "failed" as const, error: err.text } : o));
    if (next.length !== outbox.length || next.some((o, i) => o !== outbox[i])) setOutbox(next);
  }, [chat, older, outbox]);
  useEffect(() => {
    if (!chat?.available) return;
    return pollWhileVisible(() => void load(), busy ? CHAT_POLL_FAST_MS : CHAT_POLL_IDLE_MS); // not while the tab is hidden
  }, [busy, chat?.available, load]);
  // the chat reads its newest lines the moment it is on screen again (the app back from the background, the
  // phone unlocked, back online), never at the next poll: his phone showed the chat from two hours before.
  useEffect(() => onShownAgain(() => void load()), [load]);
  // the first read failed (no chat to show yet): keep trying, the page says so meanwhile
  useEffect(() => {
    if (chat || !error) return;
    const t = setTimeout(() => void load(), waitsForBox(error) ? CHAT_WAIT_BOX_MS : CHAT_RETRY_MS);
    return () => clearTimeout(t);
  }, [chat, error, load]);
  // an answer from the console's last good read (T3 was slow): the fresh one is a moment away
  useEffect(() => {
    if (!chat?.stale) return;
    const t = setTimeout(() => void load(), CHAT_POLL_STALE_MS);
    return () => clearTimeout(t);
  }, [chat, load]);

  // the history shown = older pages + the newest page; scrolling near the top loads the next older page.
  const shown = older ? [...older.messages, ...(chat?.messages ?? [])] : (chat?.messages ?? []);
  const voiceReplies = voiceReplyIds(shown, !!chat?.working);
  const hasEarlier = older ? older.hasEarlier : !!chat?.hasEarlier;
  const oldest = shown[0]?.position;
  const canPage = hasEarlier && oldest !== undefined;
  const loadOlder = async () => {
    if (loadingOlder || !canPage) return;
    setLoadingOlder(true);
    setOlderError(undefined);
    const el = panel ? scroller.current : (document.scrollingElement ?? document.documentElement);
    clearTimeout(olderRetry.current);
    const again = () => {
      setOlderSlow(true);
      olderRetry.current = setTimeout(() => void loadOlderRef.current(), OLDER_RETRY_MS);
    };
    try {
      const page = await fetchChat({ before: oldest, limit: CHAT_PAGE });
      if (!alive.current) return;
      // the console's read of the older page outlasted its budget: it reads on, ask again in a moment (never an error)
      if (page.loading) return again();
      olderFails.current = 0;
      setOlderSlow(false);
      const have = new Set(shown.map((m) => m.id));
      const add = (page.messages ?? []).filter((m) => !have.has(m.id));
      anchor.current = el?.scrollHeight;
      const o = { messages: [...add, ...(olderRef.current?.messages ?? [])], hasEarlier: !!page.hasEarlier && add.length > 0 };
      olderRef.current = o;
      setOlder(o);
    } catch (e) {
      if (!alive.current) return;
      if (++olderFails.current <= OLDER_RETRIES) return again();
      olderFails.current = 0;
      setOlderSlow(false);
      setOlderError((e as Error).message);
    } finally {
      if (alive.current) setLoadingOlder(false);
    }
  };
  const loadOlderRef = useRef(loadOlder);
  loadOlderRef.current = loadOlder;
  // keep the owner's place: the page put on top grows the history by its height
  useLayoutEffect(() => {
    if (anchor.current === undefined) return;
    const h0 = anchor.current;
    anchor.current = undefined;
    if (panel) {
      const el = scroller.current;
      if (el) el.scrollTop += el.scrollHeight - h0;
    } else {
      const el = document.scrollingElement ?? document.documentElement;
      window.scrollBy?.(0, el.scrollHeight - h0);
    }
  }, [older, panel]);

  // follow the latest line (a new or growing message, sending…, working…) while the owner is at the bottom; scrolled up, he
  // stays where he reads and a "Jump to latest" control says there is more.
  useEffect(() => {
    const onScroll = () => {
      const at = atBottom();
      stuck.current = at;
      setAway(!at);
      if (at) setUnseen(false);
      const top = panel ? (scroller.current?.scrollTop ?? 0) : window.scrollY;
      if (!at && top < OLDER_PX) void loadOlderRef.current();
    };
    const target: HTMLElement | Window | null = panel ? scroller.current : window;
    target?.addEventListener("scroll", onScroll, { passive: true });
    return () => target?.removeEventListener("scroll", onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-attach when the panel mounts (after the first load)
  }, [panel, !!chat?.available]);
  const lastMsg = chat?.messages.at(-1);
  const tail = `${chat?.messages.length ?? 0}|${lastMsg?.id}|${lastMsg?.status}|${lastMsg?.text.length}|${outbox.length}|${chat?.working ? 1 : 0}|${chat?.available ? 1 : 0}|${chat?.queued?.length ?? 0}|${liveKey}`;
  useLayoutEffect(() => {
    if (!chat?.available) return;
    if (stuck.current) toBottom();
    else setUnseen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `tail` is the content signature
  }, [tail]);
  const jumpToLatest = () => {
    stuck.current = true;
    setAway(false);
    setUnseen(false);
    toBottom();
  };

  const navigate = useBriefingDoor();
  const files = useChatAttach({ enabled: attach });
  const patchOut = (crid: string, p: Partial<OutboxItem>) => setOutbox((xs) => xs.map((o) => (o.crid === crid ? { ...o, ...p } : o)));
  /** post one outbox message (behind his earlier ones); the transcript read after it shows it in place. */
  const deliver = (o: OutboxItem) => {
    const go = async () => {
      try {
        await sendMessage(o.text, o.page, o.crid, ...(o.ids?.length ? [o.ids] : []));
        if (!alive.current) return;
        patchOut(o.crid, { state: "sent" });
        void load();
      } catch (e) {
        if (alive.current) patchOut(o.crid, { state: "failed", error: (e as Error).message });
      }
    };
    sendChain.current = sendChain.current.then(go, go);
  };
  // Send never waits: his message shows at once, the box clears for the next one, the console's work runs after.
  const send = async () => {
    const body = text.trim();
    const ids = files.ids;
    if ((!body && !ids.length) || !files.ready) return;
    // "brief me" opens his briefing: the Team desk walks him through his objectives one by one.
    if (!ids.length && isBriefMe(body)) {
      setText("");
      navigate(briefingHref());
      return;
    }
    // His own send always brings him to the newest line (the effect scrolls once "sending…" renders).
    stuck.current = true;
    setAway(false);
    setUnseen(false);
    setSendFailed(undefined);
    const all = older ? [...older.messages, ...(chat?.messages ?? [])] : (chat?.messages ?? []);
    const o: OutboxItem = {
      crid: `chat-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`,
      text: body,
      ...(hint ? { page: hint } : {}),
      ...(ids.length ? { ids } : {}),
      state: "sending",
      seen: all.map((m) => m.id),
    };
    setOutbox((xs) => [...xs, o]);
    setText("");
    files.clear();
    if (hint) clearHint?.();
    deliver(o);
  };
  /** a failed message goes again (same request id: T3 drops a copy it already took). */
  const retry = (crid: string) => {
    const o = outboxRef.current.find((x) => x.crid === crid);
    if (!o) return;
    const again = { ...o, state: "sending" as const, error: undefined };
    patchOut(crid, again);
    deliver(again);
  };
  /** he gives up on a failed message: its words go back into the box. */
  const unsend = (crid: string) => {
    const o = outboxRef.current.find((x) => x.crid === crid);
    setOutbox((xs) => xs.filter((x) => x.crid !== crid));
    if (o?.text && !text.trim()) setText(o.text);
  };

  // rework: a voice note is sent like typed text (with the page hint), then the chat reloads to show it.
  const note = useVoiceNote(
    voiceBase || voiceNote
      ? {
          ...voiceNote,
          ...(voiceBase ? { base: voiceBase } : {}),
          ...(hint ? { page: hint } : {}),
          // files waiting in the tray go first, in one message that says the voice note follows
          beforeSend: () => {
            // the note shows in the chat at once: bring him to it, like a typed send
            stuck.current = true;
            setAway(false);
            const ids = files.ids;
            if (!ids.length) return;
            files.clear();
            // through the outbox like a typed send: his files show sending, then Sent, or Not sent with Retry
            const all = older ? [...older.messages, ...(chat?.messages ?? [])] : (chat?.messages ?? []);
            const o: OutboxItem = { crid: `chat-files-${crypto.randomUUID?.() ?? Date.now()}`, text: VOICE_FILES_NOTE, ...(hint ? { page: hint } : {}), ids, state: "sending", seen: all.map((m) => m.id) };
            setOutbox((xs) => [...xs, o]);
            deliver(o);
          },
          onSent: () => {
            stuck.current = true;
            setAway(false);
            if (hint) clearHint?.();
            void load();
          },
        }
      : { state: async () => undefined },
  );
  // his voice note shows in the chat the moment he taps Send (its words fill in once written) and leaves when
  // the transcript holds it (the head line carries the note's id); the chat reads fast meanwhile and follows it down.
  const voicePosting = note.posting;
  useEffect(() => {
    if (!voicePosting?.id || !chat) return;
    const all = older ? [...older.messages, ...chat.messages] : chat.messages;
    if (all.some((m) => m.role === "user" && m.text.includes(voicePosting.id!))) note.landed();
  }, [chat, older, voicePosting?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // a posted note the transcript never shows back (another chat's wording) still leaves after two minutes
    if (voicePosting?.state !== "sent" && voicePosting?.state !== "safe") return;
    const t = setTimeout(() => note.landed(), POSTED_SHOW_MS);
    return () => clearTimeout(t);
  }, [voicePosting?.state]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!voicePosting || !chat?.available || busy) return;
    return pollWhileVisible(() => void load(), CHAT_POLL_FAST_MS);
  }, [!!voicePosting, !!chat?.available, busy]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (!voicePosting || !chat?.available) return;
    if (stuck.current) toBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the bubble appearing or its words filling in
  }, [voicePosting?.state, voicePosting?.words]);
  // a reply speaks only on Play; a tap anywhere else, a new message or leaving the chat stops it.
  useEffect(() => {
    const off = stopOnTapOutside();
    return () => {
      off();
      replySpeaker().stop();
    };
  }, []);
  const lastId = chat?.messages.at(-1)?.id;
  const seenLast = useRef(lastId);
  useEffect(() => {
    if (seenLast.current !== undefined && lastId !== seenLast.current) replySpeaker().stop();
    seenLast.current = lastId;
  }, [lastId]);
  // the newest finished desk reply is spoken ahead on the worker server, so Play on it starts at once.
  const warmId = lastMsg?.role === "assistant" && lastMsg.status === "completed" && !chat?.working ? lastMsg.id : undefined;
  useEffect(() => {
    // the same words Play says (a call's summary without its head line)
    if (warmId && lastMsg) replySpeaker().warm(warmId, callHead(lastMsg.text)?.rest ?? lastMsg.text);
  }, [warmId]); // eslint-disable-line react-hooks/exhaustive-deps
  // "Speak replies" on: the desk's first finished answer after his voice note plays by itself, once (Pause and Stop by it).
  useEffect(() => {
    if (!note.speakAfter || !chat || chat.working) return;
    const last = chat.messages.at(-1);
    if (last?.role === "assistant" && last.status === "completed" && Date.parse(last.at ?? "") >= note.speakAfter - 2000) {
      replySpeaker().play(last.id, last.text);
      note.spoken();
    }
  }, [chat, note.speakAfter]); // eslint-disable-line react-hooks/exhaustive-deps

  const threadUrl = (id: string) => threadHref(id, chat?.environmentId);
  const short = who.replace(/^Team /, "").toLowerCase();
  // a voice note the desk's chat lacks sits where he sent it, never below his newer messages
  const notesAt = notesInTime(chat?.undeliveredNotes, shown);
  const undeliveredBubble = (n: UndeliveredNoteItem) => (
    <UndeliveredNote key={n.id} n={n} t3={chat?.t3} base={voiceBase} onSent={() => void load()} />
  );

  return (
    <>
      {error && !chat && (
        <>
          {/* a workspace whose chat waits for its own server is reached fine: only its one line shows */}
          {!waitsForBox(error) && (
            <p role="status" className="mb-2 text-sm text-muted-foreground" data-testid="chat-retrying">
              Can't reach the console, retrying…
            </p>
          )}
          <ErrorBox error={error} muted />
        </>
      )}
      {!chat && !error && <Loading />}
      {chat && !chat.available && <Empty>{chat.reason ?? `The ${who} is not available.`}</Empty>}
      {chat?.available && (
        <>
          {error && <div className="mb-2"><ErrorBox error={error} muted /></div>}
          {/* a transcript the app drew from its saved copy (the console out of reach) says so, with its age */}
          <SavedCopyLine />
          <ChatFreshLine
            text={chatFreshText({ freshAt, newestAt: newestLineAt(chat), openedAt, failing: !!error })}
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              try {
                // a newer build is live: move onto it (his draft stays); otherwise read the newest lines now
                if (await refreshApp()) return;
                await load();
              } finally {
                if (alive.current) setRefreshing(false);
              }
            }}
          />
          {chat.unreachable && (
            // the desk's host (the worker server over the tunnel) cannot be reached: the last good transcript stays, one quiet line
            <div role="status" className="mb-2 shrink-0 text-xs text-muted-foreground" data-testid="chat-unreachable">
              {unreachableLine(chat.unreachable)}
            </div>
          )}
          {chat.t3 && !chat.unreachable && (
            // T3 is restarting (or stopped for maintenance): the last good transcript stays, one quiet line ('s tone)
            <div role="status" className="mb-2 shrink-0 text-xs text-muted-foreground" data-testid="chat-t3-down">
              {(chat.customer ? CUSTOMER_T3_DOWN_MESSAGE : T3_DOWN_MESSAGE)[chat.t3]}
            </div>
          )}
          {top && (
            <div className="shrink-0" data-testid="chat-top">
              {top}
            </div>
          )}
          {/* the history fills everything between the header and the box, with no frame of its own. */}
          <div
            ref={scroller}
            className={cn(panel && "min-h-0 flex-1 overflow-y-auto overscroll-contain pt-1 [scrollbar-gutter:stable]")}
            data-testid="chat-scroll"
            tabIndex={panel ? 0 : undefined}
            aria-label={panel ? "Chat history" : undefined}
          >
          {canPage ? (
            // older messages load when the owner scrolls up to here (or taps)
            <p className="mb-2 text-center text-xs text-muted-foreground">
              <button type="button" className="rounded px-2 py-1 underline hover:bg-accent disabled:no-underline" disabled={loadingOlder || olderSlow} onClick={() => void loadOlder()} data-testid="chat-older">
                {olderSlow ? OLDER_SLOW : loadingOlder ? "Loading older messages…" : "Show older messages"}
              </button>
              {olderError && <span className="block text-destructive">Could not load them: {olderError}</span>}
            </p>
          ) : (
            hasEarlier && <p className="mb-2 text-center text-xs text-muted-foreground">{chat.customer ? "Older messages are not shown here." : `Older messages are in the ${short}'s T3 thread.`}</p>
          )}
          <ol className="grid min-w-0 gap-3 pb-4" aria-label={`Chat with the ${who}`} data-testid="chat-transcript">
            {!shown.length && !chat.working && !outbox.length && !chat.queued?.length && !chat.undelivered?.length && (
              // never a blank panel: say whether the chat is still loading or simply has nothing yet
              <li role="status" className="py-6 text-center text-sm text-muted-foreground" data-testid="chat-empty">
                {chat.stale || chat.unreachable || chat.t3 ? CHAT_EMPTY.loading : CHAT_EMPTY.empty}
              </li>
            )}
            {notesAt.get("")?.map(undeliveredBubble)}
            {foldChat(shown).map((it) =>
              it.kind === "message" ? (
                <Fragment key={it.m.id}>
                  <Bubble m={it.m} threadUrl={threadUrl} customer={chat.customer} voiceReply={voiceReplies.get(it.m.id)} />
                  {notesAt.get(it.m.id)?.map(undeliveredBubble)}
                </Fragment>
              ) : (
                <Fragment key={it.id}>
                  {it.kind === "console" ? <ConsoleFold lines={it.lines} /> : <StepsFold msgs={it.msgs} />}
                  {(it.kind === "console" ? it.lines : it.msgs).flatMap((m) => notesAt.get(m.id) ?? []).map(undeliveredBubble)}
                </Fragment>
              ),
            )}
            {chat.undelivered?.map((m) => <UndeliveredMessage key={m.id} m={m} />)}
            {chat.queued?.map((q) => (
              <li key={q.id} className="flex justify-end" data-testid="chat-queued">
                <div className="min-w-0 max-w-[92%] rounded-lg bg-primary/70 px-3 py-2 text-sm text-primary-foreground sm:max-w-[85%]">
                  {q.page && <p className="mb-1 text-[11px] opacity-80 [overflow-wrap:anywhere]">about: {q.page}</p>}
                  <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{splitAttachments(q.text).text}</p>
                  <SentFiles files={splitAttachments(q.text).files} />
                  {/* the console holds it (it sends it by itself), so it is Sent, no spinner */}
                  <p className="mt-1 flex items-center gap-1 text-[11px] opacity-80" data-testid="chat-queued-state">
                    {chat.customer ? CUSTOMER_QUEUED_NOTE : QUEUED_NOTE}
                  </p>
                </div>
              </li>
            ))}
            {outbox.map((o) => (
              <li key={o.crid} className="flex justify-end" data-testid={o.state === "failed" ? "chat-failed" : "chat-posting"}>
                <div className={cn("min-w-0 max-w-[92%] rounded-lg px-3 py-2 text-sm sm:max-w-[85%]", o.state === "failed" ? "border border-destructive bg-primary/60 text-primary-foreground" : "bg-primary/70 text-primary-foreground")}>
                  {o.page && <p className="mb-1 text-[11px] opacity-80 [overflow-wrap:anywhere]">about: {o.page}</p>}
                  {o.text && <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{o.text}</p>}
                  {o.state === "failed" ? (
                    <div className="mt-1.5 rounded bg-background px-2 py-1.5 text-xs text-destructive" role="alert" data-testid="chat-failed-error">
                      Not sent: {o.error}
                      <span className="mt-1 flex gap-2">
                        <Button size="sm" variant="outline" className={cn(PHONE_TAP, "h-8")} onClick={() => retry(o.crid)} data-testid="chat-retry">
                          Retry
                        </Button>
                        <Button size="sm" variant="ghost" className={cn(PHONE_TAP, "h-8 text-muted-foreground")} onClick={() => unsend(o.crid)} data-testid="chat-unsend">
                          Edit
                        </Button>
                      </span>
                    </div>
                  ) : (
                    // the owner 25 Nov (vn_083b0ef7, replaces E948-S174's spin-until-the-desk-holds-it for the chat): "Why can't the
                    // console get the message at once? And then say to the front end, I got the message. Go away." It spins only
                    // until the console has it; a later failure comes back on this bubble (sendError) or as "Not delivered".
                    <p className="mt-1 flex items-center gap-1 text-[11px] opacity-80" data-testid="chat-posting-state">
                      {o.state === "sent" ? (
                        SENT_NOTE
                      ) : (
                        <>
                          <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
                          {o.ids?.length ? `Sending with ${o.ids.length} file${o.ids.length > 1 ? "s" : ""}…` : "Sending…"}
                        </>
                      )}
                    </p>
                  )}
                </div>
              </li>
            ))}
            {voicePosting && <PostingBubble p={voicePosting} />}
            {chat.working && <WorkingLine who={who} since={chat.workingSince} />}
            {live}
          </ol>
          </div>
          <div
            className={cn(panel ? "relative shrink-0 pt-2" : "sticky bottom-0 z-10 -mx-4 border-t bg-background/95 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8")}
            data-testid="chat-dock"
          >
            {away && (
              <button
                type="button"
                onClick={jumpToLatest}
                // a small pill on the history's bottom edge
                className={cn("absolute left-1/2 z-10 inline-flex h-7 -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full border bg-background/95 px-2.5 text-xs shadow-md backdrop-blur hover:bg-accent", panel ? "-top-3.5" : "-top-4")}
                data-testid="chat-jump-latest"
              >
                <ArrowDown className="h-3.5 w-3.5" /> {unseen ? "New messages" : "Latest"}
              </button>
            )}
            <SpeakingBar />
            {chat.sending > 0 && !posting && !outbox.length && (
              <p className="mb-2 text-xs text-amber-700 dark:text-amber-400" role="status" data-testid="chat-sending">
                {chat.sending} message{chat.sending > 1 ? "s" : ""} waiting {chat.customer ? "to send" : "for T3"} (the {short} is busy or compacting; retrying).
              </p>
            )}
            {(sendFailed || (chat.sendError && !outbox.some((o) => o.crid === chat.sendError!.clientRequestId))) && (
              <p className="mb-2 text-xs text-destructive" role="alert" data-testid="chat-send-error">
                Not sent: {sendFailed ?? chat.sendError!.text}
              </p>
            )}
            {hint && (
              <p className="mb-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" data-testid="chat-hint">
                <span className="min-w-0 [overflow-wrap:anywhere]">{hintLabel ?? `About: ${hint}`}</span>
                <button type="button" className="shrink-0 rounded p-1 hover:bg-accent" aria-label="Drop the page hint" onClick={() => clearHint?.()}>
                  <X className="h-3.5 w-3.5" />
                </button>
              </p>
            )}
            <WordsBox
              draftKept={!!draftKey}
              value={text}
              onChange={setText}
              files={files}
              voice={note}
              above={dock}
              rows={panel ? 1 : 2}
              placeholder={placeholder}
              label={`Message to the ${who}`}
              enterKeyHint={touchKeyboard() ? "enter" : "send"}
              onKeyDown={(e) => {
                if (sendsOnKey(e)) {
                  e.preventDefault();
                  void send();
                }
              }}
              send={
                /* Send never spins: his message shows above at once and the box is free for the next one. */
                <Button
                  className={cn(PHONE_TAP, "shrink-0 max-sm:size-11 max-sm:px-0")}
                  disabled={(!text.trim() && !files.ids.length) || !files.ready}
                  aria-label="Send"
                  onClick={() => void send()}
                >
                  <Send /> <span className="max-sm:sr-only">Send</span>
                </Button>
              }
            />
          </div>
        </>
      )}
    </>
  );
}

/**
 * "<who> is working… 3:15": a live timer from the turn's start. The server's start time (T3's run) survives a reload;
 * without one, the time this page first saw the desk working.
 */
function WorkingLine({ who, since }: { who: string; since?: string }) {
  const seen = useRef(Date.now());
  const parsed = since ? Date.parse(since) : NaN;
  const start = Number.isFinite(parsed) ? parsed : seen.current;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <li className="text-sm text-muted-foreground" role="status" data-testid="chat-working">
      {who} is working…{" "}
      <span className="tabular-nums" data-testid="chat-working-elapsed">
        {formatElapsed(now - start)}
      </span>
    </li>
  );
}

/**
 * E942-S173: a run of console lines (relay receipts, held batches, note-touch lists, steps) and the desk's short replies to
 * them, as one quiet folded row: they are not his words and not answers to him. Open it to read each line.
 */
export function ConsoleFold({ lines }: { lines: DeskMessage[] }) {
  const n = lines.filter((m) => m.role === "user").length;
  const last = lines[lines.length - 1];
  const summary = consoleSummary(lines);
  return (
    <li className="min-w-0" data-testid="chat-console-fold">
      <details className="rounded-md border border-dashed px-3 py-1.5 text-xs text-muted-foreground">
        <summary className="cursor-pointer [overflow-wrap:anywhere]">
          <span className="font-medium">Console{n > 1 ? `, ${n} lines` : ""}</span>{summary && <> · {summary}</>} · <RelTime iso={last.at} />
        </summary>
        <ol className="mt-2 grid gap-2">
          {lines.map((m) => (
            <li key={m.id} className="whitespace-pre-wrap [overflow-wrap:anywhere]" data-testid={m.role === "user" ? "chat-console-line" : "chat-console-reply"}>
              <span className="font-medium">{m.role === "user" ? "Console" : "Desk"}:</span> {m.text.trim()}
            </li>
          ))}
        </ol>
      </details>
    </li>
  );
}

/** E942-S173: the desk's short messages before its answer in one turn ("Reading his long note now"), folded above the answer. */
export function StepsFold({ msgs }: { msgs: DeskMessage[] }) {
  return (
    <li className="min-w-0" data-testid="chat-steps-fold">
      <details className="px-1 text-xs text-muted-foreground">
        <summary className="cursor-pointer">{msgs.length === 1 ? "1 working step" : `${msgs.length} working steps`}</summary>
        <ol className="mt-1 grid gap-1 border-l pl-3">
          {msgs.map((m) => (
            <li key={m.id} className="whitespace-pre-wrap [overflow-wrap:anywhere]">
              {m.text.trim()}
            </li>
          ))}
        </ol>
      </details>
    </li>
  );
}

/** what the bubble of a voice note on its way says under it (it spins only until the console has it). */
export const POSTING_TEXT: Record<PostingNote["state"], string> = {
  writing: "Sending…",
  // the console has his audio (safe) or his words (sent): Sent at once; it writes and posts them by itself
  safe: SENT_NOTE,
  sent: SENT_NOTE,
  kept: "Sending · saved on this phone, it goes by itself",
  failed: "not sent yet: Send again below",
};

/** his voice note in the chat from the moment he taps Send, like a typed message's "sending…" bubble. */
function PostingBubble({ p }: { p: PostingNote }) {
  return (
    <li className="flex justify-end" data-testid="chat-voice-posting" data-state={p.state} data-at={p.at}>
      <div className={cn("min-w-0 max-w-[92%] rounded-lg px-3 py-2 text-sm text-primary-foreground sm:max-w-[85%]", p.state === "failed" ? "border border-destructive bg-primary/60" : "bg-primary/70")}>
        <p className="mb-1 flex items-center gap-x-1.5 text-[11px] opacity-90">
          <Mic className="h-3 w-3" aria-hidden /> <span className="font-medium">Voice note</span> · {clockOf(p.seconds)}
        </p>
        {p.words && <p className="whitespace-pre-wrap [overflow-wrap:anywhere]" data-testid="chat-voice-posting-words">{p.words}</p>}
        {/* E948-S174: one spinner until the desk's chat holds the note; its ✓ Sent is the message's own mark there */}
        <p className="mt-1 flex items-center gap-1 text-[11px] opacity-80" data-testid="chat-voice-posting-state">
          {(p.state === "writing" || p.state === "kept") && <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />}{POSTING_TEXT[p.state]}
        </p>
      </div>
    </li>
  );
}

/**
 * the desk's answers to his voice notes: the last finished desk message before his next message, when
 * his message was a voice note. "ready": the newest of them, under a day old, made into a voice note by itself; "tap": older.
 */
export function voiceReplyIds(msgs: DeskMessage[], working: boolean, now = Date.now()): Map<string, "ready" | "tap"> {
  const out = new Map<string, "ready" | "tap">();
  let afterNote = false;
  let answer: DeskMessage | undefined;
  const close = () => {
    if (afterNote && answer) out.set(answer.id, "tap");
  };
  for (const m of msgs) {
    if (m.kind === "seed") continue;
    if (m.role === "user" && m.from !== "console") {
      close();
      afterNote = !!parseVoiceNote(m.text);
      answer = undefined;
    } else if (m.role === "assistant" && m.status === "completed" && m.text.trim()) answer = m;
  }
  if (!working) close();
  const newest = [...out.keys()].at(-1);
  const at = newest ? msgs.find((m) => m.id === newest)?.at : undefined;
  if (newest && at && now - Date.parse(at) < 24 * 3_600_000) out.set(newest, "ready");
  return out;
}

function Bubble({ m, threadUrl, customer, voiceReply }: { m: DeskMessage; threadUrl: (id: string) => string; customer?: boolean; voiceReply?: "ready" | "tap" }) {
  if (m.kind === "seed")
    return (
      <li className="flex items-center gap-3 text-[11px] uppercase tracking-wider text-muted-foreground" data-testid="chat-divider">
        <span className="h-px flex-1 bg-border" />
        <span className={cn("text-center", m.note && "normal-case tracking-normal")}>{m.note ?? ((m.session ?? 1) > 1 ? "New session: the earlier chat was gone" : "Chat started")}</span>
        <span className="h-px flex-1 bg-border" />
      </li>
    );
  // words the console or his other desk passed in are not his own message: shown apart, on the desk's side.
  const passed = m.role === "user" ? passedHead(m.text) : undefined;
  if (passed) return <PassedBubble p={passed} at={m.at} />;
  // the desk's own "Passed to the EpicTeam desk: … (link)" line shows as passed on, with where it went
  const passedOn = m.role === "assistant" ? passedReply(m.text) : undefined;
  if (passedOn)
    return (
      <>
        <PassedBubble p={passedOn.p} at={m.at} />
        {passedOn.rest && <Bubble m={{ ...m, text: passedOn.rest }} threadUrl={threadUrl} customer={customer} />}
      </>
    );
  const mine = m.role === "user";
  // his files come back from the console's block under his words
  const sent = mine ? splitAttachments(m.text) : { text: m.text, files: [] };
  const call = callHead(sent.text);
  return (
    <li className={cn("flex", mine ? "justify-end" : "justify-start")} data-testid={mine ? "chat-user" : "chat-assistant"}>
      <div className={cn("min-w-0 max-w-[92%] rounded-lg px-3 py-2 text-sm sm:max-w-[85%]", mine ? "bg-primary text-primary-foreground" : "border bg-card")}>
        {/* what the message is about as a small chip (a phone for a voice call), not "about: …". */}
        {m.page && (
          <span className="mb-1.5 inline-flex max-w-full items-center gap-1.5 rounded-full border bg-background px-2 py-px text-xs font-medium text-muted-foreground [overflow-wrap:anywhere]" data-testid="chat-page-chip">
            {/voice call/i.test(m.page) && <Phone className="h-3 w-3 shrink-0" aria-hidden />}
            {m.page.charAt(0).toUpperCase() + m.page.slice(1)}
          </span>
        )}
        {m.since && (
          <details className="mb-1 text-[11px] opacity-80" data-testid="chat-since-chip">
            <summary className="cursor-pointer">updates sent along</summary>
            <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{m.since}</p>
          </details>
        )}
        {call && <span className="block font-semibold" data-testid="chat-call-head">{call.head}</span>}
        {mine ? (call?.rest ?? sent.text) && <VoiceNoteBody text={call?.rest ?? sent.text} /> : <ChatMarkdown text={call?.rest ?? m.text} threadUrl={threadUrl} />}
        <SentFiles files={sent.files} />
        <p className={cn("mt-1 text-[11px]", mine ? "opacity-80" : "text-muted-foreground")}>
          {m.status !== "completed" && "writing… "}
          {mine && <span data-testid="chat-sent-mark">{SENT_MARK} · </span>}
          <RelTime iso={m.at} />
          {m.truncated && (customer ? " · cut short" : " · cut short, full text in T3")}
        </p>
        {!mine && voiceReply && !customer && <ReplyVoiceNote text={call?.rest ?? m.text} ready={voiceReply === "ready"} />}
        {!mine && m.status === "completed" && m.text.trim() && <ReplyPlay id={m.id} text={call?.rest ?? m.text} />}
        {mine && <TicketLine m={m} />}
      </div>
    </li>
  );
}

/**
 * Where his words went, in his words (the owner, 22 Nov: "I've read this several times and I don't know what you're
 * talking about"): under each message of his, the task it went to by its plain name and where it stands, linked to his inbox
 * when its card waits there, or "Not picked up yet". No row codes, no "ticket" or "request".
 */
type Row = NonNullable<DeskMessage["rows"]>[number];
export function plainStatus(status?: string): string | undefined {
  const s = (status ?? "").toLowerCase();
  if (!s) return undefined;
  if (s === "review") return "in your inbox";
  if (/^(ready|draft)/.test(s)) return "queued";
  if (/^(doing|active|in[ _-]?progress|claimed|rework)/.test(s)) return "being worked on";
  if (s === "blocked") return "waiting on an answer";
  if (s === "monitoring") return "being watched";
  if (/^(done|closed|approved)/.test(s)) return "done";
  if (s === "parked") return "parked";
  if (/^(superseded|folded)/.test(s)) return "merged into another task";
  return undefined;
}
const rowName = (r: Row) => r.title || "a task";
export function ticketLine(rows: DeskMessage["rows"]): string | undefined {
  if (!rows) return undefined;
  if (!rows.length) return "Not picked up yet";
  const first = rows[0];
  const st = plainStatus(first.status);
  const head = `Your words went to: ${rowName(first)}${st ? ` (${st})` : ""}`;
  return rows.length === 1 ? head : `${head}, and ${rows.length - 1} more`;
}

function TicketLine({ m }: { m: DeskMessage }) {
  const line = ticketLine(m.rows);
  if (!line || !m.request) return null;
  const first = m.rows?.[0];
  const routed = useInRouterContext();
  const toInbox = first?.status?.toLowerCase() === "review";
  return (
    <p className="mt-0.5 text-xs opacity-90 [overflow-wrap:anywhere]" data-testid="chat-ticket-line" data-state={!m.rows?.length ? "none" : m.rows.length === 1 ? "one" : "many"} data-request={m.request}>
      {toInbox ? (
        routed ? (
          <Link to={`/${INBOX_PATH}`} className="underline underline-offset-2">
            {line}
          </Link>
        ) : (
          <a href={`/${INBOX_PATH}`} className="underline underline-offset-2">
            {line}
          </a>
        )
      ) : (
        line
      )}
    </p>
  );
}

/**
 * the chat's freshness: when it shows a copy that is not the newest (the console not reached yet, or no fresh answer for a
 * minute) one quiet line says from when; the Refresh beside it is always there and always reads fresh.
 */
function ChatFreshLine({ text, refreshing, onRefresh }: { text?: string; refreshing: boolean; onRefresh: () => void }) {
  return (
    <div className="mb-1 flex min-h-6 shrink-0 items-center gap-2 text-xs text-muted-foreground" data-testid="chat-fresh">
      <span role="status" aria-live="polite" className="min-w-0 flex-1" data-testid="chat-fresh-text">
        {text ?? ""}
      </span>
      <button
        type="button"
        className={cn(PHONE_TAP, "inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 hover:bg-accent disabled:opacity-60")}
        onClick={onRefresh}
        disabled={refreshing}
        aria-label="Refresh the chat"
        data-testid="chat-refresh"
      >
        <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} /> {refreshing ? "Refreshing" : "Refresh"}
      </button>
    </div>
  );
}
