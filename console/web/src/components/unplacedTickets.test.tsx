// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { UnplacedTickets } from "./goalSets";

/** an objective's open tickets that hang under no key result show under its key results. */
describe("tickets under no key result", () => {
  it("lists each open ticket no key result lists, with a link to its epic", () => {
    render(
      <MemoryRouter>
        <UnplacedTickets setId="obj" node={{ keyResults: [{ label: "K", kind: "key-result", state: "red", value: "0" }], unplaced: [{ code: "E901-S3", repo: "app", title: "Builds the thing", status: "ready", kind: "ticket", epicCode: "EPIC-901" }, { code: "E901-S4", repo: "app", status: "review", kind: "ticket" }] }} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("unplaced").textContent).toContain("2 open tickets hang under no key result");
    const items = screen.getAllByTestId("unplaced-item");
    expect(items).toHaveLength(2);
    expect(items[0].querySelector("a")).not.toBeNull();
    expect(items[1].textContent).toContain("in review");
  });

  it("says every ticket hangs under one when none is loose, and nothing without key results", () => {
    const { rerender } = render(
      <MemoryRouter>
        <UnplacedTickets setId="obj" node={{ keyResults: [{ label: "K", kind: "key-result", state: "red", value: "0" }] }} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("unplaced-none").textContent).toBe("Every open ticket hangs under a key result.");
    rerender(
      <MemoryRouter>
        <UnplacedTickets setId="obj" node={{}} />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId("unplaced-none")).toBeNull();
  });
});
