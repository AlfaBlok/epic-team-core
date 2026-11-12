// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { blocks, cells, ChatMarkdown, hasTable } from "@/lib/chatMarkdown";
import { ACCOUNTS_REPLY, LIBRARIAN_REPLY, SIGNUP_REPLY } from "@/lib/chatMarkdown.fixtures";
import { ClampText } from "@/components/unblock";
import { speakable } from "@/voice/speak";

// desk replies with Markdown tables showed raw pipes in Chat. Real replies from the Team desk history.
afterEach(cleanup);

const md = (text: string) => {
  render(<ChatMarkdown text={text} threadUrl={(id) => `t3code://threads/env/${id}`} />);
  return screen.getByTestId("chat-md");
};
const rowsOf = (table: HTMLElement) => [...table.querySelectorAll("tr")].map((tr) => [...tr.querySelectorAll("th, td")].map((c) => c.textContent));

describe("E918-S19 tables in chat bubbles", () => {
  it("the accounts reply: a real table with a header row and nine rows, the bullets and link after it", () => {
    const root = md(ACCOUNTS_REPLY);
    expect(root.textContent).not.toContain("|---");
    const box = within(root).getByTestId("chat-md-table");
    const table = box.querySelector("table")!;
    expect([...table.querySelectorAll("thead th")].map((th) => th.textContent)).toEqual(["#", "Account", "Login email", "Password in Bitwarden"]);
    expect(table.querySelectorAll("tbody tr")).toHaveLength(9);
    expect(rowsOf(table)[4]).toEqual(["4", "X @MemoAgent → @MemoMemory", "existing account, untouched", "not made (on hold)"]);
    expect(root.querySelectorAll("ul > li")).toHaveLength(3);
    expect(root.querySelector("li strong")?.textContent).toBe("None of the passwords are in Bitwarden yet.");
    const live = within(root).getByRole("link", { name: "live table" });
    expect(live.getAttribute("href")).toBe("http://worker.tail.example:9019/kit/status/");
    expect(live.getAttribute("target")).toBe("_blank");
  });

  it("the box scrolls sideways by itself and holds the first column; the page never does", () => {
    const root = md(ACCOUNTS_REPLY);
    expect(root.className).toContain("grid-cols-[minmax(0,1fr)]");
    const box = within(root).getByTestId("chat-md-table");
    expect(box.className).toContain("overflow-x-auto");
    expect(box.className).toContain("max-w-full");
    expect(box.getAttribute("role")).toBe("region");
    const first = box.querySelectorAll("tr > :first-child");
    expect([...first].every((c) => c.className.includes("sticky") && c.className.includes("left-0"))).toBe(true);
    // a column of words keeps a readable minimum width; the short # column does not
    expect(box.querySelector("tbody td:nth-child(3) > div")!.className).toContain("min-w-");
    expect(box.querySelector("tbody td:nth-child(1) > div")!.className).not.toContain("min-w-");
    // words break normally inside cells (not one letter per line)
    expect(box.querySelector("table")!.className).toContain("[overflow-wrap:break-word]");
  });

  it("the sign-up reply: bold paragraphs, a table between them, links in text and a bullet list", () => {
    const root = md(SIGNUP_REPLY);
    const table = within(root).getByTestId("chat-md-table").querySelector("table")!;
    expect(rowsOf(table)[0]).toEqual(["Where", "Account", "Login email", "Time"]);
    expect(rowsOf(table)[3]).toEqual(["Phone, TikTok app", "@memomemory", "owner+memo-tiktok@example.com", "3 min"]);
    expect(within(root).getByRole("link", { name: "kit" }).getAttribute("href")).toBe("http://worker.tail.example:9019/kit/");
    expect([...root.querySelectorAll("strong")].map((s) => s.textContent)).toContain("Yes, this has to happen on your own devices.");
    expect(root.querySelectorAll("ul")).toHaveLength(2);
    expect(root.textContent).not.toMatch(/\*\*|\|/);
  });

  it("the librarian reply: bold and quoted words inside cells, italic in text", () => {
    const root = md(LIBRARIAN_REPLY);
    const table = within(root).getByTestId("chat-md-table").querySelector("table")!;
    expect(table.querySelectorAll("tbody tr")).toHaveLength(4);
    expect(table.querySelector("tbody td strong")?.textContent).toBe("Keep");
    expect(rowsOf(table)[2][1]).toBe("\"Who is our plumber?\"");
    expect(root.querySelector("em")?.textContent).toBe("\"Memo · the librarian of your memory\"");
  });

  it("column alignment, escaped pipes, short rows and <br> in cells", () => {
    const root = md("| Name | Count | Note |\n|:---|---:|:-:|\n| a \\| b | 3 | x<br>y |\n| c | 4 |");
    const th = root.querySelectorAll("th");
    expect(th[0].className).toContain("text-left");
    expect(th[1].className).toContain("text-right");
    expect(th[2].className).toContain("text-center");
    const rows = rowsOf(root.querySelector("table")!);
    expect(rows[1]).toEqual(["a | b", "3", "xy"]);
    expect(rows[2]).toEqual(["c", "4", ""]);
    expect(root.querySelectorAll("td:nth-child(3) span.block")).toHaveLength(3);
  });

  it("a line with pipes but no delimiter row stays text", () => {
    expect(hasTable("a | b\nc | d")).toBe(false);
    expect(blocks("a | b\nc | d")).toEqual([{ kind: "p", text: "a | b\nc | d" }]);
    expect(cells("| a | b \\| c |")).toEqual(["a", "b | c"]);
    expect(hasTable(ACCOUNTS_REPLY)).toBe(true);
  });
});

