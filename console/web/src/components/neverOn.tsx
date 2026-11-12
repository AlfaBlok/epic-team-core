import { Badge } from "@/components/ui/badge";
import type { Assignment } from "@/api/types";

/** off and never switched on (attached off; Run now alone does not count), told apart from "someone switched it off". */
export function NeverOnBadge({ a }: { a: Pick<Assignment, "enabled" | "neverOn"> }) {
  if (a.enabled || !a.neverOn) return null;
  return (
    <Badge variant="gray" title="Attached off and never switched on: it wakes only by Run now. Each on/off switch is logged in Activity.">
      never on
    </Badge>
  );
}
