/** GET /api/pursuits: the owner's pursuits (docs/pursuits.json), each scorecard read from real checks (server/src/pursuits.ts). */
export type PursuitLineState = "green" | "amber" | "red" | "unknown";
export interface PursuitLine {
  label: string;
  state: PursuitLineState;
  value: string;
  note?: string;
}
export interface PursuitTotem {
  label: string;
  url?: string;
  missing?: string;
}
export interface Pursuit {
  id: string;
  name: string;
  greenWhen: string;
  state: PursuitLineState;
  greens: number;
  total: number;
  lines: PursuitLine[];
  totems: PursuitTotem[];
  motion: "moving" | "stalled" | "unknown";
  lastMove: { at: string; repo: string; subject: string } | null;
}
export interface PursuitsBody {
  pursuits: Pursuit[];
  staleDays: number;
  said?: { source: string; words: string };
  boardAt?: string | null;
}
