import { useEffect, useState, type ReactNode } from "react";
import { CalendarClock, Check, ExternalLink, MessageSquare, Pencil, RotateCcw, Send, ThumbsDown, ThumbsUp, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { AnswerTextarea, ErrorBox, Loading, PageHeader, PHONE_TAP } from "@/components/common";
import { useChatAttach, wordsWithFiles } from "@/components/ChatAttach";
import { WordsBox } from "@/components/WordsBox";
import type { SocialData, SocialWriteAction, SocialWriteResult } from "@/api/types";
import { shortTo, useAnswerVoice } from "@/voice/AnswerVoice";
import { paragraphs, slotShort } from "@/lib/postBasics";
import { api } from "@/api";
import { useQuery } from "@/lib/data";
import { editable, isLive, noFreeSlot, postNowPending, postNowState, pullable, restorable, revisePending, slotPassed, withTheWriter, type Post, type PostStatus } from "@/lib/social";
import type { WriteNote } from "@/lib/useSocialWrite";

/**
 * the ready draft's button is Schedule ("not posted, that's ambiguous"; it was Post
 * it, briefly Mark ready); Change it is Give feedback (typed or spoken); a scheduled post has Post now (asks once).
 * pieces every social screen shares: header, write outcome, post status, post controls. A held post
 * (waiting for you) is posted (Post it), sent back for a new version (Change it: the Writer redrafts it and it comes back
 * to you; or, as an option inside it, approved with feedback: the Writer applies it and it goes out), not posted (Don't
 * post, with Undo) or rewritten by you (Rewrite it myself: your text replaces the post word for word).
 */

export type Write = (w: SocialWriteAction) => Promise<SocialWriteResult | undefined>;

const STATUS_BADGE: Record<PostStatus, { label: string; variant: "amber" | "green" | "blue" | "red" | "gray" | "violet" }> = {
  idea: { label: "idea", variant: "gray" },
  draft: { label: "draft", variant: "amber" },
  scheduled: { label: "scheduled", variant: "green" },
  posted: { label: "posted", variant: "blue" },
  measured: { label: "measured", variant: "blue" },
  held: { label: "held", variant: "violet" },
  pulled: { label: "pulled", variant: "red" },
  expired: { label: "expired", variant: "gray" },
  other: { label: "", variant: "gray" },
};

export function PostBadge({ p }: { p: Pick<Post, "status" | "statusText"> }) {
  const b = STATUS_BADGE[p.status];
  return <Badge variant={b.variant}>{b.label || p.statusText}</Badge>;
}

import { dayLabel, slotLabel } from "@/lib/dayLabel";
export { dayLabel, slotLabel };

export function OutLink({ href, children = "live" }: { href?: string | null; children?: ReactNode }) {
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline">
      {children} <ExternalLink className="h-3 w-3" />
    </a>
  );
}

