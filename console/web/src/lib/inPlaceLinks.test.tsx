// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router-dom";
import { InPlaceLinks } from "@/components/InPlaceLinks";
import { CARD_TYPES } from "@/components/cardInventory";
import { ChatMarkdown } from "@/lib/chatMarkdown";
import { forgetWorld } from "@/lib/useSocial";
import { clearAnswerVoiceState } from "@/voice/AnswerVoice";
import { forgetDeskVoiceWorld } from "@/voice/deskBase";
import { installInPlaceLinks, linkKind, ourPagePath } from "./inPlaceLinks";
import { linkUrls } from "./linkjsx/links";

// The owner 25 Nov (vn_77ec9815), said again: a link to the app stays in the app;
// every other URL opens a new window, so the app's back and a voice note being recorded stay.
const origin = window.location.origin;

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

beforeEach(() => {
  forgetWorld();
  forgetDeskVoiceWorld();
  clearAnswerVoiceState();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ error: { message: "not faked" } }), { status: 404, headers: { "content-type": "application/json" } })),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("where a link opens", () => {
  it("an app screen, a page of ours the app does not draw, and another site", () => {
    expect(linkKind("/milestones/ms_1?tab=deck", origin)).toBe("route");
    expect(linkKind(`${origin}/inbox#E907-S3`, origin)).toBe("route");
    expect(linkKind("/steps/view/abc", origin)).toBe("page");
    expect(linkKind("/api/files/x", origin)).toBe("page");
    expect(linkKind("/status/e18-s28/shot.webp", origin)).toBe("page");
    expect(linkKind("https://github.com/example/repo", origin)).toBe("outside");
    expect(linkKind("http://host1.example.net:9484/#diagram", origin)).toBe("outside");
    expect(linkKind("mailto:", origin)).toBeUndefined();
    expect(linkKind("blob:abc", origin)).toBeUndefined();
  });
});

function Card() {
  const loc = useLocation();
  return (
    <div data-inbox-card="E907-S3">
      <p data-testid="at">{loc.pathname}</p>
      <a href="/milestones/ms_1" target="_blank" rel="noreferrer">deck</a>
      <a href="http://host1.example.net:9484/#diagram" target="_blank" rel="noreferrer">Open the three tiers</a>
      <a href="http://host1.example.net:9484/#diagram">bare outside</a>
      <a href="/steps/view/abc">steps page</a>
      <a href="/steps/view/def" target="_blank" rel="noreferrer">steps page new</a>
      <a href="https://example.com/file.pdf" download>file</a>
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
const tap = (text: string) => {
  const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  screen.getByText(text).dispatchEvent(click);
  return click;
};

for (const installed of [true, false])
  describe(installed ? "in the installed app" : "in a browser tab", () => {
    it("an outside page never takes the app's window: target=_blank stays the browser's new window, a bare link opens one", async () => {
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      const r = mount(installed);
      expect(tap("Open the three tiers").defaultPrevented).toBe(false); // the browser's own new window
      expect(tap("bare outside").defaultPrevented).toBe(true);
      expect(open).toHaveBeenLastCalledWith("http://host1.example.net:9484/#diagram", "_blank", "noopener");
      expect(r.state.location.pathname).toBe("/inbox");
    });

    it(installed ? "a page of ours the app does not draw shows on the app's own screen for it, never window.open (a second app)" : "a page of ours the app does not draw opens a new tab", async () => {
      const before = window.open;
      const open = vi.fn(() => null);
      window.open = open as unknown as typeof window.open; // a plain stand-in: the rule's own window.open wraps it
      const r = createMemoryRouter([{ path: "*", element: <Card /> }], { initialEntries: ["/inbox"] });
      render(<RouterProvider router={r} />);
      const undo = installInPlaceLinks((to) => void r.navigate(to), { installed });
      try {
        expect(tap("steps page").defaultPrevented).toBe(true);
        if (installed) {
          await act(async () => undefined);
          expect(r.state.location.pathname + r.state.location.search).toBe(ourPagePath("/steps/view/abc"));
          expect(tap("steps page new").defaultPrevented).toBe(true);
          await new Promise((ok) => setTimeout(ok, 5)); // a later tap, not the same click
          await act(async () => void window.open("/steps/view/ghi", "_blank"));
          expect(r.state.location.search).toBe(`?u=${encodeURIComponent("/steps/view/ghi")}`);
          expect(open).not.toHaveBeenCalled();
          // Back walks the app's own history to the card
          await act(async () => void (await r.navigate(-1)));
          await act(async () => void (await r.navigate(-1)));
          await act(async () => void (await r.navigate(-1)));
          expect(r.state.location.pathname).toBe("/inbox");
        } else {
          expect(open).toHaveBeenLastCalledWith(`${origin}/steps/view/abc`, "_blank", "noopener");
          expect(tap("steps page new").defaultPrevented).toBe(false); // target=_blank: the browser's new tab
          expect(r.state.location.pathname).toBe("/inbox");
        }
      } finally {
        undo();
        window.open = before;
      }
    });

    it("an auto-linked outside URL in a button opens a new window", async () => {
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      mount(installed);
      await act(async () => { fireEvent.click(screen.getByText("https://example.org/x")); });
      expect(open).toHaveBeenCalledWith("https://example.org/x", "_blank", "noopener,noreferrer");
    });

    it("a download and a Ctrl or Cmd click keep their own way", () => {
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      mount(installed);
      expect(tap("file").defaultPrevented).toBe(false);
      const cmd = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, metaKey: true });
      screen.getByText("bare outside").dispatchEvent(cmd);
      expect(cmd.defaultPrevented).toBe(false);
      expect(open).not.toHaveBeenCalled();
    });
  });

