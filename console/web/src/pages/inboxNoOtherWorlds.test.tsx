// @vitest-environment jsdom
import { forgetWorld } from "@/lib/useSocial";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import { TeamPage } from "@/pages/Team";
import { SidebarNav } from "@/components/Layout";
import { forgetOtherWorlds } from "@/components/otherWorlds";
import { ProjectProvider } from "@/lib/project";
import { SKINS, SkinProvider, type Skin } from "@/lib/skin";

/**
 * the owner ("remove the purple section ... inbox is inbox, filters on"): the console skin's Inbox is the filters, then the
 * expanders, with no other-world band between them and no violet count beside Inbox in the menu. The social skin keeps its
 * own band (socialHomeHomeFirst).
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  forgetOtherWorlds();
});
beforeEach(() => (localStorage.clear(), forgetWorld(), forgetOtherWorlds()));
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const worlds = {
  worlds: [{ tenantId: "social-world", tenantName: "Sam", app: "SocialApp", appUrl: "https://cloud.example.com", items: [{ key: "ask:a", kind: "ask" as const, id: "a", title: "Old account ask (Sam", openUrl: "https://cloud.example.com/" }] }],
};
const at = (ui: React.ReactNode, skin: Skin, path = "/inbox") =>
  render(
    <SkinProvider skin={skin}>
      <MemoryRouter initialEntries={[path]}>
        <ProjectProvider>{ui}</ProjectProvider>
      </MemoryRouter>
    </SkinProvider>,
  );

describe("the console skin's Inbox has no other-world panel", () => {
  it("the Inbox shows the filters then Blocked, and nothing of the other world", async () => {
    vi.spyOn(api, "listCompanyWorlds").mockResolvedValue(worlds);
    at(<TeamPage />, SKINS.console);
    await screen.findByText(/Blocked on you/);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId("other-world")).toBeNull();
    expect(screen.queryByText(/SocialApp waits on you/)).toBeNull();
    expect(screen.queryByText(/Old account ask/)).toBeNull();
    // the laptop switch opens the Blocked section, inside it, not as a box between the filters and the sections
    const laptop = await screen.findByTestId("laptop-switch");
    expect(screen.getByTestId("waiting-on-you").contains(laptop)).toBe(true);
  });

  it("the menu's Inbox carries no violet other-world count in the console skin, and keeps it in the social skin", async () => {
    vi.spyOn(api, "listCompanyWorlds").mockResolvedValue(worlds);
    at(<SidebarNav />, SKINS.console, "/");
    await screen.findByTestId("nav-inbox");
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId("other-world-pill")).toBeNull();
    cleanup();
    forgetOtherWorlds();
    at(<SidebarNav />, SKINS.social, "/");
    expect((await screen.findByTestId("other-world-pill")).textContent).toBe("1");
  });
});
