// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { api, type RedLine } from "@/api";
import { RedLineBand } from "@/components/ownerPriority";

// the memory service
// red line shows its live tester count with where it came from, and opens the memory service's testers and counts page.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const page = { name: "Memo testers and counts", address: "cloud.memo.example.com/admin/testers", url: "https://cloud.memo.example.com/admin/testers" };
const memo: RedLine = {
  name: "Memo's first tester",
  sentence: "Get Memo's first real tester signed up and using it every day.",
  state: "agreed",
  items: [{ repo: "memo", ref: "T26-A3" }],
  links: [{ label: "Memo testers and counts", url: "https://cloud.memo.example.com/admin/testers" }],
  counts: [
    { label: "Active testers", source: "memory-counts#active_testers", value: 0, sourceText: "Memo's public counts, active_testers, read hourly from cloud.memo.example.com/api/public/counts", note: "read 2026-11-10 21:04 UTC", page },
    { label: "Tester applications", source: "memory-counts#applications", value: 1, sourceText: "Memo's public counts, applications, read hourly from cloud.memo.example.com/api/public/counts", page },
  ],
};

describe("T80-S4 the red line's live counts and link", () => {
  it("shows each count, where it came from and when, and the page link with one plain label", async () => {
    vi.spyOn(api, "redLine").mockResolvedValue({ redLine: memo, redLines: [memo] });
    render(<RedLineBand />);
    await waitFor(() => expect(screen.getAllByTestId("red-line-count-value")).toHaveLength(2));
    expect(screen.getAllByTestId("red-line-count-value").map((e) => e.textContent)).toEqual(["0 active testers", "1 tester applications"]);
    expect(screen.getByTestId("red-line-count-from").textContent).toBe("from Memo's public counts, read 21:04 UTC");
    // the unfolded line is only its cards; where a number came from, in full, is its hover.
    expect(screen.getAllByTestId("red-line-count-value")[0].getAttribute("title")).toBe("Memo's public counts, active_testers, read hourly from cloud.memo.example.com/api/public/counts. read 2026-11-10 21:04 UTC");
    const a = screen.getByTestId("red-line-link") as HTMLAnchorElement;
    expect(a.textContent).toBe("Memo testers and counts");
    expect(a.getAttribute("href")).toBe("https://cloud.memo.example.com/admin/testers");
    expect(a.getAttribute("target")).toBe("_blank");
  });

  it("a line without them is as before; a count not read yet shows a dash", async () => {
    const plain: RedLine = { ...memo, links: undefined, counts: [{ ...memo.counts![0], value: null, note: undefined }] };
    vi.spyOn(api, "redLine").mockResolvedValue({ redLine: plain, redLines: [plain, { ...memo, name: "Other", counts: undefined, links: undefined }] });
    render(<RedLineBand />);
    await waitFor(() => expect(screen.getAllByTestId("red-line")).toHaveLength(2));
    expect(screen.getByTestId("red-line-count-value").textContent).toBe("– active testers");
    expect(screen.queryByTestId("red-line-link")).toBeNull();
    expect(screen.getAllByTestId("red-line-counts")).toHaveLength(1);
  });
});
