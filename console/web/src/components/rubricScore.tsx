import type { RunCheck } from "@/api";

const FACTORS = ["reversal", "options", "impact", "evidence"] as const;

/**
 * the confidence rubric a check was judged by: "score 82/75 (reversal 4 · options 3 · impact 3 · evidence 4)",
 * plus the hard-floor items it touches. Nothing for checks from before the rubric.
 */
export function RubricScore({ check }: { check: Pick<RunCheck, "scores" | "rubric" | "floor"> }) {
  const { rubric, scores, floor } = check;
  if (!rubric || !scores) return null;
  return (
    <span className="text-muted-foreground" data-testid="rubric-score" title={`weights ${FACTORS.map((f) => `${f} ${rubric.weights[f]}`).join(", ")} · min factor ${rubric.minFactor} · settings: ${rubric.from}`}>
      {" · "}
      <span className={rubric.clears ? "text-emerald-700 dark:text-emerald-400" : undefined}>
        score {rubric.score}/{rubric.threshold}
      </span>{" "}
      ({FACTORS.map((f) => `${f} ${scores[f]}`).join(" · ")})
      {floor?.length ? <span> · floor: {floor.join(", ")}</span> : null}
    </span>
  );
}