/** Title, data source line, load / error state and the export's warnings. Children render once data is in. */
export function SocialScreen({ title, intro, social, error, children }: { title: string; intro: ReactNode; social?: SocialData; error?: Error; children: (s: SocialData) => ReactNode }) {
  const warnings = social?.data.warnings ?? [];
  return (
    <>
      <PageHeader
        title={title}
        description={
          <>
            {intro} From {social?.sample ? "sample data (no console server here)" : social?.repo ? `${social.repo} (social pack)` : social ? "no social repo in this world" : "…"}.
          </>
        }
      />
      {error && <ErrorBox error={error} />}
      {!social && !error && <Loading />}
      {warnings.length > 0 && (
        <details className="mb-3 text-xs text-muted-foreground" data-testid="social-warnings">
          <summary>
            {warnings.length} data warning{warnings.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-1 grid gap-0.5">
            {warnings.map((x, i) => (
              <li key={i}>
                {x.file}
                {x.line ? `:${x.line}` : ""}: {x.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      {social && children(social)}
    </>
  );
}

/** What the last click did (sticks until the next one). */
export function WriteNoteLine({ note, inline }: { note?: WriteNote; inline?: boolean }) {
  if (!note) return null;
  return (
    <div
      role="status"
      data-testid="write-note"
      className={cn(inline ? "mt-1 px-2 py-1.5 text-xs" : "mb-3 px-3 py-2 text-sm", "rounded-md border", note.ok ? "border-emerald-500/30 bg-emerald-500/10" : "border-destructive/40 bg-destructive/10 text-destructive")}
    >
      {note.text}
      {note.ok && note.undo && (
        <Button size="sm" variant="outline" className="ml-2 h-7" onClick={() => note.undo!.run()} data-testid="write-undo">
          <RotateCcw /> {note.undo.label}
        </Button>
      )}
      {!note.ok && note.issues && (
        <ul className="mt-1 list-disc pl-5 text-xs">
          {note.issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** the result of a click, right under the control it came from (only when the note is that control's). */
export function ScopedNote({ note, scope }: { note?: WriteNote; scope: string }) {
  return note?.scope === scope ? <WriteNoteLine note={note} inline /> : null;
}

/**
 * The post controls. A held post (the owner's words): Post it · Change it (what should change? the Writer makes a new
 * version and it comes back here for review; the option "post it after this change without showing me again" is approve
 * with feedback) · Don't post (one-line confirm; Undo after) · Rewrite it myself (your text replaces the post word for
 * word). While the Writer works on a new version the buttons give way to "With the Writer: new version coming". Pull on a
 * scheduled or live post asks first and says what it does: on a live post it deletes it (C5). A pulled post that never
 * went out can be put back (to what it was, with its slot). A held post whose slot has passed says so and offers
 * Schedule for the next free slot (named on the button) or Pick a new time (UTC); a held post never has Post now.
 * Post now is on a scheduled post only, and only while it really sends at once (postNowState: the Mac is online).
 */
/** a drop on the Pipeline asks the card to make its own move (`n` changes on each drop). */
export type CardAsk = { move: "schedule" | "post-now"; n: number };
/** Drops already acted on: a card that mounts again (it moved, or it opened for the drop) never repeats one. */
const askedMoves = new Set<number>();
/** True once per drop: the first caller acts on it. */
export const takeAsk = (n: number) => !askedMoves.has(n) && !!askedMoves.add(n);

export function PostActions(props: { p: Post; write: Write; busy?: string; now?: Date; note?: WriteNote; compact?: boolean; ask?: CardAsk }) {
  return (
    <>
      <PostControls {...props} />
      <ScopedNote note={props.note} scope={props.p.id} />
    </>
  );
}

/** the egresses the world's posts go out through (is the Mac online?), read once for every card on the screen, again after 30 s. */
let egressCache: { at: number; p: Promise<{ name: string; state: string }[]> } | undefined;
const egressNow = () => {
  if (!egressCache || Date.now() - egressCache.at > 30_000)
    egressCache = { at: Date.now(), p: Promise.resolve().then(() => api.listEgress(true)).catch(() => [{ name: "laptop", state: "unknown" }]) };
  return egressCache.p;
};
/** the egress read, for the board's drop rules (Post now only while it really sends). */
export const useEgress = () => useQuery(egressNow, []).data;
/** Tests: forget the cached egress read. */
export const resetEgressCache = () => (egressCache = undefined);

/** `compact` (Drafts to approve rows): Post it, Change it, Don't post only; Rewrite it myself lives on the campaign's Pipeline. */
function PostControls({ p, write, busy, now = new Date(), compact, ask }: { p: Post; write: Write; busy?: string; now?: Date; compact?: boolean; ask?: CardAsk }) {
  const [mode, setMode] = useState<"edit" | "pull" | "change" | "dont" | "now" | "slot">();
  const egress = useQuery(egressNow, []);
  const [slot, setSlot] = useState("");
  // the editor shows the ledger's paragraphs as blank lines (the server joins them back with " · ")
  const typed = paragraphs(p.text ?? "").join("\n\n");
  const [text, setText] = useState(typed);
  const [feedback, setFeedback] = useState("");
  const [postAfter, setPostAfter] = useState(false);
  const off = !!busy;
  // a reply in someone else's thread (Kind outreach, held by R4) is the Engager's: it redrafts and sends it.
  const reply = (p.kind ?? "").toLowerCase() === "outreach";
  const who = reply ? "Engager" : "Writer";
  /** this post's action is the one running: its button spins, the rest only wait. */
  const mine = (...a: string[]) => a.some((x) => busy === `posts/${p.id}/${x}`);
  const act = (a: "pull" | "drop" | "restore") => write({ action: `posts/${p.id}/${a}` }).then(() => setMode(undefined));
  const approve = (newSlot?: string) => write({ action: `posts/${p.id}/approve`, body: newSlot ? { slot: newSlot } : {} }).then((r) => r && (setSlot(""), setMode(undefined)));
  // a drop on Scheduled is Schedule (as the button: the next free slot); a drop on Posted asks Post now first.
  useEffect(() => {
    if (!ask || !takeAsk(ask.n)) return;
    if (ask.move === "post-now") setMode("now");
    else void approve(reply ? undefined : p.nextSlot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask?.n]);
  const change = (fb: string) =>
    write(postAfter ? { action: `posts/${p.id}/approve`, body: { feedback: fb } } : { action: `posts/${p.id}/revise`, body: { feedback: fb } }).then(
      (r) => r && (setFeedback(""), setPostAfter(false), setMode(undefined)),
    );
  // the one recorder (useAnswerVoice, as on every card) in place of the browser dictation (Dictate): Send sends the box.
  const voice = useAnswerVoice({
    origin: `post-change:${p.id}`,
    to: shortTo(`What should change in ${p.id}`),
    page: `post ${p.id}: what should change`,
    typed: feedback,
    deliver: (reply) => change(reply).then((r) => {
      if (!r) throw new Error("the change did not go out, open the post to see why");
    }),
    disabled: off,
  });

  if (mode === "change")
    return (
      <div className="grid gap-2 rounded-md border p-2" data-testid="change-it">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="text-sm font-medium" htmlFor={`change-${p.id}`}>
            What should change?
          </label>
          {voice.button}
        </div>
        {voice.strip}
        <AnswerTextarea
          id={`change-${p.id}`}
          aria-label={`What should change in ${p.id}?`}
          placeholder="e.g. shorter, lead with the question, redo the diagram"
          className="min-h-20 w-full rounded-md border bg-background p-2 text-sm"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
        <div className="text-xs text-muted-foreground">
          {postAfter ? `The ${who} applies this, then it goes out${reply ? " inside today's caps" : " at its slot"}. You won't see it again.` : `The ${who} makes a new version and it comes back here for your review. Nothing is ${reply ? "sent" : "posted"}.`}
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={postAfter} onChange={(e) => setPostAfter(e.target.checked)} />
          Post it after this change without showing me again
        </label>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" className={PHONE_TAP} disabled={off || voice.busy || !feedback.trim()} pending={mine("approve", "revise")} pendingLabel={postAfter ? `Sending to the ${who}, then posting…` : `Sending to the ${who}…`} onClick={() => change(feedback.trim())}>
            <Send /> {postAfter ? "Change it, then post it" : `Send to the ${who}`}
          </Button>
          <Button size="sm" variant="ghost" className={PHONE_TAP} onClick={() => (setFeedback(""), setPostAfter(false), setMode(undefined))}>
            Cancel
          </Button>
        </div>
      </div>
    );

  if (mode === "slot")
    return (
      <div className="grid gap-2 rounded-md border p-2" data-testid="pick-time">
        <label className="text-sm font-medium" htmlFor={`slot-${p.id}`}>
          New time (UTC)
        </label>
        <input id={`slot-${p.id}`} type="datetime-local" aria-label={`New time for ${p.id} (UTC)`} className="w-fit rounded-md border bg-background px-2 py-1 text-sm" value={slot} onChange={(e) => setSlot(e.target.value)} />
        <div className="text-xs text-muted-foreground">It moves to Scheduled and goes out at this time.</div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" className={PHONE_TAP} disabled={off || !slot} pending={mine("approve")} pendingLabel="Scheduling…" onClick={() => approve(`${slot.slice(0, 16)}Z`)}>
            <CalendarClock /> Schedule it
          </Button>
          <Button size="sm" variant="ghost" className={PHONE_TAP} onClick={() => (setSlot(""), setMode(undefined))}>
            Cancel
          </Button>
        </div>
      </div>
    );

  if (mode === "edit")
    return (
      <div className="grid gap-2 rounded-md border p-2" data-testid="rewrite-it">
        <div className="text-xs text-muted-foreground">
          <b>What you type here replaces the post text word for word</b>, and that is what goes out. To ask the {who} for changes instead, use Give feedback.
        </div>
        <AnswerTextarea aria-label={`Text of ${p.id}`} className="min-h-24 w-full rounded-md border bg-background p-2 text-sm" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" className={PHONE_TAP} disabled={off || !text.trim() || text === typed} pending={mine("text")} pendingLabel="Saving…" onClick={() => write({ action: `posts/${p.id}/text`, body: { text } }).then((r) => r && setMode(undefined))}>
            Save as the post text
          </Button>
          <Button size="sm" variant="ghost" className={PHONE_TAP} onClick={() => (setText(typed), setMode(undefined))}>
            Cancel
          </Button>
        </div>
      </div>
    );

  if (mode === "dont")
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm" role="alertdialog" aria-label={`Don't post ${p.id}?`}>
        <span>It won't go out. You can undo this.</span>
        <Button size="sm" variant="destructive" className={PHONE_TAP} disabled={off} pending={mine("drop")} pendingLabel="Not posting…" onClick={() => act("drop")}>
          <X /> Don't post it
        </Button>
        <Button size="sm" variant="ghost" className={PHONE_TAP} onClick={() => setMode(undefined)}>
          Keep it
        </Button>
      </div>
    );

  if (mode === "now")
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-sm" role="alertdialog" aria-label={`Post ${p.id} now?`}>
        <span>It goes out on {p.platform || "its platform"} now, not at {slotLabel(p)}.</span>
        <Button size="sm" className={PHONE_TAP} disabled={off} pending={mine("post-now")} pendingLabel="Sending it now…" onClick={() => write({ action: `posts/${p.id}/post-now` }).then((r) => r && setMode(undefined))}>
          <Send /> Post it now
        </Button>
        <Button size="sm" variant="ghost" className={PHONE_TAP} onClick={() => setMode(undefined)}>
          Keep its slot
        </Button>
      </div>
    );

  if (mode === "pull") {
    const live = isLive(p);
    return (
      <div className="grid gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm" role="alertdialog" aria-label={`Pull ${p.id}?`}>
        <div>
          {live ? (
            <>
              <b>This deletes the live post</b> on {p.platform || "its platform"} now: the Publisher wakes and removes it. The row keeps its link, marked pulled.
            </>
          ) : (
            <>Pull stops it going out at its slot; the row is marked pulled.</>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="destructive" className={PHONE_TAP} disabled={off} pending={mine("pull")} pendingLabel={live ? "Deleting live post…" : "Pulling…"} onClick={() => act("pull")}>
            <Trash2 /> {live ? "Delete live post" : "Pull it"}
          </Button>
          <Button size="sm" variant="ghost" className={PHONE_TAP} onClick={() => setMode(undefined)}>
            Keep it
          </Button>
        </div>
      </div>
    );
  }

  const canEdit = editable(p, now);
  const held = p.status === "held";
  const writing = withTheWriter(p);
  const passed = held && !writing && slotPassed(p, now);
  if (restorable(p))
    return (
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" className={PHONE_TAP} disabled={off} pending={mine("restore")} pendingLabel="Putting it back…" onClick={() => act("restore")} title="Back to where it was before, with its slot">
          <RotateCcw /> Put it back
        </Button>
      </div>
    );
  if (!canEdit && !held && !pullable(p)) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {held && writing && (
        <span className="text-xs text-violet-700 dark:text-violet-400" data-testid="new-version-coming">
          With the {who}: {revisePending(p) ? "new version coming" : "applying your change, then it goes out"}
        </span>
      )}
      {passed && (
        <>
          <span className="basis-full text-xs font-medium text-amber-700 dark:text-amber-400" data-testid="slot-passed">
            Its slot ({p.slot!.slice(0, 10)} {p.slot!.slice(11, 16)} UTC) has passed. It is not posted.
            {/* never a time weeks out: with nothing free in the next 3 days he picks one. */}
            {noFreeSlot(p, new Date()) && " Nothing is free in the next 3 days, so pick a time."}
          </span>
          {!noFreeSlot(p, new Date()) && (
            <Button size="sm" className={PHONE_TAP} disabled={off} pending={mine("approve")} pendingLabel="Scheduling…" onClick={() => approve(p.nextSlot)} title="It moves to Scheduled. This is the next free time within the campaign's limits." data-testid="schedule-next">
              <CalendarClock /> {p.nextSlot ? `Schedule for ${slotShort(p.nextSlot)}` : "Schedule"}
            </Button>
          )}
          <Button size="sm" variant={noFreeSlot(p, new Date()) ? "default" : "outline"} className={PHONE_TAP} disabled={off} onClick={() => setMode("slot")} data-testid="pick-time">
            <CalendarClock /> Pick a new time
          </Button>
          <Button size="sm" variant="outline" className={PHONE_TAP} disabled={off} onClick={() => setMode("change")} title={`Typed or spoken: the ${who} makes a new version and it comes back here`}>
            <MessageSquare /> Give feedback
          </Button>
        </>
      )}
      {held && !writing && !passed && (
        <>
          <Button size="sm" className={PHONE_TAP} disabled={off} pending={mine("approve")} pendingLabel={reply ? "Approving…" : "Scheduling…"} onClick={() => approve(reply ? undefined : p.nextSlot)} title={reply ? "The Engager sends it inside today's caps and pacing" : "It moves to Scheduled and goes out at its slot"}>
            <Check /> {reply ? "Approve" : p.nextSlot ? `Schedule for ${slotShort(p.nextSlot)}` : "Schedule"}
          </Button>
          {/* colour goes on the decision (Schedule); Give feedback is secondary. */}
          <Button size="sm" variant="outline" className={PHONE_TAP} disabled={off} onClick={() => setMode("change")} title={`Typed or spoken: the ${who} makes a new version and it comes back here`}>
            <MessageSquare /> Give feedback
          </Button>
        </>
      )}
      {held && (
        <Button size="sm" variant="outline" className={PHONE_TAP} disabled={off} onClick={() => setMode("dont")}>
          <X /> Don't post
        </Button>
      )}
      {canEdit && !writing && !compact && (
        <Button size="sm" variant="outline" className={PHONE_TAP} disabled={off} onClick={() => (setText(typed), setMode("edit"))}>
          <Pencil /> Rewrite it myself
        </Button>
      )}
      {p.status === "scheduled" && !compact && !postNowPending(p) && postNowState(p, egress.data) === "ready" && (
        <Button size="sm" className={PHONE_TAP} disabled={off} onClick={() => setMode("now")} title="Skip the slot: the Publisher posts it at once">
          <Send /> Post now
        </Button>
      )}
      {p.status === "scheduled" && !compact && !postNowPending(p) && postNowState(p, egress.data) === "mac-offline" && (
        <span className="basis-full text-xs text-muted-foreground" data-testid="post-now-off">
          The Mac is not online, so it can't go out right now. It goes out at its slot when the Mac is back online.
        </span>
      )}
      {pullable(p) && (
        <Button size="sm" variant="outline" className={PHONE_TAP} disabled={off} onClick={() => setMode("pull")}>
          <Trash2 /> Pull
        </Button>
      )}
    </div>
  );
}

/** Feedback after the fact: 👍, 👎 or a note, written to the post row and the Feedback log as the owner. */
export function FeedbackBox({ p, write, busy, note, noteOnClick }: { p: Post; write: Write; busy?: string; note?: WriteNote; noteOnClick?: boolean }) {
  const [text, setText] = useState("");
  // in compact rows the note box opens only on that row's Note.
  const [open, setOpen] = useState(!noteOnClick);
  const [which, setWhich] = useState<string>();
  // the note is the one box (paste, paperclip, drop): a screenshot goes with it as a link after his words.
  const files = useChatAttach({ enabled: true, disabled: !!busy });
  const send = async (feedback: string, w: string) => {
    setWhich(w);
    try {
      const withFiles = w === "note" ? (await wordsWithFiles(feedback, files.ids)).trim() : feedback;
      const r = await write({ action: `posts/${p.id}/feedback`, body: { feedback: withFiles } });
      if (r && w === "note") (setText(""), files.clear());
      return r;
    } finally {
      setWhich(undefined);
    }
  };
  const off = !!busy;
  const sending = (w: string) => which === w && busy === `posts/${p.id}/feedback`;
  // the one recorder (useAnswerVoice, as on every card) in place of the browser dictation (Dictate): Send sends the box.
  const voice = useAnswerVoice({
    origin: `post-note:${p.id}`,
    to: shortTo(`Feedback on ${p.id}`),
    page: `post ${p.id}: feedback`,
    typed: text,
    deliver: (reply) => send(reply, "note").then((r) => {
      if (!r) throw new Error("the note did not go out, open the post to see why");
    }),
    disabled: off,
  });
  return (
    <div className="grid gap-1.5">
      {p.feedback && <div className="text-xs text-muted-foreground">You said: {p.feedback}</div>}
      <div className="flex flex-wrap items-start gap-1.5">
        <Button size="icon" variant="outline" aria-label={`Thumbs up ${p.id}`} disabled={off} pending={sending("up")} onClick={() => send("👍", "up")}>
          <ThumbsUp />
        </Button>
        <Button size="icon" variant="outline" aria-label={`Thumbs down ${p.id}`} disabled={off} pending={sending("down")} onClick={() => send("👎", "down")}>
          <ThumbsDown />
        </Button>
        {!open && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid={`note-open-${p.id}`}>
            Note
          </Button>
        )}
        {open && (
          <>
            <WordsBox
              label={`Feedback on ${p.id}`}
              placeholder="A note for the team…"
              rows={1}
              boxClassName="min-h-9"
              className="min-w-40 flex-1"
              value={text}
              onChange={setText}
              files={files}
              voice={voice}
              testid="post-note-box"
              send={
                <Button size="sm" className={cn(PHONE_TAP, "shrink-0")} disabled={off || !files.ready || (!text.trim() && !files.ids.length)} pending={sending("note")} pendingLabel="Sending…" onClick={() => void send(text.trim(), "note")}>
                  <Send /> Send
                </Button>
              }
            />
          </>
        )}
      </div>
      <ScopedNote note={note} scope={`${p.id}#feedback`} />
    </div>
  );
}
