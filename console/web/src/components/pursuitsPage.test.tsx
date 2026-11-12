// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import { PursuitsPage, SidebarPursuits } from "@/components/pursuits";
import type { PursuitsBody } from "@/api/pursuit-types";

/** The owner's pursuits: his scorecard, the totems one click away, moving or stalled shown. */
const BODY: PursuitsBody = {
  staleDays: 3,
  said: { source: "Log/x.md#^e-1", words: "the worst thing is the stale" },
  pursuits: [
    {
      id: "live",
      name: "Product live",
      greenWhen: "A stranger signs up and pays.",
      state: "red",
      greens: 1,
      total: 2,
      lines: [
        { label: "Healthy", state: "green", value: "yes" },
        { label: "One payment", state: "red", value: "not yet", note: "Pay once with a real card" },
      ],
      totems: [
        { label: "Product deck", url: "https://example.com/deck" },
        { label: "Launch board", url: "/launch" },
        { label: "Social kit", missing: "Only the pictures exist" },
      ],
      motion: "moving",
      lastMove: { at: new Date(Date.now() - 3600_000).toISOString(), repo: "app", subject: "Payment page built" },
    },
    { id: "vault", name: "Secrets kept", greenWhen: "Every login is in the vault.", state: "amber", greens: 0, total: 1, lines: [{ label: "Waiting", state: "amber", value: "1 of 2" }], totems: [], motion: "stalled", lastMove: null },
  ],
};

describe("pursuits", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("the page shows each pursuit's green-when line, its scorecard, its totems and whether it moves", async () => {
    vi.spyOn(api, "listPursuits").mockResolvedValue(BODY);
    render(
      <MemoryRouter>
        <PursuitsPage />
      </MemoryRouter>,
    );
    const [live, vault] = await screen.findAllByTestId("pursuit");
    expect(within(live).getByText("Green when a stranger signs up and pays.")).toBeTruthy();
    expect(within(live).getByTestId("pursuit-state").dataset.state).toBe("red");
    expect(within(live).getByTestId("pursuit-ring").getAttribute("aria-label")).toBe("1 of 2 lines green");
    const lines = within(live).getAllByTestId("pursuit-line");
    expect(lines.map((l) => l.dataset.state)).toEqual(["green", "red"]);
    expect(within(lines[1]).getByText("Pay once with a real card")).toBeTruthy();
    const totems = within(live).getAllByTestId("pursuit-totem");
    expect(totems[0].getAttribute("href")).toBe("https://example.com/deck");
    expect(totems[1].getAttribute("href")).toBe("/launch");
    expect(totems[2].textContent).toBe("Social kit: missing, only the pictures exist");
    expect(within(live).getByTestId("pursuit-motion").textContent).toBe("moving");
    expect(within(live).getByTestId("pursuit-last-move").textContent).toContain("Payment page built");
    expect(within(vault).getByTestId("pursuit-motion").textContent).toBe("stalled");
    expect(within(vault).getByTestId("pursuit-motion").className).toContain("text-destructive");
    expect(screen.getByTestId("pursuits-said").textContent).toContain("the worst thing is the stale");
  });

  it("the sidebar lists each pursuit with moving or stalled and its green lines, linking to its panel", async () => {
    vi.spyOn(api, "listPursuits").mockResolvedValue(BODY);
    render(
      <MemoryRouter>
        <SidebarPursuits />
      </MemoryRouter>,
    );
    const items = await screen.findAllByTestId("sidebar-pursuit");
    expect(items.map((i) => i.getAttribute("href"))).toEqual(["/pursuits#live", "/pursuits#vault"]);
    expect(items.map((i) => within(i).getByTestId("pursuit-motion").textContent)).toEqual(["moving", "stalled"]);
    expect(within(items[0]).getByTestId("sidebar-pursuit-count").textContent).toBe("1/2");
  });

  it("no pursuits: the sidebar shows nothing", async () => {
    const spy = vi.spyOn(api, "listPursuits").mockResolvedValue({ pursuits: [], staleDays: 3 });
    const { container } = render(
      <MemoryRouter>
        <SidebarPursuits />
      </MemoryRouter>,
    );
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
