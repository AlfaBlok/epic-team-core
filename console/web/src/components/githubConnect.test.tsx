// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "@/api";
import { GithubConnect } from "@/components/githubConnect";

// The owner 2026-11-18 (vn_bd196a82): "I need a button that allows me to say I give permission to this app to read and
// write on this repo ... selecting an existing repo where I have a workspace or creating a new repo in GitHub."

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});
const start = "/api/tenants/et-dana/github/start";
// the mock client has no GitHub: give it the four calls the card makes
const a = api as unknown as Record<string, unknown>;
for (const k of ["listGithubRepos", "checkGithubRepo", "pickGithubRepo", "newGithubRepo"]) a[k] ??= () => Promise.reject(new Error("unset"));

describe("Connect GitHub", () => {
  it("not connected: one button to GitHub's page, saying what it gives; from Connections it comes back there", () => {
    render(<GithubConnect world="et-dana" state={{ available: true, connected: false, startUrl: start }} where="home" />);
    expect(screen.getByTestId("github-connect").getAttribute("data-state")).toBe("start");
    expect(screen.getByTestId("github-start").textContent).toBe("Connect GitHub");
    expect(screen.getByTestId("github-start").getAttribute("href")).toBe(start);
    expect(screen.getByTestId("github-connect").textContent).toContain("read and write your repos");
    cleanup();
    render(<GithubConnect world="et-dana" state={{ available: true, connected: false, startUrl: start }} where="connections" />);
    expect(screen.getByTestId("github-start").getAttribute("href")).toBe(`${start}?next=%2Fconnections`);
  });

  it("says why when GitHub's answer was no, and takes the answer out of the address", () => {
    window.history.replaceState(null, "", "/?github=cancelled");
    render(<GithubConnect world="et-dana" state={{ available: true, connected: false, startUrl: start }} where="home" />);
    expect(screen.getByTestId("github-answer").textContent).toMatch(/did not say yes on GitHub/);
    expect(window.location.search).toBe("");
  });

  it("connected: pick a repo you already have (it says whether it holds a workspace) or make a new one", async () => {
    vi.spyOn(api as Required<typeof api>, "listGithubRepos").mockResolvedValue({ login: "dana-gh", repos: [{ repo: "dana-gh/epic-team", private: true }, { repo: "dana-gh/site", private: false }] });
    const check = vi.spyOn(api as Required<typeof api>, "checkGithubRepo").mockResolvedValue({ repo: "dana-gh/epic-team", workspace: true, title: "Dana's team" });
    const pick = vi.spyOn(api as Required<typeof api>, "pickGithubRepo").mockRejectedValue(new Error("you can read that repo but not write it; pick one you can write"));
    const make = vi.spyOn(api as Required<typeof api>, "newGithubRepo").mockRejectedValue(new Error("you already have a repo called my-team"));
    render(<GithubConnect world="et-dana" state={{ available: true, connected: true, login: "dana-gh", startUrl: start }} where="home" />);
    expect(screen.getByTestId("github-connect").getAttribute("data-state")).toBe("pick");
    expect(screen.getByTestId("github-login").textContent).toContain("connected as dana-gh");
    await waitFor(() => expect(screen.getAllByTestId("github-repo-item").length).toBe(2));
    fireEvent.change(screen.getByTestId("github-search"), { target: { value: "epic" } });
    expect(screen.getAllByTestId("github-repo-item").map((x) => x.textContent)).toEqual(["dana-gh/epic-teamprivate"]);
    fireEvent.click(screen.getByTestId("github-repo-item"));
    expect(check).toHaveBeenCalledWith("et-dana", "dana-gh/epic-team");
    await waitFor(() => expect(screen.getByTestId("github-check").textContent).toBe("dana-gh/epic-team already holds a workspace, Dana's team. Its goals and key results load as they are."));
    fireEvent.click(screen.getByTestId("github-pick"));
    expect(pick).toHaveBeenCalledWith("et-dana", "dana-gh/epic-team");
    await waitFor(() => expect(screen.getByTestId("github-error").textContent).toMatch(/not write it/));
    // a new repo, private, named by her
    fireEvent.change(screen.getByTestId("github-new-name"), { target: { value: "my-team" } });
    expect(screen.getByTestId("github-new").textContent).toContain("Made private in your GitHub account, as dana-gh/my-team");
    fireEvent.click(screen.getByTestId("github-new-make"));
    await waitFor(() => expect(make).toHaveBeenCalledWith("et-dana", "my-team"));
    await waitFor(() => expect(screen.getByTestId("github-error").textContent).toMatch(/already have a repo/));
  });

  it("with its repo: nothing on Home, the connected line on Connections; nothing where GitHub cannot be connected", () => {
    const state = { available: true, connected: true, login: "dana-gh", repo: "dana-gh/epic-team", startUrl: start };
    const home = render(<GithubConnect world="et-dana" state={state} where="home" />);
    expect(home.container.textContent).toBe("");
    cleanup();
    render(<GithubConnect world="et-dana" state={state} where="connections" />);
    expect(screen.getByTestId("github-connect").textContent).toContain("Connected as dana-gh. This workspace lives in dana-gh/epic-team.");
    expect(screen.getByTestId("github-repo").getAttribute("href")).toBe("https://github.com/dana-gh/epic-team");
    cleanup();
    const none = render(<GithubConnect world="et-dana" state={{ available: false, connected: false, startUrl: start }} where="home" />);
    expect(none.container.textContent).toBe("");
  });
});
