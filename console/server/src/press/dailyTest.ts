import fs from "node:fs";
import path from "node:path";
import type { SpineWrite, SpineWriter } from "../inbox/spineWrite.js";
import { slotOf } from "../book/refresh.js";
import type { Press, Presses, WriteHealth } from "./presses.js";
import { homeRepo, ownerName, sites } from "../identity.js";

/**
 * the daily live test of the owner's buttons, a timer the console owns (no persona, no seat). Once a
 * day, from `PRESS_TEST_HOUR_UTC` (and at start when today's has not run yet):
 *  1. arm: the TEST repo (`e67-feedback-test`, on no production list) gets its press-test spines as the presses need them
 *     (five T972-D rows in `review`, a goal closed for Reopen), one commit through the console's spine writer;
 *  2. press, through the app's own routes as the console host (`x-console-run: press-test`), every button kind on those
 *     rows: Snooze, Unsnooze, Approve, Mark complete, Changes wanted, Decline and goal Reopen (renamed the buttons
 *     Feedback and Deny; their press kinds stay `feedback` and `deny`, the same routes). Asks are never pressed: an ask
 *     shows in the owner's inbox (a TEST ask reached him on 2026-11-07);
 *  3. wait until each press has landed (GET /api/presses/:id `landed` with a commit), at most 15 min;
 *  4. restore: the TEST spines go back to rest (superseded, nothing shown anywhere), one commit;
 *  5. check: write-health's presses today rose by the number pressed with `failed` unchanged, no clone lagging and no
 *     fallback in the last 24 h, and no TEST row or ask in the owner's review list, goals or inbox;
 *  6. record one line per day in the code repo `docs/status/press-test-daily.md` (the source, L-45; due reads it).
 * A failed day is an alert to the agents: /api/health `pressTest`, a section in the Delivery Manager's wakes, the log.
 * the owner hears of it only when two days in a row fail: then one coded ask in the spine (raised once).
 */

export const PRESS_TEST_HOUR_UTC = 4;
/** A press still landing after this long is a failure. */
export const LANDING_LIMIT_MS = 15 * 60_000;
/** A TEST card's link is checked this many times (RECHECK_MS apart) before the closing buttons are pressed. */
export const RECHECK_TRIES = 4;
export const RECHECK_MS = 20_000;
export const DAILY_FILE = "docs/status/press-test-daily.md";
/** the epic that owns this test (its spine, code and row; sites().pressTest) */
export const pressTestHome = () => sites().pressTest;
export const TEST_SPINE = "docs/spines/press-test.md";
export const REOPEN_SPINE = "docs/spines/press-test-reopen.md";
/** The screenshot the TEST cards show (already in the TEST repo). */
const SHOT = "../status/test.png";
export const PRESS_TEST_RUN = "press-test";
export const TWICE_ASK =
  "The daily button test failed two days in a row: the lines are in docs/status/press-test-daily.md. Should an agent stop other work and fix the button path first?";

export interface TestRow {
  ref: string;
  title: string;
  card: string;
}
export const TEST_ROWS: TestRow[] = [
  { ref: "T972-D1", title: "TEST card for Snooze and Unsnooze", card: "A test card was put up to try Snooze and Unsnooze." },
  { ref: "T972-D2", title: "TEST card for the yes button", card: "A test card was put up to try the yes button." },
  { ref: "T972-D3", title: "TEST card for Mark complete", card: "A test card was put up to try marking a card complete." },
  { ref: "T972-D4", title: "TEST card for Changes wanted", card: "A test card was put up to try Changes wanted." },
  { ref: "T972-D5", title: "TEST card for Decline", card: "A test card was put up to try Decline." },
];
export const REOPEN_ROW: TestRow = { ref: "T972-D6", title: "TEST row a closed goal hides", card: "A test card was put up behind a closed goal." };

