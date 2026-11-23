/**
 * One colour order for every ring, donut, segmented bar, count and list: all the greens together, then the
 * ambers, then the reds, left to right (the owner 22 Nov, vn_68cda1fe: "green first, then yellow, then red"), then no reading (grey, blue, unknown). A stable sort, so items of one colour keep
 * their own order and each colour is one continuous arc.
 * Its twin for the generated pages is scripts/ring_order.py: keep the two in step.
 */
export const RING_ORDER = ["green", "amber", "yellow", "red", "grey", "gray", "blue", "unknown"] as const;

const RANK: Record<string, number> = Object.fromEntries(RING_ORDER.map((s, i) => [s, i]));

/** where a state sits in the ring; any state not named goes last. */
export function ringRank(state: string | undefined | null): number {
  return RANK[String(state ?? "unknown").toLowerCase()] ?? RING_ORDER.length;
}

/** the items sorted by colour (green, amber, red, no reading), each colour together; the input is not changed. */
export function byRingColour<T extends { state?: string | null }>(items: readonly T[]): T[] {
  return items
    .map((x, i) => [x, i] as const)
    .sort((a, b) => ringRank(a[0].state) - ringRank(b[0].state) || a[1] - b[1])
    .map(([x]) => x);
}
