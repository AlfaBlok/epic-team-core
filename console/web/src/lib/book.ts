import type { Book, BookEpic, BookMade, BookRepo, BookState, CapabilityCell, CapabilityPlain, CapabilityState, CapabilityTable, MilestoneBook, PlainWord } from "@/api/types";
import { ownerName, homeRepo, sites } from "@/lib/identity";

/** helpers for the Epic Book page (pages/Book.tsx). */

export const BOOK_PATH = "book";

/**'s page: every open question from the owner's 2026-10-28 voice note (ask). */
export const questionsUrl = (): string => sites().bookQuestionsUrl;

export type BookFilter = "open" | "stuck" | "moving" | "all";
export const FILTERS: { id: BookFilter; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "stuck", label: "Stuck" },
  { id: "moving", label: "Moving" },
  { id: "all", label: "Everything" },
];

export const STATE_LABEL: Record<BookState, string> = { moving: "moving", stuck: "stuck", parked: "parked", done: "done" };
export const STATE_DOT: Record<BookState, string> = {
  moving: "bg-emerald-500",
  stuck: "bg-red-500",
  parked: "bg-zinc-400",
  done: "bg-sky-500",
};

/** capability cell chips. */
export const CAP_STYLE: Record<CapabilityState, string> = {
  works: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  stale: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  gap: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  "n/a": "bg-muted text-muted-foreground",
};

/** every cell and status line reads Works / Partly / Not yet. */
export const PLAIN_LABEL: Record<PlainWord, string> = { works: "Works", partly: "Partly", "not yet": "Not yet", "n/a": "n/a" };
export const PLAIN_STYLE: Record<PlainWord, string> = {
  works: CAP_STYLE.works,
  partly: CAP_STYLE.stale,
  "not yet": CAP_STYLE.gap,
  "n/a": CAP_STYLE["n/a"],
};
const FROM_STATE: Record<CapabilityState, PlainWord> = { works: "works", stale: "partly", gap: "not yet", "n/a": "n/a" };
/** A cell's plain word and text: its own `plain` when the data file has one, else derived from the probe state
 *  (also when the daily probe has since found a "Works" cell failing, so a stale hand-written word never shows green). */
export function plainOf(c: CapabilityCell): CapabilityPlain {
  if (c.plain && !(c.plain.word === "works" && (c.state === "gap" || c.state === "stale"))) return c.plain;
  const fix = c.fix ? ` Fix: ${c.fix}` : "";
  return { word: FROM_STATE[c.state] ?? "n/a", text: c.why ? `${c.why}.${fix}` : c.summary };
}

/** rework: one colour per egress kind (the legend's keys); unknown kinds fall back to muted. */
export const EGRESS_STYLE: Record<string, string> = {
  api: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  server: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  direct: "bg-sky-50 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  laptop: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  proxy: "bg-violet-50 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
  decodo: "bg-violet-50 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
  none: "bg-muted text-muted-foreground",
};

/** A two-service capability table for the mock API and tests. */
export function sampleCapabilities(): CapabilityTable {
  return {
    title: "What the team can do, per service",
    about: "Tested live; writes as dry runs only.",
    scope: "What any seat or persona launched from home_repo can do with the team's infra.",
    egressLegend: { api: "none (API): the service's own API from the server", laptop: `${ownerName()}'s Mac (laptop egress): refused while the Mac is offline` },
    checkedAt: "2026-11-01T15:13:29Z",
    plainStatus: [
      { world: "Your account (home)", platform: "Reddit", word: "partly", text: "Works only while your Mac is online." },
      { world: "Tester worlds", platform: "Reddit", word: "not yet", text: "Needs a residential proxy per world." },
    ],
    states: { works: "tested live and working", gap: "does not work today: why, and what fixes it", "n/a": "the service has no such thing" },
    capabilities: [
      { id: "read", label: "Read" },
      { id: "reply", label: "Reply" },
      { id: "read_dms", label: "Read DMs" },
    ],
    services: [
      {
        id: "x",
        label: "X",
        account: "@MemoAccount",
        egress: { kind: "laptop", label: `${ownerName()}'s Mac (laptop egress)`, offline: "refused, nothing sent", tester: "the tester's own browser, direct from server" },
        cells: {
          read: {
            state: "works",
            summary: "reads the home feed",
            tested: "2026-11-01T15:12:44Z",
            test: "x_home_feed (read)",
            plain: { word: "partly", text: "Mentions work without your Mac; the feed needs your Mac online." },
          },
          reply: {
            state: "works",
            summary: "replies as @MemoAccount",
            tested: "2026-11-01T15:12:58Z",
            test: "x_reply dry run",
            egressSeen: "laptop (MX 189.128.x.x)",
            lastReal: { at: "2026-11-01T14:55:11Z", what: "x_reply", url: "https://x.com/MemoAccount/status/2116906887027261931" },
          },
          read_dms: { state: "gap", summary: "legacy inbox is empty", tested: "2026-11-01T15:13:10Z", test: "x_dm_list (read)", why: "DMs moved to encrypted X Chat", fix: `${ownerName()} enters the X Chat passcode once` },
        },
      },
      {
        id: "youtube",
        label: "YouTube",
        pending: "EPIC-929-A1",
        egress: { kind: "api", label: "none (API)" },
        cells: { read_dms: { state: "n/a", summary: "YouTube removed DMs on 2019-09-18", tested: "2026-11-01T15:09:31Z", test: "social_dms" } },
      },
    ],
    other: [{ id: "memo", label: "Memo memory", what: "search and store team memory", egress: { kind: "server", label: "server-side" } }],
    source: "docs/status/service-capabilities.json",
    href: "https://github.com/Acme/home_repo/blob/main/docs/status/service-capabilities.json",
  };
}

