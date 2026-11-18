import { InactiveObjectives } from "@/components/objectiveSwitch";
import { AnswerBox, WheelsTable, keyResultsOf, lightOf, useGoalSets, useSetInbox } from "@/components/goalSets";

/**
 * The Pursuits page: one row per pursuit (wheel) with its traffic light, each expanding to its key-result table and
 * collapsing again (the owner on the social desk: "expand collapse on each row, and be a list of rows with a traffic
 * light. Remove fluff"). The same table as All objectives' first tab; a pursuit's own page keeps its tabs.
 */
export function PursuitsListPage() {
  const { data, error, loading } = useGoalSets();
  const inbox = useSetInbox(data);
  const nodes = data?.nodes ?? [];
  return (
    <div className="mx-auto grid w-full min-w-0 max-w-5xl gap-3" data-testid="pursuits-list-page">
      {/* one boxed line first, then only the rows (the card check: the first screen opens on its answer). */}
      <AnswerBox
        light={lightOf(nodes.flatMap(keyResultsOf))}
        title="Pursuits"
        testId="pursuits-answer"
        answer={data ? `${nodes.filter((n) => lightOf(keyResultsOf(n)) === "green").length} of ${nodes.length} pursuits green, ${nodes.filter((n) => lightOf(keyResultsOf(n)) === "red").length} red, most important first.` : "Every pursuit, most important first."}
      />
      {loading && !data && <div className="text-sm text-muted-foreground">Reading the pursuits…</div>}
      {error && <div className="text-sm text-destructive">Could not read the pursuits: {error.message}</div>}
      {nodes.length > 0 && <WheelsTable nodes={nodes} countFor={inbox.countFor} />}
      <InactiveObjectives />
    </div>
  );
}
