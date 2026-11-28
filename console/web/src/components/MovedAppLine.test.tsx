// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MovedAppLine, forgetMovedArrival } from "./MovedAppLine";

// The owner 28 Nov (vn_6f1d9926): only installing the app again from the new address took the cross bar away.
describe("an arrival from the old address says how to get the app view back", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    forgetMovedArrival();
    window.history.replaceState(null, "", "/");
  });
  it("the marker shows one line naming the new address and leaves the address, keeping the rest", () => {
    window.history.replaceState(null, "", "/sets/x?call=1&moved_from=old.example.com#card");
    render(<MovedAppLine />);
    expect(screen.getByTestId("moved-app-line").textContent).toContain(`install it again from ${window.location.host}`);
    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/sets/x?call=1#card");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("moved-app-line")).toBeNull();
  });
  it("no marker: nothing shows", () => {
    window.history.replaceState(null, "", "/inbox");
    render(<MovedAppLine />);
    expect(screen.queryByTestId("moved-app-line")).toBeNull();
    expect(window.location.search).toBe("");
  });
});
