// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { MilestoneTree, TreeNode, WaitingItem } from "@/api";
import { EpicTree } from "@/components/tree";
import { answeredBy } from "@/components/waiting";
import { DEFAULT_OWNER, ownerLabel } from "@/lib/owner";

// the world's owner is named per tenant. the home world (no owner field from the API) reads exactly as before: "the owner".

afterEach(cleanup);

const tree = (owner?: MilestoneTree["owner"]): MilestoneTree => {
  const row: TreeNode = { key: "k/T1", id: "T1", kind: "ticket", title: "Pick a day", status: "blocked", color: "red", children: [], flags: [], asks: [{ ask: "decide", question: "Which day?", who: "", since: "2026-10-20" }] } as TreeNode;
  const root: TreeNode = { key: "k", id: "ROOT", kind: "spine", title: "Root", status: "active", color: "blue", children: [row], flags: [] };
  return { milestoneId: "ms", root, counts: { grey: 0, blue: 1, yellow: 0, red: 1, green: 0 }, nonGreen: 2, closed: 0, flagged: 0, source: "spines", warnings: [], ...(owner ? { owner } : {}) };
};
const item = (over: Partial<WaitingItem>): WaitingItem => ({ id: "wj_1", source: "ask", state: "answered", milestoneId: "ms", milestoneTitle: "M", nodeKey: "k", title: "t", ask: "decide", question: "q", contextLinks: [], owner: { kind: "none", label: "" }, decidable: false, ...over }) as WaitingItem;

describe("T21-S4 owner per world", () => {
  it("ownerLabel falls back to Sam", () => {
    expect(DEFAULT_OWNER).toBe("Sam");
    expect(ownerLabel(undefined)).toBe("Sam");
    expect(ownerLabel({ name: "Ana B." })).toBe("Ana B.");
  });

  it("an unnamed ask in the tree is the world owner's: Sam in acme, Ana in hers", () => {
    render(<EpicTree tree={tree()} />);
    expect(screen.getByText("ask: decide").getAttribute("title")).toBe("decide @Sam: Which day?");
    cleanup();
    render(<EpicTree tree={tree({ handle: "Ana", name: "Ana" })} />);
    expect(screen.getByText("ask: decide").getAttribute("title")).toBe("decide @Ana: Which day?");
  });

  it("'answered by' names the world's owner for a console answer", () => {
    const response = { createdAt: "2026-10-22T10:00:00Z" } as WaitingItem["response"];
    expect(answeredBy(item({ response, answer: "yes" }))).toMatch(/^answered by Sam .*: yes$/);
    expect(answeredBy(item({ response, answer: "yes", ownerName: "Ana B." }))).toMatch(/^answered by Ana B\. .*: yes$/);
    expect(answeredBy(item({ answer: "no" }))).toBe("answered by Sam: no");
    expect(answeredBy(item({ answer: "no", ownerName: "Ana B." }))).toBe("answered by Ana B.: no");
    expect(answeredBy(item({ answer: "no", who: "Steward", ownerName: "Ana B." }))).toBe("answered by Steward: no");
  });
});
