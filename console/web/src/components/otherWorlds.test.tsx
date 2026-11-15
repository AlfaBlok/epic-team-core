// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { api } from "@/api";
import type { WorldInbox, WorldItem } from "@/api/company-types";
import { forgetOtherWorlds, orderWorldItems, OtherWorldsPill, OtherWorldsWaiting, worldSummary, worldsToShow } from "./otherWorlds";

/**
 * E907-S3: the social product world's own asks and cards lead the Inbox, read only, each opening in its own app.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  forgetOtherWorlds();
});
beforeEach(() => forgetOtherWorlds());

const item = (n: number, kind: "ask" | "review", priority?: number): WorldItem => ({
  key: `${kind}:${n}`,
  kind,
  id: `${kind}${n}`,
  title: `${kind === "ask" ? "Approve Sprint" : "Strategy deck"} ${n}`,
  openUrl: `https://cloud.example.com/x/${n}`,
  ...(priority !== undefined ? { priority } : {}),
  project: "Memory testers",
});
const world = (items: WorldItem[], error?: string): WorldInbox => ({ tenantId: "social-world", tenantName: "Sam", app: "SocialApp", appUrl: "https://cloud.example.com", items, ...(error ? { error } : {}) });

describe("E907-S3 SocialApp waits on you, on the Inbox", () => {
  it("orders asks before cards, by priority, and says the count in plain words", () => {
    const items = [item(1, "review", 1), item(2, "ask", 3), item(3, "ask", 1)];
    expect(orderWorldItems(items).map((i) => i.id)).toEqual(["ask3", "ask2", "review1"]);
    expect(worldSummary(items)).toBe("2 decisions and 1 card to review");
    expect(worldSummary([item(1, "review"), item(2, "review")])).toBe("2 cards to review");
    expect(worldsToShow([world([]), world([item(1, "ask")])]).length).toBe(1);
    expect(worldsToShow([world([], "HTTP 500")]).length).toBe(1);
  });

  it("lists each item with a link into its own app, five first, then all on one tap", async () => {
    vi.spyOn(api, "listCompanyWorlds").mockResolvedValue({ worlds: [world([...[1, 2, 3].map((n) => item(n, "ask")), ...[4, 5, 6, 7].map((n) => item(n, "review"))])] });
    render(<OtherWorldsWaiting />);
    expect(await screen.findByRole("heading", { name: /SocialApp waits on you/ })).toBeTruthy();
    expect(screen.getByTestId("other-world-count").textContent).toBe("7");
    expect(screen.getByTestId("other-world-summary").textContent).toContain("3 decisions and 4 cards to review");
    const rows = screen.getAllByTestId("other-world-item");
    expect(rows).toHaveLength(5);
    expect(rows[0].dataset.kind).toBe("ask");
    expect(rows[0].querySelector("a")?.getAttribute("href")).toBe("https://cloud.example.com/x/1");
    fireEvent.click(screen.getByTestId("other-world-more"));
    expect(screen.getAllByTestId("other-world-item")).toHaveLength(7);
  });

  it("says nothing when the world has nothing open, and says missing, not zero, when it could not be read", async () => {
    vi.spyOn(api, "listCompanyWorlds").mockResolvedValue({ worlds: [world([])] });
    const { container } = render(<OtherWorldsWaiting />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
    cleanup();
    forgetOtherWorlds();
    vi.spyOn(api, "listCompanyWorlds").mockResolvedValue({ worlds: [world([], "/review-items: HTTP 500")] });
    render(<OtherWorldsWaiting />);
    expect((await screen.findByTestId("other-world-error")).textContent).toContain("missing here, not zero");
  });

  it("the sidebar pill counts every open SocialApp item, and one read feeds band and pill", async () => {
    const spy = vi.spyOn(api, "listCompanyWorlds").mockResolvedValue({ worlds: [world([item(1, "ask"), item(2, "review")])] });
    render(
      <>
        <OtherWorldsPill />
        <OtherWorldsWaiting />
      </>,
    );
    expect((await screen.findByTestId("other-world-pill")).textContent).toBe("2");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a failed read shows nothing rather than breaking the Inbox", async () => {
    vi.spyOn(api, "listCompanyWorlds").mockRejectedValue(new Error("404"));
    const { container } = render(<OtherWorldsPill />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
  });
});
