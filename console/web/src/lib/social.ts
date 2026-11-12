import type { Persona, Run, RunOutcome, SocialData, SocialExport, SocialIdea, SocialPost, SocialReport } from "@/api/types";
import { POST_STATES, type PostState } from "@/api/types";
import { ownerName, socialWorld } from "@/lib/identity";

/**
 * the social screens' helpers over the pack export (GET /api/tenants/:id/social, `SocialData`), the one typed
 * source for social data. It replaced the browser-side ledger parsers (lib/posts.ts, lib/weeklyReport.ts): the screens
 * never read Markdown; they read typed export rows. Week math, the weekly report numbers and the
 * screens' lanes and "today" live here.
 */

export type { SocialData, SocialExport, SocialPost };

/** A pack lifecycle state, or "other" (a value off the lifecycle). No approve / reject: there is no gate (C1). */
export type PostStatus = PostState | "other";

/** One export post as the screens show it. */
export interface Post {
  /** The row's id (`P-0001`), else `L<line>` for a ledger row from before ids (stable: rows are only added). */
  id: string;
  date: string;
  persona: string;
  platform: string;
  kind: string | null;
  link?: string;
  title: string;
  /** The post text: the Text cell, else (rows from before the pack) the `Draft: "…"` part of the Title cell; "" if none. */
  text: string;
  status: PostStatus;
  /** The status cell as written (e.g. "left for owner"). */
  statusText: string;
  replies: number;
  result: string;
  /** 1-based line in data/posts-ledger.md (writes by it). */
  line: number;
  /** `YYYY-MM-DD HH:MM` UTC slot, if set. */
  slot?: string;
  community?: string;
  format?: string;
  metrics?: string;
  /** The pack's check line (why a post was held or kept a draft). */
  checks?: string;
  /** the owner's feedback so far (`; `-joined). */
  feedback?: string;
  /** Asset ids (`A-3`) the post carries (its diagram), from the Assets cell. */
  assets?: string[];
  /** Directions highlight it serves (H1), topic it came from, idea it came from. */
  highlight?: string;
  topic?: string;
  idea?: string;
  /** the named campaign it counts toward (epic code); absent = the repo itself. */
  campaign?: string;
  /** its slot has passed: Schedule gives it this next free slot within the caps (the server's, `YYYY-MM-DDTHH:MMZ`). */
  nextSlot?: string;
}

const LEGACY_DRAFT = /^([\s\S]*?)\s*Draft:\s*"([\s\S]*)"\s*$/;
const isState = (s: string): s is PostState => (POST_STATES as readonly string[]).includes(s);

export function toPost(p: SocialPost): Post {
  const titleCell = p.title ?? "";
  const legacy = p.text ? null : LEGACY_DRAFT.exec(titleCell);
  const statusText = p.status ?? "";
  return {
    id: p.id ?? `L${p._line}`,
    date: p.date ?? p.slot?.slice(0, 10) ?? "",
    persona: p.persona ?? "",
    platform: p.platform ?? "",
    kind: p.kind,
    ...(p.link ? { link: p.link } : {}),
    title: legacy ? legacy[1].replace(/[.\s]+$/, "") : titleCell,
    text: p.text ?? legacy?.[2] ?? "",
    status: isState(statusText) ? statusText : "other",
    statusText,
    replies: p.replies ?? 0,
    result: p.result ?? "",
    line: p._line,
    ...(p.assets?.length ? { assets: p.assets } : {}),
    ...opt({ slot: p.slot, community: p.community, format: p.format, metrics: p.metrics, checks: p.checks, feedback: p.feedback, highlight: p.highlight, topic: p.topic, idea: p.idea, campaign: p.campaign ?? null, nextSlot: p.nextSlot ?? null }),
  };
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
/** a post's images (its diagram) as URLs the console serves from the world's repo (`/social/file`), in Assets order. */
export function postImages(s: Pick<SocialData, "tenantId" | "repo" | "data"> | undefined, p: Pick<Post, "assets">): { id: string; url: string }[] {
  if (!s?.repo || !p.assets?.length) return [];
  return p.assets.flatMap((id) => {
    const a = s.data.assets.find((x) => x.id === id);
    if (!a?.file || !IMAGE.test(a.file)) return [];
    const q = `repo=${encodeURIComponent(s.repo!)}&path=${encodeURIComponent(a.file)}`;
    return [{ id, url: `/api/tenants/${encodeURIComponent(s.tenantId)}/social/file?${q}` }];
  });
}

/** The set (non-empty) fields only, so a Post stays free of `undefined` keys. */
const opt = <T extends Record<string, string | null>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v)) as { [K in keyof T]?: string };

