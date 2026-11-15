// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { OwnerPriorityTag } from "@/components/ownerPriority";
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

describe("a standing first rule", () => {
  it("names the rule with its live count and says when it stops", () => {
    const p = { level: "high" as const, why: "High.", ref: "E907-S9", pressing: { kind: "first" as const, rule: "Acme testers", why: "You asked that Acme tester work comes first.", count: { value: 2, reaches: 5, label: "active Acme testers" } } };
    render(<OwnerPriorityTag p={p} />);
    const tag = screen.getByTestId("owner-priority");
    expect(tag.textContent).toBe("Acme testers first · 2 of 5");
    expect(tag.getAttribute("data-pressing")).toBe("first");
    fireEvent.click(tag);
    expect(screen.getByTestId("owner-priority-why").textContent).toContain("First in your inbox until 5 active Acme testers, 2 now.");
  });
});
