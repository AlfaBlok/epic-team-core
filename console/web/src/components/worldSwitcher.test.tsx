// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api as client, type ApiClient } from "@/api";
import { WorldSwitcher } from "./Layout";
import { forgetWorld } from "@/lib/useSocial";

/** The optional methods the switcher calls, as required ones (vi.spyOn needs them present). */
const api = client as Required<ApiClient>;

/** the bottom-left world switcher: every world of the login with its counts, one click switches. */
describe("T77-S1 world switcher", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("lists each world with its red and green, marks the current one, and one click switches to another", async () => {
    vi.spyOn(api, "getWorldCounts").mockResolvedValue({
      worlds: [
        { tenantId: "acme", tenantName: "acme", role: "owner", current: true, needsYou: 3, review: 2 },
        { tenantId: "e77-test", tenantName: "E977 test world", role: "member", current: false, needsYou: 1, review: 0 },
      ],
    });
    const sw = vi.spyOn(api, "switchWorld").mockResolvedValue(undefined as never);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    render(
      <MemoryRouter>
        <WorldSwitcher />
      </MemoryRouter>,
    );
    const here = await screen.findByTestId("world-acme");
    expect(here.getAttribute("aria-current")).toBe("true");
    expect((here as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("world-acme-needs-you").textContent).toBe("3");
    expect(screen.getByTestId("world-acme-review").textContent).toBe("2");
    expect(screen.getByTestId("world-e77-test-needs-you").textContent).toBe("1");
    expect(screen.queryByTestId("world-e77-test-review")).toBeNull(); // nothing at 0
    fireEvent.click(screen.getByTestId("world-e77-test"));
    expect(screen.getByTestId("world-e77-test").textContent).toContain("Switching…");
    await waitFor(() => expect(sw).toHaveBeenCalledWith("e77-test"));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    vi.unstubAllGlobals();
  });

  it("T77-S3: sits in the flow of the menu (not pinned) and says what a world is", async () => {
    vi.spyOn(api, "getWorldCounts").mockResolvedValue({
      worlds: [
        { tenantId: "acme", tenantName: "acme", role: "owner", current: true, needsYou: 0, review: 0 },
        { tenantId: "memo-social", tenantName: "Memo social", role: "member", current: false, needsYou: 0, review: 0 },
      ],
    });
    render(
      <MemoryRouter>
        <WorldSwitcher />
      </MemoryRouter>,
    );
    const box = await screen.findByTestId("world-switcher");
    expect(box.className).not.toMatch(/sticky|fixed/);
    expect(box.textContent).toContain("Your worlds");
    expect(screen.getByTestId("world-switcher-hint").textContent).toBe("Each world is a separate home with its own team.");
  });

  it("T77-S3 round 3: a world on the other host opens through the link the switch answers", async () => {
    vi.spyOn(api, "getWorldCounts").mockResolvedValue({
      worlds: [
        { tenantId: "acme", tenantName: "acme", role: "owner", current: true, needsYou: 0, review: 0 },
        { tenantId: "memo-social", tenantName: "Memo social", role: "owner", current: false, needsYou: 2, review: 1 },
      ],
    });
    const link = "https://social.example.com/login#handoff=abc";
    vi.spyOn(api, "switchWorld").mockResolvedValue({ handoff: link } as never);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    render(
      <MemoryRouter>
        <WorldSwitcher />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByTestId("world-memo-social"));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(link));
    vi.unstubAllGlobals();
  });

  it("hides itself for a login with one world", async () => {
    const spy = vi.spyOn(api, "getWorldCounts").mockResolvedValue({ worlds: [{ tenantId: "x", tenantName: "x", role: "owner", current: true, needsYou: 0, review: 0 }] });
    const { container } = render(
      <MemoryRouter>
        <WorldSwitcher />
      </MemoryRouter>,
    );
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(container.querySelector("[data-testid=world-switcher]")).toBeNull();
  });
});

describe("T77-S1 world marks", () => {
  it("tells the product worlds apart", async () => {
    const { worldMark, worldTint } = await import("./Layout");
    expect(["EpicTeam", "SocialApp", "Memo", "acme", "Memo social", "E977 test world B"].map(worldMark)).toEqual(["ET", "SA", "M", "A", "MS", "EB"]);
    expect(worldTint("acme")).toBe(worldTint("acme"));
  });
});

describe("T77-S3 menu order", () => {
  afterEach(cleanup);
  it("puts the worlds last, under the account block", async () => {
    const { SidebarNav } = await import("./Layout");
    render(
      <MemoryRouter>
        <SidebarNav />
      </MemoryRouter>,
    );
    const worlds = await screen.findByTestId("world-switcher");
    const account = await screen.findByTestId("account-block");
    expect(account.compareDocumentPosition(worlds) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(worlds.nextElementSibling).toBeNull();
  });

  // the owner 17 Nov (vn_c149df3a): an EpicTeam customer account makes a new workspace from the menu
  it("a customer workspace shows Your workspaces even with one, and New workspace makes one and opens it", async () => {
    forgetWorld();
    vi.spyOn(api, "getMe").mockResolvedValue({ mode: "on", identity: { kind: "user" }, tenant: { id: "et-dana", name: "Dana's team", skin: "console" }, worlds: [] } as never);
    vi.spyOn(api, "getWorldCounts").mockResolvedValue({ worlds: [{ tenantId: "et-dana", tenantName: "Dana's team", role: "owner", current: true, needsYou: 0, review: 0 }] });
    const nw = vi.spyOn(api, "newWorkspace").mockResolvedValue({ tenantId: "et-dana-side", name: "Side project", made: true });
    const sw = vi.spyOn(api, "switchWorld").mockResolvedValue(undefined as never);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    render(
      <MemoryRouter>
        <WorldSwitcher />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByTestId("new-workspace"));
    expect(screen.getByTestId("world-switcher").textContent).toContain("Your workspaces");
    expect(screen.getByTestId("world-switcher").textContent).not.toMatch(/world/i);
    fireEvent.change(screen.getByTestId("new-workspace-name"), { target: { value: "Side project" } });
    fireEvent.click(screen.getByTestId("new-workspace-make"));
    await waitFor(() => expect(nw).toHaveBeenCalledWith("et-dana", "Side project"));
    await waitFor(() => expect(sw).toHaveBeenCalledWith("et-dana-side"));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    vi.unstubAllGlobals();
  });
});