describe("E918-S19 the rest of GitHub Markdown", () => {
  it("nested lists, task lists, numbered lists keep their start, quotes, rules, heading sizes", () => {
    const root = md("## Plan\n\n1. first\n   - sub a\n   - sub b\n2. second\n\nThen:\n\n5. fifth\n\n- [x] done\n- [ ] open\n\n> quoted **bold**\n> more\n\n---\n\n### Small");
    const heads = root.querySelectorAll("[role=heading]");
    expect([...heads].map((h) => h.textContent)).toEqual(["Plan", "Small"]);
    expect(heads[0].className).toContain("text-base");
    const ols = root.querySelectorAll("ol");
    expect(ols[0].querySelectorAll(":scope > li")).toHaveLength(2);
    expect(ols[0].querySelector("li ul")?.textContent).toBe("sub asub b");
    expect(ols[1].getAttribute("start")).toBe("5");
    const boxes = root.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    expect([...boxes].map((b) => [b.checked, b.disabled])).toEqual([[true, true], [false, true]]);
    expect(root.querySelector("blockquote strong")?.textContent).toBe("bold");
    expect(root.querySelector("hr")).not.toBeNull();
  });

  it("a numbered list split by blank lines stays one list", () => {
    const root = md("1. one\n\n2. two\n\n3. three");
    expect(root.querySelectorAll("ol")).toHaveLength(1);
    expect(root.querySelectorAll("ol > li")).toHaveLength(3);
  });

  it("italic, strike, bold with a link inside, escapes and <url>; snake_case is not italic", () => {
    const root = md("*it* _it2_ ~~gone~~ **see [docs](https://x.dev/a)** \\*not\\* <https://y.dev/b> my_var_name");
    expect([...root.querySelectorAll("em")].map((e) => e.textContent)).toEqual(["it", "it2"]);
    expect(root.querySelector("del")?.textContent).toBe("gone");
    expect(root.querySelector("strong a")?.getAttribute("href")).toBe("https://x.dev/a");
    expect(root.textContent).toContain("*not*");
    expect(within(root).getByRole("link", { name: "https://y.dev/b" }).getAttribute("target")).toBe("_blank");
    expect(root.textContent).toContain("my_var_name");
  });

  it("stays safe: no raw HTML, no unsafe links, inside tables too", () => {
    const root = md("| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | [x](javascript:alert(1)) |\n\n<script>alert(1)</script> ![p](data:image/png;base64,AA)");
    expect(root.querySelector("img, script")).toBeNull();
    expect(root.querySelector("a")).toBeNull();
    expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(root.textContent).toContain("<script>alert(1)</script>");
  });

  it("t3-thread links still become T3 deep links", () => {
    const root = md("open [the thread](t3-thread://v1/th_9)");
    expect(within(root).getByRole("link", { name: "the thread" }).getAttribute("href")).toBe("t3code://threads/env/th_9");
  });
});

describe("E918-S19 run summaries and speech", () => {
  it("a run summary with a table shows the table once opened", () => {
    // jsdom has no layout: make the text taller than its clamp, as a browser would
    const tall = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 100 });
    try {
      render(
        <MemoryRouter>
          <ClampText text={"Done: three checks\n\n| Check | Result |\n|---|---|\n| 390 | ok |\n| 1280 | ok |"} />
        </MemoryRouter>,
      );
      expect(screen.queryByTestId("chat-md-table")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "show more" }));
      expect(screen.getByTestId("chat-md-table").querySelectorAll("tbody tr")).toHaveLength(2);
    } finally {
      if (tall) Object.defineProperty(HTMLElement.prototype, "scrollHeight", tall);
      else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    }
  });

  it("speech skips a table's delimiter row", () => {
    expect(speakable("| A | B |\n|---|:-:|\n| 1 | 2 |")).toBe("A B 1 2");
  });
});
