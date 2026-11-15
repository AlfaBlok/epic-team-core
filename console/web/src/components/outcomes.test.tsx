// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import { OutcomesPage, PAGE, punchline, tidyText } from "@/components/outcomes";
import { ClaimChip } from "@/components/tree";
import { rowClaim } from "@/lib/claim";
import type { OutcomesBody } from "@/api/outcome-types";

/** The outcome log opens with its answer and the count per kind, then filters and one line per outcome. */
const BODY: OutcomesBody = {
  outcomes: [
    { at: "2026-11-12T22:40:00.000Z", day: "2026-11-12", kind: "delivered", text: "The One-offs page is live.", row: "E907-S21", product: "EpicTeam", persona: "Ticket worker", repo: "app", source: "run", link: "https://team.example/one-offs", runId: "run_1" },
    { at: "2026-11-12T21:10:00.000Z", day: "2026-11-12", kind: "learning", text: "L-60 added.", row: "E907-S19", product: "EpicTeam", persona: "Delivery manager", repo: "app", source: "backfill" },
  ],
  counts: { delivered: 1, learning: 1 },
  kinds: ["delivered", "learning", "merged", "folded", "superseded", "released", "fixed", "asked", "other"],
  facets: { persona: ["Delivery manager", "Ticket worker"], product: ["EpicTeam"], kind: ["delivered", "learning"], day: ["2026-11-12"], repo: ["app"] },
};

describe("outcomes page", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("leads with the answer and the kinds, lists each outcome, and a kind box filters", async () => {
    const spy = vi.spyOn(api, "listOutcomes").mockResolvedValue(BODY);
    render(
      <MemoryRouter initialEntries={["/outcomes?day=2026-11-12"]}>
        <OutcomesPage />
      </MemoryRouter>,
    );
    expect((await screen.findByTestId("outcomes-punchline")).textContent).toBe("2 outcomes on 2026-11-12 from 2 personas: 1 delivered, 1 learning added.");
    expect(spy).toHaveBeenCalledWith({ day: "2026-11-12" });
    const lines = within(screen.getByTestId("outcomes-list")).getAllByTestId("outcome");
    expect(lines.map((l) => l.dataset.row)).toEqual(["E907-S21", "E907-S19"]);
    expect(within(lines[0]).getByText("see it").getAttribute("href")).toBe("https://team.example/one-offs");
    const learning = screen.getAllByTestId("outcomes-kind").find((b) => b.dataset.kind === "learning")!;
    fireEvent.click(learning);
    await vi.waitFor(() => expect(spy).toHaveBeenLastCalledWith({ day: "2026-11-12", kind: "learning" }));
  });

  it("opens with the punchline box before the counts and the filters", async () => {
    vi.spyOn(api, "listOutcomes").mockResolvedValue(BODY);
    render(
      <MemoryRouter initialEntries={["/outcomes"]}>
        <OutcomesPage />
      </MemoryRouter>,
    );
    const punch = await screen.findByTestId("outcomes-punchline");
    const order = [punch, screen.getByTestId("outcomes-kinds"), screen.getByTestId("outcomes-filters"), screen.getByTestId("outcomes-list")];
    for (let i = 1; i < order.length; i++) expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("outcomes-end").textContent).toBe("That is all 2 for this filter.");
  });

  it("shows a page of lines at a time and a summary cut mid-word ends with an ellipsis", async () => {
    const many = Array.from({ length: PAGE + 3 }, (_, i) => ({ ...BODY.outcomes[0], row: `E907-S${i}` }));
    vi.spyOn(api, "listOutcomes").mockResolvedValue({ ...BODY, outcomes: many });
    render(
      <MemoryRouter initialEntries={["/outcomes"]}>
        <OutcomesPage />
      </MemoryRouter>,
    );
    await screen.findByTestId("outcomes-list");
    expect(screen.getAllByTestId("outcome")).toHaveLength(PAGE);
    fireEvent.click(screen.getByTestId("outcomes-more"));
    expect(screen.getAllByTestId("outcome")).toHaveLength(PAGE + 3);
    expect(screen.queryByTestId("outcomes-more")).toBeNull();
    const cut = `${"word ".repeat(79)}next: int`;
    expect(tidyText(cut)).toBe(`${"word ".repeat(78)}word next…`);
    expect(tidyText("Short and whole.")).toBe("Short and whole.");
  });

  it("shows what counts for the chosen persona beside its filter, and every persona's in a closed list", async () => {
    const definitions = {
      rule: "An outcome is something now true.",
      personas: [
        { persona: "Ticket worker", counts: "The row's result is live.", doesNot: "Code not live.", examples: ["The page is live."] },
        { persona: "Delivery manager", counts: "A row moved for real.", doesNot: "Workers dispatched.", examples: [] },
      ],
    };
    const spy = vi.spyOn(api, "listOutcomes").mockResolvedValue({ ...BODY, definitions });
    render(
      <MemoryRouter initialEntries={["/outcomes?persona=Ticket%20worker"]}>
        <OutcomesPage />
      </MemoryRouter>,
    );
    const box = await screen.findByTestId("outcomes-definition");
    expect(box.textContent).toContain("What counts as an outcome for Ticket worker");
    expect(box.textContent).toContain("✓ Counts: The row's result is live.");
    expect(box.textContent).toContain("✗ Does not count: Code not live.");
    expect(box.textContent).toContain("Example: “The page is live.”");
    cleanup();
    render(
      <MemoryRouter initialEntries={["/outcomes"]}>
        <OutcomesPage />
      </MemoryRouter>,
    );
    const all = await screen.findByTestId("outcomes-definitions");
    expect(within(all).getAllByTestId("outcome-def").map((d) => d.dataset.persona)).toEqual(["Ticket worker", "Delivery manager"]);
    fireEvent.click(within(all).getByText("Delivery manager"));
    await vi.waitFor(() => expect(spy).toHaveBeenLastCalledWith({ persona: "Delivery manager" }));
  });

  it("says plainly when nothing is logged", () => {
    expect(punchline({ ...BODY, outcomes: [], counts: {} }, { persona: "Writer" })).toBe("No outcome logged by Writer yet.");
  });
});

describe("the claim beside a row", () => {
  afterEach(cleanup);
  it("reads the Owner cell and shows the holder and the lease", () => {
    const owner = "run_1571a767-8eb0-4029-becd-a5fca00e9641 — claimed 2026-11-12T23:02Z, lease until 2026-11-13T01:02Z";
    const now = Date.parse("2026-11-13T00:00:00Z");
    expect(rowClaim(owner, now)).toMatchObject({ by: "run_1571a767-8eb0-4029-becd-a5fca00e9641", until: "2026-11-13T01:02Z", past: false });
    expect(rowClaim("unassigned")).toBeUndefined();
    render(<ClaimChip owner={owner} now={now} />);
    expect(screen.getByTestId("row-claim").textContent).toBe("claimed by run_1571a767 until 01:02Z");
    cleanup();
    render(<ClaimChip owner={owner} status="done (fed E907-A1)" now={now} />);
    expect(screen.queryByTestId("row-claim")).toBeNull();
  });
});
