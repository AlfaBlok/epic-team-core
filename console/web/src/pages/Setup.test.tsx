// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppRoutes } from "@/App";
import { SidebarNav } from "@/components/Layout";
import { SKINS, SkinProvider, type Skin } from "@/lib/skin";
import { reachSites, setupConnections } from "@/pages/Setup";
import { api, type AuthSite, type Milestone } from "@/api";
import { mockCampaignCard } from "@/api/mockCampaigns";

afterEach(cleanup);

const routeAt = (path: string, skin: Skin) =>
  render(
    <SkinProvider skin={skin}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </SkinProvider>,
  );

const now = new Date("2026-10-26T12:00:00Z");
const campaigns = [mockCampaignCard()];
const site = (p: Partial<AuthSite>): AuthSite => ({
  id: "s",
  pattern: "x.com",
  domains: ["x.com"],
  cookieCount: 3,
  sourceBrowser: "chrome",
  sourceProfile: "Default",
  syncedAt: "2026-10-20T00:00:00Z",
  ...p,
});

describe("T24-S3 setupConnections", () => {
  it("reads the world's repo and each site's sign-in into connected / expired / missing", () => {
    const list = setupConnections({
      campaigns,
      now,
      sites: [
        site({ id: "a", pattern: "x.com", loginExpiry: "2027-01-01T00:00:00Z" }),
        site({ id: "b", pattern: "*.reddit.com", domains: [".reddit.com"], loginExpiry: "2026-10-01T00:00:00Z" }),
      ],
    });
    expect(list.map((c) => [c.id, c.state])).toEqual([
      ["github", "connected"],
      ["x", "connected"],
      ["reddit", "expired"],
      ["linkedin", "missing"],
    ]);
    expect(list[0].detail).toBe("memo-ai/social");
    for (const c of list) expect(c.steps.length).toBeGreaterThan(0);
  });

  it("a sign-in the site rejected reads as expired; a repo without a remote as missing", () => {
    const list = setupConnections({
      campaigns: [{ ...campaigns[0], remote: undefined }],
      now,
      sites: [site({ pattern: "*.linkedin.com", domains: ["www.linkedin.com"], session: "dead", sessionReason: "login redirect" })],
    });
    expect(list.find((c) => c.id === "github")!.state).toBe("missing");
    expect(setupConnections({ campaigns: [], sites: [], sitesUnavailable: true })[1].detail).toMatch(/could not be read/);
    const li = list.find((c) => c.id === "linkedin")!;
    expect(li.state).toBe("expired");
    expect(li.detail).toContain("login redirect");
  });

  it("E22-1: a world with no campaign repo shows No repository yet; two campaigns show both remotes", () => {
    const none = setupConnections({ campaigns: [], sites: [] })[0];
    expect([none.state, none.detail]).toEqual(["missing", "No repository yet"]);
    const two = setupConnections({ campaigns: [campaigns[0], { ...campaigns[0], repo: "pod-campaign", remote: "Acme/pod-campaign" }], sites: [] })[0];
    expect(two.detail).toBe("memo-ai/social · Acme/pod-campaign");
  });
});

