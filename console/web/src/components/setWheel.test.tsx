// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SetWheel, ringArcs } from "@/components/goalSets";

/**
 * The owner's ask, 22 Nov 20:46Z: the ring is one continuous circle whose arcs show the share of green, then yellow,
 * then red key results, no gaps. Grey (not measured) is placed after red, the last arc before the circle closes.
 */
afterEach(cleanup);
const rows = (...s: ("green" | "amber" | "red" | "unknown")[]) => s.map((state) => ({ state }));

describe("ringArcs", () => {
  it("one arc per colour, sized by share, green then yellow then red then grey, end to end with no gap", () => {
    const arcs = ringArcs(rows("red", "green", "unknown", "amber", "green", "red", "red", "green"), 100);
    expect(arcs.map((a) => a.state)).toEqual(["green", "amber", "red", "unknown"]);
    expect(arcs.map((a) => a.share)).toEqual([3 / 8, 1 / 8, 3 / 8, 1 / 8]);
    let at = 0;
    for (const a of arcs) {
      expect(a.offset).toBeCloseTo(at, 9); // each arc starts exactly where the one before ends
      at += a.length;
    }
    expect(at).toBeCloseTo(100, 9); // together they close the circle
  });
  it("the share, never the count, sets an arc: 6 rows read the same as 3 with the same mix", () => {
    const a = ringArcs(rows("green", "red", "red"), 90).map((x) => x.length);
    const b = ringArcs(rows("green", "green", "red", "red", "red", "red"), 90).map((x) => x.length);
    expect(a).toEqual(b);
  });
  it("no rows, no arcs", () => expect(ringArcs([], 100)).toEqual([]));
});

describe("SetWheel", () => {
  it("draws one circle per colour present, a single colour as a whole circle", () => {
    const { container } = render(<SetWheel rows={rows("green", "red", "green", "amber")} />);
    expect([...container.querySelectorAll("[data-arc]")].map((c) => c.getAttribute("data-arc"))).toEqual(["green", "amber", "red"]);
    cleanup();
    const one = render(<SetWheel rows={rows("red", "red")} testId="w" />).container.querySelectorAll("[data-arc]");
    expect(one).toHaveLength(1);
    expect(one[0].getAttribute("stroke-dasharray")).toBeNull();
    expect(screen.getByTestId("w").getAttribute("aria-label")).toBe("0 of 2 rows green");
  });
});
