import fs from "node:fs";
import path from "node:path";

/**
 * The persona log. The owner, 24 Nov 05:11Z (Log/2026-11-24.md#^e-0a42dd): "One of these data totems should
 * be persona logs where we see ... any agent that is doing a job in the context of the wheel as part of its turn it needs
 * to log. This agent was here and did this ... this log should allow us to reconstruct decision making. And then we
 * should be able to label, was this ... a correct one or an incorrect one?"
 *
 * One line per step in docs/persona-log/<day>.jsonl of the home repo, written from what each run already reports
 * (scripts/persona_log.py, no model, in the hourly pursuit-checks timer); his labels in docs/persona-log/labels.json,
 * which only this module's labelEdit (his tap) and the script write. The console's database holds neither.
 */
export const PERSONA_LOG_DIR = "docs/persona-log";
export const PERSONA_LOG_LABELS = `${PERSONA_LOG_DIR}/labels.json`;

export type StepLabel = "correct" | "incorrect";
export interface PersonaStep {
  id: string;
  at: string;
  persona: string;
  worker: boolean;
  objective: string | null;
  objectiveName?: string | null;
  milestone?: string | null;
  kr: string | null;
  row: string | null;
  from: string | null;
  did: string;
  why: string;
  asked: boolean;
  outcome: string;
  costUsd?: number | null;
  label?: StepLabel;
  labelledAt?: string;
}
export interface PersonaLog {
  wheel: string;
  days: number;
  steps: PersonaStep[];
  /** steps nobody asked for, and of those how many he labelled correct / incorrect: the key result's reading. */
  counts: { steps: number; unasked: number; correct: number; incorrect: number; unlabelled: number };
  file: string;
}

type Labels = Record<string, { label: StepLabel; by?: string; at?: string; why?: string }>;
const day = (d: Date) => d.toISOString().slice(0, 10);

export function readLabels(home: string): Labels {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(home, PERSONA_LOG_LABELS), "utf8")) as { labels?: Labels };
    return v.labels ?? {};
  } catch {
    return {};
  }
}

/** a wheel's steps (an objective id, or `milestone:<id>` for a campaign, or `all`), newest first, with his labels. */
export function readPersonaLog(home: string | undefined, wheel: string, days = 7, now = new Date()): PersonaLog {
  const steps: PersonaStep[] = [];
  const cut = now.getTime() - days * 86_400_000;
  if (home) {
    for (let i = 0; i <= days; i++) {
      const f = path.join(home, PERSONA_LOG_DIR, `${day(new Date(now.getTime() - i * 86_400_000))}.jsonl`);
      let text = "";
      try {
        text = fs.readFileSync(f, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const s = JSON.parse(line) as PersonaStep;
          if (Date.parse(s.at) < cut) continue;
          const mine = wheel === "all" || (wheel.startsWith("milestone:") ? s.milestone === wheel.slice(10) : s.objective === wheel);
          if (mine) steps.push(s);
        } catch {
          /* a broken line is skipped; the file's history says who wrote it */
        }
      }
    }
  }
  const labels = home ? readLabels(home) : {};
  for (const s of steps) {
    const l = labels[s.id];
    if (l) Object.assign(s, { label: l.label, labelledAt: l.at });
  }
  steps.sort((a, b) => b.at.localeCompare(a.at));
  const unasked = steps.filter((s) => !s.asked);
  const correct = unasked.filter((s) => s.label === "correct").length;
  const incorrect = unasked.filter((s) => s.label === "incorrect").length;
  return {
    wheel,
    days,
    steps,
    counts: { steps: steps.length, unasked: unasked.length, correct, incorrect, unlabelled: unasked.length - correct - incorrect },
    file: PERSONA_LOG_DIR,
  };
}

const ABOUT =
  "The owner's labels on the persona log's steps: correct or incorrect, one per run id. Written by his tap on a wheel's Log tab (the console commits it) or scripts/persona_log.py label. Never in a database.";

/** the labels file with one step's label set (or cleared with `clear`); the same shape scripts/persona_log.py writes. */
export function labelEdit(text: string, id: string, label: StepLabel | "clear", by: string, at = new Date()): string {
  let labels: Labels = {};
  try {
    labels = text.trim() ? ((JSON.parse(text) as { labels?: Labels }).labels ?? {}) : {};
  } catch {
    labels = {};
  }
  if (label === "clear") delete labels[id];
  else labels[id] = { label, by, at: at.toISOString().slice(0, 16) + "Z" };
  const sorted = Object.fromEntries(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
  return `${JSON.stringify({ about: ABOUT, labels: sorted }, null, 1)}\n`;
}

export const isStepId = (v: unknown): v is string => typeof v === "string" && /^run_[0-9a-f-]{8,64}$/.test(v);
export const isStepLabel = (v: unknown): v is StepLabel | "clear" => v === "correct" || v === "incorrect" || v === "clear";