/**
 * the feedback and Decline words are as long as a long voice note (about 9,000 characters): a card once refused the owner's
 * note at a 4,000 character limit, so every day's run proves a long note still lands whole.
 */
export const LONG_TEST_WORDS = (what: string) => `TEST: the daily press test's ${what}, as long as a long voice note. ${"Every word said on a card is taken, however long. ".repeat(180)}End of the TEST ${what}.`;

export type PressKind = "snooze" | "unsnooze" | "approve" | "complete" | "feedback" | "deny" | "reopen";

const LEDGER_HEAD = [
  "| Issue | Role | Owner / Assignment | Title | Status | Depends On | PR/Branch | Base | Latest Evidence | Last Verified | Next Action |",
  "|---|---|---|---|---|---|---|---|---|---|---|",
];
const rowLine = (r: TestRow, date: string) =>
  `| ${r.ref} | Ticket worker | TEST builder | ${r.title} | review | none | none | main | [test page](${sites().teamUrl}/) | ${date} | followups: none; confirm: yes — a TEST card |`;

const head = (code: string, title: string) => [
  `# ${code}: ${title}`,
  "",
  "Spine profile: compact",
  "Repository: e67-feedback-test",
  "Root spine: [root](root.md)",
  "Parent spine: [root](root.md)",
  "Integration policy: main-direct",
  `Project name: [TEST Epic Team](${sites().teamUrl}/)`,
  "Goal sentence: We want to see every press land.",
  "",
  "## Goal",
  "",
  `TEST only: ${homeRepo()} ${pressTestHome().row}'s daily press test presses every review button kind on these rows in production, then puts them back. On no production list; the console's TEST filter hides them.`,
  "",
];

/** The press-test spine: armed (rows in review, pressed today) or at rest (superseded: read by nothing). */
export function testSpine(state: "armed" | "rest", date: string): string {
  return [
    ...head("EPIC-973", "TEST daily press test"),
    "## Current State",
    "",
    "Owner: TEST builder (the agent-team console)",
    state === "armed" ? `Status: active (TEST, armed by the daily press test ${date})` : "Status: superseded (TEST at rest between daily press tests)",
    "Next action: the console's daily press test arms these rows, presses them and puts them back",
    "",
    "## Issue Ledger",
    "",
    ...LEDGER_HEAD,
    ...TEST_ROWS.map((r) => rowLine(r, date)),
    "",
  ].join("\n");
}

/** The goal Reopen is pressed on: armed it is closed by the test (listed for Reopen only in the TEST filter), at rest superseded. */
export function reopenSpine(state: "armed" | "rest", date: string): string {
  return [
    ...head("EPIC-974", "TEST goal for Reopen"),
    "## Current State",
    "",
    "Owner: TEST builder (the agent-team console)",
    state === "armed" ? `Status: done (closed by the daily press test ${date})` : "Status: superseded (TEST at rest between daily press tests)",
    "Next action: the console's daily press test closes this goal, presses Reopen and puts it back",
    "",
    "## Issue Ledger",
    "",
    ...LEDGER_HEAD,
    rowLine(REOPEN_ROW, date),
    "",
  ].join("\n");
}

export const cardFile = (r: TestRow) =>
  [
    "---",
    `row: ${r.ref}`,
    `title: ${r.card}`,
    "goal: We want to see every press land.",
    "delivered:",
    "  - ✓ The test card is there to press.",
    "  - ✓ Nothing real depends on it.",
    `evidence: [Open the test page](${sites().teamUrl}/)`,
    `screenshot: ${SHOT}`,
    "source: The daily press test raised it, to check that every button works.",
    "decision: Does every button work? The team recommends Mark complete.",
    "name: the test card",
    "confirm: yes",
    "---",
    "",
    `TEST card for ${homeRepo()} ${pressTestHome().row}'s daily press test.`,
    "",
  ].join("\n");

