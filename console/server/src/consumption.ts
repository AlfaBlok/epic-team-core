import fs from "node:fs";
import path from "node:path";

/**
 * A wheel's Consumption chapter. The owner, WhatsApp voice note 25 Nov 14:34Z
 * (Log/2026-11-25.md#^e-3941fc): "I need to have like a consumption chart which speaks to mean percentages of my
 * subscription ... percentage of total subscription and percentage of the used subscription" and "is this a chapter? I
 * think yes ... you click and you get the breakdown of consumption. Like, which personas have been consuming what and
 * what's been the contribution of the personas? In the context of this wheel".
 *
 * One file in the home repo, docs/consumption/latest.json, written by the home repo's own script from the seat broker
 * and the meter; the console's database holds none of it.
 */
export const CONSUMPTION_FILE = "docs/consumption/latest.json";

export interface ConsumptionPersona {
  persona: string;
  ofTotal: number;
  ofUsed: number;
  ofWheel?: number;
  runs: number;
  outcomes: number;
  madeTrue: number;
  top?: { key: string; name: string; ofUsed: number }[];
}
export interface ConsumptionWheel {
  key: string;
  name: string;
  kind: string;
  ofTotal: number;
  ofUsed: number;
  runs: number;
  outcomes: number;
  madeTrue: number;
  personas: ConsumptionPersona[];
}
export interface Consumption {
  at: string | null;
  seats: number;
  usedOfTotal: number;
  /** this wheel's line (null when it used nothing this week); `all` gives none */
  wheel: ConsumptionWheel | null;
  /** this wheel's place among all wheels by use (1 = the most), and how many used any */
  rank: number | null;
  of: number;
  /** every wheel's line, biggest first: only for `all` */
  wheels?: ConsumptionWheel[];
  /** every persona's part across all wheels: only for `all` */
  personas?: ConsumptionPersona[];
  /** the page that sets every wheel side by side, when the writer names one */
  page?: string | null;
  file: string;
}

type Raw = {
  at?: string;
  seats?: number;
  usedOfTotal?: number;
  wheels?: Record<string, ConsumptionWheel>;
  order?: string[];
  personas?: ConsumptionPersona[];
  milestones?: Record<string, ConsumptionWheel>;
  page?: string;
};

/** a wheel's consumption: an objective id, `milestone:<id>` for a campaign, or `all`. */
export function readConsumption(home: string | undefined, wheel: string): Consumption {
  let raw: Raw = {};
  if (home) {
    try {
      raw = JSON.parse(fs.readFileSync(path.join(home, CONSUMPTION_FILE), "utf8")) as Raw;
    } catch {
      raw = {};
    }
  }
  const order = (raw.order ?? []).map((k) => raw.wheels?.[k]).filter((w): w is ConsumptionWheel => Boolean(w));
  const base = { at: raw.at ?? null, seats: raw.seats ?? 0, usedOfTotal: raw.usedOfTotal ?? 0, page: raw.page ?? null, file: CONSUMPTION_FILE };
  if (wheel === "all") return { ...base, wheel: null, rank: null, of: order.length, wheels: order, personas: raw.personas ?? [] };
  const campaign = wheel.startsWith("milestone:");
  const one = campaign ? (raw.milestones?.[wheel] ?? raw.wheels?.[wheel]) : raw.wheels?.[wheel];
  const i = order.findIndex((w) => w.key === wheel);
  return { ...base, wheel: one ?? null, rank: i >= 0 ? i + 1 : null, of: order.length };
}
