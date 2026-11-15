// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { OwnerPriorityTag, rankWhy } from "@/components/ownerPriority";
import { pressingInReviewOnly } from "@/pages/Team";

// the owner: what he was frustrated about or asked for again leads his inbox until answered,
// by a general rule and no section of its own; its card says why it is on top, with his words.

afterEach(cleanup);

const hot = (kind: "frustrated" | "repeated") => ({
  level: "normal" as const,
  why: "Normal.",
  ref: "E907-S3",
  pressing: { kind, why: "You said the wheel is not understood, and that frustrates you.", words: "which is extremely frustrating to me", said: "2026-11-15" },
});

describe("the pressing marker", () => {
  it("names why it leads and shows his words, never the level", () => {
    render(<OwnerPriorityTag p={hot("frustrated")} />);
    const tag = screen.getByTestId("owner-priority");
    expect(tag.textContent).toBe("You were frustrated");
    expect(tag.getAttribute("data-pressing")).toBe("frustrated");
    fireEvent.click(tag);
    const why = screen.getByTestId("owner-priority-why").textContent ?? "";
    expect(why).toContain("You said the wheel is not understood");
    expect(why).toContain("which is extremely frustrating to me");
    expect(why).toContain("First in your inbox until you answer it.");
  });

  it("a repeat says so", () => {
    render(<OwnerPriorityTag p={hot("repeated")} />);
    expect(screen.getByTestId("owner-priority").textContent).toBe("You asked again");
  });
});

describe("the review list moves above Blocked only for a pressing review card", () => {
  const p = { ownerPriority: { pressing: { kind: "repeated" } } };
  it("pressing review card, no pressing ask: review first", () => {
    expect(pressingInReviewOnly([p], [], [{ id: "a" }])).toBe(true);
  });
  it("a pressing open ask already leads Blocked: order as before", () => {
    expect(pressingInReviewOnly([p], [{ id: "a", ...p }], [{ id: "a" }])).toBe(false);
    expect(pressingInReviewOnly([p], [], [{ id: "a", ...p }])).toBe(false);
  });
  it("nothing pressing: order as before", () => {
    expect(pressingInReviewOnly([{}], [], [])).toBe(false);
    expect(pressingInReviewOnly(undefined, [], [])).toBe(false);
  });
});

describe("his objectives rank the inbox by themselves", () => {
  it("an item on his first objective says so in one short line, and why it leads", () => {
    const p = { level: "normal" as const, why: "It moves your objective 1: Five testers use Acme.", ref: "E907-S9", objective: { n: 0, id: "acme-live", name: "Five testers use Acme" } };
    render(<OwnerPriorityTag p={p} />);
    const tag = screen.getByTestId("owner-priority");
    expect(tag.textContent).toBe("Your objective 1: Five testers use Acme");
    expect(tag.getAttribute("data-objective")).toBe("1");
    fireEvent.click(tag);
    expect(screen.getByTestId("owner-priority-objective").textContent).toBe("It moves your first objective, Five testers use Acme, so it leads your inbox.");
    expect(screen.getByTestId("owner-priority-why").textContent).toContain("First in your inbox while this is your first objective.");
  });
  it("what put an item high keeps its word and adds the objective it moves", () => {
    expect(rankWhy({ level: "high", why: "x", ref: "a", pressing: { kind: "frustrated", why: "y" }, objective: { n: 2, id: "b", name: "B" } })).toBe("You were frustrated · objective 3");
    expect(rankWhy({ level: "normal", why: "x", ref: "a", objective: { n: 1, id: "b", name: "Five testers use Beta" } })).toBe("Your objective 2: Five testers use Beta");
    expect(rankWhy({ level: "high", why: "x", ref: "a" })).toBe("High priority");
  });
  it("a review card on his first objective puts the review list first", () => {
    expect(pressingInReviewOnly([{ ownerPriority: { objective: { n: 0 } } }], [], [])).toBe(true);
    expect(pressingInReviewOnly([{ ownerPriority: { objective: { n: 1 } } }], [], [])).toBe(false);
  });
});
