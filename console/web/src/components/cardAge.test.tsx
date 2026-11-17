// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { WaitingItem } from "@/api";
import { WaitingCard } from "@/components/waiting";

// every card says how long ago it was issued, in its header next to the chip or code,
// with the full date and time on hover.
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NOW = new Date("2026-11-01T12:00:00Z");
const ask = (since?: string): WaitingItem => ({
  id: "wj_1",
  source: "ask",
  state: "open",
  who: "Sam",
  code: "T9-A1",
  milestoneId: "ms_1",
  milestoneTitle: "E909",
  path: "docs/E909.md",
  title: "Pick",
  ask: "decide",
  question: "Which one?",
  options: [],
  contextLinks: [],
  owner: { kind: "none", label: "nobody" },
  ...(since ? { since } : {}),
  decidable: true,
});
const at = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

describe("card age (T48-S11)", () => {
  // the header is the meta line (kind word, project, age); the code moved to the card's foot
  it("an ask card shows its age in the meta line, after the kind, with the full time on hover; the code in the foot", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    render(<MemoryRouter><WaitingCard item={ask(at(5))} /></MemoryRouter>);
    const age = screen.getByTestId("issued-age");
    expect(age.textContent).toBe("5 min old");
    expect(age.getAttribute("title")).toMatch(/^issued Nov 1, 2026, \d\d:55/);
    const header = age.parentElement!;
    expect(header.getAttribute("data-testid")).toBe("card-meta");
    expect(within(header).getByTestId("card-kind").textContent).toBe("Decision");
    expect(within(screen.getByTestId("card-foot")).getByTestId("ask-code").textContent).toBe("T9-A1");
    fireEvent.click(screen.getByTestId("ask-lead"));
    expect(screen.getByTestId("waiting-details").textContent).not.toMatch(/waiting/);
  });

  it("hours, days and years; an old date-only ask reads in days", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const cases: [string, string][] = [
      [at(180), "3 h old"],
      [at(3 * 1440), "3 d old"],
      [at(400 * 1440), "1 yr old"],
      ["2026-11-01", "today"],
      ["2026-10-29", "3 d old"],
    ];
    for (const [since, label] of cases) {
      render(<MemoryRouter><WaitingCard item={ask(since)} /></MemoryRouter>);
      expect(screen.getByTestId("issued-age").textContent).toBe(label);
      cleanup();
    }
    render(<MemoryRouter><WaitingCard item={ask("2026-10-29")} /></MemoryRouter>);
    expect(screen.getByTestId("issued-age").getAttribute("title")).toBe("issued 2026-10-29 (day only)");
  });

  it("no since: no age", () => {
    render(<MemoryRouter><WaitingCard item={ask()} /></MemoryRouter>);
    expect(screen.queryByTestId("issued-age")).toBeNull();
  });

  // the approved card face shows no age or code (they sit in its folded Details); components/review.test.tsx
});