/** The export's posts with a date, in ledger order. */
/**
 * DMs are not posts. A DM row left in an old posts ledger (Community `DM u/…` or `DMs`, or one
 * `moved` to the messages ledger) never reaches Drafts to approve, the Pipeline or a post count; DMs show on Messages.
 */
export const isDmRow = (p: Pick<Post, "community" | "statusText">) => /^\s*dms?\b/i.test(p.community ?? "") || p.statusText.toLowerCase() === "moved";
export const postsOf = (d: SocialExport | undefined): Post[] => (d?.posts ?? []).map(toPost).filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date) && !isDmRow(p));

/** A reply or outreach we wrote (vs a post of our own): the Kind cell, else the platform words of older rows. */
export const isReply = (p: Pick<Post, "kind" | "platform">) => (p.kind ? p.kind === "reply" || p.kind === "outreach" : /\b(reply|dm|dms)\b/i.test(p.platform));
/** Live: posted, or posted and measured. */
export const isLive = (p: Pick<Post, "status">) => p.status === "posted" || p.status === "measured";

// ----: no approval gate (C1).'s browser-only approve / reject is gone; its stored decisions are dropped. ----

/** Where kept this browser's approve / reject decisions; removes the key on the social screens' first read. */
export const LEGACY_DECISIONS_KEY = "e24s5:post-decisions:v1";
export function forgetLegacyDecisions(storage: Pick<Storage, "removeItem"> | undefined = globalThis.localStorage) {
  try {
    storage?.removeItem(LEGACY_DECISIONS_KEY);
  } catch {
    // private mode: nothing was stored
  }
}

// ---- screens: Pipeline lanes, Home's today ----

/** The slot as a sortable UTC string (`YYYY-MM-DD HH:MM`), else the date. */
export const slotOf = (p: Pick<Post, "slot" | "date">) => (p.slot ?? p.date).replace("T", " ").slice(0, 16);
/** Text can still change: not live, not gone, and its slot (if any) not passed. */
export const editable = (p: Pick<Post, "status" | "slot" | "date">, now: Date) =>
  (p.status === "idea" || p.status === "draft" || p.status === "scheduled" || p.status === "held") && (!p.slot || slotOf(p) > now.toISOString().replace("T", " ").slice(0, 16));
/** Pull is offered on what is going out or is out: live posts (C5: deletes the live post) and scheduled ones. */
/** the campaign holds every post for the owner's approval (its hold rule `Kind: post`). */
/**
 * with `campaign` (its code, null = the repo level), that campaign's own switch: on when the repo-wide rule or its
 * own rule `Kind: post, Campaign: <code>` (`none` for the repo level) holds its posts (server: social/forceReview.ts).
 */
export const approvesEveryPost = (d: SocialExport | undefined, campaign?: string | null) =>
  (d?.brief.hold_rules ?? []).some((r) => {
    if (/^\s*kind\s*[:=]\s*post\s*$/i.test(r.match ?? "")) return true;
    const own = /^\s*kind\s*[:=]\s*post\s*,\s*campaign\s*[:=]\s*([^,]+?)\s*$/i.exec(r.match ?? "")?.[1].toLowerCase();
    return campaign !== undefined && own !== undefined && own === (campaign?.trim().toLowerCase() || "none");
  });
