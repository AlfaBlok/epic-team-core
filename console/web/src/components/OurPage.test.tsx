// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { OurPage } from "./OurPage";
import { OUR_PAGE_PATH, ourPagePath } from "@/lib/inPlaceLinks";

// The owner 25 Nov 14:57Z (vn_982a8bd6): a link opened a brand new instance of the app with no back. A page of ours the
// app does not draw now shows on this screen inside the app.
afterEach(cleanup);

const at = (u: string) => {
  const r = createMemoryRouter([{ path: OUR_PAGE_PATH, element: <OurPage /> }], { initialEntries: [u] });
  render(<RouterProvider router={r} />);
};

describe("a page of ours inside the app", () => {
  it("shows a steps page in a frame", () => {
    at(ourPagePath("/steps/view/abc?x=1#s2"));
    expect(screen.getByTestId("our-page").getAttribute("src")).toBe("/steps/view/abc?x=1#s2");
  });
  it("never another site, an app screen or a script address", () => {
    for (const u of ["https://example.com/x", "//example.com/x", "/inbox", "javascript:alert(1)"]) {
      at(ourPagePath(u));
      expect(screen.queryByTestId("our-page")).toBeNull();
      expect(screen.getByTestId("our-page-refused")).toBeTruthy();
      cleanup();
    }
  });
});
