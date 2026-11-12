// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SocialData, SocialInsight } from "@/api/types";
import { emptySocialExport } from "@/lib/social";
import { WhatsWorking, workingLines } from "@/pages/social/History";

/** History shows the Reporter's insights as "What's working", a fold list with a count (L-39). */
const line = (o: Partial<SocialInsight>): SocialInsight => ({ _line: 1, id: "IN-1", insight: "A real question draws comments.", use: "End on a question.", evidence: "P-0019 50 comments", confidence: "medium · 4 posts", since: "2026-11-03", state: "active", ...o });
const data = (campaign?: string): SocialData => {
  const d = emptySocialExport("");
  d.insights = { lines: [line({}), line({ id: "IN-2", insight: "Retired.", state: "retired" }), line({ id: "IN-3", insight: "Only PLAN-9.", campaign: "PLAN-9" })], calls: [] };
  return { tenantId: "social", repo: "social", data: d, ...(campaign ? { campaign: { code: campaign, name: "c", path: "p", platform: null, period: null, plan: "" } } : {}) };
};

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("T64-S5 What's working", () => {
  it("active lines of this campaign or the repo; retired ones and other campaigns' are out", () => {
    expect(workingLines(data("PLAN-11")).map((x) => x.id)).toEqual(["IN-1"]);
    expect(workingLines(data("PLAN-9")).map((x) => x.id)).toEqual(["IN-1", "IN-3"]);
    expect(workingLines(undefined)).toEqual([]);
  });

  it("a fold list with a count: open by default, one line each with its confidence, folds to the header", () => {
    render(<WhatsWorking s={data("PLAN-11")} />);
    expect(screen.getByTestId("whats-working").textContent).toContain("What's working · 1 active");
    expect(screen.getByTestId("whats-working-list").textContent).toContain("A real question draws comments.medium · 4 posts");
    fireEvent.click(screen.getByRole("button", { name: /What's working/ }));
    expect(screen.queryByTestId("whats-working-list")).toBeNull();
  });

  it("says who writes it when there is nothing yet", () => {
    render(<WhatsWorking s={{ ...data(), data: emptySocialExport("") }} />);
    expect(screen.getByTestId("whats-working").textContent).toContain("0 active");
    expect(screen.getByTestId("whats-working-list").textContent).toContain("the Reporter's weekly pass writes it");
  });
});
