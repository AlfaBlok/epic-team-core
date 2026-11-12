// @vitest-environment jsdom
import { formatDateTime } from "@/lib/format";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Assignment, Milestone, Persona, Run, WaitingItem } from "@/api";
import { evidenceItems, evidenceLink, MilestoneTopCard, stateFreshness } from "@/components/outcome";
import { RunTimeline } from "@/components/timeline";
import { runLiveState, runningOnly, timelineGroups } from "@/lib/derive";

afterEach(cleanup);

const base: Milestone = {
  id: "ms_1",
  title: "EPIC-906",
  repo: "Acme/home_repo",
  path: "docs/EPIC-906-outcome.md",
  owner: "Sam",
  paused: false,
  createdAt: "2026-10-16T00:00:00Z",
  remote: "Acme/home_repo",
  dod: {
    done: 2,
    total: 2,
    tracked: true,
    items: [
      { text: "E6-1 The console shows the verdict on every milestone page", checked: true },
      { text: "E6-2 Activity is a run timeline with spine commits", checked: true },
    ],
  },
};

const run = (id: string, startedAt: string, extra: Partial<Run> = {}): Run => ({
  id,
  assignmentId: "as_1",
  milestoneId: "ms_1",
  startedAt,
  outcome: "progressed",
  summary: `summary ${id}`,
  ...extra,
});

describe("Top card, Outcome mode", () => {
  const m: Milestone = {
    ...base,
    verdict: { word: "accomplished", source: "outcome" },
    outcome: {
      verdict: "accomplished",
      sentence: "Sam sees whether each milestone was accomplished.",
      evidence: [
        { doneMeans: "E6-1 The console shows the verdict on every milestone page", links: ["https://github.com/Acme/home_repo/pull/12", "0891cbb"] },
        { doneMeans: "E6-2 Activity is a run timeline with spine commits", links: ["PR #13"] },
      ],
      risk: "commits outside the spine folder are not listed",
      closedAt: "2026-10-20",
      closedBy: "run_close",
    },
  };

  it("shows verdict, sentence, Done means x/y with evidence links, risk, closed by the run, spine link", () => {
    render(<MilestoneTopCard m={m} runs={[run("run_close", "2026-10-20T10:00:00Z", { threadId: "thr_9" })]} />);
    const card = screen.getByTestId("outcome-card");
    expect(within(card).getByText("accomplished")).toBeTruthy();
    expect(within(card).getByText("Sam sees whether each milestone was accomplished.")).toBeTruthy();
    expect(within(card).getByText("Done means 2/2")).toBeTruthy();
    expect(within(card).getByText("PR #12").getAttribute("href")).toBe("https://github.com/Acme/home_repo/pull/12");
    expect(within(card).getByText("0891cbb").getAttribute("href")).toBe("https://github.com/Acme/home_repo/commit/0891cbb");
    expect(within(card).getByText("PR #13").getAttribute("href")).toBe("https://github.com/Acme/home_repo/pull/13");
    expect(within(card).getByText(/Risk: commits outside/)).toBeTruthy();
    expect(within(card).getByText("closing run").getAttribute("href")).toBe("?tab=activity#run-run_close");
    // no environment known: the in-T3 link plus a copy-id button (the link opens nothing in a browser).
    expect(within(card).getByText(/^\s*thread/).closest("a")!.getAttribute("href")).toBe("t3-thread://v1/thr_9");
    expect(within(card).getByRole("button", { name: "Copy thread id" }).getAttribute("title")).toContain("thr_9");
    expect(within(card).getByText(/Open spine: Outcome/).closest("a")!.getAttribute("href")).toBe(
      "https://github.com/Acme/home_repo/blob/HEAD/docs/EPIC-906-outcome.md#outcome",
    );
    expect(screen.queryByTestId("state-card")).toBeNull();
  });

  it("a run with its environment links t3code:// and shows no copy button", () => {
    render(<MilestoneTopCard m={m} runs={[run("run_close", "2026-10-20T10:00:00Z", { threadId: "thr_9", environmentId: "5359a170-5adb-4e2d-8e6a-4569a169cfd9" })]} />);
    const card = screen.getByTestId("outcome-card");
    expect(within(card).getByText(/^\s*thread/).closest("a")!.getAttribute("href")).toBe(`t3code://threads/5359a170-5adb-4e2d-8e6a-4569a169cfd9/thr_9`);
    expect(within(card).queryByRole("button", { name: "Copy thread id" })).toBeNull();
  });
});