/** Every file the TEST repo needs in `state`, by path. */
export function seedFiles(state: "armed" | "rest", date: string): Record<string, string> {
  return {
    [TEST_SPINE]: testSpine(state, date),
    [REOPEN_SPINE]: reopenSpine(state, date),
    ...Object.fromEntries([...TEST_ROWS, REOPEN_ROW].map((r) => [`docs/cards/${r.ref}.md`, cardFile(r)])),
  };
}

export interface PressResult {
  kind: PressKind;
  target: string;
  status: number;
  pressId?: string;
  state?: Press["state"] | "not logged";
  sha?: string;
  reason?: string;
  /** how long the button's route took to answer (the browser's wait), ms. */
  replyMs?: number;
}

export interface PressTestRun {
  at: string;
  endedAt: string;
  /** The run's UTC date (one line per date in the daily file). */
  day: string;
  reason: string;
  ok: boolean;
  presses: PressResult[];
  /** Today's write-health counts before and after. */
  health: { before: { presses: number; failed: number }; after: { presses: number; failed: number } };
  arm?: { status: SpineWrite["status"] | "unchanged"; sha?: string; reason?: string };
  restore?: { status: SpineWrite["status"] | "unchanged"; sha?: string; reason?: string };
  failures: string[];
  /** The day's line in docs/status/press-test-daily.md. */
  line: string;
  record?: { status: SpineWrite["status"]; sha?: string; reason?: string };
  /** The two-days-in-a-row ask, when raised. */
  ask?: { status: string; code?: string; reason?: string };
}

/** A visible item of the owner's lists (review list, goals, inbox) that belongs to a TEST repo or row. */
export interface ListLeak {
  list: string;
  what: string;
}

export interface PressTestDeps {
  presses: Pick<Presses, "get" | "health">;
  writer: SpineWriter;
  /** The TEST repo's checkout (undefined: not on this host). */
  testRepo: () => { name: string; dir: string } | undefined;
  /** the code repo's checkout (the daily line and the ask go there). */
  teamRepo: () => string | undefined;
  /** The review row id of `ref` in `rel` of the TEST repo, read from the spine now (undefined: not in review). */
  rowId: (rel: string, ref: string) => string | undefined;
  /** The closed-goal key of `rel` in the TEST repo (undefined: not closed). */
  goalKey: (rel: string) => string | undefined;
  /** POST a route through the app, as the console host (a button route is logged as a press); `path` without /api. */
  press: (path: string, body: unknown) => Promise<{ status: number; pressId?: string; json?: unknown }>;
  /** Clone status (write-health `clones`). */
  clones: () => { lagging?: unknown[]; fallbacks?: { at: string }[] } | undefined;
  /** TEST items visible on the owner's lists right now. */
  leaks: () => Promise<ListLeak[]>;
  /** A written checkout: drop its cached views. */
  invalidate: (dir: string) => void;
  /** Raise the two-days-in-a-row ask (inbox/raise.ts, into the spine). */
  raise?: (question: string) => Promise<{ status: string; code?: string; reason?: string }>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How often a landing press is looked at (default 5 s). */
  pollMs?: number;
  landingLimitMs?: number;
  recheckMs?: number;
  hourUtc?: number;
  log?: (msg: string) => void;
}

const DAY_LINE = /^- (\d{4}-\d{2}-\d{2}) \S+ (PASS|FAIL)\b/;

/** The recorded days, newest last: `{day, pass}` from docs/status/press-test-daily.md. */
export function recordedDays(text: string): { day: string; pass: boolean }[] {
  return text
    .split("\n")
    .map((l) => DAY_LINE.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ day: m[1], pass: m[2] === "PASS" }));
}

const DAILY_HEAD = [
  "# Daily press test",
  "",
  "One line per day, written by the agent-team console's daily press test (core/console/server/src/press/dailyTest.ts).",
  `It presses every review button kind on TEST rows in the TEST repo e67-feedback-test (on no production list), checks each press landed with a commit, checks /api/write-health and ${ownerName()}'s lists, then puts the TEST rows back.`,
  `A FAIL line is an alert to the agents (/api/health \`pressTest\`, the Delivery Manager's wake). Two FAIL days in a row raise one ask in ${pressTestHome().epic}.`,
  `Live: ${sites().teamUrl}/api/press-test`,
  "",
];

