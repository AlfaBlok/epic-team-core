// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import { AppRoutes } from "@/App";
import { SKINS, SkinProvider, type Skin } from "@/lib/skin";
import { forgetWorld } from "@/lib/useSocial";

/**
 * the owner, 2026-11-12 22:43Z: "at the top, I need a navigation direct to the inbox, a direct access,
 * just as I have a direct access to the chat and the microphone". Home is the bird's-eye goals view, the full Inbox its own
 * page one tap away in the top bar beside Chat and the mic, in both skins; the phone bar never crowds.
 */
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => {
  localStorage.clear();
  forgetWorld();
  Element.prototype.scrollIntoView = vi.fn();
});

/** the bar's links and buttons are exactly Inbox, Chat and the mic, in that order (jsdom has no recorder, so no mic there). */
const onlyInboxChatMic = (bar: HTMLElement) => {
  const links = [...bar.querySelectorAll("a")].map((a) => a.getAttribute("data-testid"));
  const buttons = [...bar.querySelectorAll("button")].map((b) => b.getAttribute("data-testid"));
  return links.join(",") === "topbar-team,topbar-chat" && buttons.every((b) => b === "topbar-voice") && buttons.length <= 1;
};

const at = (skin: Skin, path: string) =>
  render(
    <SkinProvider skin={skin}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </SkinProvider>,
  );

describe("Home is the goals view, the Inbox one tap away", () => {
  it("the console skin: Home shows all goal sets; the top bar has only Inbox (with its counts), Chat and the mic", async () => {
    at(SKINS.console, "/");
    await screen.findByTestId("goal-sets-page");
    expect(screen.queryByTestId("inbox-search")).toBeNull();
    const bar = screen.getByTestId("topbar-pills");
    const inbox = within(bar).getByTestId("topbar-team");
    expect(inbox.getAttribute("href")).toBe("/inbox");
    expect(inbox.getAttribute("aria-label")).toMatch(/^Inbox: \d+ waiting on you, \d+ to review$/);
    // Home is the product mark beside the menu button
    expect(screen.getByTestId("topbar-brand").getAttribute("href")).toBe("/");
    expect(onlyInboxChatMic(bar)).toBe(true);
  });

  it("the console skin: /inbox is the full Inbox, with its search box", async () => {
    at(SKINS.console, "/inbox");
    await screen.findByTestId("inbox-search");
    expect(screen.queryByTestId("goal-sets-page")).toBeNull();
    expect(screen.getByTestId("topbar-team").className).toMatch(/bg-accent text-foreground/);
  });

  it("a world with no goal sets keeps the Inbox as Home", async () => {
    vi.spyOn(api, "listScorecards").mockRejectedValue(Object.assign(new Error("no goal sets here"), { status: 404 }));
    at(SKINS.console, "/");
    await screen.findByTestId("inbox-search");
    expect(screen.queryByTestId("goal-sets-page")).toBeNull();
  });

  it("the social skin: Home is the goal and its key results with a light each, all goal sets one tap away in the fold", async () => {
    // the owner: "I want to see a list of key results and traffic light for each"
    at(SKINS.social, "/");
    await screen.findByTestId("goal-lights");
    expect(screen.queryByTestId("goal-sets-page")).toBeNull();
    expect(screen.getByTestId("topbar-team").getAttribute("href")).toBe("/inbox");
    fireEvent.click(screen.getByTestId("home-more-toggle"));
    expect((await screen.findByTestId("home-all-objectives")).getAttribute("href")).toBe("/sets");
  });

  it("the social skin with no goal sets: Home shows the projects' campaigns without the inbox lists; /inbox shows the inbox alone", async () => {
    vi.spyOn(api, "listScorecards").mockRejectedValue(Object.assign(new Error("no goal sets here"), { status: 404 }));
    at(SKINS.social, "/");
    fireEvent.click(await screen.findByTestId("home-more-toggle"));
    await screen.findByTestId("project-campaigns");
    expect(screen.getByRole("heading", { name: "Home" })).toBeTruthy();
    expect(document.querySelector('[data-slot-stack="social-inbox"], [data-stack="social-inbox"]')).toBeNull();
    expect(screen.queryByText("Blocked, waiting on you")).toBeNull();
    expect(screen.getByTestId("topbar-team").getAttribute("href")).toBe("/inbox");
    cleanup();
    at(SKINS.social, "/inbox");
    await screen.findByRole("heading", { name: "Inbox" });
    expect(screen.queryByTestId("project-campaigns")).toBeNull();
  });

  it("the bar holds only Inbox, Chat and the mic; One-offs, Outcomes, Pages and Voice notes sit in the sidebar below the goal sets", async () => {
    // the owner, 2026-11-12 (vn_87528e51): "In there, we only need the quick access to the inbox, the chat, and the
    // microphone. The other things are in the sidebar."
    at(SKINS.console, "/inbox");
    const bar = await screen.findByTestId("topbar-pills");
    expect(onlyInboxChatMic(bar)).toBe(true);
    for (const gone of ["topbar-home", "topbar-more", "topbar-one-offs", "topbar-outcomes", "topbar-pages"]) expect(screen.queryByTestId(gone)).toBeNull();
    // the whole name stands with the mark again: the bar has room for it at 360 px
    expect(screen.getByTestId("topbar-brand-name").className).not.toMatch(/sr-only/);
    const more = (await screen.findAllByTestId("sidebar-more-pages"))[0];
    // a page pinned by name (the sample's Daily reports, at its short address) leads the list, then the fixed pages
    expect(within(more).getAllByRole("link").map((a) => [a.textContent?.trim(), a.getAttribute("href")])).toEqual([
      ["Daily reports", "/daily"],
      ["One-offs", "/one-offs"],
      ["Outcomes", "/outcomes"],
      ["Pages", "/pages"],
      ["Voice notes", "/voice-notes"],
      ["X stats", "/x-stats"],
    ]);
    // below the goal sets, above the projects
    const sidebar = more.parentElement!;
    const goal = sidebar.querySelector("[data-testid='sidebar-goal-sets']");
    if (goal) expect(goal.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(more.compareDocumentPosition(within(sidebar).getByTestId("sidebar-milestones")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the social bar: Inbox, Chat and the mic only, no page links in it", async () => {
    at(SKINS.social, "/");
    const bar = await screen.findByTestId("topbar-pills");
    expect(onlyInboxChatMic(bar)).toBe(true);
    expect(screen.getByTestId("topbar-brand").getAttribute("href")).toBe("/");
  });
});
