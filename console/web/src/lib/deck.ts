import type { BigRock, BigRocks, DeckCard, DeckListItem, EpicDeck } from "@/api/types";
import { ownerName, homeRepo } from "@/lib/identity";

/** the epic decks (`/deck/<repo>/<code>`), their index (`/deck`) and's big rocks board (`/rocks`). */
export const DECK_PATH = "deck";
export const ROCKS_PATH = "rocks";
/** every epic of every repo and the capabilities table (was the Epic Book's index, /book). */
export const DECK_ALL_PATH = "deck/all";
export const deckHref = (repo: string, code: string) => `/${DECK_PATH}/${encodeURIComponent(repo)}/${encodeURIComponent(code)}`;

/** The house paper style (house-diagram-style skill, L-49): warm off-white, ink, one deep-green focus. */
export const PAPER = {
  bg: "#F5F3EE",
  card: "#FFFFFF",
  ink: "#1D2329",
  muted: "#62676D",
  line: "#1D2329",
  focusFill: "#E3EFE8",
  focusLine: "#1F5F4A",
  focusInk: "#123D30",
  quietFill: "#ECE9E2",
  quietLine: "#B9B4AA",
  warn: "#9A3B1E",
} as const;
export const SERIF = "Fraunces, Georgia, 'Times New Roman', serif";

const rock = (id: string, name: string, notes: number, days: number, weight: "heavy" | "medium", epics: string[]): BigRock => ({
  id,
  name,
  want: `We want ${name.toLowerCase()}.`,
  weight,
  frequency: { notes, days, first: "2026-10-13", last: "2026-11-07", text: `${notes} notes on ${days} days, first 2026-10-13, last 2026-11-07` },
  epics,
  why: "He comes back to it again and again.",
  evidence: [{ date: "2026-11-07", ref: "Log/2026-11-07.md#^e-5fc46c", url: "https://github.com/Acme/obsidian-brain/blob/main/Log/2026-11-07.md#%5Ee-5fc46c", quote: "It's time to get testers." }],
});

/** Mock data (the real board is docs/big-rocks.md, parsed on the server). */
export function sampleRocks(): BigRocks {
  return {
    file: "docs/big-rocks.md",
    repo: "home_repo",
    goal: `We want ${ownerName()}'s heaviest, most repeated themes on one board.`,
    window: "2026-09-01 to 2026-11-07",
    read: "49 voice notes on 25 days (17 personal notes skipped)",
    lastRead: "2026-11-07",
    method: "Every voice-note transcript was read in full.",
    note: null,
    rocks: [rock("R1", "Get real users now", 6, 5, "heavy", ["home_repo/EPIC-936"]), rock("R2", "A goal tree he trusts", 5, 4, "heavy", ["home_repo/EPIC-940"])].map((r) => ({
      ...r,
      decks: [{ ref: { repo: "home_repo", code: r.epics[0].split("/")[1] }, href: deckHref("home_repo", r.epics[0].split("/")[1]), title: r.name, kind: "lane" as const }],
    })),
  };
}

export function sampleDeckList(): DeckListItem[] {
  return [
    { ref: { repo: "home_repo", code: "EPIC-946" }, href: deckHref("home_repo", "EPIC-946"), title: "Epic Social launch", state: "stuck", kind: "big", goalsMet: 2, goalsTotal: 5, rocks: ["R1"] },
    { ref: { repo: "home_repo", code: "EPIC-940" }, href: deckHref("home_repo", "EPIC-940"), title: "Lanes and radar", state: "moving", kind: "lane", goalsMet: 2, goalsTotal: 6, rocks: ["R2"] },
  ];
}

export function sampleDeckCards(): DeckCard[] {
  return [{ ref: { repo: "home_repo", code: "EPIC-946" }, href: deckHref("home_repo", "EPIC-946"), title: "Epic Social launch", date: "2026-11-07", text: "A goal is met: E46-3.", goals: { met: 3, total: 5 } }];
}

export function sampleDeck(repo = "home_repo", code = "EPIC-940"): EpicDeck {
  const rocks = sampleRocks().rocks;
  return {
    builtAt: new Date().toISOString(),
    ref: { repo, code },
    href: deckHref(repo, code),
    title: "Lanes and radar",
    path: "docs/spines/epic-940-lanes-and-radar.md",
    state: "moving",
    status: "active",
    updatedAt: new Date().toISOString(),
    rocks,
    goal: `We want ${ownerName()} to see his big lanes and what moves each.`,
    serves: `${ownerName()} orients himself in one place.`,
    goals: [
      { id: "E40-1", text: "The Epic Book is live.", done: true },
      { id: "E40-2", text: "Lanes on the home.", done: false },
      { id: "E40-3", text: "A radar of what moves.", done: false },
    ],
    whereWeAre: ["1 of 3 goals met.", "3 epics under it: 2 moving, 1 done."],
    next: [{ text: "Plan rows for the lanes." }],
    outcome: null,
    justDid: [
      { date: "2026-11-07", kind: "commit", text: "The epic deck is live.", code: "EPIC-975" },
      { date: "2026-11-04", kind: "decision", text: "Lists cut at 20.", code: "EPIC-940" },
    ],
    measure: {
      goalsMet: 1,
      goalsTotal: 3,
      epics: { moving: 2, stuck: 0, parked: 0, done: 1 },
      subGoals: { done: 3, total: 8 },
      asksOnJordi: 0,
      weekly: ["W38", "W39", "W40", "W41", "W42", "W43", "W44", "W45"].map((w, i) => ({ week: `2026-${w}`, n: [0, 1, 0, 3, 5, 2, 6, 4][i] })),
      trend: [],
    },
    plan: [
      { path: "docs/spines/epic-940-lanes-and-radar.md", code: "EPIC-940", title: "Lanes and radar", parent: null, depth: 0, state: "moving", status: "active", dod: { done: 1, total: 3 }, next: null, waitingOn: null, asks: [], outcome: null },
      { path: "docs/spines/epic-947.md", code: "EPIC-947", title: "Epic Book per milestone", parent: "docs/spines/epic-940-lanes-and-radar.md", depth: 1, state: "done", status: "review", dod: { done: 4, total: 4 }, next: null, waitingOn: null, asks: [], outcome: null },
      { path: "docs/spines/epic-975.md", code: "EPIC-975", title: "Epic deck", parent: "docs/spines/epic-940-lanes-and-radar.md", depth: 1, state: "moving", status: "active", dod: { done: 0, total: 2 }, next: null, waitingOn: null, asks: [], outcome: null },
    ],
    decisions: [{ date: "2026-11-07", code: "EPIC-975", outcome: "accepted", decision: "The deck sits next to the Epic Book.", summary: "Nothing is removed." }],
    waits: [],
    made: [],
    fingerprint: "0000000000",
  };
}

/** "the code repo/" → ""; another repo keeps its name. */
export const epicLabel = (ref: string) => (ref.startsWith(`${homeRepo()}/`) ? ref.slice(`${homeRepo()}/`.length) : ref);

/** A spine's deck code, as the server names it (deck/build.ts deckCode): its EPIC-n or Mn code, else its file name. */
export const deckCodeOf = (code: string, path: string) => (/^(EPIC-\d+|M\d+)$/i.test(code) ? code.toUpperCase() : path.split("/").pop()!.replace(/\.md$/i, ""));
