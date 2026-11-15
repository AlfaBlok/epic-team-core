// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { api } from "@/api";
import { ConnectCards } from "@/components/connectCards";

/** The one-button connect names the account and the channel and links to Google's consent hop. */
afterEach(() => (cleanup(), vi.restoreAllMocks()));
const card = {
  id: "sam-youtube",
  title: "Connect Sam YouTube",
  what: "Posts Shorts.",
  account: "sam@example.com",
  channel: { name: "Sam", handle: "@SamShorts", id: "UC1" },
  gives: ["upload videos"],
  connected: false,
  startUrl: "https://cloud.example.com/api/access/oauth/connect/sam-youtube/start",
  inbox: true,
};

describe("ConnectCards", () => {
  it("the inbox card names the account and channel, every step exact, one button to the consent hop", async () => {
    vi.spyOn(api, "listConnects").mockResolvedValue({ connects: [card] });
    render(<ConnectCards where="inbox" />);
    const btn = await screen.findByTestId("connect-button");
    expect(btn.getAttribute("href")).toBe(card.startUrl);
    expect(btn.textContent).toBe("Connect Sam YouTube");
    expect(screen.getByTestId("connect-account").textContent).toBe("sam@example.com");
    expect(screen.getByTestId("connect-channel").textContent).toContain("Sam @SamShorts");
    const steps = screen.getByTestId("connect-steps").textContent!;
    expect(steps).toContain("pick sam@example.com");
    expect(steps).not.toMatch(/\bsign in\b/i);
  });

  it("a connected one leaves the inbox and shows Connected on the Connections page", async () => {
    vi.spyOn(api, "listConnects").mockResolvedValue({ connects: [{ ...card, connected: true, at: "2026-11-13T22:00:00Z" }] });
    const { container } = render(<ConnectCards where="inbox" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
    cleanup();
    render(<ConnectCards where="connections" />);
    expect((await screen.findByTestId("connect-state")).textContent).toContain("Connected");
  });
});
