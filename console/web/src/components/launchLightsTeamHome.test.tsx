// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api, type LaunchBoard, type LaunchLight } from "@/api";
import { LaunchBoardPage, LaunchLights } from "@/components/launchBoard";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

// the launch board inside the console; each red names who fixes it, its epic and why.
const red = (label: string, who: string, draft = false): LaunchLight => ({
  group: "Stripe and checkout",
  label,
  state: "red",
  seen: "row T93-S2: blocked",
  kind: "row",
  fix: "Claude on Sam's Mac makes the plan.",
  owner: {
    by: draft ? "capability" : "row",
    who,
    epic: { code: "PLAN-93", title: "Stripe through MCP", file: "docs/spines/stripe.md", deck: "/deck/home_repo/PLAN-93" },
    next: draft ? null : { code: "T93-S2", kind: "row", text: "row T93-S2", state: "blocked", open: true },
    capability: { key: "stripe", what: "Stripe", epic: null },
    ...(draft ? { draft: true } : {}),
    why: draft ? "No open row: PLAN-93 owns Stripe." : "Row T93-S2 is blocked in PLAN-93; its assignee is the Mac agent.",
  },
});
const board = (products: LaunchBoard["products"], drafts: LaunchBoard["drafts"] = []): LaunchBoard => ({
  checkedAt: new Date().toISOString(),
  nextAt: new Date().toISOString(),
  greens: products.reduce((n, p) => n + p.greens, 0),
  total: products.reduce((n, p) => n + p.total, 0),
  ownerRule: "Who fixes a red: the open row or ask named on the light.",
  products,
  drafts,
});
const TEAM = {
  id: "epicteam",
  name: "EpicTeam",
  site: "https://epicteam.app/",
  greens: 2,
  total: 3,
  lights: [
    { group: "Website", label: "epicteam.app answers", state: "green", seen: "answered 200", kind: "http" },
    { group: "Health", label: "healthy", state: "green", seen: "status: ok", kind: "json" },
    red("The €49 plan exists", "Mac agent"),
  ] as LaunchLight[],
};
const SOCIAL = { ...TEAM, id: "socialapp", name: "SocialApp", site: "https://social-app.example.com/", greens: 0, total: 1, lights: [red("Paid plan", "Delivery Manager", true)] };

describe("T85-S9 launch lights on the Team home", () => {
  it("shows this product's score, each red's owner with its epic's deck and the next row, the rule, and Every product", async () => {
    const spy = vi.spyOn(api, "getLaunchBoard").mockResolvedValue({ board: board([TEAM]), ranAt: null });
    render(<MemoryRouter><LaunchLights product="epicteam" /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("launch-lights")).toBeTruthy());
    expect(spy).toHaveBeenCalledWith("epicteam");
    expect(screen.getByTestId("launch-lights").textContent).toContain("Launch board: EpicTeam, 2 of 3 lights green");
    expect(screen.getAllByTestId("launch-red")).toHaveLength(1);
    expect(screen.getByTestId("launch-owner").textContent).toContain("Owner: Mac agent");
    expect(screen.getByTestId("launch-owner").textContent).toContain("its assignee is the Mac agent");
    expect(screen.getByTestId("launch-owner-epic").getAttribute("href")).toBe("/deck/home_repo/PLAN-93");
    expect(screen.getByTestId("launch-owner-next").textContent).toContain("T93-S2 blocked");
    expect(screen.getByTestId("launch-rule").textContent).toContain("Who owns a red.");
    expect(screen.getByTestId("launch-all-link").getAttribute("href")).toBe("/launch");
  });

  it("renders nothing when the board is refused (another world) or not there yet", async () => {
    vi.spyOn(api, "getLaunchBoard").mockRejectedValue(new Error("403 world_scope"));
    const { container } = render(<MemoryRouter><LaunchLights product="socialapp" /></MemoryRouter>);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
  });
});

describe("T85-S9 /launch: every product", () => {
  it("scores each product, lists every red with its owner, and the reds with no row yet", async () => {
    vi.spyOn(api, "getLaunchBoard").mockResolvedValue({
      board: board([TEAM, SOCIAL], [{ product: "SocialApp", label: "Paid plan", fix: "x", seen: "y", epic: "PLAN-93", spine: "docs/spines/stripe.md" }]),
      ranAt: null,
    });
    render(<MemoryRouter><LaunchBoardPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId("launch-board")).toBeTruthy());
    expect(screen.getAllByTestId("launch-score").map((s) => s.textContent)).toEqual([expect.stringContaining("EpicTeam2 / 3"), expect.stringContaining("SocialApp0 / 1")]);
    expect(screen.getAllByTestId("launch-owner")).toHaveLength(2);
    expect(screen.getAllByTestId("launch-owner")[1].textContent).toContain("no row yet");
    expect(screen.getByTestId("launch-drafts").textContent).toContain("SocialApp: Paid plan → PLAN-93");
  });
});
