// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { api } from "@/api";
import { PURSUIT_KIT_PATH, PURSUIT_PATH, PURSUIT_TAB_PATH, PURSUITS_PATH, OldPursuitRoute, PursuitKitRedirect, PursuitPage, PursuitsPage, SidebarPursuits } from "@/components/pursuits";
import type { PursuitKitBody, PursuitsBody } from "@/api/pursuit-types";
import { SocialKitView } from "@/components/socialKit";
import { SKINS, SkinProvider } from "@/lib/skin";

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}

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
      kit: true,
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

  it("the sidebar's Pursuits heading opens every pursuit and each pursuit opens its own page", async () => {
    vi.spyOn(api, "listPursuits").mockResolvedValue(BODY);
    render(
      <MemoryRouter>
        <SidebarPursuits />
      </MemoryRouter>,
    );
    const items = await screen.findAllByTestId("sidebar-pursuit");
    expect(screen.getByTestId("sidebar-pursuits-all").getAttribute("href")).toBe("/pursuits");
    expect(items.map((i) => i.getAttribute("href"))).toEqual(["/pursuits/live", "/pursuits/vault"]);
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

  const KIT: PursuitKitBody = {
    pursuit: { id: "live", name: "Product live" },
    files: "http://files.example/live/assets/",
    kit: {
      id: "live",
      name: "Live",
      tagline: "Agents that post for you.",
      colours: [{ name: "Violet", hex: "#7c3bed", use: "The mark" }],
      accounts: [{ platform: "X", handle: "@live", url: "https://x.com/live", state: "made" }],
      bios: [{ where: "X, 160 at most", text: "Agents that post for you." }],
      templates: [{ id: "news", title: "News", w: 1600, h: 900 }],
    },
  };
  const at = (url: string) =>
    render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path={PURSUITS_PATH} element={<PursuitsPage />} />
          <Route path={PURSUIT_PATH} element={<PursuitPage />} />
          <Route path={PURSUIT_TAB_PATH} element={<PursuitPage />} />
        </Routes>
      </MemoryRouter>,
    );

  it("a pursuit's own page: a way back to Pursuits, its scorecard, and a Social kit tab when it has a kit", async () => {
    vi.spyOn(api, "listPursuits").mockResolvedValue(BODY);
    at("/pursuits/live");
    await screen.findByTestId("pursuit");
    expect(screen.getByTestId("pursuit-back").getAttribute("href")).toBe("/pursuits");
    expect(screen.getByTestId("pursuit-tab-scorecard").getAttribute("href")).toBe("/pursuits/live");
    expect(screen.getByTestId("pursuit-tab-kit").getAttribute("href")).toBe("/sets/live?tab=kit");
    cleanup();
    at("/pursuits/vault");
    await screen.findByTestId("pursuit");
    expect(screen.queryByTestId("pursuit-tab-kit")).toBeNull();
  });

  it("the Social kit tab shows the kit inside the console, its previews from the console and downloads from the file store", async () => {
    const kit = vi.spyOn(api, "getPursuitKit").mockResolvedValue(KIT);
    render(<SocialKitView id="live" />);
    await screen.findByTestId("social-kit");
    expect(kit).toHaveBeenCalledWith("live");
    expect(screen.getByTestId("kit-tagline").textContent).toBe("Agents that post for you.");
    expect(screen.getAllByTestId("kit-section").map((x) => x.dataset.part)).toEqual(["accounts", "picture", "banners", "bios", "colours", "type", "templates"]);
    expect(screen.getAllByTestId("kit-shot")[0].getAttribute("src")).toBe("/api/pursuits/live/kit/previews/avatars-round.webp");
    const dl = within(screen.getAllByTestId("kit-template")[0]).getByRole("link");
    expect(dl.getAttribute("href")).toBe("http://files.example/live/assets/post-news-1600x900.png");
  });

  it("the old kit address leads to the goal set's Social kit tab", async () => {
    vi.spyOn(api, "listPursuits").mockResolvedValue(BODY);
    render(
      <MemoryRouter initialEntries={["/pursuits/live/social-kit"]}>
        <Routes>
          <Route path={PURSUIT_TAB_PATH} element={<PursuitPage />} />
          <Route path="/sets/:id" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    expect((await screen.findByTestId("where")).textContent).toBe("/sets/live?tab=kit");
    cleanup();
    // the skin without the pursuit pages still has the redirect route
    render(
      <MemoryRouter initialEntries={["/pursuits/live/social-kit"]}>
        <Routes>
          <Route path={PURSUIT_KIT_PATH} element={<PursuitKitRedirect />} />
          <Route path="/sets/:id" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    expect((await screen.findByTestId("where")).textContent).toBe("/sets/live?tab=kit");
  });

  it("in the social skin an old pursuit link opens its objective, the kit its Social kit tab, the list All objectives", async () => {
    vi.spyOn(api, "listPursuits").mockResolvedValue(BODY);
    const go = (url: string, skin = SKINS.social) =>
      render(
        <SkinProvider skin={skin}>
          <MemoryRouter initialEntries={[url]}>
            <Routes>
              <Route path={PURSUITS_PATH} element={<OldPursuitRoute page={<PursuitsPage />} />} />
              <Route path={PURSUIT_PATH} element={<OldPursuitRoute page={<PursuitPage />} />} />
              <Route path={PURSUIT_TAB_PATH} element={<OldPursuitRoute page={<PursuitPage />} />} />
              <Route path="/sets" element={<Where />} />
              <Route path="/sets/:id" element={<Where />} />
            </Routes>
          </MemoryRouter>
        </SkinProvider>,
      );
    for (const [from, to] of [
      ["/pursuits/live", "/sets/live"],
      ["/pursuits/live/social-kit", "/sets/live?tab=kit"],
      ["/pursuits", "/sets"],
    ]) {
      go(from);
      expect((await screen.findByTestId("where")).textContent).toBe(to);
      cleanup();
    }
    // in the console skin too one pursuit opens as its wheel, with its tabs (the key results first); the list stays
    go("/pursuits/live", SKINS.console);
    expect((await screen.findByTestId("where")).textContent).toBe("/sets/live");
    cleanup();
    go("/pursuits", SKINS.console);
    expect(await screen.findByTestId("pursuits-page")).toBeTruthy();
  });

  it("Copy still copies when the browser refuses the clipboard", async () => {
    vi.spyOn(api, "getPursuitKit").mockResolvedValue(KIT);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")) }, configurable: true });
    const exec = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { value: exec, configurable: true });
    render(<SocialKitView id="live" />);
    await screen.findByTestId("social-kit");
    screen.getAllByRole("button", { name: "Copy" })[0].click();
    await waitFor(() => expect(exec).toHaveBeenCalledWith("copy"));
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

  it("the list page names each pursuit as a link to its own page", async () => {
    vi.spyOn(api, "listPursuits").mockResolvedValue(BODY);
    at("/pursuits");
    const opens = await screen.findAllByTestId("pursuit-open");
    expect(opens.map((a) => a.getAttribute("href"))).toEqual(["/pursuits/live", "/pursuits/vault"]);
  });
});