const hm = (iso: string) => iso.slice(11, 16) + "Z";
const short = (s?: string) => (s ? s.slice(0, 8) : "");

export function dayLine(r: Omit<PressTestRun, "line" | "record" | "ask" | "endedAt">): string {
  const kinds = r.presses.map((p) => p.kind).join(", ");
  const landed = r.presses.filter((p) => p.state === "landed").length;
  // the slowest reply a button gave (the browser's wait; the landing runs after it)
  const replies = r.presses.map((p) => p.replyMs).filter((x): x is number => typeof x === "number");
  const reply = replies.length ? `, slowest reply ${Math.max(...replies)} ms` : "";
  const base = `- ${r.day} ${hm(r.at)} ${r.ok ? "PASS" : "FAIL"}: ${landed} of ${r.presses.length} presses landed (${kinds})${reply}; write-health today ${r.health.before.presses} to ${r.health.after.presses}, failed ${r.health.before.failed} to ${r.health.after.failed}`;
  const restore = r.restore && (r.restore.status === "written" || r.restore.status === "unchanged") ? `; TEST rows back at rest${r.restore.sha ? ` ${short(r.restore.sha)}` : ""}` : "";
  return `${base}${restore}${r.failures.length ? `; failures: ${r.failures.join(" / ").replace(/\|/g, "/").slice(0, 600)}` : "; lists clean"}`;
}

