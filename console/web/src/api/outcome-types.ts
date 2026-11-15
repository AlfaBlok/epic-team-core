/** The outcome log: GET /api/outcomes, read from docs/outcomes/<day>.jsonl of every tracked repo (server/src/outcomes.ts). */
export interface OutcomeLine {
  at: string;
  day: string;
  kind: string;
  text: string;
  row?: string;
  goalRow?: string;
  link?: string;
  product: string;
  persona: string;
  runId?: string;
  milestoneId?: string;
  repo: string;
  source: "run" | "backfill";
}
export interface OutcomeFilter {
  persona?: string;
  product?: string;
  row?: string;
  kind?: string;
  day?: string;
  repo?: string;
}
export interface OutcomesBody {
  outcomes: OutcomeLine[];
  facets: { persona: string[]; product: string[]; kind: string[]; day: string[]; repo: string[] };
  counts: Record<string, number>;
  kinds: string[];
  /** what counts as an outcome for each persona (docs/outcomes/what-counts.json); absent on an older server. */
  definitions?: { rule: string; personas: OutcomeDefinition[] };
}
export interface OutcomeDefinition {
  persona: string;
  counts: string;
  doesNot: string;
  examples?: string[];
}
