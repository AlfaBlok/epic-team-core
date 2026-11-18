// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { InboxPlace, LandFolded, useSectionOpen } from "@/components/homeSection";
import { INBOX_LAND, useInboxPlace } from "@/lib/inboxPlace";

/**
 * The owner: the Inbox button opens the Inbox with every section folded, at the top; Back returns to the same open
 * sections and the same scroll place.
 */
function Fold({ name }: { name: string }) {
  const [open, setOpen] = useSectionOpen(name, false);
  return (
    <button type="button" data-testid={name} aria-expanded={open} onClick={() => setOpen(!open)}>
      {name}
    </button>
  );
}
function Inbox() {
  const { place, visit } = useInboxPlace();
  const go = useNavigate();
  return (
    <>
      <button type="button" onClick={() => go("/inbox", { replace: true, state: INBOX_LAND })}>
        Inbox button
      </button>
      <button type="button" onClick={() => go("/inbox?show=review", { replace: true })}>
        a filter
      </button>
      <button type="button" onClick={() => go("/card")}>
        open a card
      </button>
      <InboxPlace.Provider value={place} key={visit}>
        <LandFolded.Provider value>
          <div data-testid="inbox-stack" data-ready="yes">
            <Fold name="blocked" />
            <Fold name="review" />
          </div>
        </LandFolded.Provider>
      </InboxPlace.Provider>
    </>
  );
}
function Card() {
  const go = useNavigate();
  return (
    <>
      <button type="button" onClick={() => go(-1)}>
        Back
      </button>
      <button type="button" onClick={() => go("/inbox", { state: INBOX_LAND })}>
        Inbox button
      </button>
    </>
  );
}
const app = () =>
  render(
    <MemoryRouter initialEntries={["/inbox"]}>
      <Routes>
        <Route path="/inbox" element={<Inbox />} />
        <Route path="/card" element={<Card />} />
      </Routes>
    </MemoryRouter>,
  );
const open = (n: string) => screen.getByTestId(n).getAttribute("aria-expanded");
let scrolls: [number, number][];
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  scrolls = [];
  window.scrollTo = vi.fn((x: number, y: number) => void scrolls.push([x, y])) as never;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const scrollTo = (y: number) =>
  act(() => {
    Object.defineProperty(window, "scrollY", { value: y, configurable: true });
    window.dispatchEvent(new Event("scroll"));
  });
const frames = () => act(() => new Promise((r) => setTimeout(r, 60)));

describe("the Inbox's place", () => {
  it("Back returns to the same open sections and the same scroll place", async () => {
    app();
    expect([open("blocked"), open("review")]).toEqual(["false", "false"]);
    fireEvent.click(screen.getByTestId("review"));
    scrollTo(840);
    await frames();
    fireEvent.click(screen.getByText("open a card"));
    fireEvent.click(screen.getByText("Back"));
    expect([open("blocked"), open("review")]).toEqual(["false", "true"]);
    await frames();
    expect(scrolls.at(-1)).toEqual([0, 840]);
  });

  it("the Inbox button lands folded at the top, from another page and on the Inbox itself", async () => {
    app();
    fireEvent.click(screen.getByTestId("review"));
    scrollTo(500);
    await frames();
    fireEvent.click(screen.getByText("open a card"));
    fireEvent.click(screen.getByText("Inbox button"));
    expect([open("blocked"), open("review")]).toEqual(["false", "false"]);
    expect(scrolls.at(-1)).toEqual([0, 0]);
    fireEvent.click(screen.getByTestId("blocked"));
    expect(open("blocked")).toBe("true");
    // a filter (a same-page replace) keeps what is open
    fireEvent.click(screen.getByText("a filter"));
    expect(open("blocked")).toBe("true");
    // the Inbox button on the Inbox itself (a same-page link replaces, with the land state)
    fireEvent.click(screen.getByText("Inbox button"));
    expect(open("blocked")).toBe("false");
    expect(scrolls.at(-1)).toEqual([0, 0]);
  });
});
