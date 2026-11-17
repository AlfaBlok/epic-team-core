// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * E948-S140 iteration 2 (the owner 17 Nov 23:22Z, four green Sent rows stacked on his phone an hour after the release:
 * "Can we only have the last one and then the other ones vanish? How do I need to ask you? I've asked you five times.";
 * on the card, vn_973b3646: "Not working, man. I'm still seeing the last three cards, like four cards on top of this one
 * right now."): answers stored in his browser before the rule shipped carried no `gone`, so every one showed after the
 * reload. The whole inbox now draws at most one Sent row, the newest answer, across every section and list.
 */
const STORE = "inbox.sent.v1";
const old = (slot: string, title: string, minsAgo: number, id: number) => [slot, { id, said: "Closed", title, at: Date.now() - minsAgo * 60_000 }];

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  localStorage.clear();
  vi.resetModules();
});

const page = async () => {
  vi.resetModules();
  const { render, screen } = await import("@testing-library/react");
  const { MemoryRouter } = await import("react-router-dom");
  const { SentOr } = await import("@/components/sentRow");
  const lib = await import("@/lib/sentRows");
  const card = (s: string) => (
    <SentOr key={s} slot={s}>
      <div data-testid={`card-${s}`}>{s}</div>
    </SentOr>
  );
  // two sections, as on his inbox: Done waiting for review and Blocked on you
  render(
    <MemoryRouter>
      <section>{["review:rv_a", "review:rv_b"].map(card)}</section>
      <section>{["ask:c", "status:d", "review:rv_e"].map(card)}</section>
    </MemoryRouter>,
  );
  return { screen, lib };
};

describe("one Sent row in the whole inbox", () => {
  it("four answers stored without gone (an older build) draw one row after a reload: the newest", async () => {
    localStorage.setItem(STORE, JSON.stringify([old("review:rv_a", "Every new sign-up", 40, 1), old("review:rv_b", "Cards show their age", 30, 2), old("ask:c", "The morning talk", 20, 3), old("status:d", "A wheel was said back", 10, 4)]));
    const { screen, lib } = await page();
    const rows = screen.getAllByTestId("sent-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("A wheel was said back");
    // the others stay answered: their cards never come back
    expect(screen.queryByTestId("card-review:rv_a")).toBeNull();
    expect(lib.answeredHere("c")).toBe(true);
    expect(screen.getByTestId("card-review:rv_e")).toBeTruthy();
  });

  it("another tab's newer answer takes this tab's row away", async () => {
    localStorage.setItem(STORE, JSON.stringify([old("review:rv_a", "Mine", 5, 1)]));
    const { screen } = await page();
    expect(screen.getAllByTestId("sent-row")[0].textContent).toContain("Mine");
    const { act } = await import("@testing-library/react");
    const theirs = JSON.stringify([old("review:rv_a", "Mine", 5, 1), old("ask:c", "Theirs", 0, 1)]);
    act(() => {
      localStorage.setItem(STORE, theirs);
      window.dispatchEvent(new StorageEvent("storage", { key: STORE, newValue: theirs }));
    });
    const rows = screen.getAllByTestId("sent-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Theirs");
  });
});