export const isOpen = (s: BookState) => s === "moving" || s === "stuck";

export function shows(filter: BookFilter, e: BookEpic): boolean {
  if (filter === "all") return true;
  if (filter === "open") return isOpen(e.state);
  return e.state === filter;
}

/** The title without its code prefix (": Lanes" → "Lanes"). */
export const titleRest = (e: BookEpic) => e.title.replace(/^\s*(EPIC-\d+|M\d+)\s*[:—–-]\s*/i, "").trim() || e.title;

/** the code repo first, then the repos with the most open epics. */
export function orderRepos(repos: BookRepo[]): BookRepo[] {
  const open = (r: BookRepo) => r.counts.moving + r.counts.stuck;
  return [...repos].sort((a, b) => Number(b.name === homeRepo()) - Number(a.name === homeRepo()) || open(b) - open(a) || a.name.localeCompare(b.name));
}

/** "2026-10-31T22:00:00.000Z" or "2026-10-31" → "31 Oct". */
export const day = (iso: string) => {
  const t = Date.parse(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
};

/** A small book for the mock API and tests. */
export function sampleBook(now = new Date("2026-10-31T23:00:00Z")): Book {
  const epic = (over: Partial<BookEpic> & Pick<BookEpic, "path" | "code" | "title" | "state">): BookEpic => ({
    depth: 1,
    parent: "docs/spines/root.md",
    status: "active",
    goal: null,
    serves: null,
    decisions: [],
    timeline: [],
    timelineTotal: 0,
    next: null,
    lastAttempted: null,
    verifiedAt: null,
    waitingOn: null,
    asks: [],
    dod: { done: 0, total: 0 },
    outcome: null,
    ...over,
  });
  const epics: BookEpic[] = [
    epic({ path: "docs/spines/root.md", code: "root", title: "home_repo", state: "moving", depth: 0, parent: null, goal: `${ownerName()} steers the team from one console.` }),
    epic({
      path: "docs/spines/epic-940-lanes-and-radar.md",
      code: "EPIC-940",
      title: `EPIC-940: Lanes and radar: ${ownerName()} sees his big lanes and what moves each`,
      state: "moving",
      goal: `${ownerName()} opens team.example.com and sees his big lanes, not a flat list.`,
      serves: `home_repo: ${ownerName()} steers from the top branches of the tree instead of chasing tickets.`,
      decisions: [{ date: "2026-10-31", outcome: "accepted", decision: `${ownerName()} asked for the Epic Book`, summary: "home team.example.com/book" }],
      timeline: [
        { date: "2026-10-31T23:30:00.000Z", kind: "commit", text: "E940-S2: Epic Book", sha: "72c751e" },
        { date: "2026-10-31", kind: "decision", text: `${ownerName()} asked for the Epic Book: home team.example.com/book` },
      ],
      timelineTotal: 2,
      next: `${ownerName()} answers EPIC-940-A1; lanes on the console home`,
      dod: { done: 1, total: 4 },
    }),
    epic({
      path: "docs/spines/epic-922-two-worlds-live.md",
      code: "EPIC-922",
      title: "EPIC-922: two worlds live",
      state: "stuck",
      waitingOn: `${ownerName()}: E922-A1 (his two console logins)`,
      asks: [{ code: "E922-A1", who: ownerName(), question: "Set your two passwords and log in once on each site" }],
      next: `auth on + 1 h watch after ${ownerName()}'s logins`,
    }),
    epic({ path: "docs/spines/epic-916-clean-spine-trees.md", code: "EPIC-916", title: "EPIC-916: Clean spine trees", state: "done", status: "done", outcome: "closed work stays out of the way" }),
  ];
  const counts = { moving: 2, stuck: 1, parked: 0, done: 1 };
  return { builtAt: now.toISOString(), counts, repos: [{ name: "home_repo", remote: "Acme/home_repo", root: "docs/spines/root.md", epics, counts, capabilities: sampleCapabilities() }] };
}

/** a milestone's Epic Book, `/book/<milestone id>` (the repo's name also opens its root milestone). */
export const milestoneBookHref = (key: string) => `/${BOOK_PATH}/${encodeURIComponent(key)}`;

/**
 * where an ask shows in its milestone's Epic Book: "Where we are" is the section that says what the milestone is
 * waiting on (server book/milestone.ts whereWeAre: "Waiting on <who> (<code>)"), so an ask's Context links there.
 */
export const ASK_BOOK_SECTION = { id: "where", title: "Where we are" } as const;
export const askBookLink = (milestoneId: string) => ({
  href: `${milestoneBookHref(milestoneId)}#${ASK_BOOK_SECTION.id}`,
  label: `Epic deck: ${ASK_BOOK_SECTION.title}`,
});

export const STATE_FILL: Record<BookState, string> = {
  moving: "fill-emerald-500",
  stuck: "fill-red-500",
  parked: "fill-zinc-400",
  done: "fill-sky-500",
};

/** One row of the plan diagram: a spine, or the closed/parked children of a parent folded into one row. */
export interface PlanRow {
  key: string;
  depth: number;
  code?: string;
  title: string;
  state: BookState;
  dod?: { done: number; total: number };
  /** Open spines further down, not drawn (the diagram stops at `maxDepth`). */
  hidden?: number;
  /** Index of the parent row (connector), -1 for the milestone itself. */
  parent: number;
}

/**
 * The plan diagram's rows, generated from the tree (never hand-drawn): the milestone, its open epics and their open
 * children down to `maxDepth`, each parent's done and parked children folded into one row ("4 done · 1 parked").
 */
export function planRows(tree: MilestoneBook["tree"], maxDepth = 2): PlanRow[] {
  const rows = planRowsAt(tree, maxDepth);
  // A big tree (the code repo: ~40 open epics) is drawn one level deep, each row counting the open work below it.
  return rows.length > PLAN_MAX_ROWS && maxDepth > 1 ? planRowsAt(tree, 1) : rows;
}

/** More rows than this and the diagram is drawn one level deep. */
export const PLAN_MAX_ROWS = 40;

function planRowsAt(tree: MilestoneBook["tree"], maxDepth: number): PlanRow[] {
  const kids = new Map<string, MilestoneBook["tree"]>();
  for (const n of tree) if (n.parent) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);
  const openBelow = (p: string): number => (kids.get(p) ?? []).reduce((a, k) => a + (isOpen(k.state) ? 1 : 0) + openBelow(k.path), 0);
  const rows: PlanRow[] = [];
  const walk = (n: MilestoneBook["tree"][number], parent: number) => {
    const at = rows.length;
    const children = kids.get(n.path) ?? [];
    const deeper = n.depth >= maxDepth;
    rows.push({ key: n.path, depth: n.depth, code: n.code, title: n.title, state: n.state, dod: n.dod, parent, ...(deeper && openBelow(n.path) ? { hidden: openBelow(n.path) } : {}) });
    if (deeper) return;
    // view-only folds (docs/epic-folds.json): a folded child is no row of its own, one dashed line under its parent names them.
    const folded = children.filter((k) => k.foldedInto);
    const own = children.filter((k) => !k.foldedInto);
    const open = own.filter((k) => isOpen(k.state)).sort((a, b) => Number(b.state === "stuck") - Number(a.state === "stuck"));
    for (const k of open) walk(k, at);
    if (folded.length)
      rows.push({
        key: `${n.path}#folded`,
        depth: n.depth + 1,
        title: `${folded.length} folded in: ${folded.map((k) => k.code).join(", ")}`,
        state: folded.some((k) => isOpen(k.state)) ? "moving" : "done",
        parent: at,
      });
    const done = own.filter((k) => k.state === "done").length;
    const parked = own.filter((k) => k.state === "parked").length;
    if (done || parked)
      rows.push({
        key: `${n.path}#closed`,
        depth: n.depth + 1,
        title: [done && `${done} done`, parked && `${parked} parked`].filter(Boolean).join(" · "),
        state: done ? "done" : "parked",
        parent: at,
      });
  };
  const root = tree.find((n) => n.parent === null) ?? tree[0];
  if (root) walk(root, -1);
  return rows;
}

