// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { ErrorBoundary, PageBoundary } from "@/components/ErrorBoundary";

afterEach(cleanup);

function Boom(): JSX.Element {
  throw new Error("messages is undefined");
}

describe("T68-S1: an error never leaves a blank screen", () => {
  it("a page that throws shows a clear state under the nav, and another page draws again", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <nav>
          <Link to="/">Home</Link>
        </nav>
        <Routes>
          <Route path="/" element={<PageBoundary><p>home page</p></PageBoundary>} />
          <Route path="/chat" element={<PageBoundary><Boom /></PageBoundary>} />
        </Routes>
      </MemoryRouter>,
    );
    const box = screen.getByTestId("error-boundary-page");
    expect(box.textContent).toContain("This page stopped drawing.");
    expect(box.textContent).toContain("messages is undefined");
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(screen.getByText("Home")).toBeTruthy(); // the nav is still there
    expect(err.mock.calls.some((c) => String(c[0]).startsWith("console page error:"))).toBe(true);
    fireEvent.click(screen.getByText("Home"));
    expect(screen.getByText("home page")).toBeTruthy();
    expect(screen.queryByTestId("error-boundary-page")).toBeNull();
    err.mockRestore();
  });

  it("an error outside any page is caught by the app boundary", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ErrorBoundary scope="app">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("error-boundary-app").textContent).toContain("The console stopped drawing.");
    err.mockRestore();
  });

  it("draws its children when nothing throws", () => {
    render(
      <ErrorBoundary scope="app">
        <p>fine</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("fine")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
