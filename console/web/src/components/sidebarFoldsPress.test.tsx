// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import type { ScorecardNode, ScorecardsBody } from "@/api/pursuit-types";
import { SidebarNav } from "@/components/Layout";

// the Gap finder switched on, so its page is one of Tools' own (the page the card check pressed Tools on).
vi.mock("@/lib/gapFinder", async (orig) => ({ ...(await orig<typeof import("@/lib/gapFinder")>()), useGapFinder: () => ({ on: true }) }));

/**
 * the card check pressed "Tools 17" on /gap-finder/2026-11-16 and nothing happened. A fold opened by
 * itself on one of its own pages could not be folded: every folded group (Tools, Settings; no Other goals fold)
 * answers each press, on every page, its own pages included.
 */
const node = (id: string, name: string, rank: number): ScorecardNode =>
  ({ id, kind: "pursuit", name, rank, greens: 0, total: 1, spines: [], keyResults: [{ label: "One", state: "red", value: "0", kind: "key-result", work: [] }], rows: [], children: [] }) as ScorecardNode;
const body: ScorecardsBody = { nodes: [node("launch", "Acme: 5 testers", 1), node("books", "Books: accounts in order", 2)], spineInfo: {} };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

const PAGES = ["/gap-finder/2026-11-16", "/inbox", "/sets/launch", "/sets/books", "/runs", "/personas", "/"];
const FOLDS = ["nav-pages-toggle", "nav-settings-toggle"]; // the Other goals fold is gone

describe("every folded group of the sidebar opens and folds when pressed", () => {
  for (const page of PAGES) {
    it(`on ${page}`, async () => {
      vi.spyOn(api, "listScorecards").mockResolvedValue(body);
      render(
        <MemoryRouter initialEntries={[page]}>
          <SidebarNav />
        </MemoryRouter>,
      );
      await screen.findByTestId("nav-pages-toggle");
      expect(screen.queryByTestId("nav-other-goals-toggle")).toBeNull();
      for (const id of FOLDS) {
        const before = screen.getByTestId(id).getAttribute("aria-expanded");
        fireEvent.click(screen.getByTestId(id));
        expect(screen.getByTestId(id).getAttribute("aria-expanded"), `${id} first press`).toBe(before === "true" ? "false" : "true");
        fireEvent.click(screen.getByTestId(id));
        expect(screen.getByTestId(id).getAttribute("aria-expanded"), `${id} second press`).toBe(before);
      }
    });
  }

  it("Tools is open by itself on the Gap finder page, and a press folds it", async () => {
    vi.spyOn(api, "listScorecards").mockResolvedValue(body);
    render(
      <MemoryRouter initialEntries={["/gap-finder/2026-11-16"]}>
        <SidebarNav />
      </MemoryRouter>,
    );
    const toggle = await screen.findByTestId("nav-pages-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("nav-gap-finder")).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByTestId("nav-pages-list")).toBeNull();
  });
});
