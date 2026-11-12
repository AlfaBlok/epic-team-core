import type { CampaignTotems, TotemSlide } from "@/api/types";
import { safeHref, type LinkBase } from "@/lib/mdlinks";
import { ownerName, socialWorld } from "@/lib/identity";

/**
 * a campaign page in the social skin has fixed
 * tabs, each a part of its epic file. Deck (the campaign's epic deck, once called Brief), Product (what this
 * campaign pushes), Waiting on me, Pipeline (its posts), Tasks, Observations, History, Chat. Settings and personas sit
 * behind one header button. Old links land on the tab that now holds what they showed.
 */
export const FIVE_TABS = ["deck", "product", "waiting", "pipeline", "work", "observations", "history", "chat"] as const;
export type FiveTab = (typeof FIVE_TABS)[number] | "settings";
/** Each tab's name; the breadcrumb (Project › Campaign › Tab) shows it too. */
export const FIVE_LABELS: Record<(typeof FIVE_TABS)[number] | "settings", string> = {
  deck: "Deck",
  product: "Product",
  waiting: "Waiting on me",
  pipeline: "Pipeline",
  work: "Tasks",
  observations: "Observations",
  history: "History",
  chat: "Chat",
  settings: "Settings and personas",
};

const OLD: Record<string, FiveTab> = {
  brief: "deck",
  summary: "deck",
  definitions: "deck",
  approvals: "waiting",
  tree: "work",
  backlog: "work",
  activity: "history",
  personas: "settings",
  settings: "settings",
};

/** ?tab= → one of the tabs (or the Settings and personas view); no tab = Deck. An old Work › Posts link opens Pipeline. */
export function fiveTabFromParams(params: URLSearchParams): FiveTab {
  const t = params.get("tab") ?? "";
  if (t === "work" && params.get("view") === "posts") return "pipeline";
  if ((FIVE_TABS as readonly string[]).includes(t)) return t as FiveTab;
  return OLD[t] ?? (params.get("node") ? "work" : "deck");
}

/** The note a slide's "This slide" box sends to the campaign chat: the prefix the Repo desk acts on (seed v11). */
export const slideNote = (s: Pick<TotemSlide, "n" | "title" | "file" | "ref">, note: string) => `[slide ${s.n}: ${s.title} · file ${s.file} · ref ${s.ref}] ${note.trim()}`;
/** a Product tab slide note as the campaign chat reads it (the console has filed it already). */
export const productSlideNote = (s: { n: number; title: string; file: string }, note: string) => `[product slide ${s.n}: ${s.title} · file ${s.file}] ${note.trim()}`;
/** A sent slide note shown back in the chat: "slide 5 · <note>". */
export const SLIDE_PREFIX = /^\[slide (\d+): [^\]]*\]\s*/;

/** Markdown with every relative link made absolute (GitHub, like the spine's own page) or dropped to its label. */
export function absoluteLinks(md: string, base: LinkBase): string {
  return md.replace(/(!?)\[([^\]\n]*)\]\(\s*<?([^\s)<>]+)>?\s*\)/g, (all, bang: string, label: string, target: string) => {
    if (bang) return label;
    if (/^https?:/i.test(target)) return all;
    const href = safeHref(target, base);
    return href ? `[${label}](${href})` : label;
  });
}

