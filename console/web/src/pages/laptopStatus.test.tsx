// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import { BrowserAuthPage } from "@/pages/BrowserAuth";

/** the Sign-ins page shows whether the laptop egress is online. */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const page = () =>
  render(
    <MemoryRouter>
      <BrowserAuthPage />
    </MemoryRouter>,
  );

describe("T34-S13 laptop online status on Sign-ins", () => {
  it("online: a green badge and since when", async () => {
    vi.spyOn(api, "listAuthSites").mockResolvedValue([]);
    vi.spyOn(api, "listEgress").mockResolvedValue([{ name: "laptop", state: "online", since: new Date(Date.now() - 2 * 3600_000).toISOString() }]);
    page();
    const box = await screen.findByTestId("laptop-status");
    expect(await within(box).findByText("online")).toBeTruthy();
    expect(within(box).getByText(/since/)).toBeTruthy();
  });

  it("offline with hold: a red badge, last seen, and that reads are held", async () => {
    vi.spyOn(api, "listAuthSites").mockResolvedValue([]);
    vi.spyOn(api, "listEgress").mockResolvedValue([
      { name: "decodo", state: "online" },
      { name: "laptop", state: "offline", since: new Date().toISOString(), lastSeen: new Date(Date.now() - 600_000).toISOString(), whenDown: "hold", heldWrites: 3 },
    ]);
    page();
    const box = await screen.findByTestId("laptop-status");
    expect(await within(box).findByText("offline")).toBeTruthy();
    expect(within(box).getByText(/last seen/)).toBeTruthy();
    expect(within(box).getByText(/held until it is back/)).toBeTruthy();
    // the writes the outbox holds for the laptop.
    expect(within(box).getByTestId("held-writes").textContent).toMatch(/3 writes held.*sent when it is back/);
  });

  it("no laptop egress in this world: nothing shown; status unreadable: unknown", async () => {
    vi.spyOn(api, "listAuthSites").mockResolvedValue([]);
    const egress = vi.spyOn(api, "listEgress").mockResolvedValue([{ name: "decodo", state: "online" }]);
    page();
    await screen.findByText("Each sign-in the team makes shows here.");
    await vi.waitFor(() => expect(egress).toHaveBeenCalled());
    expect(screen.queryByTestId("laptop-status")).toBeNull();
    cleanup();
    egress.mockRejectedValue(new Error("browser_unavailable"));
    page();
    const box = await screen.findByTestId("laptop-status");
    expect(await within(box).findByText("unknown")).toBeTruthy();
    expect(within(box).getByText(/could not be read/)).toBeTruthy();
  });
});
