// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { api } from "@/api";
import { TrackersTab } from "./trackersTab";

// the owner: the Applications tracker sits beside Testers; the team's own tests stay on
// it, marked, and out of its count.
describe("a tracker's entries not counted", () => {
  it("counts only the real entries and names the rest in plain words", async () => {
    vi.spyOn(api, "getTrackers").mockResolvedValue({
      wheel: "alpha-live",
      name: "Alpha: Get 5 testers",
      tables: [
        { id: "testers", name: "Testers", columns: ["Name", "Status"], statuses: [], from: "own", open: true, rows: [["A", "signed up"]], counts: [{ status: "signed up", n: 1 }], file: "x" },
        {
          id: "applications", name: "Applications", columns: ["Name", "Status"], statuses: ["applied", "team test"], from: "own", open: true, source: "console:applications",
          rows: [["Ana", "applied"], ["TEST 1", "team test"], ["TEST 2", "team test"]],
          counts: [{ status: "applied", n: 1 }], uncounted: [{ status: "team test", n: 2 }], file: "the console's database",
        },
      ],
    });
    render(<TrackersTab wheel="alpha-live" />);
    const apps = (await screen.findAllByTestId("tracker"))[1];
    expect(apps.getAttribute("data-tracker")).toBe("applications");
    expect(apps.querySelector("[data-testid=tracker-count]")?.textContent).toBe("1 entry: 1 applied, plus 2 not counted: 2 team test");
  });
});