/** A small milestone book for the mock API and tests. */
export function sampleMilestoneBook(key = "ms_sample"): MilestoneBook {
  const root = "docs/spines/root.md";
  const n = (over: Partial<MilestoneBook["tree"][number]> & Pick<MilestoneBook["tree"][number], "path" | "code" | "title" | "state">) => ({
    parent: root,
    depth: 1,
    status: "active",
    dod: { done: 0, total: 0 },
    next: null,
    waitingOn: null,
    asks: [],
    outcome: null,
    ...over,
  });
  return {
    builtAt: "2026-11-01T12:00:00.000Z",
    repo: { name: "home_repo", remote: "Acme/home_repo" },
    milestone: { id: key, title: "home_repo", path: root, code: "root", state: "moving", status: "active", href: "https://github.com/Acme/home_repo/blob/main/docs/spines/root.md" },
    narrative: {
      goal: "Run a small team of AI employees on the VPS that push a milestone forward on their own.",
      goals: [
        { id: "DOD-1", text: "T3 runs as a service on host1 and survives a reboot.", done: true },
        { id: "DOD-2", text: "Three personas run a milestone unattended.", done: false },
      ],
      whereWeAre: ["1 of 2 goals met.", "3 epics under it: 1 moving, 1 waiting on someone, 1 done."],
      next: [
        { text: `${ownerName()} answers E922-A1 (two logins).` },
        { code: "EPIC-922", stuck: true, text: `Two worlds live: waiting on ${ownerName()}` },
        { code: "EPIC-940", text: "Lanes and radar: build the lanes" },
      ],
      outcome: null,
    },
    tree: [
      n({ path: root, code: "root", title: "home_repo", state: "moving", parent: null, depth: 0, dod: { done: 1, total: 2 } }),
      n({ path: "docs/spines/epic-940.md", code: "EPIC-940", title: "Lanes and radar", state: "moving", dod: { done: 1, total: 4 }, next: "build the lanes" }),
      n({ path: "docs/spines/epic-922.md", code: "EPIC-922", title: "Two worlds live", state: "stuck", asks: [{ code: "E922-A1", who: ownerName(), question: "Log in once" }] }),
      n({ path: "docs/spines/epic-916.md", code: "EPIC-916", title: "Clean spine trees", state: "done", status: "done" }),
    ],
    counts: { moving: 1, stuck: 1, parked: 0, done: 1 },
    timeline: [{ date: "2026-11-01T05:05:00.000Z", kind: "commit", text: `Plan ${ownerName()}'s voice note`, sha: "26e6b01" }],
    capabilities: sampleCapabilities(),
    updated: { at: new Date().toISOString(), spineAt: "2026-11-01T05:05:00.000Z", probeAt: "2026-11-01T15:13:29.000Z", refreshedAt: new Date().toISOString(), stale: false },
    made: sampleMade(root),
  };
}

