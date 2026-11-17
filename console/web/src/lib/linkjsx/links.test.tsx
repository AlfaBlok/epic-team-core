// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { bareUrlsIn } from "@/lib/bareUrls";
import { hrefOf } from "@/lib/linkjsx/links";

// E948-S129 (the owner, vn_dc4a25de): "we should never have a URL that is not clickable". Our JSX runtime makes every address
// in rendered text a link; these pin what it links and what it leaves alone.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const hrefs = (c: HTMLElement) => [...c.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));

describe("E948-S129 every address in rendered text is a link", () => {
  it("full URLs, a tailnet page with its port and a page written without https:// all become links", () => {
    const { container } = render(
      <p>
        Page http://host1.example.net:9658/ : open it. Also host1.example.net:9471/#numbers and x.com/settings, from example.org.
      </p>,
    );
    expect(hrefs(container)).toEqual(["http://host1.example.net:9658/", "http://host1.example.net:9471/#numbers", "https://x.com/settings"]);
    expect(container.textContent).toBe("Page http://host1.example.net:9658/ : open it. Also host1.example.net:9471/#numbers and x.com/settings, from example.org.");
    expect(bareUrlsIn(container)).toEqual([]);
  });

  it("leaves e-mail addresses, a bare site name, file names and paths as text", () => {
    const { container } = render(<p>Mail ops+apply@example.com, 23 cookies (reddit.com), run deploy.sh, read docs/cards/E948-S129.md and card_qc.py, e.g. now.</p>);
    expect(hrefs(container)).toEqual([]);
  });

  it("a URL inside inline code is a link; a copy box and a pre block stay text", () => {
    const { container } = render(
      <div>
        <code>https://team.example.org/pages</code>
        <code className="select-all">curl -fsSL https://team.example.org/mac/go.sh | sh</code>
        <pre>https://example.com/block</pre>
        <span data-url-plain="">https://example.com/plain</span>
      </div>,
    );
    expect(hrefs(container)).toEqual(["https://team.example.org/pages"]);
  });

  it("text in a fragment and beside other children keeps its siblings and gets its link", () => {
    const { container } = render(
      <div>
        <>see https://a.example.com/x</>
        <b>bold</b> then https://b.example.com/y.
      </div>,
    );
    expect(hrefs(container)).toEqual(["https://a.example.com/x", "https://b.example.com/y"]);
    expect(container.querySelector("b")?.textContent).toBe("bold");
  });

  it("a link inside a button opens its page and never presses the button", () => {
    const press = vi.fn();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const { container } = render(
      <button type="button" onClick={press}>
        <span>Open https://example.com/page</span>
      </button>,
    );
    fireEvent.click(container.querySelector("a")!);
    expect(press).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith("https://example.com/page", "_blank", "noopener,noreferrer");
  });

  it("refuses a script address", () => {
    expect(hrefOf("javascript:alert(1)")).toBeUndefined();
  });
});
