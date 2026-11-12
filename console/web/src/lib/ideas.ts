import type { MonthPriority, SocialDirectionsInput, SocialExport, SocialIdea, WeekHighlight } from "@/api/types";
import { ApiError } from "@/api/real";

/**
 * "My ideas & priorities" helpers over the pack export. An idea's shown state folds in what it became (the
 * export's computed `became`: post ids whose Idea cell names it): a post row → drafted, a live one → posted, so the
 * screen is right even before the Writer moves the State cell. the owner may drop (park) only a new or picked-up idea
 * (social pack, epicspine-skill 2026.10.27.7); every other move is the Writer's.
 */

export const IDEA_FILTERS = ["all", "new", "open", "picked up", "drafted", "posted", "spent", "parked", "epic"] as const;
export type IdeaFilter = (typeof IDEA_FILTERS)[number];

export interface BecamePost {
  id: string;
  status: string;
  link?: string;
}

export interface IdeaView {
  id: string;
  date: string;
  idea: string;
  format: string;
  platform: string;
  from: string;
  link: string;
  /** The State cell, lower case ("" if empty). */
  state: string;
  /** What the screen shows: the State cell, raised to drafted / posted by the posts it became. */
  shown: string;
  why: string;
  became: BecamePost[];
  /** the owner may drop it (new, open or picked up → parked). */
  droppable: boolean;
  line: number;
}

const LIVE = new Set(["posted", "measured"]);
const EARLY = new Set(["", "new", "picked up"]);

export function ideaViews(d: SocialExport | undefined): IdeaView[] {
  const posts = new Map((d?.posts ?? []).filter((p) => p.id).map((p) => [p.id!, p]));
  return (d?.ideas ?? [])
    .filter((i): i is SocialIdea & { id: string } => !!i.id)
    .map((i) => {
      const state = (i.state ?? "").trim().toLowerCase();
      const became = (i.became ?? []).map((id) => {
        const p = posts.get(id);
        return { id, status: p?.status ?? "", ...(p?.link ? { link: p.link } : {}) };
      });
      const shown = EARLY.has(state) && became.length ? (became.some((b) => LIVE.has(b.status)) ? "posted" : "drafted") : state || "new";
      return {
        id: i.id,
        date: i.date ?? "",
        idea: i.idea ?? "",
        format: i.format ?? "",
        platform: i.platform ?? "",
        from: i.from ?? "",
        link: i.link ?? "",
        state,
        shown,
        why: i.why ?? "",
        became,
        droppable: state === "new" || state === "open" || state === "picked up", // open ideas too
        line: i._line,
      };
    })
    .reverse(); // newest first
}

export const filterIdeas = (ideas: IdeaView[], f: IdeaFilter) => (f === "all" ? ideas : ideas.filter((i) => i.shown === f));
export const countIdeas = (ideas: IdeaView[]) => Object.fromEntries(IDEA_FILTERS.map((f) => [f, filterIdeas(ideas, f).length])) as Record<IdeaFilter, number>;

/** A link cell that is a URL (else it is an asset id or a note). */
export const isUrl = (s: string) => /^https?:\/\//i.test(s.trim());

// ---- week + month priorities: the editable rows, saved together as one `directions` write ----

export interface WeekRow {
  id: string;
  highlight: string;
  why: string;
  until: string;
  servedBy: string[];
}
export interface MonthRow {
  id: string;
  priority: string;
  why: string;
  month: string;
  servedBy: string[];
}

export const weekRows = (w: WeekHighlight[] = []): WeekRow[] =>
  w.map((h) => ({ id: h.id ?? "", highlight: h.highlight ?? "", why: h.why ?? "", until: h.until ?? "", servedBy: h.served_by ?? [] }));
export const monthRows = (m: MonthPriority[] = []): MonthRow[] =>
  m.map((p) => ({ id: p.id ?? "", priority: p.priority ?? "", why: p.why ?? "", month: p.month ?? "", servedBy: p.served_by ?? [] }));

const orNull = (s: string) => (s.trim() ? s.trim() : null);

/** The `directions` body for one Save: both lists whole (empty rows dropped; a new row has no id, the server fills H../M..). */
export function prioritiesBody(week: WeekRow[], month: MonthRow[]): Required<Pick<SocialDirectionsInput, "week" | "month">> {
  return {
    week: week.filter((r) => r.highlight.trim()).map((r) => ({ id: orNull(r.id), highlight: r.highlight.trim(), why: orNull(r.why), until: orNull(r.until) })),
    month: month.filter((r) => r.priority.trim()).map((r) => ({ id: orNull(r.id), priority: r.priority.trim(), why: orNull(r.why), month: orNull(r.month) })),
  };
}

/** A failed write as lines to show inline: the pack's issue lines (422), else the message. */
export const writeIssues = (e: unknown): string[] => (e instanceof ApiError && e.issues?.length ? e.issues : [e instanceof Error ? e.message : String(e)]);
