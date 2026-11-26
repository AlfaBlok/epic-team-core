// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useSharedQuery } from "@/lib/data";
import { resetInboxHold } from "@/lib/inboxHold";
import { resetNewCards } from "@/lib/inboxNew";
import { InboxNewLine } from "@/components/InboxNewLine";

/**
 * The owner chose "Yes: trim the asks next" after the slow-phone fix (the phone downloaded all 423 asks, about 115 KB, for
 * about 20 open ones): the inbox's first draw reads only the open asks; the whole list (answered, done, superseded) comes
 * right after, never as "N new", and a folded history section shows "…" until then.
 */
afterEach(() => {
  cleanup();
  resetInboxHold();
  resetNewCards();
  sessionStorage.clear();
});

type It = { id: string; state: string };
let calls: string[] = [];
let whole: It[] = [];
const openOnes = () => whole.filter((x) => x.state === "open");

function List({ k }: { k: string }) {
  const q = useSharedQuery<It[]>(
    k,
    () => (calls.push("whole"), Promise.resolve(whole.map((x) => ({ ...x })))),
    { tag: "inbox", first: () => (calls.push("open"), Promise.resolve(openOnes().map((x) => ({ ...x })))) },
  );
  return (
    <div>
      <span data-testid="partial">{String(q.partial)}</span>
      <span data-testid="n">{q.data?.length ?? "-"}</span>
      <button data-testid="rest" onClick={() => q.loadRest()} />
    </div>
  );
}
const page = (k: string) =>
  render(
    <MemoryRouter initialEntries={[{ pathname: "/inbox" }]}>
      <InboxNewLine visit="v1" />
      <List k={k} />
    </MemoryRouter>,
  );

describe("the inbox draws its open asks first", () => {
  it("first the open asks, then the whole list after a pause, with no 'N new' line for the history", async () => {
    calls = [];
    whole = [
      { id: "o1", state: "open" },
      { id: "o2", state: "open" },
      ...Array.from({ length: 40 }, (_, n) => ({ id: `h${n}`, state: n % 2 ? "done" : "answered" })),
    ];
    page("first-then-whole");
    await waitFor(() => expect(screen.getByTestId("n").textContent).toBe("2"));
    expect(screen.getByTestId("partial").textContent).toBe("true");
    expect(calls).toEqual(["open"]);
    // the whole list follows by itself
    await waitFor(() => expect(screen.getByTestId("n").textContent).toBe("42"), { timeout: 4000 });
    expect(screen.getByTestId("partial").textContent).toBe("false");
    expect(calls).toEqual(["open", "whole"]);
    expect(screen.queryByTestId("inbox-new-line")).toBeNull();
  });

  it("opening a history fold asks for the whole list at once", async () => {
    calls = [];
    whole = [
      { id: "o1", state: "open" },
      { id: "h1", state: "answered" },
    ];
    page("rest-on-open");
    await waitFor(() => expect(screen.getByTestId("n").textContent).toBe("1"));
    await act(async () => {
      screen.getByTestId("rest").click();
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(screen.getByTestId("n").textContent).toBe("2");
    expect(calls).toEqual(["open", "whole"]);
  });

  it("an open card that arrived meanwhile still waits behind the 'N new' line", async () => {
    calls = [];
    whole = [
      { id: "o1", state: "open" },
      { id: "h1", state: "done" },
    ];
    page("new-open-card");
    await waitFor(() => expect(screen.getByTestId("n").textContent).toBe("1"));
    whole = [{ id: "fresh", state: "open" }, ...whole];
    await act(async () => {
      screen.getByTestId("rest").click();
      await new Promise((r) => setTimeout(r, 5));
    });
    // parked whole: the screen keeps what it shows, the line names the one new card
    expect(screen.getByTestId("n").textContent).toBe("1");
    await waitFor(() => expect(screen.getByTestId("inbox-new-line").textContent).toMatch(/1 new/));
  });
});
