// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { BOARD_ENTRY, campaignEntries, DirectoryList, objectiveEntries } from "./PhoneDirectory";
import type { ScorecardNode } from "@/api/pursuit-types";

// one phone directory lists everyone he can call, the board first, then each objective's or
// campaign's manager in his order; each Call opens that level's own page with its call starting (?call=1).

afterEach(cleanup);

const node = (id: string, name: string, over: Partial<ScorecardNode> = {}): ScorecardNode =>
  ({ id, kind: "pursuit", name, greens: 1, total: 4, state: "red", spines: [], children: [], rows: [], ...over }) as ScorecardNode;

describe("the phone directory", () => {
  it("lists each objective's manager in his order, folded ones left out, each a prepared call link", () => {
    const e = objectiveEntries([node("acme-live", "Acme: Launch Acme"), node("one-offs", "Hub: Handle one-offs", { foldedInto: "alignment" } as Partial<ScorecardNode>), node("hub-launch", "Hub: Launch Hub", { greens: 1, total: 16 }), node("old", "Old: Parked one", { parked: true })]);
    expect(e.map((x) => x.who)).toEqual(["Launch Acme manager", "Launch Hub manager"]);
    expect(e[1]).toMatchObject({ title: "Hub: Launch Hub", about: "1 of 16 key results green", href: "/sets/hub-launch?call=1", light: "red" });
  });

  it("lists each campaign's manager on its chat with the call starting", () => {
    expect(campaignEntries([{ id: "ms_1", title: "Acme testers" }])).toEqual([{ key: "ms_1", title: "Acme testers", who: "Acme testers manager", href: "/milestones/ms_1?tab=chat&call=1" }]);
  });

  it("draws the board first, then every manager with its own Call, the full name never cut", () => {
    const entries = [BOARD_ENTRY, ...objectiveEntries([node("a", "Cars: Market Mi Proximo Descapotable, the long name kept whole")])];
    render(
      <MemoryRouter>
        <DirectoryList entries={entries} />
      </MemoryRouter>,
    );
    const calls = screen.getAllByTestId("directory-call");
    expect(calls).toHaveLength(2);
    expect(calls[0].getAttribute("href")).toBe("/chat?call=partner");
    expect(calls[0].getAttribute("aria-label")).toBe("Call the Team desk partner");
    expect(screen.getAllByTestId("directory-title")[1].textContent).toBe("Cars: Market Mi Proximo Descapotable, the long name kept whole");
  });
});
