/** One-offs: GET /api/one-offs, read from the home repo's spines (server/src/oneOffs.ts). */
export type OneOffStage = "filed" | "in work" | "stuck" | "your card" | "delivered" | "parked";

export interface OneOff {
  id: string;
  name: string;
  detail?: string;
  stage: OneOffStage;
  status: string;
  holder?: string;
  epic: { repo: string; path: string; code?: string; title?: string };
  card?: { rel: string; title?: string; evidenceUrl?: string };
  source?: { ref: string; url?: string };
  next?: string;
  date?: string;
}
export interface OneOffsBody {
  oneOffs: OneOff[];
  counts: Record<OneOffStage, number>;
  spine: string;
  deliveredDays: number;
}