/** The newest `<word> YYYY-MM-DD HH:MM` stamp in a cell ("" when none); stamps compare as strings. */
const lastStamp = (cell: string | null | undefined, re: RegExp) => [...(cell ?? "").matchAll(re)].reduce((m, x) => (x[1] > m ? x[1] : m), "");
const REVISE_ASKED = /revise requested (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/gi;
const REVISED = /\brevised (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/gi;
type Review = Pick<Post, "status" | "feedback" | "checks">;
/**
 * the owner asked for a new version (`Revise requested <when>: …` in Feedback) and the Writer has not
 * answered it yet (its `Revised <when>` at the start of Checks, pack rule revise_requested, is older or missing).
 */
export const revisePending = (p: Review) => {
  if (p.status !== "held") return false;
  const asked = lastStamp(p.feedback, REVISE_ASKED);
  return !!asked && asked > lastStamp(p.checks, REVISED);
};
/** the Writer's new version is back for review: its `Revised <when>` stamp, else undefined. */
export const revisedAt = (p: Review) => (p.status === "held" && !revisePending(p) && lastStamp(p.feedback, REVISE_ASKED) ? lastStamp(p.checks, REVISED) || undefined : undefined);
/** what the owner asked for in his last Change it ("" when none). */
export const lastReviseAsk = (p: Pick<Post, "feedback">) => {
  const f = p.feedback ?? "";
  const i = f.toLowerCase().lastIndexOf("revise requested ");
  if (i < 0) return "";
  return f.slice(i).replace(/^revise requested \d{4}-\d{2}-\d{2} \d{2}:\d{2}(?: UTC)?:\s*/i, "").split(/;\s*(?=approved\b)/i)[0].trim();
};
/** a held post the owner approved with feedback (the Writer applies it, then schedules it). */
export const approvedWithFeedback = (p: Pick<Post, "status" | "feedback">) => p.status === "held" && /approved with feedback/i.test(p.feedback ?? "");
/** A held post the Writer is working on: approved with feedback or a new version on its way. */
export const withTheWriter = (p: Review) => approvedWithFeedback(p) || revisePending(p);
/** a pulled post that never went out can be put back for review (Undo of Don't post). */
export const restorable = (p: Pick<Post, "status" | "link">) => p.status === "pulled" && !p.link;

/** A ledger slot (`2026-11-03 14:00`, ISO with or without Z) as UTC ms: a bare `YYYY-MM-DD HH:MM` is UTC, never the browser's time zone. */
export const slotTime = (slot: string) => Date.parse(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(slot.trim()) ? `${slot.trim().replace(" ", "T")}Z` : slot);
/**
 * a held post whose slot has passed (e.g. back from an Undo after it), never a silent hold. Its card
 * offers Schedule for the next free slot (`nextSlot`) and Pick a new time, never Post now.
 */
export const slotPassed = (p: Pick<Post, "status" | "slot">, now: Date) => p.status === "held" && !!p.slot && slotTime(p.slot) <= now.getTime();

/**
 * Post now is shown only when it really
 * sends at once. Reddit and X go out through the owner's Mac (the Team Browser's `laptop` egress): while it is not online,
 * Post now would only queue it, so the card says it goes out when the Mac is back. `checking`: not known yet.
 */
export function postNowState(p: Pick<Post, "platform">, egresses: { name: string; state: string }[] | undefined): "ready" | "mac-offline" | "checking" {
  if (!/reddit|^x$|twitter/i.test((p.platform ?? "").trim())) return "ready";
  if (!egresses) return "checking";
  const mac = egresses.find((e) => e.name === "laptop");
  return !mac || mac.state === "online" ? "ready" : "mac-offline";
}
/**
 * the slot a scheduled post had before the console moved it (it missed that slot while the laptop was offline;
 * the console's `Moved <when> UTC from <old slot>` note in Feedback), `YYYY-MM-DD HH:MM` UTC; undefined when never moved.
 */
export function movedFrom(p: Pick<Post, "feedback">): string | undefined {
  return [...(p.feedback ?? "").matchAll(/\bMoved \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC from (\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2})/g)].pop()?.[1].replace("T", " ");
}
/** a held post whose slot has passed with no free time in the next 3 days to offer: he picks one. */
export const noFreeSlot = (p: Pick<Post, "status" | "slot" | "kind" | "nextSlot">, now: Date) => slotPassed(p, now) && !p.nextSlot && (p.kind ?? "").toLowerCase() !== "outreach";

/** the owner pressed Post now on a scheduled post (his `Post now <when>` note) and it is not live yet: it is being sent. */
export const postNowPending = (p: Pick<Post, "status" | "feedback">) => p.status === "scheduled" && /\bpost now \d{4}-\d{2}-\d{2} \d{2}:\d{2}/i.test(p.feedback ?? "");

export const pullable = (p: Pick<Post, "status">) => p.status === "scheduled" || isLive(p);

export type LaneId = "idea" | "draft" | "held" | "scheduled" | "posted" | "measured";
export const LANES: { id: LaneId; label: string }[] = [
  { id: "idea", label: "Ideas" },
  { id: "draft", label: "Drafts" },
  { id: "held", label: "Waiting for you" },
  { id: "scheduled", label: "Approved · scheduled" },
  { id: "posted", label: "Posted" },
  { id: "measured", label: "Measured" },
];

/** One card on the Pipeline: a post row, or an idea from ideas.md not yet drafted. */
export type LaneItem = { kind: "post"; post: Post } | { kind: "idea"; idea: SocialIdea };
const OPEN_IDEA = new Set(["new", "picked up"]);

/**
 * The Pipeline's lanes: our own posts by status (replies and outreach go out as today and are not on the board),
 * plus open ideas (new, picked up) in the Ideas lane. Scheduled oldest slot first; the rest newest first.
 */
export function pipelineLanes(d: SocialExport | undefined): { lanes: Record<LaneId, LaneItem[]>; replies: number } {
  const lanes: Record<LaneId, LaneItem[]> = { idea: [], draft: [], held: [], scheduled: [], posted: [], measured: [] };
  const posts = postsOf(d);
  for (const idea of d?.ideas ?? []) if (OPEN_IDEA.has(idea.state ?? "")) lanes.idea.push({ kind: "idea", idea });
  for (const p of [...posts].reverse()) if (!isReply(p) && p.status in lanes) lanes[p.status as LaneId].push({ kind: "post", post: p });
  const bySlot = (a: LaneItem, b: LaneItem) => (a.kind === "post" && b.kind === "post" ? slotOf(a.post).localeCompare(slotOf(b.post)) : 0);
  lanes.scheduled.sort(bySlot);
  return { lanes, replies: posts.filter(isReply).length };
}

// ----: the board the owner works on: Ideas, Drafts, Scheduled, Posted (no "Waiting for you": many things wait on him) ----

export type BoardLaneId = "idea" | "draft" | "scheduled" | "posted";
export const BOARD_LANES: { id: BoardLaneId; label: string }[] = [
  { id: "idea", label: "Ideas" },
  { id: "draft", label: "Drafts" },
  { id: "scheduled", label: "Scheduled" },
  { id: "posted", label: "Posted" },
];

/**
 * One card on the board. `working` (the card spins and is not clickable) says what the Writer is doing: drafting an
 * idea (the owner pressed Draft it now, or the Writer picked it up), a draft that is not ready yet, a new version the owner asked
 * for, or his change before it goes out. A held post the Writer is done with is ready: Mark ready.
 */
export type BoardItem = LaneItem & { working?: string };

/** ideas never expire: open until the owner parks one or the Writer marks it spent (or an epic). */
const CLOSED_IDEA = new Set(["parked", "spent", "epic"]);
const isOpenIdea = (i: SocialIdea) => !CLOSED_IDEA.has((i.state ?? "").trim().toLowerCase());

/** the posts an idea became, by platform: the export's `used_on`, else the ledger's Idea cells. */
export function ideaUsedOn(i: SocialIdea, d: SocialExport | undefined): { platform: string; posts: { id: string; status: string }[] }[] {
  const posts = postsOf(d);
  const byId = new Map(posts.filter((p) => p.id).map((p) => [p.id!, p]));
  const used: Record<string, string[]> = i.used_on ?? {};
  if (!i.used_on) for (const p of posts) if (i.id && p.id && (p.idea ?? "").split(/[,\s]+/).includes(i.id)) (used[p.platform || "-"] ??= []).push(p.id);
  const team = [...new Set(posts.filter((p) => !isReply(p)).map((p) => p.platform).filter((x): x is string => !!x))];
  const own = (i.platform ?? "").split(/[,;]|\band\b/).map((s) => s.trim().split(/\s+/)[0].replace(/\s*\(.*$/, "")).filter(Boolean);
  const plats = [...new Set([...own, ...team, ...Object.keys(used)])];
  return plats.map((platform) => ({ platform, posts: (used[platform] ?? []).map((id) => ({ id, status: byId.get(id)?.status ?? "" })) }));
}

/**
 * the board's four columns from one campaign's export. Ideas: open ideas (state `new`) the owner has not sent to the
 * Writer. Drafts: ideas being drafted (`drafting` holds the ids the owner pressed Draft it now on; `picked up` means the
 * Writer took it), draft rows (not ready yet) and held rows (ready for Mark ready, unless the Writer is on a change).
 * Scheduled: by slot, soonest first. Posted: posted and measured, newest first. An idea that became a post shows as the
 * post only. Replies and outreach stay off the board, as before.
 */
export function boardLanes(d: SocialExport | undefined, drafting: ReadonlySet<string> | ReadonlyMap<string, string> = new Set()): { lanes: Record<BoardLaneId, BoardItem[]>; replies: number } {
  const lanes: Record<BoardLaneId, BoardItem[]> = { idea: [], draft: [], scheduled: [], posted: [] };
  const posts = postsOf(d);
  const fromIdea = (id: string) => posts.filter((p) => (p.idea ?? "").split(/[,\s]+/).includes(id)).length;
  // an idea stays on the board after a post (ideas never expire); the owner's Draft it is done once a new post came from it
  // (the pending entry's snap = how many posts it had when he pressed; a plain set = none yet).
  const isDrafting = (id: string) => {
    if (!drafting.has(id)) return false;
    const snap = drafting instanceof Map ? Number(drafting.get(id) || 0) : 0;
    return fromIdea(id) <= snap;
  };
  const ready: BoardItem[] = [];
  const working: BoardItem[] = [];
  for (const idea of [...(d?.ideas ?? [])].reverse()) {
    if (!isOpenIdea(idea)) continue;
    if ((idea.state === "picked up" && !(idea.id && fromIdea(idea.id))) || (idea.id && isDrafting(idea.id))) working.push({ kind: "idea", idea, working: "The Writer is drafting it. It turns into a draft here when it is ready." });
    else lanes.idea.push({ kind: "idea", idea });
  }
  for (const p of [...posts].reverse()) {
    if (isReply(p)) continue;
    if (p.status === "draft") working.push({ kind: "post", post: p, working: p.checks ? `The Writer is still on it (${p.checks}).` : "The Writer is still on it." });
    else if (p.status === "held") {
      if (revisePending(p)) working.push({ kind: "post", post: p, working: `The Writer is making the new version you asked for: ${lastReviseAsk(p)}` });
      else if (approvedWithFeedback(p)) working.push({ kind: "post", post: p, working: `The Writer is applying your change, then it goes to Scheduled${p.feedback ? `: ${p.feedback}` : ""}` });
      else ready.push({ kind: "post", post: p });
    } else if (p.status === "scheduled") lanes.scheduled.push({ kind: "post", post: p, ...(postNowPending(p) ? { working: "Sending it now: the Publisher is posting it. It moves to Posted once it is live." } : {}) });
    else if (isLive(p)) lanes.posted.push({ kind: "post", post: p });
  }
  lanes.draft = [...ready, ...working];
  lanes.scheduled.sort((a, b) => (a.kind === "post" && b.kind === "post" ? slotOf(a.post).localeCompare(slotOf(b.post)) : 0));
  return { lanes, replies: posts.filter(isReply).length };
}

// ----: drag a card to another column: only the moves the pack lets the owner make (the card's own buttons) ----

/** What a drop does: the card's button it stands for, or why it snaps back (one plain line). */
export type BoardMove = { move: "draft" | "schedule" | "post-now" } | { reason: string };

/**
 * a drag makes the same move as the card's own
 * button, and nothing else: an idea → Drafts is Draft it (the Writer drafts it); a ready draft → Scheduled is Schedule
 * (the owner's approve, pack held → scheduled); a scheduled post → Posted is Post now (it asks first, as the button does).
 * Every other drop snaps back with the reason. undefined = the same column (nothing to do).
 */
export function boardMove(item: BoardItem, from: BoardLaneId, to: BoardLaneId, o: { writer: boolean; egress?: { name: string; state: string }[] }): BoardMove | undefined {
  if (from === to) return undefined;
  if (to === "idea") return { reason: "A post can't go back to Ideas." };
  if (from === "posted") return { reason: "It is live. Open it to give feedback or to pull it." };
  if (item.kind === "idea") {
    if (to !== "draft") return { reason: "Drop it on Drafts first: the Writer writes the post." };
    if (item.working) return { reason: "The Writer is already drafting it." };
    if (!item.idea.id) return { reason: "This idea has no Id yet, so the Writer can't take it." };
    if (!o.writer) return { reason: "No Writer works on this campaign, so nobody can draft it." };
    return { move: "draft" };
  }
  const p = item.post;
  if (from === "draft") {
    if (to === "posted") return { reason: "Schedule it first: posts go out from Scheduled." };
    if (p.status !== "held") return { reason: "The Writer is still drafting it." };
    if (item.working || withTheWriter(p)) return { reason: "The Writer is on it. Schedule it when the new version is in." };
    return { move: "schedule" };
  }
  // from Scheduled
  if (to === "draft") return { reason: "A scheduled post can't go back to Drafts. Open it to pull it." };
  if (item.working || postNowPending(p)) return { reason: "It is already on its way out." };
  const state = postNowState(p, o.egress);
  if (state === "mac-offline") return { reason: "The Mac is not online, so it can't go out now. It goes out at its slot." };
  if (state === "checking") return { reason: "Still checking whether it can go out now. Try again in a moment." };
  return { move: "post-now" };
}

/** Posted keeps the last 7 days; older ones fold away. */
export const POSTED_DAYS = 7;
/** When it went out: its slot, else its date (UTC ms). */
const wentOut = (p: Pick<Post, "slot" | "date">) => {
  const t = p.slot ? slotTime(p.slot) : NaN;
  return Number.isNaN(t) ? Date.parse(`${p.date}T23:59:59Z`) : t;
};
/** Did it go out in the last POSTED_DAYS days? A row with no readable time counts as recent (never hidden by mistake). */
export const postedRecently = (p: Pick<Post, "slot" | "date">, now: Date) => {
  const t = wentOut(p);
  return Number.isNaN(t) || now.getTime() - t <= POSTED_DAYS * 86_400_000;
};

/** a live post's numbers, from the ledger's Metrics cell (the Reporter) or a live read. */
export interface PostNumbers {
  impressions?: number;
  likes?: number;
  reposts?: number;
  replies?: number;
  /** Reddit: the post's score (upvotes minus downvotes) and its comments. */
  score?: number;
  comments?: number;
  /** When they were read (`YYYY-MM-DD HH:MM` UTC), if the cell says. */
  readAt?: string;
  /** ledger: the Reporter's Metrics cell; live: the console read the platform just now (X API). */
  source: "ledger" | "live";
}

const num = (s: string, re: RegExp) => {
  const m = re.exec(s);
  return m ? Number(m[1].replace(/,/g, "")) : undefined;
};

/**
 * The Metrics cell as numbers. The Reporter writes it in words, e.g. X: `3 posts: 3 impressions (2/1/0), 0 likes,
 * 0 reposts, 0 external replies at 2026-10-28 20:05 UTC`; Reddit: `score 6, 50 comments (45 read) at …`. Undefined when
 * the cell is empty (not read yet: the Reporter measures 48 h after posting).
 */
export function ledgerNumbers(p: Pick<Post, "metrics" | "replies">): PostNumbers | undefined {
  const m = p.metrics?.trim();
  if (!m) return undefined;
  const n: PostNumbers = {
    source: "ledger",
    impressions: num(m, /(\d[\d,]*)\s+impressions?\b/i),
    likes: num(m, /(\d[\d,]*)\s+likes?\b/i),
    reposts: num(m, /(\d[\d,]*)\s+(?:reposts?|retweets?)\b/i),
    replies: num(m, /(\d[\d,]*)\s+(?:external\s+|direct\s+)?repl(?:y|ies)\b/i),
    score: num(m, /\bscore\s+(-?\d[\d,]*)/i),
    comments: num(m, /(\d[\d,]*)\s+comments?\b/i),
    readAt: /\bat\s+(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2})/i.exec(m)?.[1].replace("T", " "),
  };
  return Object.fromEntries(Object.entries(n).filter(([, v]) => v !== undefined)) as unknown as PostNumbers;
}

export interface Today {
  /** Scheduled posts whose slot is still ahead, soonest first. */
  next: Post[];
  /** Live posts (posted, measured), newest first. */
  live: Post[];
  held: number;
  /** Ideas a writer picked up (state `picked up`), newest first. */
  pickedUp: SocialIdea[];
  /** The newest `data/reports/{date}.md`. */
  digest?: SocialReport;
}

export function today(d: SocialExport | undefined, now: Date): Today {
  const posts = postsOf(d);
  const nowSlot = now.toISOString().replace("T", " ").slice(0, 16);
  const reports = d?.reports ?? [];
  return {
    next: posts.filter((p) => p.status === "scheduled" && slotOf(p) >= nowSlot.slice(0, p.slot ? 16 : 10)).sort((a, b) => slotOf(a).localeCompare(slotOf(b))),
    live: posts.filter(isLive).sort((a, b) => b.date.localeCompare(a.date) || b.line - a.line),
    held: posts.filter((p) => p.status === "held").length,
    pickedUp: (d?.ideas ?? []).filter((i) => i.state === "picked up").reverse(),
    ...(reports.length ? { digest: [...reports].sort((a, b) => a.date.localeCompare(b.date))[reports.length - 1] } : {}),
  };
}

// Week math on calendar dates (YYYY-MM-DD, UTC), Monday first.
const toDay = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => {
  const d = toDay(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
};
export const weekStart = (iso: string) => addDays(iso, -((toDay(iso).getUTCDay() + 6) % 7));

export interface Day<T> {
  date: string;
  posts: T[];
}

/** The seven days (Mon..Sun) of the week starting `start`, each with its posts. */
export function placeByDay<T extends { date: string }>(posts: T[], start: string): Day<T>[] {
  const days = Array.from({ length: 7 }, (_, i) => ({ date: addDays(start, i), posts: [] as T[] }));
  for (const p of posts) days.find((d) => d.date === p.date)?.posts.push(p);
  return days;
}

/** The week to open on: the one holding the newest post, else today's. */
export const initialWeek = (posts: { date: string }[], today: string) => weekStart(posts.reduce((a, p) => (p.date > a ? p.date : a), "") || today);

// ---- weekly report ----

/** Start of "this week": the last 7 days up to `now` (rolling, so a Monday morning report is not empty). */
export const reportFrom = (now: Date) => new Date(now.getTime() - 7 * 24 * 3600 * 1000);

export interface PersonaWeek {
  personaId: string;
  name: string;
  runs: number;
  progressed: number;
  last?: Run;
}

export interface WeeklyReport {
  from: Date;
  to: Date;
  posts: { drafted: number; scheduled: number; published: number; repliesSent: number; repliesReceived: number; waiting: number };
  runs: { total: number; byOutcome: Partial<Record<RunOutcome, number>>; byPersona: PersonaWeek[] };
  /** Newest first: what the listening persona found this week. */
  listening: Run[];
}

/** Persona names that do the listening (a social world repo's Listener; the product deck's Scout). */
const LISTENER = /\b(listener|scout)\b/i;

export function buildWeeklyReport({ runs, personas, posts, now }: { runs: Run[]; personas: Persona[]; posts: Post[]; now: Date }): WeeklyReport {
  const from = reportFrom(now);
  const fromDay = from.toISOString().slice(0, 10);
  const nowDay = now.toISOString().slice(0, 10);
  const weekPosts = posts.filter((p) => p.date >= fromDay && p.date <= nowDay);
  const weekRuns = runs.filter((r) => {
    const t = Date.parse(r.startedAt);
    return t >= from.getTime() && t <= now.getTime();
  });

  const byOutcome: Partial<Record<RunOutcome, number>> = {};
  const per = new Map<string, PersonaWeek>();
  const name = new Map(personas.map((p) => [p.id, p.name]));
  for (const r of weekRuns) {
    byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
    const id = r.personaId ?? "unknown";
    const row = per.get(id) ?? { personaId: id, name: name.get(id) ?? "Unknown", runs: 0, progressed: 0 };
    row.runs += 1;
    if (r.outcome === "progressed") row.progressed += 1;
    if (!row.last || r.startedAt > row.last.startedAt) row.last = r;
    per.set(id, row);
  }

  const listeners = new Set(personas.filter((p) => LISTENER.test(p.name)).map((p) => p.id));
  const listening = weekRuns
    .filter((r) => r.personaId && listeners.has(r.personaId) && r.summary.trim() && r.outcome !== "running")
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 3);

  return {
    from,
    to: now,
    posts: {
      drafted: weekPosts.length,
      scheduled: weekPosts.filter((p) => p.status === "scheduled" || isLive(p)).length,
      published: weekPosts.filter((p) => isLive(p) && !isReply(p)).length,
      repliesSent: weekPosts.filter((p) => isLive(p) && isReply(p)).length,
      repliesReceived: weekPosts.reduce((n, p) => n + p.replies, 0),
      waiting: weekPosts.filter((p) => p.status === "draft" || p.status === "held").length,
    },
    runs: { total: weekRuns.length, byOutcome, byPersona: [...per.values()].sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name)) },
    listening,
  };
}

