// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api, type MilestoneFreshness, type MilestoneTree } from "@/api";
import { useQuery } from "@/lib/data";
import { FreshnessLine, SyncFooter } from "@/components/freshness";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
const fresh = (over: Partial<MilestoneFreshness> = {}): MilestoneFreshness => {
  const f = { repo: "home_repo", sha: "16e63f4a9b8c", syncedAt: ago(40), behind: 0, ahead: 0, ...over };
  return { ...f, repos: [f], narrative: {}, ...over };
};

describe("T13-S6 FreshnessLine", () => {
  it("fresh: 'Synced from GitHub <age> · <sha7>', not amber", async () => {
    vi.spyOn(api, "getFreshness").mockResolvedValue(fresh());
    render(<FreshnessLine milestoneId="m1" />);
    const line = await screen.findByTestId("freshness-line");
    expect(line.textContent).toMatch(/^Synced from GitHub .+ · 16e63f4$/);
    expect(line.dataset.state).toBe("fresh");
    expect(line.className).not.toMatch(/amber/);
  });

  it("behind: says N commits behind, amber", async () => {
    vi.spyOn(api, "getFreshness").mockResolvedValue(fresh({ behind: 4 }));
    render(<FreshnessLine milestoneId="m1" />);
    const line = await screen.findByTestId("freshness-line");
    expect(line.textContent).toContain("· 4 commits behind");
    expect(line.dataset.state).toBe("behind");
    expect(line.className).toMatch(/amber/);
  });

  it("failed: amber with the reason on hover", async () => {
    vi.spyOn(api, "getFreshness").mockResolvedValue(fresh({ error: "fatal: Not possible to fast-forward, aborting." }));
    render(<FreshnessLine milestoneId="m1" />);
    const line = await screen.findByTestId("freshness-line");
    expect(line.dataset.state).toBe("failed");
    expect(line.title).toMatch(/fast-forward/);
    expect(line.className).toMatch(/amber/);
  });

  it("flags a Current State older than its children", async () => {
    vi.spyOn(api, "getFreshness").mockResolvedValue(fresh({ narrative: { verifiedAt: ago(7200), childCommitAt: ago(60), behindMinutes: 119, behindHours: 2 } }));
    render(<FreshnessLine milestoneId="m1" />);
    expect((await screen.findByTestId("narrative-age")).textContent).toBe("Current State is 2 h behind its children");
  });

  it("a lag under an hour reads in minutes, not '1 h'", async () => {
    vi.spyOn(api, "getFreshness").mockResolvedValue(fresh({ narrative: { verifiedAt: ago(420), childCommitAt: ago(60), behindMinutes: 6, behindHours: 0 } }));
    render(<FreshnessLine milestoneId="m1" />);
    expect((await screen.findByTestId("narrative-age")).textContent).toBe("Current State is 6 min behind its children");
  });

  it("Refresh pulls and the tree on the page re-fetches with the new fixture", async () => {
    let title = "old root";
    vi.spyOn(api, "getFreshness").mockImplementation(async () => fresh(title === "old root" ? { behind: 1 } : {}));
    vi.spyOn(api, "getTree").mockImplementation(async () => ({ root: { title } }) as unknown as MilestoneTree);
    const refresh = vi.spyOn(api, "refreshMilestone").mockImplementation(async () => {
      title = "new root"; // the pull brought a new spine
      return { repo: "home_repo", sha: "9f1c2ab4", behind: 0, pulled: true };
    });
    function TreeProbe() {
      const { data } = useQuery(() => api.getTree("m1"), []);
      return <p data-testid="probe">{data?.root.title}</p>;
    }
    render(
      <>
        <FreshnessLine milestoneId="m1" />
        <TreeProbe />
      </>,
    );
    expect((await screen.findByTestId("probe")).textContent).toBe("old root");
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("new root"));
    expect(refresh).toHaveBeenCalledWith("m1");
    expect((await screen.findByTestId("refresh-note")).textContent).toBe("pulled");
    await waitFor(() => expect(screen.getByTestId("freshness-line").dataset.state).toBe("fresh"));
  });

  it("Refresh inside 5 s says so", async () => {
    vi.spyOn(api, "getFreshness").mockResolvedValue(fresh());
    vi.spyOn(api, "refreshMilestone").mockResolvedValue({ repo: "home_repo", pulled: false, rateLimited: true });
    render(<FreshnessLine milestoneId="m1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Refresh/ }));
    expect((await screen.findByTestId("refresh-note")).textContent).toMatch(/just refreshed/);
  });
});

describe("T13-S6 SyncFooter", () => {
  it("shows the oldest synced time and which repos are not in line", async () => {
    vi.spyOn(api, "getFreshnessSummary").mockResolvedValue({
      repos: [
        { repo: "home_repo", syncedAt: ago(30) },
        { repo: "ops", syncedAt: ago(600), behind: 2 },
      ],
      oldestSyncedAt: ago(600),
    });
    render(<SyncFooter />);
    const f = await screen.findByTestId("sync-footer");
    expect(f.textContent).toMatch(/Oldest sync from GitHub: .+ \(ops\) · 2 repos · not in line: ops/);
  });
});