describe("the app's own screens", () => {
  it("installed: a new-window link to our screen opens in place, so Back returns to the card", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const r = mount(true);
    await act(async () => { fireEvent.click(screen.getByText("deck")); });
    expect(r.state.location.pathname).toBe("/milestones/ms_1");
    expect(open).not.toHaveBeenCalled();
    await act(async () => { await r.navigate(-1); });
    expect(r.state.location.pathname).toBe("/inbox");
  });

  it("in a browser tab: unchanged (a new tab)", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const r = mount(false);
    expect(tap("deck").defaultPrevented).toBe(false);
    expect(r.state.location.pathname).toBe("/inbox");
  });

  it("the undo puts window.open back", () => {
    const before = window.open;
    const undo = installInPlaceLinks(() => undefined, { installed: true });
    expect(window.open).not.toBe(before);
    undo();
    expect(window.open).toBe(before);
  });
});

// Every card kind his inbox draws, with its real links: each link to a page outside the app opens a new window.
describe("every card kind: an outside link opens a new window, never the app's window", () => {
  for (const installed of [true, false])
    it(`${installed ? "installed app" : "browser tab"}: every card kind and a chat answer`, () => {
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      let outside = 0;
      const kinds: string[] = [];
      const items = [
        ...CARD_TYPES.map((c) => ({ name: c.name, el: c.render() })),
        { name: "chat answer", el: <ChatMarkdown text={"See [the three tiers](http://host1.example.net:9484/#diagram) and http://host1.example.net:9547/ and [steps](/steps/view/abc)"} /> },
      ];
      for (const c of items) {
        const r = createMemoryRouter([{ path: "*", element: <><InPlaceLinks installed={() => installed} /><div data-testid="card">{c.el}</div></> }], { initialEntries: ["/inbox"] });
        const { container, unmount } = render(<RouterProvider router={r} />);
        const links = [...container.querySelectorAll<HTMLAnchorElement>("a[href]")].filter((a) => !a.hasAttribute("download") && linkKind(a.href) === "outside");
        for (const a of links) {
          open.mockClear();
          const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
          a.dispatchEvent(click);
          const blank = a.target === "_blank";
          if (blank) expect(a.rel, `${c.name}: ${a.href} opens a new window without noopener`).toMatch(/noopener|noreferrer/);
          const newWindow = (blank && !click.defaultPrevented) || (click.defaultPrevented && open.mock.calls.some(([u, t]) => String(u) === a.href && t === "_blank"));
          expect(newWindow, `${c.name}: "${a.textContent?.trim()}" ${a.href} does not open a new window`).toBe(true);
          expect(r.state.location.pathname, `${c.name}: an outside link moved the app`).toBe("/inbox");
          outside++;
          if (!kinds.includes(c.name)) kinds.push(c.name);
        }
        unmount();
      }
      expect(outside).toBeGreaterThan(5);
      expect(kinds).toContain("chat answer");
    });
});