/** Task codes in a line → split for links to Work. */
export function splitTaskCodes(text: string): ({ text: string } | { code: string })[] {
  const out: ({ text: string } | { code: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(/\bE\d+-S\d+[a-z]?\b/g)) {
    const at = m.index ?? 0;
    // a code inside a Markdown link label or target stays as written
    const before = text.slice(0, at);
    if ((before.match(/\[/g)?.length ?? 0) > (before.match(/\]/g)?.length ?? 0) || /\]\([^)]*$/.test(before)) continue;
    if (at > last) out.push({ text: text.slice(last, at) });
    out.push({ code: m[0] });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** The mock's sample campaign (the web dev server and tests). */
export function mockTotems(): CampaignTotems {
  const file = "docs/spines/campaign-reddit-awareness-week-37.md";
  const slide = (n: number, title: string, ref: string, source: string, body: string, extra: Partial<TotemSlide> = {}): TotemSlide => ({ n, ref, file, title, source, body, ...extra });
  return {
    epic: { code: "EPIC-911", title: "Reddit awareness week 37", path: file, kind: "epic", status: "ready" },
    chain: [
      { code: "EPIC-911", title: "Reddit awareness week 37", path: file },
      { code: "EPIC-900", title: "Memo social presence", path: "docs/spines/root.md" },
    ],
    slides: [
      slide(1, "Where we are", "## Goal", "Goal · Current State", `Builders who run several agents learn that I built Memo.\n\n**Next:** ${ownerName()} presses Don't post on P-0065`, {
        facts: [
          { label: "Channels", value: "Reddit" },
          { label: "When", value: "2026-11-02 to 2026-11-08" },
          { label: "So far", value: "1 thread out, 4 replies answered" },
          { label: "For you", value: "2 things wait on Work" },
        ],
      }),
      slide(2, "Why this campaign", "## Campaign plan > ### One-pager draft > #### Why this campaign", "Campaign plan · one-pager draft", "- Builders re-explain everything each session.", { draft: "Draft E911-S1: it waits for your Approve on Work" }),
      slide(3, "Voice", "## Campaign plan > ### Voice", "Campaign plan · Voice", "- Me, first person, casual.\n- Short paragraphs: one to three sentences each."),
      slide(4, "Done means", "## Done means", "Done means", "- [ ] E11-1 Three threads out."),
    ],
    rebuilds: [],
    work: {
      rows: [
        { id: "E911-S1", title: "One-pager draft", owner: "the Repo desk", role: "Ticket worker", status: "review", evidence: "link", next: "confirm: yes", group: "waiting" },
        { id: "E911-S2", title: "The week's three Reddit threads", owner: "Writer", role: "Writer", status: "active", evidence: "P-0048 out 2 Nov", next: "", group: "moving" },
        { id: "E911-S4", title: "Research a fresh question", owner: "Scout", role: "Scout", status: "done (I-15)", evidence: "I-15", next: "", group: "done" },
      ],
      asks: [{ code: "EPIC-911-A1", text: "Press Don't post on P-0065. [row E911-S3]" }],
    },
    observations: [
      { id: "L-1", when: "writing any EPIC-911 thread", rule: "higher ground first", why: `${ownerName()}, Team desk 2026-11-03`, confirmed: `confirmed 2026-11-03 (${ownerName()})`, retired: false, raw: "" },
      { id: "L-2", when: "picking an example", rule: "easy to follow", why: `${ownerName()} on P-0065`, confirmed: "retired by L-5", retired: true, raw: "" },
      { id: "L-4", when: "replying on Reddit", rule: "end on one question", why: "Reporter IN-3", confirmed: "measured 2026-11-03", retired: false, proposal: { part: "Reply style", text: "End every reply on one specific question.", state: "open" }, raw: "" },
    ],
    history: {
      weeks: [
        {
          week: "2026-W45",
          line: "running: 1 of 3 threads out",
          page: "docs/log/campaign-reddit-awareness-week-37/2026-W45.md",
          days: [
            {
              date: "2026-11-03",
              day: "51 commits",
              lines: [
                { time: "", who: "Decision", text: "Campaign created", kind: "decision" },
                { time: "21:12", who: "Scout", text: "E911-S4 idea I-15 added, [I-15](../../../data/ideas.md)", kind: "wake" },
                { time: "05:44", who: `${ownerName()} (console)`, text: "pull P-0065", kind: "owner" },
              ],
            },
          ],
        },
      ],
    },
    remote: `memo-ai/${socialWorld()}`,
    team: { root: { code: "EPIC-900", title: "Memo social presence", path: "docs/spines/root.md" }, slides: [slide(1, "Positioning", "## Positioning", "data/brief.md · Positioning", "One memory for every agent.", { file: "data/brief.md" })], rebuilds: [], observations: [] },
  };
}
