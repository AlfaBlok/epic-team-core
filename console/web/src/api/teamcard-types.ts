/** GET /api/inbox/team-cards: the team's own inbox cards (server/src/inbox/teamCards.ts, docs/inbox/cards.json). */
export type TeamCardKind = "digest" | "idea" | "goal" | "advisor";
export interface TeamCardLink {
  label: string;
  url: string;
}
export type TeamCardLineState = "green" | "amber" | "red" | "unknown";
export interface TeamCard {
  id: string;
  kind: TeamCardKind;
  /** the world that made it, when not the home world (the social world's own personas). */
  world?: string;
  scorecard?: string;
  scorecardName?: string;
  /** the key result of that goal set it is about; absent = the objective as a whole. */
  keyResult?: string;
  by: string;
  run?: string;
  at: string;
  day: string;
  title: string;
  source?: string;
  digest?: {
    greens: number;
    total: number;
    prevGreens?: number;
    prevTotal?: number;
    prevDay?: string;
    trend: "greener" | "redder" | "same" | "first";
    reasons: { text: string; url?: string; keyResult?: string }[];
    lines?: { label: string; state: TeamCardLineState; value: string; was?: TeamCardLineState }[];
  };
  idea?: { gain: string; recommend: string; links?: TeamCardLink[] };
  goal?: { unset: string; options: { goal: string; number: string }[]; recommend?: number; links?: TeamCardLink[] };
  /** the Senior advisor's suggestions of one week, one marked set (E948-S59). */
  advisor?: AdvisorSet;
  answer?: { at: string; text: string; pick?: number; via: "text" | "voice" | "button"; attachments?: string[] };
}
export interface AdvisorItem {
  id: string;
  title: string;
  why?: string;
  done?: string;
  spine: string;
  row?: string;
  verdict?: { state: "accepted" | "declined"; at: string; via: "text" | "voice" | "button"; text?: string; row?: string };
  notes?: { at: string; text: string; via: "text" | "voice" | "button"; attachments?: string[] }[];
}
export interface AdvisorSet {
  week: string;
  weekLabel?: string;
  page?: string;
  items: AdvisorItem[];
}
export interface AdvisorVerdictBody {
  verdict: "accept" | "decline" | "note";
  /** none: every open suggestion (Accept all) */
  items?: string[];
  text?: string;
  via?: "text" | "voice" | "button";
  attachments?: string[];
}
export interface TeamCardsBody {
  open: TeamCard[];
  answered: TeamCard[];
  counts: Record<TeamCardKind, number>;
  limits: { digestPerScorecardPerDay: number; ideasPerDay: number; openGoalsPerScorecard: number; advisorSetsPerWeek?: number };
  today: string;
}
export interface TeamCardAnswer {
  text?: string;
  pick?: number;
  via?: "text" | "voice" | "button";
  attachments?: string[];
}
