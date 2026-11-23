// @vitest-environment jsdom
/**
 * Mark done on an objective's page shows only once every Done-means box of its epics is ticked: green key results
 * with a box still open are not done.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { api } from "@/api";
import type { PursuitsBody } from "@/api/pursuit-types";
import { ObjectiveOffButton } from "@/components/objectiveSwitch";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BODY = { pursuits: [{ id: "launch", name: "Acme: Get 5 testers" }] } as unknown as PursuitsBody;

describe("Mark done", () => {
  it("shows when no Done-means box is open", async () => {
    vi.spyOn(api, "listPursuits").mockResolvedValue(BODY);
    render(<ObjectiveOffButton id="launch" openBoxes={0} />);
    expect(await screen.findByTestId("objective-mark-done")).toBeTruthy();
  });
  it("hides while a box of its epics is still open; Switch off stays", async () => {
    vi.spyOn(api, "listPursuits").mockResolvedValue(BODY);
    render(<ObjectiveOffButton id="launch" openBoxes={1} />);
    expect(await screen.findByTestId("objective-switch-off")).toBeTruthy();
    expect(screen.queryByTestId("objective-mark-done")).toBeNull();
  });
});