export function createPressTest(d: PressTestDeps) {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = d.log ?? ((m: string) => console.log(m));
  const pollMs = d.pollMs ?? 5_000;
  const limitMs = d.landingLimitMs ?? LANDING_LIMIT_MS;
  const recheckMs = d.recheckMs ?? RECHECK_MS;
  const runs: PressTestRun[] = [];
  let running: Promise<PressTestRun> | undefined;
  let triedSlot: number | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const dailyText = (): string => {
    const dir = d.teamRepo();
    try {
      return dir ? fs.readFileSync(path.join(dir, DAILY_FILE), "utf8") : "";
    } catch {
      return "";
    }
  };

  async function seed(state: "armed" | "rest", date: string): Promise<NonNullable<PressTestRun["arm"]>> {
    const repo = d.testRepo();
    if (!repo) return { status: "skipped", reason: "the TEST repo is not checked out on this console" };
    const files = seedFiles(state, date);
    const w = await d.writer.scaffold({
      repoDir: repo.dir,
      path: TEST_SPINE,
      label: `press test ${state}`,
      scaffold: async (dir) => {
        for (const [rel, text] of Object.entries(files)) {
          fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
          fs.writeFileSync(path.join(dir, rel), text);
        }
        return { ok: true, files: Object.keys(files) };
      },
      msg: state === "armed" ? `TEST: armed for ${homeRepo()} ${pressTestHome().row}'s daily press test ${date} (console)` : `TEST: back at rest after ${homeRepo()} ${pressTestHome().row}'s daily press test ${date} (console)`,
      body:
        state === "armed"
          ? "The agent-team console's daily press test put the TEST rows T972-D1..D6 in review and closed the TEST goal EPIC-974, to press every review button kind on them. On no production list."
          : "The agent-team console's daily press test put the TEST rows back at rest (both TEST spines superseded: read by nothing).",
    });
    d.invalidate(repo.dir);
    if (w.status === "skipped" && /changed nothing/.test(w.reason ?? "")) return { status: "unchanged" };
    return { status: w.status, ...(w.sha ? { sha: w.sha } : {}), ...(w.reason ? { reason: w.reason } : {}) };
  }

  /** Wait until the press has landed or failed, at most until `deadline`. */
  async function settle(p: PressResult, deadline: number): Promise<void> {
    if (!p.pressId) {
      p.state = "not logged";
      return;
    }
    for (;;) {
      const x = d.presses.get(p.pressId);
      if (!x) {
        p.state = "not logged";
        return;
      }
      p.state = x.state;
      if (x.sha) p.sha = x.sha;
      if (x.reason) p.reason = x.reason;
      if (x.state !== "landing" || now() >= deadline) return;
      await sleep(pollMs);
    }
  }

  async function runOnce(reason: string): Promise<PressTestRun> {
    const at = new Date(now()).toISOString();
    // the day is the run's UTC date (a manual run counts as that day's run: the 04:00Z slot then finds its line)
    const day = at.slice(0, 10);
    const date = day;
    const failures: string[] = [];
    const counts = (h: WriteHealth) => ({ presses: h.today.presses, failed: h.today.failed, day: h.today.day });
    const before = counts(d.presses.health(1));
    const presses: PressResult[] = [];

    const arm = await seed("armed", date);
    if (arm.status !== "written" && arm.status !== "unchanged") failures.push(`arming the TEST rows was ${arm.status}: ${arm.reason ?? "unknown"}`);
    else {
      const id = (ref: string) => d.rowId(TEST_SPINE, ref);
      const [d1, d2, d3, d4, d5] = TEST_ROWS.map((r) => r.ref);
      const plan: { kind: PressKind; target: string; path: () => string | undefined; body: unknown }[] = [
        { kind: "snooze", target: d1, path: () => (id(d1) ? `/review-items/${id(d1)}/snooze` : undefined), body: { hours: 3 } },
        { kind: "unsnooze", target: d1, path: () => (id(d1) ? `/review-items/${id(d1)}/snooze` : undefined), body: { until: null } },
        { kind: "approve", target: d2, path: () => (id(d2) ? `/review-items/${id(d2)}/approve` : undefined), body: {} },
        { kind: "complete", target: d3, path: () => (id(d3) ? `/review-items/${id(d3)}/complete` : undefined), body: {} },
        { kind: "feedback", target: d4, path: () => (id(d4) ? `/review-items/${id(d4)}/relaunch` : undefined), body: { feedback: LONG_TEST_WORDS("feedback") } },
        { kind: "deny", target: d5, path: () => (id(d5) ? `/review-items/${id(d5)}/deny` : undefined), body: { reason: LONG_TEST_WORDS("deny") } },
        { kind: "reopen", target: "EPIC-974", path: () => (d.goalKey(REOPEN_SPINE) ? "/review-goals/reopen" : undefined), body: { key: d.goalKey(REOPEN_SPINE) } },
      ];
      // the closing buttons act only on a card whose link answered: check the TEST rows' link now (no press, not logged),
      // again up to RECHECK_TRIES times while one is not live (a slow console timed its own link out, 2026-11-08 01:36Z)
      for (const r of TEST_ROWS) {
        const rid = id(r.ref);
        for (let i = 0; rid && i < RECHECK_TRIES; i++) {
          const c = await d.press(`/review-items/${rid}/recheck`, {}).catch(() => undefined);
          if ((c?.json as { state?: string } | undefined)?.state === "review") break;
          if (i < RECHECK_TRIES - 1) await sleep(recheckMs);
        }
      }
      for (const p of plan) {
        const route = p.path();
        if (!route) {
          presses.push({ kind: p.kind, target: p.target, status: 0, state: "not logged", reason: "the TEST row or goal was not found after arming" });
          continue;
        }
        try {
          const t0 = now();
          const r = await d.press(route, p.kind === "reopen" ? { key: d.goalKey(REOPEN_SPINE) } : p.body);
          const replyMs = now() - t0;
          const why = r.status >= 400 ? ((r.json as { error?: { message?: string } } | undefined)?.error?.message ?? "") : "";
          presses.push({ kind: p.kind, target: p.target, status: r.status, replyMs, ...(r.pressId ? { pressId: r.pressId } : {}), ...(why ? { reason: why.slice(0, 200) } : {}) });
        } catch (e) {
          presses.push({ kind: p.kind, target: p.target, status: 0, reason: (e as Error).message.slice(0, 200) });
        }
      }
      const deadline = now() + limitMs;
      for (const p of presses) await settle(p, deadline);
      for (const p of presses)
        if (p.state !== "landed" || !p.sha)
          failures.push(`${p.kind} ${p.target} ${p.state === "landing" ? "still landing after 15 min" : p.state === "landed" ? "landed without a commit" : `${p.state ?? "not pressed"} (HTTP ${p.status}${p.reason ? `: ${p.reason}` : ""})`}`);
    }

    const restore = await seed("rest", date);
    if (restore.status !== "written" && restore.status !== "unchanged") failures.push(`restoring the TEST rows was ${restore.status}: ${restore.reason ?? "unknown"}`);

    const after = counts(d.presses.health(1));
    const pressed = presses.filter((p) => p.pressId).length;
    if (after.day === before.day) {
      if (after.presses - before.presses < pressed) failures.push(`write-health counted ${after.presses - before.presses} presses today, ${pressed} were pressed`);
      if (after.failed !== before.failed) failures.push(`write-health failed today went from ${before.failed} to ${after.failed}`);
    }
    const clones = d.clones();
    if (clones?.lagging?.length) failures.push(`${clones.lagging.length} shared checkout(s) lagging behind the write clone`);
    const recent = (clones?.fallbacks ?? []).filter((f) => now() - Date.parse(f.at) < 86_400_000);
    if (recent.length) failures.push(`${recent.length} write(s) fell back to the shared checkout in the last 24 h`);
    try {
      const leaks = await d.leaks();
      if (leaks.length) failures.push(`TEST items on ${ownerName()}'s lists: ${leaks.map((l) => `${l.list} ${l.what}`).join(", ")}`);
    } catch (e) {
      failures.push(`${ownerName()}'s lists could not be read: ${(e as Error).message.slice(0, 120)}`);
    }

    const ok = failures.length === 0;
    const partial = { at, day, reason, ok, presses, health: { before: { presses: before.presses, failed: before.failed }, after: { presses: after.presses, failed: after.failed } }, arm, restore, failures };
    const line = dayLine(partial);
    const run: PressTestRun = { ...partial, line, endedAt: at };

    // the day's line, in the repo (the source): appended under the head, a line already there for the day is replaced
    const team = d.teamRepo();
    const prior = recordedDays(dailyText()).filter((x) => x.day !== day);
    if (team) {
      const w = await d.writer.scaffold({
        repoDir: team,
        path: DAILY_FILE,
        label: "daily press test",
        scaffold: async (dir) => {
          const f = path.join(dir, DAILY_FILE);
          let text = "";
          try {
            text = fs.readFileSync(f, "utf8");
          } catch {
            text = DAILY_HEAD.join("\n") + "\n";
          }
          const lines = text.replace(/\n+$/, "").split("\n").filter((l) => DAY_LINE.exec(l)?.[1] !== day);
          fs.mkdirSync(path.dirname(f), { recursive: true });
          fs.writeFileSync(f, [...lines, line, ""].join("\n"));
          return { ok: true, files: [DAILY_FILE] };
        },
        msg: `daily press test ${day} ${ok ? "PASS" : "FAIL"} (console)`,
        body: `The agent-team console's daily press test: ${line.slice(2)}`,
      });
      run.record = { status: w.status, ...(w.sha ? { sha: w.sha } : {}), ...(w.reason ? { reason: w.reason } : {}) };
      d.invalidate(team);
    }
    // two failed days in a row: one coded ask (raise.ts never asks the same question twice while it is open)
    if (!ok && prior.length && !prior[prior.length - 1].pass && d.raise) {
      run.ask = await d.raise(TWICE_ASK).catch((e) => ({ status: "failed", reason: (e as Error).message }));
    }
    run.endedAt = new Date(now()).toISOString();
    runs.unshift(run);
    runs.splice(10);
    log(`press test (${reason}): ${line.slice(2)}${run.record ? ` [recorded ${run.record.status}${run.record.sha ? ` ${run.record.sha}` : run.record.reason ? `: ${run.record.reason}` : ""}]` : ""}${run.ask ? ` [ask ${run.ask.status}${run.ask.code ? ` ${run.ask.code}` : ""}]` : ""}`);
    return run;
  }

  const run = (reason = "manual") => {
    // any run uses up the slot it falls in, in this process too (the line may not reach the shared checkout at once)
    triedSlot = slotOf(now(), d.hourUtc ?? PRESS_TEST_HOUR_UTC);
    return (running ??= runOnce(reason).finally(() => (running = undefined)));
  };

  /**
   * The current slot (from 04:00Z) has no line in the daily file and this process has not tried it yet. A line is dated by
   * its run, so a run between midnight and 04:00Z (a manual one) counts for the slot it fell in: any line dated on or
   * after the slot's day.
   */
  function due(): boolean {
    const slot = slotOf(now(), d.hourUtc ?? PRESS_TEST_HOUR_UTC);
    if (triedSlot === slot) return false;
    const day = new Date(slot).toISOString().slice(0, 10);
    return !recordedDays(dailyText()).some((x) => x.day >= day);
  }

  async function tick(reason = "daily"): Promise<PressTestRun | undefined> {
    if (running || !due()) return undefined;
    triedSlot = slotOf(now(), d.hourUtc ?? PRESS_TEST_HOUR_UTC);
    return run(reason);
  }

  /** /api/health `pressTest`: the last recorded day (this process's run, else the daily file). */
  function health() {
    const last = runs[0];
    const days = recordedDays(dailyText());
    let streak = 0;
    for (let i = days.length - 1; i >= 0 && !days[i].pass; i--) streak++;
    if (last) return { state: running ? "running" : last.ok ? "ok" : "failed", day: last.day, at: last.at, failures: last.failures, failedDaysInARow: streak };
    const l = days[days.length - 1];
    return l ? { state: running ? "running" : l.pass ? "ok" : "failed", day: l.day, failedDaysInARow: streak } : { state: running ? "running" : "none" };
  }

  /** The Delivery Manager's wake section while the last day failed (undefined when it passed). */
  function section(): string | undefined {
    const h = health();
    if (h.state !== "failed") return undefined;
    const last = runs[0];
    return [
      "## Daily press test failed",
      `The console's daily press test of ${ownerName()}'s buttons failed on ${h.day}${(h.failedDaysInARow ?? 0) > 1 ? ` (${h.failedDaysInARow} days in a row)` : ""}: ${last ? last.failures.join("; ") : `see ${DAILY_FILE}`}.`,
      `This wake: read ${DAILY_FILE}, GET /api/press-test, /api/write-health?days=2 and /api/presses?state=failed; find the cause, fix it under ${pressTestHome().epic} (a ready row) and run the test again (POST /api/press-test/run). ${ownerName()} gets one ask only when two days in a row fail.`,
    ].join("\n");
  }

  return {
    run,
    tick,
    due,
    runs: () => [...runs],
    running: () => !!running,
    health,
    section,
    start(everyMs: number, firstAfterMs = 5 * 60_000) {
      if (timer || everyMs <= 0) return;
      setTimeout(() => void tick("start").catch((e) => log(`press test: ${(e as Error).message}`)), firstAfterMs).unref?.();
      timer = setInterval(() => void tick().catch((e) => log(`press test: ${(e as Error).message}`)), everyMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

export type PressTest = ReturnType<typeof createPressTest>;
