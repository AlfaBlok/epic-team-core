import type { PendingItem } from "@/api";
import { StatusItemRow } from "@/components/waiting";

/**
 * the Stalled line under a goal's header strip: a goal whose team is off. E948-S204 (the owner, closing E948-S200 24 Nov:
 * "a stalled-team card asks Should a team member work on it? and offers Switch on, not Yes and No"): it is the inbox's
 * own card, one frame for every kind. Its question in his words, Switch on (the Personas tab's assignment switch, written
 * to the repo), Leave it off (pauses the goal, written to the repo too) and the free note box.
 */
export function StalledActions({ item }: { item: PendingItem }) {
  return (
    <div className="w-full" data-testid="stalled-item">
      <StatusItemRow item={item} />
    </div>
  );
}
