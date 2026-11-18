// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useNavigate } from "react-router-dom";
import { BackArrow } from "./backArrow";

// The owner: the installed app hides the browser's back, so the top bar carries one.
function Bar({ installed }: { installed: boolean }) {
  const navigate = useNavigate();
  return (
    <div>
      <BackArrow installed={() => installed} />
      <button onClick={() => navigate("/inbox")}>go</button>
    </div>
  );
}

const setIdx = (idx: number) => window.history.replaceState({ idx }, "");

describe("back arrow in the top bar", () => {
  afterEach(cleanup);
  it("is not there on the first screen of the installed app", () => {
    setIdx(0);
    const r = createMemoryRouter([{ path: "*", element: <Bar installed /> }]);
    render(<RouterProvider router={r} />);
    expect(screen.queryByTestId("topbar-back")).toBeNull();
  });

  it("shows after a move in the installed app and goes back one step", async () => {
    setIdx(1);
    const r = createMemoryRouter([{ path: "*", element: <Bar installed /> }], { initialEntries: ["/", "/inbox"], initialIndex: 1 });
    render(<RouterProvider router={r} />);
    const back = screen.getByTestId("topbar-back");
    expect(back.getAttribute("aria-label")).toBe("Back");
    await act(async () => { fireEvent.click(back); });
    expect(r.state.location.pathname).toBe("/");
  });

  it("never shows in a browser tab, where the browser's own back is", () => {
    setIdx(3);
    const r = createMemoryRouter([{ path: "*", element: <Bar installed={false} /> }]);
    render(<RouterProvider router={r} />);
    expect(screen.queryByTestId("topbar-back")).toBeNull();
  });
});