/** a sample "Everything made for this": the milestone's own list and one epic's, a stopped preview and a gone page. */
export function sampleMade(root = "docs/spines/root.md"): BookMade[] {
  const gh = "https://github.com/Acme/home_repo";
  return [
    {
      path: root,
      code: "root",
      title: "home_repo",
      depth: 0,
      state: "moving",
      items: [
        { url: "https://team.example.com/book/home_repo", label: "The Epic Book for home_repo", kind: "live page", date: "2026-11-01", row: "E947-S1", check: { state: "ok", at: "2026-11-04T10:00:00Z" } },
        {
          url: "http://worker.tail.example:8795/plans/e940-1-voice-note/index.html",
          label: "Your voice note, as a plan page",
          kind: "proposal",
          date: "2026-10-31",
          row: "E940-S1",
          servePath: "home_repo/docs",
          repoUrl: `${gh}/tree/main/docs/plans/e40-1-voice-note`,
          check: { state: "not running", at: "2026-11-04T10:00:00Z", detail: "ECONNREFUSED" },
        },
        { url: `${gh}/blob/main/docs/status/e16-old.md`, label: "An old evidence page", kind: "evidence", date: "2026-10-20", file: "docs/status/e16-old.md", check: { state: "gone", at: "2026-11-04T10:00:00Z", detail: "no longer in the repo" } },
      ],
    },
    {
      path: "docs/spines/epic-940.md",
      code: "EPIC-940",
      title: "Lanes and radar",
      depth: 1,
      state: "moving",
      items: [{ url: "http://worker.tail.example:8971/", label: "The lanes deck, round 2", kind: "deck", date: "2026-11-02", row: "E940-S4", check: { state: "ok", at: "2026-11-04T10:00:00Z" } }],
    },
    { path: "docs/spines/epic-922.md", code: "EPIC-922", title: "Two worlds live", depth: 1, state: "stuck", items: [] },
  ];
}