/** Placeholder until's credit ledger: 1 credit = €0.01 of measured cost (plan §4); founding plan grants 4,000 a month. */
export interface CreditsView {
  balance: number;
  monthlyGrant: number;
  plan: string;
  /** true = not a real balance; the screen says so on its face. */
  mock: true;
}
export const MOCK_CREDITS: CreditsView = { balance: 2750, monthlyGrant: 4000, plan: "founding", mock: true };

// ---- the sample (mock client: local dev and tests) ----

/** An export with every section empty (what the server sends with its warnings when it has nothing to read). */
export function emptySocialExport(repo = "", warnings: SocialExport["warnings"] = []): SocialExport {
  return {
    schemaVersion: 1,
    pack: "social",
    packVersion: 0,
    repo,
    generatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    warnings,
    brief: { objective: null, targets: null, audience: null, key_messages: [], voice: [], style_rules: [], never_say: [], topic_weights: [], feedback_log: [], formats: [], examples: [], hold_rules: [] },
    directions: { week: [], do_dont: [], voice_note: null, month: [] },
    topics: [],
    ideas: [],
    posts: [],
    messages: { chats: [], messages: [] },
    assets: [],
    reports: [],
    sources: {},
  };
}

/** Sample export in the pack's shape; post dates fall in the 7 days before `now`, so it reads as "this week". */
export function sampleSocialExport(now: Date = new Date()): SocialExport {
  const day = (back: number) => new Date(now.getTime() - back * 24 * 3600 * 1000).toISOString().slice(0, 10);
  let line = 4;
  const post = (p: Partial<SocialPost>): SocialPost => ({
    id: null, date: null, persona: null, kind: null, platform: null, community: null, slot: null, title: null, text: null, format: null, assets: [], topic: null,
    highlight: null, messages: [], idea: null, checks: null, link: null, replies: null, metrics: null, result: null, feedback: null, status: null,
    _line: ++line,
    ...p,
  });
  const d = emptySocialExport(`/sample/${socialWorld()}`);
  d.packVersion = 1;
  d.brief.objective = "Memo becomes a known voice in the AI memory space (sample).";
  d.posts = [
    post({ id: "P-0001", date: day(5), persona: "Writer", kind: "post", platform: "X", title: "Memory as files you own", text: "Your agent's memory should be files you own.", link: "https://x.com/example/status/1", replies: 2, result: "posted 10:03 UTC", status: "posted" }),
    post({ id: "P-0002", date: day(5), persona: "Writer", kind: "post", platform: "Reddit", community: "r/ContextEngineering", title: "I built a librarian for my personal context", link: "https://www.reddit.com/r/example/comments/1/", replies: 5, result: "posted 16:20 UTC", status: "measured" }),
    post({ id: "P-0003", date: day(2), persona: "Responder", kind: "reply", platform: "Reddit", title: "Reply to a tester asking how to start", text: "Plain Markdown in a git repo you own. Happy to help you set it up.", link: "https://www.reddit.com/r/example/comments/1/c1/", replies: 1, status: "posted" }),
    post({ id: "P-0004", date: day(1), persona: "Responder", kind: "reply", platform: "Reddit (DM)", title: "Chat request from u/carol", status: "draft", result: "no draft yet" }),
    post({ id: "P-0005", date: day(1), persona: "Engager", kind: "outreach", platform: "X", title: "Reply to @bob on agent memory", text: "Every memory a commit, so git log is the audit trail.", link: "https://x.com/example/status/2", status: "draft" }),
    post({ id: "P-0006", date: day(0), persona: "Writer", kind: "post", platform: "LinkedIn", slot: `${day(0)} 18:00`, title: "Why plain files beat a vector store", text: "Why plain files beat a vector store.", status: "scheduled", highlight: "H1" }),
    post({ id: "P-0007", date: day(0), persona: "Writer", kind: "post", platform: "X", slot: `${day(-1)} 14:00`, title: "ai-memory has 12.6k stars: what we do differently", text: "ai-memory has 12.6k stars. Here is what we do differently.", status: "held", checks: "hold rule R1: number claim" }),
  ];
  d.ideas = [
    { id: "I-1", date: day(1), idea: "How git log saved me from a bad memory", format: "text", platform: "Reddit", from: ownerName(), link: null, state: "new", why: null, became: [], _line: 5 },
    { id: "I-2", date: day(3), idea: "Keep AGENTS.md lean; put the why in memory", format: "text", platform: "X", from: "Creative", link: null, state: "picked up", why: null, became: [], _line: 6 },
  ];
  d.topics = [
    { rank: 1, id: "T-1", topic: "When a session ends, what state do you keep?", where: "r/AI_Agents", link: "https://www.reddit.com/r/example/comments/2/", heat: 36, date: day(0), reply_target: true, used_by: [], _line: 5 },
    { rank: 2, id: "T-2", topic: "One stale note spreads to every agent", where: "r/ClaudeAI", link: "https://www.reddit.com/r/example/comments/3/", heat: 21, date: day(0), reply_target: false, used_by: ["P-0006"], _line: 6 },
  ];
  d.directions = {
    week: [{ id: "H1", highlight: "git log is your agent's memory", why: "every memory a commit", until: day(-5), served_by: ["P-0006"], _line: 5 }],
    do_dont: [{ kind: "don't", rule: "Mention pricing or a waitlist", until: day(-3), _line: 9 }],
    voice_note: "Sound like a builder talking to builders. Short. No hype words.",
    month: [{ id: "M1", priority: "Push the EpicSpine angle: durable state across sessions", why: null, month: day(0).slice(0, 7), served_by: [], _line: 14 }],
  };
  d.reports = [{ date: day(1), path: `data/reports/${day(1)}.md`, numbers: "3 posts, 8 replies", best_worst: null, learned: "Questions beat announcements.", highlights: null, feedback: null, cost: null }];
  return d;
}

/** The mock client's answer for any world: the sample, marked. */
export const sampleSocialData = (tenantId: string, now?: Date): SocialData => ({ tenantId, repo: socialWorld(), data: sampleSocialExport(now), sample: true });