describe("Outcome evidence with Markdown links (E906-S3, EPIC-904 shape)", () => {
  const m: Milestone = {
    ...base,
    remote: "Acme/epicspine-skill",
    path: "docs/EPIC-904-DOCTRINE-2.md",
    verdict: { word: "accomplished", source: "outcome" },
    outcome: {
      verdict: "accomplished",
      sentence: "Every epic says what it achieves, see [doctrine](doctrine/README.md).",
      evidence: [
        { doneMeans: "E6-1 The console shows the verdict on every milestone page", links: ["[EPIC-904 view](doctrine/evidence/epic4.png)", "home_repo c5f8bdb", "[bad](javascript:alert(1))"] },
        { doneMeans: "E6-2 Activity is a run timeline with spine commits", links: ["[evidence](root/dod.md): 61 lines", "live https://team.example.com/x", "<img src=x onerror=alert(1)>"] },
      ],
      risk: null,
      closedAt: null,
      closedBy: null,
    },
  };

  it("Done means labels with Markdown links render them (live EPIC-900 shape)", () => {
    const withLink: Milestone = {
      ...m,
      dod: { done: 1, total: 1, tracked: true, items: [{ text: "DOD-1 bind in three hops (2026-10-24: [proof](root/dod.md))", checked: true }] },
    };
    render(<MilestoneTopCard m={withLink} />);
    const card = screen.getByTestId("outcome-card");
    expect(within(card).getByText("proof").getAttribute("href")).toBe("https://github.com/Acme/epicspine-skill/blob/HEAD/docs/root/dod.md");
    expect(card.textContent).not.toMatch(/\]\(/);
  });

  it("renders labelled, safe links (spine-relative targets) and never raw `[label](url)` or HTML", () => {
    const { container } = render(<MilestoneTopCard m={m} />);
    const card = screen.getByTestId("outcome-card");
    const blob = "https://github.com/Acme/epicspine-skill/blob/HEAD/docs/";
    const view = within(card).getByText("EPIC-904 view");
    expect(view.getAttribute("href")).toBe(`${blob}doctrine/evidence/epic4.png`);
    expect(view.getAttribute("rel")).toBe("noopener noreferrer");
    expect(within(card).getByText("evidence").getAttribute("href")).toBe(`${blob}root/dod.md`);
    expect(within(card).getByText("https://team.example.com/x").getAttribute("href")).toBe("https://team.example.com/x");
    expect(within(card).getByText("bad").closest("a")).toBeNull();
    expect(within(card).getByText("doctrine").getAttribute("href")).toBe(`${blob}doctrine/README.md`);
    expect(card.textContent).not.toMatch(/\]\(/);
    expect(container.querySelector("img")).toBeNull();
    expect(within(card).getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    for (const a of card.querySelectorAll("a[href]")) expect(a.getAttribute("href")).toMatch(/^(https?:|\?tab=|t3)/);
  });
});

describe("Top card, Current-state mode (no outcome)", () => {
  const m: Milestone = {
    ...base,
    status: "active",
    dod: { ...base.dod!, done: 1, items: [base.dod!.items[0], { ...base.dod!.items[1], checked: false }] },
    outcome: null,
    verdict: { word: "blocked on Sam", source: "derived" },
    spineCommitAt: "2026-10-20T11:00:00Z",
    state: {
      status: "active",
      lastAttempted: "2026-10-20 timeline built (3e563d0). " + "x".repeat(200),
      result: "card renders",
      evidence: "[PR #14](https://github.com/Acme/home_repo/pull/14), 3e563d0",
      waitingOn: "Sam's approval of the card copy",
      nextAction: "Sam reviews the card",
      verifiedAt: "2026-10-20 09:00 CEST",
      source: "spines",
    },
  };

  it("shows Status, Last attempted, Result, Evidence links, Waiting on (plain: no open ask), Next action, verdict, x/y, spine link", () => {
    render(<MilestoneTopCard m={m} runs={[]} />);
    const card = screen.getByTestId("state-card");
    expect(screen.queryByTestId("outcome-card")).toBeNull();
    expect(within(card).getByText("blocked on Sam")).toBeTruthy();
    expect(within(card).getByText("Done means 1/2")).toBeTruthy();
    for (const label of ["Status", "Last attempted", "Result", "Evidence", "Waiting on", "Next action"]) expect(within(card).getByText(label)).toBeTruthy();
    expect(within(card).queryByText("Last")).toBeNull();
    expect(within(card).getByText("PR #14").getAttribute("href")).toBe("https://github.com/Acme/home_repo/pull/14");
    expect(within(card).getByText("3e563d0").getAttribute("href")).toBe("https://github.com/Acme/home_repo/commit/3e563d0");
    expect(within(card).getByText("Waiting on").parentElement!.className).not.toMatch(/red|amber/);
    expect(within(card).getByText(/Open spine: Current State/).closest("a")!.getAttribute("href")).toMatch(/EPIC-906-outcome\.md#current-state$/);
    expect(within(card).getByText(/^updated /)).toBeTruthy();
    expect(within(card).queryByText(/stale/)).toBeNull();
  });

  // colour follows the milestone state (open asks), never the text naming the owner.
  const openAsk = { id: "w_1", source: "ask", state: "open", who: "Sam", code: "EPIC-906-A1", milestoneId: "ms_1", ask: "decide", question: "Which?", title: "Which?", contextLinks: [], decidable: true } as unknown as WaitingItem;
  it("Needs you: Waiting on row is amber and links to the Waiting on you tab", () => {
    render(<MemoryRouter><MilestoneTopCard m={m} runs={[]} open={[openAsk]} waitingHref="?tab=waiting" /></MemoryRouter>);
    const row = within(screen.getByTestId("state-card")).getByText("Waiting on").parentElement!;
    expect(row.className).toMatch(/amber/);
    expect(row.className).not.toMatch(/red/);
    expect(within(row).getByRole("link", { name: /1 waiting on you/ }).getAttribute("href")).toBe("/?tab=waiting");
  });
  it("Monitoring / no open asks: text naming Sam renders a plain row", () => {
    const mon: Milestone = { ...m, state: { ...m.state!, waitingOn: "nothing open for Sam (A21 answered 2026-10-23)" } };
    render(<MilestoneTopCard m={mon} runs={[]} open={[]} waitingHref="?tab=waiting" />);
    const row = within(screen.getByTestId("state-card")).getByText("Waiting on").parentElement!;
    expect(row.className).not.toMatch(/red|amber/);
    expect(within(row).queryByRole("link")).toBeNull();
    expect(row.textContent).toContain("nothing open for Sam");
  });

  it("clamps long fields with a more/less toggle", () => {
    render(<MilestoneTopCard m={m} runs={[]} />);
    const more = screen.getByRole("button", { name: "more" });
    expect(more.previousElementSibling!.className).toMatch(/line-clamp-2/);
    fireEvent.click(more);
    expect(screen.getByRole("button", { name: "less" }).previousElementSibling!.className).not.toMatch(/line-clamp/);
  });

  it("stale flag: verified_at older than the last run's endedAt (child runs ignored)", () => {
    const runs = [
      run("r1", "2026-10-20T08:00:00Z", { endedAt: "2026-10-20T08:30:00Z" }),
      run("r2", "2026-10-20T12:00:00Z", { endedAt: "2026-10-20T12:20:00Z" }),
    ];
    render(<MilestoneTopCard m={m} runs={runs} />);
    expect(screen.getByText(/^stale: a run ended/)).toBeTruthy();
    // Verified at wins over the (newer) spine commit; child runs never make it stale.
    expect(stateFreshness(m, runs)).toMatchObject({ stale: true, from: "verified at", updatedAt: "2026-10-20T09:00:00.000Z" });
    expect(stateFreshness(m, [run("c", "2026-10-21T00:00:00Z", { endedAt: "2026-10-21T00:10:00Z", parentRunId: "r2" })]).stale).toBe(false);
    expect(stateFreshness(m, [run("r0", "2026-10-20T07:00:00Z", { endedAt: "2026-10-20T07:10:00Z" })]).stale).toBe(false);
  });

  it("no Verified at → the spine's last commit time is the fallback", () => {
    const noVerified = { ...m, state: { ...m.state!, verifiedAt: null } };
    expect(stateFreshness(noVerified, [run("r2", "2026-10-20T12:00:00Z", { endedAt: "2026-10-20T12:20:00Z" })])).toMatchObject({
      from: "spine commit",
      updatedAt: "2026-10-20T11:00:00.000Z",
      stale: true,
    });
    expect(stateFreshness({ state: noVerified.state }, []).updatedAt).toBeUndefined();
  });

  it("evidence items: split on , and ; (not inside links); Markdown links give their target", () => {
    expect(evidenceItems("[PR #1](https://x/pull/1), abc1234; docs/a.md")).toEqual(["[PR #1](https://x/pull/1)", "abc1234", "docs/a.md"]);
    expect(evidenceLink("docs/a.md", "o/r")).toEqual({ label: "docs/a.md", href: "https://github.com/o/r/blob/HEAD/docs/a.md" });
    expect(evidenceLink("0891cbb")).toEqual({ label: "0891cbb", href: undefined });
  });
});

describe("Run timeline", () => {
  const assignments: Assignment[] = [
    { id: "as_1", milestoneId: "ms_1", personaId: "pe_1", cadence: { type: "interval", everyMinutes: 120 }, enabled: true },
    { id: "as_2", milestoneId: "ms_1", personaId: "pe_2", cadence: { type: "interval", everyMinutes: 60 }, enabled: true },
  ];
  const personas = [
    { id: "pe_1", name: "steward" },
    { id: "pe_2", name: "auditor" },
  ] as Persona[];
  const runs: Run[] = [
    run("w1", "2026-10-20T08:00:00Z", { seat: "seat1", threadId: "home_1", endedAt: "2026-10-20T08:10:00Z" }),
    run("w2", "2026-10-20T10:00:00Z", { seat: "seat2", threadId: "home_1", outcome: "blocked" }),
    run("c1", "2026-10-20T10:05:00Z", { parentRunId: "w2", threadId: "child_1", seat: "seat3" }),
    run("a1", "2026-10-20T09:00:00Z", { assignmentId: "as_2", outcome: "idle" }),
  ];

  it("groups per assignment, newest wake first with wake #n; children nest; thread links; commits per run", () => {
    const groups = timelineGroups(runs, assignments);
    expect(groups.map((g) => g.assignmentId)).toEqual(["as_1", "as_2"]);
    expect(groups[0].wakes.map((w) => [w.run.id, w.wake])).toEqual([["w2", 2], ["w1", 1]]);
    expect(groups[0].wakes[0].children.map((c) => c.run.id)).toEqual(["c1"]);
    render(
      <RunTimeline
        groups={groups}
        personas={personas}
        remote="Acme/home_repo"
        commits={{ w2: [{ sha: "3e563d0", subject: "spine: tick E6-2", at: "2026-10-20T10:20:00Z" }] }}
      />,
    );
    const steward = screen.getByRole("region", { name: "runs of steward" });
    const items = within(steward).getAllByRole("listitem").filter((li) => li.id.startsWith("run-"));
    expect(items.map((li) => li.id)).toEqual(["run-w2", "run-c1", "run-w1"]);
    expect(within(items[0]).getByText("wake #2")).toBeTruthy();
    expect(within(items[0]).getByText("seat2")).toBeTruthy();
    expect(within(items[0]).getByText("Needs you")).toBeTruthy();
    expect(within(items[0]).getByText("summary w2")).toBeTruthy();
    expect(within(items[0]).getByText(/home thread/).closest("a")!.getAttribute("href")).toBe("t3-thread://v1/home_1");
    expect(within(items[0]).getByText("3e563d0").getAttribute("href")).toBe("https://github.com/Acme/home_repo/commit/3e563d0");
    expect(within(items[0]).getByText("spine: tick E6-2")).toBeTruthy();
    expect(within(items[1]).getByText("↳ child run")).toBeTruthy();
    expect(within(items[1]).getByText(/child thread/).closest("a")!.getAttribute("href")).toBe("t3-thread://v1/child_1");
    expect(within(items[2]).getByText("wake #1")).toBeTruthy();
    expect(within(items[2]).queryByText("3e563d0")).toBeNull();
    expect(within(screen.getByRole("region", { name: "runs of auditor" })).getByText("wake #1")).toBeTruthy();
  });

  it("M2-28: overlapping child runs show only their own commits; E906-S10: running children show T3 state, never 'not closed by persona'", () => {
    const now = Date.parse("2026-10-20T11:30:00Z");
    const live = (startedAt: string) => ({ status: "live" as const, detail: "running", startedAt, checkedAt: "2026-10-20T11:29:00Z" });
    const epic: Run[] = [
      run("W", "2026-10-20T10:00:00Z", { endedAt: "2026-10-20T10:30:00Z" }),
      run("C4", "2026-10-20T10:02:00Z", { parentRunId: "W", endedAt: "2026-10-20T10:20:00Z", summary: "N10-4 docs" }),
      run("C5", "2026-10-20T10:03:00Z", { parentRunId: "W", outcome: "running", threadId: "t5", t3: live("2026-10-20T10:03:00Z"), summary: "N10-5 patch" }),
      run("C6", "2026-10-20T10:04:00Z", { parentRunId: "W", outcome: "running", threadId: "t6", t3: live("2026-10-20T10:04:00Z"), summary: "N10-6 agent-part" }),
      run("W2", "2026-10-20T11:00:00Z", { outcome: "running", threadId: "home", t3: live("2026-10-20T11:00:00Z") }),
      run("C7", "2026-10-20T11:01:00Z", { parentRunId: "W2", outcome: "running", threadId: "t7", t3: live("2026-10-20T11:10:00Z"), summary: "N10-7 open" }),
    ];
    const c = (sha: string, subject: string) => [{ sha, subject, at: "2026-10-20T10:10:00Z" }];
    render(
      <MemoryRouter>
        <RunTimeline
          now={now}
          groups={timelineGroups(epic, assignments)}
          personas={personas}
          commits={{ W: c("a000005", "EPIC-910: state update"), C5: c("a000002", "EPIC-910 N10-5: memo-mt patched"), C6: c("a000004", "EPIC-910: N10-6 agent-part worker dispatched") }}
        />
      </MemoryRouter>,
    );
    for (const sha of ["a000005", "a000002", "a000004"]) expect(screen.getAllByText(sha)).toHaveLength(1);
    const item = (id: string) => document.getElementById(`run-${id}`)!;
    expect(within(item("C6")).getByText("a000004")).toBeTruthy();
    expect(within(item("C5")).getByText("a000002")).toBeTruthy();
    expect(within(item("C4")).queryByText(/a0000/)).toBeNull();
    expect(screen.queryByText("not closed by persona")).toBeNull();
    expect(within(item("C5")).getByText("worker running · 87 min")).toBeTruthy();
    expect(within(item("C6")).getByText("worker running · 86 min")).toBeTruthy();
    // the turn's own start counts, not the run row's
    expect(within(item("C7")).getByText("worker running · 20 min")).toBeTruthy();
    expect(within(item("W2")).getByText("running · 30 min")).toBeTruthy();
    expect(within(item("C4")).getByText("Progressed")).toBeTruthy();
  });
});

describe("E906-S10 live worker chips, header count, Running filter", () => {
  const assignments: Assignment[] = [{ id: "as_1", milestoneId: "ms_1", personaId: "pe_1", cadence: { type: "interval", everyMinutes: 120 }, enabled: true }];
  const personas = [{ id: "pe_1", name: "steward" }] as Persona[];
  const now = Date.parse("2026-10-23T12:00:00Z");
  const at = (min: number) => new Date(now - min * 60_000).toISOString();
  const t3 = (status: "live" | "completed" | "failed" | "unknown", checkedMinAgo = 1, detail?: string) => ({ status, detail, startedAt: at(12), checkedAt: at(checkedMinAgo) });
  const child = (id: string, extra: Partial<Run>) => run(id, at(12), { parentRunId: "W", outcome: "running", threadId: `th_${id}`, ...extra });
  const runs: Run[] = [
    run("W", at(30), { endedAt: at(20), threadId: "home" }),
    child("live", { t3: t3("live", 1, "running") }),
    child("done", { t3: t3("completed", 1, "completed") }),
    child("fail", { t3: t3("failed", 1, "failed") }),
    child("stop", { t3: t3("failed", 1, "cancelled") }),
    child("stale", { t3: t3("live", 6, "running") }),
    child("noread", { t3: t3("unknown", 1, "read failed") }),
    child("nothread", { threadId: undefined }),
    child("closed", { outcome: "blank_report", endedAt: at(2) }),
    run("Old", at(300), { endedAt: at(290) }),
  ];
  const item = (id: string) => document.getElementById(`run-${id}`)!;
  const chip = (id: string, text: string | RegExp) => within(item(id)).getByText(text);

  it("one chip per T3 state; checkedAt in the tooltip; closed runs keep their outcome", () => {
    render(<RunTimeline now={now} groups={timelineGroups(runs, assignments)} personas={personas} />);
    const live = chip("live", "worker running · 12 min");
    expect(live.className).toMatch(/emerald/);
    expect(live.querySelector(".animate-pulse")).toBeTruthy();
    expect(live.getAttribute("title")).toContain(`last checked 1 min ago (${formatDateTime(at(1))})`);
    expect(chip("done", "finished · no report").className).toMatch(/amber/);
    expect(chip("fail", "worker failed").className).toMatch(/red/);
    expect(chip("stop", "stopped").className).toMatch(/red/);
    const stale = chip("stale", `status unknown · last checked 6 min ago`);
    expect(stale.className).toMatch(/amber/);
    expect(stale.getAttribute("title")).toMatch(/more than 5 min old.*last checked/);
    expect(chip("noread", `status unknown · last checked 1 min ago`).getAttribute("title")).toMatch(/read failed/);
    expect(chip("nothread", "status unknown · not checked yet").getAttribute("title")).toMatch(/No T3 thread/);
    expect(chip("closed", "Ended without report")).toBeTruthy();
    expect(screen.queryByText("not closed by persona")).toBeNull();
  });

  it("persona header counts live runs (wakes and children); none → no count", () => {
    const withLiveWake = [...runs, run("W3", at(5), { outcome: "running", threadId: "home", t3: t3("live") })];
    render(<RunTimeline now={now} groups={timelineGroups(withLiveWake, assignments)} personas={personas} />);
    const h = screen.getByRole("region", { name: "runs of steward" }).querySelector("h3")!;
    expect(within(h).getByText("2 workers running").className).toMatch(/emerald/);
    cleanup();
    render(<RunTimeline now={now} groups={timelineGroups([runs[0], runs[2]], assignments)} personas={personas} />);
    expect(screen.queryByText(/workers? running/)).toBeNull();
  });

  it("Running filter keeps only wakes with a live run or live child, and drops empty groups", () => {
    const groups = timelineGroups([...runs, run("X", at(60), { assignmentId: "as_2", endedAt: at(50) })], [...assignments, { ...assignments[0], id: "as_2" }]);
    const kept = runningOnly(groups, now);
    expect(kept.map((g) => g.assignmentId)).toEqual(["as_1"]);
    expect(kept[0].wakes.map((w) => [w.run.id, w.wake])).toEqual([["W", 2]]);
    expect(runningOnly(groups, now + 10 * 60_000)).toEqual([]); // all stale → nothing counts as live
    expect(runLiveState(runs[1], now)).toBe("live");
    expect(runLiveState(runs[8], now)).toBeUndefined();
  });
});

describe("threadHref (E906-S11)", () => {
  const ENV = "5359a170-5adb-4e2d-8e6a-4569a169cfd9";
  afterEach(() => vi.unstubAllEnvs());

  it("opens the T3 desktop app with t3code://threads/<env>/<id>, both URL-encoded (the id's own %3A becomes %253A)", async () => {
    const { threadHref } = await import("@/components/common");
    expect(threadHref("thread:delegated-task:command%3Amcp%3Aabc%3Adelegate-task%3Arun_1-S4", ENV)).toBe(
      `t3code://threads/${ENV}/thread%3Adelegated-task%3Acommand%253Amcp%253Aabc%253Adelegate-task%253Arun_1-S4`,
    );
    expect(threadHref("mcp:31a11da3-bb09-47ff-8aa2-002feb5e13e7", ENV)).toBe(`t3code://threads/${ENV}/mcp%3A31a11da3-bb09-47ff-8aa2-002feb5e13e7`);
  });

  it("VITE_T3_THREAD_URL takes {env} and {id}; a template with {env} is skipped while the environment is unknown", async () => {
    const { threadHref } = await import("@/components/common");
    vi.stubEnv("VITE_T3_THREAD_URL", "https://t3.example/{env}/{id}");
    expect(threadHref("mcp:x", ENV)).toBe(`https://t3.example/${ENV}/mcp%3Ax`);
    expect(threadHref("mcp:x")).toBe("t3-thread://v1/mcp:x");
    vi.stubEnv("VITE_T3_THREAD_URL", "https://t3.example/t/{id}");
    expect(threadHref("mcp:x")).toBe("https://t3.example/t/mcp%3Ax");
  });
});

describe("threadHref without an environment (M2-38)", () => {
  it("keeps the thread id exactly as T3 returned it in the deep link (no URL-encoding)", async () => {
    const { threadHref } = await import("@/components/common");
    expect(threadHref("mcp:d3607a34-64b4-42d9-a08e-ba360c64e6ba")).toBe("t3-thread://v1/mcp:d3607a34-64b4-42d9-a08e-ba360c64e6ba");
    expect(threadHref("thread:delegated-task:command%3Amcp%3Aabc")).toBe("t3-thread://v1/thread:delegated-task:command%3Amcp%3Aabc");
    expect(threadHref("91acb5f3-8fc3-4df1-be63-6f98c6b3efff")).toBe("t3-thread://v1/91acb5f3-8fc3-4df1-be63-6f98c6b3efff");
  });
});
