// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router-dom";
import { InPlaceLinks } from "@/components/InPlaceLinks";
import { inPlaceKind, installInPlaceLinks } from "./inPlaceLinks";
import { linkUrls } from "./linkjsx/links";

// The owner, 22 Nov: in the installed app a card's link opened a new app window he could not go back from.
const origin = window.location.origin;

describe("where a link opens in place", () => {
  it("routes our own screens, loads our server pages and leaves outside sites to a new window", () => {
    expect(inPlaceKind("/milestones/ms_1?tab=deck", origin)).toBe("route");
    expect(inPlaceKind(`${origin}/inbox#E907-S3`, origin)).toBe("route");
    expect(inPlaceKind("/steps/view/abc", origin)).toBe("load");
    expect(inPlaceKind("/api/files/x", origin)).toBe("load");
    expect(inPlaceKind("/status/e18-s28/shot.webp", origin)).toBe("load");
    expect(inPlaceKind("https://github.com/example/repo", origin)).toBeUndefined();
    expect(inPlaceKind("http://host1.example.net:9693/", origin)).toBeUndefined();
    expect(inPlaceKind("mailto:", origin)).toBeUndefined();
    expect(inPlaceKind("blob:abc", origin)).toBeUndefined();
  });
});

function Card() {
  const loc = useLocation();
  return (
    <div data-inbox-card="E907-S3">
      <p data-testid="at">{loc.pathname}</p>
      <a href="/milestones/ms_1" target="_blank" rel="noreferrer">deck</a>
      <a href="https://example.com/page" target="_blank" rel="noreferrer">outside</a>
      <a href="https://example.com/file.pdf" target="_blank" download>file</a>
      {/* an auto-linked URL inside a button (lib/linkjsx): its own handler calls window.open */}
      <button type="button">{linkUrls("see https://example.org/x now")}</button>
    </div>
  );
}

function mount(installed: boolean) {
  const r = createMemoryRouter([{ path: "*", element: <><InPlaceLinks installed={() => installed} /><Card /></> }], { initialEntries: ["/inbox"] });
  render(<RouterProvider router={r} />);
  return r;
}

describe("links on a card in the installed app", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("opens our own screen in place, so Back returns to the card", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const r = mount(true);
    await act(async () => { fireEvent.click(screen.getByText("deck")); });
    expect(r.state.location.pathname).toBe("/milestones/ms_1");
    expect(open).not.toHaveBeenCalled();
    await act(async () => { await r.navigate(-1); });
    expect(r.state.location.pathname).toBe("/inbox");
  });

  it("opens an outside site in a new window, never in place (vn_ce90e291)", async () => {
    const loads: string[] = [];
    const open = vi.fn(() => null);
    window.open = open as unknown as typeof window.open;
    const undo = installInPlaceLinks(() => undefined, (to) => loads.push(to), () => false);
    render(<><Card /></>, { wrapper: ({ children }) => <RouterProvider router={createMemoryRouter([{ path: "*", element: children }])} /> });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    screen.getByText("outside").dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false); // the browser's own target=_blank: a new window
    await act(async () => { fireEvent.click(screen.getByText("https://example.org/x")); });
    expect(open).toHaveBeenCalledWith("https://example.org/x", "_blank", "noopener,noreferrer");
    window.open("https://example.net/a", "_blank", "noopener");
    expect(open).toHaveBeenLastCalledWith("https://example.net/a", "_blank", "noopener");
    expect(loads).toEqual([]);
    undo();
    expect(window.open).toBe(open);
  });

  it("loads a server page of ours in place, but a new window while a note is on", async () => {
    const loads: string[] = [];
    const open = vi.fn(() => null);
    window.open = open as unknown as typeof window.open;
    let busy = false;
    const undo = installInPlaceLinks(() => undefined, (to) => loads.push(to), () => busy);
    window.open("/steps/view/abc", "_blank");
    expect(loads).toEqual([`${origin}/steps/view/abc`]);
    await new Promise((r) => setTimeout(r, 0));
    busy = true;
    window.open("/steps/view/def", "_blank");
    expect(loads).toHaveLength(1);
    expect(open).toHaveBeenCalledWith("/steps/view/def", "_blank", undefined);
    undo();
  });

  it("leaves a download and a Ctrl or Cmd click alone", () => {
    const loads: string[] = [];
    const undo = installInPlaceLinks(() => undefined, (to) => loads.push(to));
    render(<RouterProvider router={createMemoryRouter([{ path: "*", element: <Card /> }])} />);
    const dl = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    screen.getByText("file").dispatchEvent(dl);
    const cmd = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, metaKey: true });
    screen.getByText("outside").dispatchEvent(cmd);
    expect(loads).toEqual([]);
    undo();
  });

  it("changes nothing in a browser tab", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const r = mount(false);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    screen.getByText("deck").dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(r.state.location.pathname).toBe("/inbox");
    await act(async () => { fireEvent.click(screen.getByText("https://example.org/x")); });
    expect(open).toHaveBeenCalledWith("https://example.org/x", "_blank", "noopener,noreferrer");
  });
});
