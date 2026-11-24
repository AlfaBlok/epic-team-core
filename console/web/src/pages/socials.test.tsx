// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { api } from "@/api";
import { mockSocials } from "@/lib/onboarding";
import { SocialsPage } from "@/pages/Socials";

// (the owner 24 Nov 06:11Z: "Did they set up their X account ... there needs to be a UX for it"):
// Connect your socials, every state read from the console.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const at = (stage: ReturnType<typeof mockSocials>["stage"], x = false) => ({
  ...mockSocials("acme"),
  stage,
  xConnected: x,
  connected: x ? 1 : 0,
  socials: mockSocials("acme").socials.map((s) => ({ ...s, inVault: x && s.id === "x" })),
});

describe("Connect your socials", () => {
  it("first asks only for the owner's Bitwarden email", async () => {
    vi.spyOn(api, "getSocials").mockResolvedValue(at("start"));
    render(<MemoryRouter><SocialsPage /></MemoryRouter>);
    await waitFor(() => screen.getByTestId("socials-start"));
    expect(screen.getByTestId("socials-step-start").getAttribute("data-state")).toBe("now");
    expect(screen.getByText("Make my team's helper")).toBeTruthy();
  });
  it("at the invite, shows the helper's address to paste and the steps in Bitwarden", async () => {
    vi.spyOn(api, "getSocials").mockResolvedValue(at("invite"));
    render(<MemoryRouter><SocialsPage /></MemoryRouter>);
    await waitFor(() => screen.getByTestId("socials-step-invite"));
    expect(screen.getByTestId("socials-step-make").getAttribute("data-state")).toBe("done");
    expect(screen.getByTestId("socials-helper").textContent).toBe(mockSocials("acme").helper.address);
    expect(screen.getByTestId("socials-step-invite").textContent).toContain("Pick the role User");
    expect(screen.getByTestId("socials-x").getAttribute("data-state")).toBe("out");
  });
  it("says X connected once its login is in the shared collection", async () => {
    vi.spyOn(api, "getSocials").mockResolvedValue(at("ready", true));
    render(<MemoryRouter><SocialsPage /></MemoryRouter>);
    await waitFor(() => screen.getByTestId("socials-answer"));
    expect(screen.getByTestId("socials-answer").textContent).toContain("X connected");
    expect(screen.getByTestId("socials-x").textContent).toContain("Connected");
    expect(screen.getByTestId("socials-reddit").textContent).toContain("Not in your vault yet");
  });
});
