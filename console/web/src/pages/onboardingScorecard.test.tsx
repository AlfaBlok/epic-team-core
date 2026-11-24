// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import { OnboardingScorecard, ScorecardView } from "@/components/OnboardingScorecard";
import { mockOnboarding } from "@/lib/onboarding";

/** the onboarding scorecard on the social product home: six rows read by the console, shown until six of six. */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("T88-S25 onboarding scorecard", () => {
  it("shows the count, the six steps in the wizard's order and words, and their states", () => {
    render(<MemoryRouter><ScorecardView s={mockOnboarding()} chat /></MemoryRouter>);
    expect(screen.getByTestId("onboarding-ring").getAttribute("aria-label")).toBe("2 of 6 done");
    expect(screen.getByText("2 of 6 proven by a live check on cloud.social.example. Red until proven.")).toBeTruthy();
    expect(screen.getByText("Your SocialApp is not ready yet.")).toBeTruthy();
    const ids = ["signin", "vault", "accounts", "product", "campaign", "post"];
    expect(ids.map((id) => screen.getByTestId(`onboarding-${id}`).getAttribute("data-state"))).toEqual(["part", "part", "part", "done", "done", "todo"]);
    expect(screen.getByTestId("onboarding-signin").textContent).toContain("Not yet");
    expect(screen.getByTestId("onboarding-product").textContent).toContain("Proven");
  });

  it("a step opens to what the console sees today and how it knows; never a box to tick", () => {
    render(<MemoryRouter><ScorecardView s={mockOnboarding()} chat /></MemoryRouter>);
    fireEvent.click(screen.getByTestId("onboarding-accounts").querySelector("button")!);
    const d = screen.getByTestId("onboarding-accounts-detail");
    expect(d.textContent).toContain("X and Reddit signed in only on the platform's browser, not yet on your team's own.");
    expect(d.textContent).toContain("How we know.");
    // iteration 2: a red step names the one thing that turns it green, and what the check read
    expect(screen.getByTestId("onboarding-accounts-fix").textContent).toContain("your team signs in to X itself");
    expect(screen.getByTestId("onboarding-accounts-proof").textContent).toContain("Lent browser only: X and Reddit.");
    expect(screen.getByTestId("onboarding-tile-x").textContent).toContain("only on the platform's browser");
    expect(screen.getByTestId("onboarding-tile-x").getAttribute("data-state")).toBe("yellow");
    expect(screen.getByText("Stuck? Tell your desk").getAttribute("href")).toBe("/chat");
    expect(document.querySelector('[data-testid="onboarding-scorecard"] input[type="checkbox"]')).toBeNull();
  });

  it("each open step links to the screen where it is done; the vault opens Connect your socials", () => {
    render(<MemoryRouter><ScorecardView s={mockOnboarding()} chat /></MemoryRouter>);
    const open = (id: string) => fireEvent.click(screen.getByTestId(`onboarding-${id}`).querySelector("button")!);
    open("accounts");
    expect(screen.getByTestId("onboarding-accounts-open").getAttribute("href")).toBe("/auth"); // where the sync lives
    open("post");
    expect(screen.getByTestId("onboarding-post-open").getAttribute("href")).toBe("/pipeline");
    open("vault");
    // iteration 2: every login and key the team uses, each red until its item is found in his Bitwarden
    const items = screen.getByTestId("onboarding-vault-items").querySelectorAll("li");
    expect([...items].map((li) => li.getAttribute("data-state"))).toEqual(["red", "red", "red", "red"]);
    expect(items[3].textContent).toContain("The platform lends this key.");
    expect(screen.getByTestId("onboarding-vault-open").getAttribute("href")).toBe("/socials");
    expect(screen.getByTestId("onboarding-vault-detail").textContent).not.toContain("Its own screen is being built.");
    cleanup();
    render(<MemoryRouter><ScorecardView s={mockOnboarding()} has={(x) => x !== "pipeline"} /></MemoryRouter>);
    fireEvent.click(screen.getByTestId("onboarding-post").querySelector("button")!);
    expect(screen.queryByTestId("onboarding-post-open")).toBeNull();
  });

  it("the EpicTeam side: five steps, its own count", () => {
    const m = mockOnboarding("acme");
    const ticks = m.ticks.slice(0, 5).map((t, i) => ({ ...t, id: (["world", "signin", "vault", "repos", "seats"] as const)[i], state: "todo" as const }));
    render(<MemoryRouter><ScorecardView s={{ ...m, product: "team", site: "cloud.epicteam.app", done: 0, of: 5, ticks }} /></MemoryRouter>);
    expect(screen.getByTestId("onboarding-ring").getAttribute("aria-label")).toBe("0 of 5 done");
    expect(screen.getByText("Your EpicTeam is not ready yet.")).toBeTruthy();
  });

  it("the home card reads the world's scorecard and is gone at six of six", async () => {
    vi.spyOn(api as any, "getMe").mockResolvedValue({ tenant: { id: "social" } } as any);
    const get = vi.spyOn(api as any, "getOnboarding").mockResolvedValue(mockOnboarding());
    render(<MemoryRouter><OnboardingScorecard /></MemoryRouter>);
    expect(await screen.findByTestId("onboarding-scorecard")).toBeTruthy();
    expect(get).toHaveBeenCalledWith("social");
    cleanup();
    const all = mockOnboarding();
    get.mockResolvedValue({ ...all, done: 6, ticks: all.ticks.map((t) => ({ ...t, state: "done" })) });
    render(<MemoryRouter><OnboardingScorecard /></MemoryRouter>);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("onboarding-scorecard")).toBeNull();
  });
});
