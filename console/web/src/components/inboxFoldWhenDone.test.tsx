// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { FOLD_AFTER_MS, FoldSection, LandFolded } from "./homeSection";
import { markSent, resetSent } from "@/lib/sentRows";

/**
 * E948-S208 (the owner 25 Nov, vn_7a378324): "when he answers the last card of a section it folds by itself". Every Inbox
 * section is one FoldSection, on both products alike, so this is the one place the rule lives.
 */
function Section({ count }: { count: number | undefined }) {
  const [open, setOpen] = useState(true);
  return (
    <FoldSection title="Blocked on you" count={count} tone="needs-you" testId="blocked" bodyTestId="blocked-body" open={open} onToggle={setOpen}>
      <p>cards</p>
    </FoldSection>
  );
}
const draw = (count: number | undefined, inbox = true) => {
  const r = render(
    <LandFolded.Provider value={inbox}>
      <Section count={count} />
    </LandFolded.Provider>,
  );
  return (n: number | undefined) =>
    r.rerender(
      <LandFolded.Provider value={inbox}>
        <Section count={n} />
      </LandFolded.Provider>,
    );
};
const expanded = () => screen.getByTestId("blocked-toggle").getAttribute("aria-expanded");
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

beforeEach(() => resetSent());
afterEach(() => {
  cleanup();
  resetSent();
});

describe("E948-S208 a section folds when he answers its last card", () => {
  it("his answer empties the section: the green Sent row shows a beat, then the section folds to its heading with 0", async () => {
    const recount = draw(1);
    expect(expanded()).toBe("true");
    markSent("ask:a1", { said: "Approved", title: "The last card" });
    recount(0);
    expect(expanded()).toBe("true"); // the Sent row shows first
    await wait(FOLD_AFTER_MS + 100);
    expect(expanded()).toBe("false");
    expect(screen.queryByTestId("blocked-body")).toBeNull();
    expect(screen.getByTestId("blocked-count").textContent).toBe("0");
  });

  it("a card answered that is not the last keeps the section open", async () => {
    const recount = draw(2);
    markSent("ask:a1", { said: "Approved", title: "One of two" });
    recount(1);
    await wait(FOLD_AFTER_MS + 100);
    expect(expanded()).toBe("true");
  });

  it("a list that empties without his answer (a refetch, another device) stays as it was", async () => {
    const recount = draw(1);
    recount(0);
    await wait(FOLD_AFTER_MS + 100);
    expect(expanded()).toBe("true");
  });

  it("a recount in between (still loading) does not hide the drop from the last known number", async () => {
    const recount = draw(1);
    markSent("ask:a1", { said: "Approved", title: "The last card" });
    recount(undefined);
    recount(0);
    await wait(FOLD_AFTER_MS + 100);
    expect(expanded()).toBe("false");
  });

  it("outside the Inbox (a milestone page, the home lists) nothing folds by itself", async () => {
    const recount = draw(1, false);
    markSent("ask:a1", { said: "Approved", title: "The last card" });
    recount(0);
    await wait(FOLD_AFTER_MS + 100);
    expect(expanded()).toBe("true");
  });

  it("he opens it again with one tap", async () => {
    const recount = draw(1);
    markSent("ask:a1", { said: "Approved", title: "The last card" });
    recount(0);
    await wait(FOLD_AFTER_MS + 100);
    act(() => screen.getByTestId("blocked-toggle").click());
    expect(expanded()).toBe("true");
  });
});
