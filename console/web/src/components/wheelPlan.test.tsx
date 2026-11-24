// @vitest-environment jsdom
import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WheelPlanView, wrapWords } from "@/components/wheelPlan";

// the card check (rule 7): a plan is diagrams with short labels; the steps are drawn, the approach folds away.
describe("the drawn plan", () => {
  it("draws each key result's steps as one line of stops ending on green, who and by when under each", () => {
    const { getByTestId, getAllByTestId } = render(
      <WheelPlanView
        title="Memo: Get every channel working"
        keyResults={[{ label: "Every channel posted in the last 7 days" }]}
        plan={{
          present: true,
          line: "Get LinkedIn posting, then replies on Reddit, LinkedIn, YouTube and TikTok, then every channel to the posts a day you set.",
          by: "2026-12-06",
          keyResults: [
            {
              kr: 1,
              steps: [
                { do: "Post on X and read it back", owner: "Ticket worker", by: "2026-11-22", done: true },
                { do: "Make one real post on the Memo [LinkedIn](https://linkedin.com) page through your phone, then one a day", owner: "Ticket worker", by: "2026-11-26" },
              ],
            },
          ],
        } as never}
      />,
    );
    const drawn = getAllByTestId("plan-steps");
    expect(drawn.every((d) => d.tagName.toLowerCase() === "svg")).toBe(true);
    const open = drawn[drawn.length - 1];
    const step = within(open as unknown as HTMLElement).getByTestId("plan-step");
    expect(within(step).getByTestId("plan-step-do").textContent).toBe("Make one real post on the Memo LinkedIn page through your phone, then one a day");
    expect(within(step).getByTestId("plan-step-by").textContent).toBe("26 Nov");
    expect(getByTestId("plan-green").textContent).toBe("Green");
    expect((getByTestId("plan-approach") as HTMLDetailsElement).open).toBe(false);
    expect((getByTestId("plan-done") as HTMLDetailsElement).open).toBe(false);
    expect(getByTestId("plan-source").textContent).toBe("Steps to green, all by 6 Dec.");
  });

  it("breaks a label into lines that fit", () => {
    expect(wrapWords("one two three four", 9)).toEqual(["one two", "three", "four"]);
  });
});