describe("Setup reads every browser the team reads (GET /api/auth/reach)", () => {
  it("a borrowed sign-in counts as connected and says whose browser it is; the world's own wins over it", () => {
    const reach = {
      sources: [
        { world: "social", own: true, sites: [] },
        { world: "acme", own: false, sites: [site({ id: "x", pattern: "*.x.com", domains: [".x.com"] }), site({ id: "r", pattern: "*.reddit.com", domains: [".reddit.com"] })] },
      ],
    };
    const list = setupConnections({ campaigns, now, ...(({ sites, unavailable }) => ({ sites, sitesUnavailable: unavailable }))(reachSites(reach)) });
    expect(list.map((c) => [c.id, c.state])).toEqual([
      ["github", "connected"],
      ["x", "connected"],
      ["reddit", "connected"],
      ["linkedin", "missing"],
    ]);
    expect(list[1].detail).toMatch(/shared from acme's team browser$/);
    reach.sources[0].sites = [site({ id: "own", pattern: "x.com", syncedAt: "2026-10-01T00:00:00Z" })] as never;
    expect(setupConnections({ campaigns, now, sites: reachSites(reach).sites })[1].detail).not.toContain("shared");
  });

  it("unreadable only when every browser failed (or the call did)", () => {
    expect(reachSites(undefined).unavailable).toBe(true);
    expect(reachSites({ sources: [{ world: "a", own: true, sites: [], error: "down" }] }).unavailable).toBe(true);
    expect(reachSites({ sources: [{ world: "a", own: true, sites: [], error: "down" }, { world: "b", own: false, sites: [] }] }).unavailable).toBe(false);
    expect(reachSites({ sources: [] }).unavailable).toBe(false);
  });
});

describe("E22-1 setup reads the world's own repo, never another world's milestone", () => {
  afterEach(() => vi.restoreAllMocks());

  it("asks the caller's world's campaigns; acme milestones in the global list never reach the card", async () => {
    const asked: string[] = [];
    vi.spyOn(api as Required<typeof api>, "getMe").mockResolvedValue({ mode: "on", identity: { kind: "session", tenantId: "social" }, tenant: { id: "social" } } as never);
    vi.spyOn(api, "listCampaigns").mockImplementation(async (id: string) => {
      asked.push(id);
      return { tenantId: id, campaigns: [] };
    });
    // what shadow returned on the social site: the home world milestone on the infra repo first in the list
    vi.spyOn(api, "listMilestones").mockResolvedValue([{ id: "a9", repo: "Acme/ops", title: "Memo launch" }] as Milestone[]);
    routeAt("/setup", SKINS.social);
    expect(await screen.findByText("No repository yet")).toBeTruthy();
    expect(new Set(asked)).toEqual(new Set(["social"])); // the page and the menu's Setup count ask the same world
    expect(screen.getByTestId("setup-github").dataset.state).toBe("missing");
    expect(screen.queryByText(/ops/)).toBeNull();
  });
});

describe("T24-S3 setup screen sits behind the social skin", () => {
  it("renders in the social skin: four connections, states and steps, Connect disabled", async () => {
    routeAt("/setup", SKINS.social);
    expect(await screen.findByText("Set up your team")).toBeTruthy();
    for (const id of ["github", "x", "reddit", "linkedin"]) expect(screen.getByTestId(`setup-${id}`)).toBeTruthy();
    // The mock world's first milestone is on GitHub (owner/name) and it has no browser sign-ins yet.
    expect(screen.getByTestId("setup-github").dataset.state).toBe("connected");
    expect(screen.getByTestId("setup-x").dataset.state).toBe("missing");
    expect(screen.getByText(/1 of 4 connected/)).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: /^(Re)?[Cc]onnect$/ });
    expect(buttons).toHaveLength(4);
    for (const b of buttons) expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole("link", { name: "Browser auth" }).every((a) => a.getAttribute("href") === "/auth")).toBe(true); // the console name
  });

  it("is absent in the console skin: no route, no nav link; social: in the menu while something is unconnected (T58-S3)", async () => {
    routeAt("/setup", SKINS.console);
    expect(screen.getByText(/Not found\./)).toBeTruthy();
    cleanup();
    const { container } = render(
      <MemoryRouter>
        <SidebarNav />
      </MemoryRouter>,
    );
    expect(container.querySelector('a[href="/setup"]')).toBeNull();
    cleanup();
    const social = render(
      <SkinProvider skin={SKINS.social}>
        <MemoryRouter>
          <SidebarNav />
        </MemoryRouter>
      </SkinProvider>,
    );
    await waitFor(() => expect(social.container.querySelector('a[href="/setup"]')).toBeTruthy());
    expect(social.container.querySelector('[data-testid="setup-left"]')?.textContent).toBe("3 to connect");
  });
});
