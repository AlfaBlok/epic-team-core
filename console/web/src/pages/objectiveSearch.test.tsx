// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import { AppRoutes } from "@/App";
import type { ScorecardNode, ScorecardsBody } from "@/api/pursuit-types";
import { keyResultsOf } from "@/components/goalSets";
import { SKINS, SkinProvider } from "@/lib/skin";
import { forgetWorld } from "@/lib/useSocial";
import { searchObjectives } from "@/lib/objectiveSearch";

/**
 * The owner 22 Nov 23:12Z (vn_de2da36f): "We need to have a search feature that searches across all the
 * objectives and all the key results and all the tickets attached to them. It should be ... in the top left section
 * with inbox, chat, runs, messages". Each result links straight to its place.
 */
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const node = (id: string, name: string, krs: ScorecardNode["keyResults"], unplaced?: ScorecardNode["unplaced"]): ScorecardNode => ({
  id,
  kind: "pursuit",
  name,
  greens: 0,
  total: krs?.length ?? 0,
  spines: [],
  children: [],
  rows: [],
  keyResults: krs,
  unplaced,
});

const BODY: ScorecardsBody = {
  spineInfo: {},
  nodes: [
    node("house", "House: Buy a house", [
      { label: "Shortlist of flats in Condesá", kind: "key-result", state: "amber", value: "3", target: "10", work: [{ code: "E970-S4", repo: "app", title: "Scrape listings in Roma and Condesa", status: "active", kind: "ticket", epicCode: "EPIC-970" }] },
      { label: "Mortgage pre-approved", kind: "key-result", state: "red", value: "no", work: [] },
    ]),
    node("understand", "EpicTeam: Get the team to understand me", [
      { label: "He finds anything in one search", kind: "key-result", state: "unknown", value: "", work: [{ code: "E948-S181", repo: "app", title: "A Search item in the sidebar", status: "active", kind: "ticket", epicCode: "EPIC-948" }, { code: "E948-S64", repo: "app", title: "Search at the top of the inbox", status: "done (approved)", kind: "ticket", epicCode: "EPIC-948" }] },
    ], [{ code: "E948-S99", repo: "app", title: "Old search idea", status: "ready", kind: "ticket" }]),
  ],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => {
  localStorage.clear();
  forgetWorld();
  Element.prototype.scrollIntoView = vi.fn();
});

describe("searchObjectives: one search across objectives, key results and tickets", () => {
  it("finds each kind, any case, accents ignored, every word must appear", () => {
    const r = searchObjectives(BODY.nodes, "condesa", keyResultsOf);
    expect(r.objectives).toEqual([]);
    expect(r.keyResults.map((k) => k.label)).toEqual(["Shortlist of flats in Condesá"]);
    expect(r.tickets.map((t) => t.code)).toEqual(["E970-S4"]);
    expect(searchObjectives(BODY.nodes, "HOUSE", keyResultsOf).objectives.map((o) => o.id)).toEqual(["house"]);
    expect(searchObjectives(BODY.nodes, "search sidebar", keyResultsOf).tickets.map((t) => t.code)).toEqual(["E948-S181"]);
    expect(searchObjectives(BODY.nodes, "e948-s181", keyResultsOf).total).toBe(1);
    expect(searchObjectives(BODY.nodes, "x", keyResultsOf).total).toBe(0);
  });
  it("links each hit to its place, and lists open tickets before closed ones", () => {
    const r = searchObjectives(BODY.nodes, "search", keyResultsOf);
    expect(r.keyResults[0].href).toBe("/sets/understand?kr=He+finds+anything+in+one+search");
    expect(r.tickets.map((t) => t.code)).toEqual(["E948-S181", "E948-S99", "E948-S64"]);
    expect(r.tickets[0].href).toBe("/sets/understand?kr=He+finds+anything+in+one+search&row=E948-S181");
    // a ticket under no key result yet opens its objective with its line marked
    expect(r.tickets[1].href).toBe("/sets/understand?row=E948-S99");
    expect(r.tickets[0].state).toBe("amber");
    expect(r.tickets[2].state).toBe("green");
  });
});

describe("the Search page and its sidebar item", () => {
  const at = (path: string) => {
    vi.spyOn(api, "listScorecards").mockResolvedValue(BODY);
    return render(
      <SkinProvider skin={SKINS.console}>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </SkinProvider>,
    );
  };

  it("Search sits in the sidebar's top group with Inbox, Chat and Runs, right after Runs (Inbox stays first)", async () => {
    at("/inbox");
    const nav = (await screen.findAllByTestId("nav-main"))[0];
    const links = [...nav.querySelectorAll("a")].map((a) => a.getAttribute("data-testid"));
    expect(links.indexOf("nav-search")).toBe(links.indexOf("nav-runs") + 1);
    expect(links.indexOf("nav-inbox")).toBeLessThan(links.indexOf("nav-search"));
    expect(within(nav).getByTestId("nav-search").getAttribute("href")).toBe("/search");
  });

  it("typing a word shows the three groups with their state; a ticket opens its key result with its line marked", async () => {
    at("/search");
    const box = await screen.findByTestId("objective-search-input");
    fireEvent.change(box, { target: { value: "search" } });
    await waitFor(() => expect(screen.getByTestId("objective-search-line").textContent).toBe("0 objectives · 1 key result · 3 tickets"));
    expect(screen.getAllByTestId("hit-ticket").map((a) => a.getAttribute("data-state"))).toEqual(["amber", "amber", "green"]);
    fireEvent.click(screen.getAllByTestId("hit-ticket")[0]);
    const marked = await waitFor(() => {
      const el = document.querySelector('[data-marked="1"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(marked.textContent).toContain("E948-S181");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("says so when nothing matches, and the words stay in the address", async () => {
    at("/search?q=zebra");
    expect(((await screen.findByTestId("objective-search-input")) as HTMLInputElement).value).toBe("zebra");
    await waitFor(() => expect(screen.getByTestId("objective-search-line").textContent).toBe("Nothing matches “zebra”."));
  });
});
