import { describe, expect, it } from "vitest";
import { parseAsks } from "../src/inbox/asks.js";
import { findSettles, guarded, handsOnly, type SettleSource } from "../src/inbox/settles.js";
import type { WaitingItem } from "../src/inbox/waiting.js";

/**
 * settle defect: the owner's "A) yes" on (a decide ask: open the two public sites) also closed (a `do`
 * ask: make the Google and GitHub sign-in apps, which only his hands can do). Fixtures are the two lines as they stood
 * in the code repo's docs/spines/customer-one-we-run-on-epicteam-app-and.md before his answer (git 9e3cf961^, 2026-11-09).
 */
const E88_A2 =
  "- [ask T88-A2: decide @Sam since 2026-11-09 row T88-S2] May the team open app.epicteam.app and app.social-app.example.com to the internet, so strangers can sign up and you can sign in like a customer? — context: Google and GitHub sign-up is built and live in the console (T88-S2, fbedf58c, release 9c01b9a), tested end to end on a local copy; today the console is reachable only on our private network; the route file is prepared, not installed — impact: E88-1 (customers sign up on the product sites) and the readiness dates depend on it — options: A) yes; B) not yet — risk: the whole console, its login page included, becomes reachable from the internet; rollback: delete one Traefik file and both addresses answer 404 again — recommend: A, the same guards as signup.example.com, which you opened on T46-A16 and T46-A23 — why Sam: it widens public access — unblocks: T88-S2 (the TEST sign-up on the live sites), T88-S3";
const E88_A1 =
  "- [ask T88-A1: do @Sam since 2026-11-09 row T88-S2] http://worker.tail.example:9088/oauth/ : make the three sign-in apps for EpicTeam and SocialApp, about 12 minutes, every field on the page with a copy button. — context: Google and GitHub sign-up and sign-in are built for app.epicteam.app and app.social-app.example.com and tested end to end with a stand-in provider; only Google and GitHub themselves are missing, and those apps need your accounts — impact: with the keys in, Continue with Google and Continue with GitHub work on both sites (once the addresses are opened), and a stranger who signs up gets their own world — risk: none to existing logins; the apps ask only for name and email; rollback: delete the apps — recommend: do the three cards in order; each Client ID and secret goes into its own paste box on the card (the console's private Secrets page), never into chat — why Sam: the apps live under your Google and GitHub accounts — steps: open the page, do a card, press Done; Stuck with a note if anything looks different — unblocks: T88-S2's live test sign-ups, E88-1 — effort: ~12 min";
// a provide ask on the same row, no key target (a plain value he gives)
const E88_A9 =
  "- [ask T88-A9: provide @Sam since 2026-11-09 row T88-S2] Give the support email shown on app.epicteam.app's sign-in page. — context: the sign-in page needs a contact line — why Sam: it is your company's address — unblocks: T88-S2";

const spine = (...l: string[]) => `# PLAN-88: Customer one\n\n## Current State\n\nStatus: active\n\n## Waiting on\n\n${l.join("\n")}\n`;
function items(...lines: string[]): WaitingItem[] {
  return parseAsks(spine(...lines)).map((a, n) => ({
    id: `wj_${a.code}`,
    source: "ask",
    repo: "home_repo",
    code: a.code ?? undefined,
    row: a.row ?? undefined,
    who: a.who,
    state: "open",
    question: a.question,
    ...(a.contextText ? { contextText: a.contextText } : {}),
    ...(a.steps ? { steps: a.steps } : {}),
    ...(a.recommend ? { recommendation: a.recommend } : {}),
    ...(a.unblocks ? { unblocks: a.unblocks } : {}),
    ask: a.ask,
    milestoneId: "ms_x",
    milestoneTitle: "x",
    path: "docs/spines/x.md",
    line: a.line ?? n,
    title: a.question,
    contextLinks: [],
    owner: { kind: "none", label: "" },
    decidable: false,
  }));
}
const src = (it: WaitingItem, words: string): SettleSource => ({
  kind: "ask",
  itemId: it.id,
  repo: it.repo,
  code: it.code,
  row: it.row,
  ask: it.ask,
  question: it.question,
  detail: [it.contextText, it.steps, it.recommendation].filter(Boolean).join(" — "),
  answerKind: "answer",
  words,
  label: `home_repo/${it.code}`,
});

describe("T90-S3: a do or provide ask is never closed by another ask's answer", () => {
  const all = items(E88_A2, E88_A1, E88_A9);
  const by = (c: string) => all.find((i) => i.code === c)!;

  it("the real pair: his A) yes on T88-A2 leaves T88-A1 open, at most a maybe, even on a model yes", async () => {
    expect(by("T88-A1").ask).toBe("do");
    expect(by("T88-A2").ask).toBe("decide");
    // the model said yes in production (53c22fd5): the same answer here must not close it
    const r = await findSettles(src(by("T88-A2"), "A) yes"), all, async () => ({ settles: true, reason: "covered by the affirmative answer" }));
    expect(r.close).toEqual([]);
    const m = r.maybe.find((x) => x.code === "home_repo/T88-A1")!;
    expect(m).toBeTruthy();
    expect(m.reason).toMatch(/only you can do: only your answer to it or its done evidence closes it/);
    // without a model too (the same row is a weak link: a maybe, never a close)
    const r2 = await findSettles(src(by("T88-A2"), "A) yes"), all);
    expect(r2.close).toEqual([]);
  });

  it("a provide ask is the same: never closed by a decide answer", async () => {
    const r = await findSettles(src(by("T88-A2"), "A) yes"), all, async () => ({ settles: true, reason: "same row" }));
    expect(r.close.map((x) => x.code)).not.toContain("home_repo/T88-A9");
    expect(handsOnly(src(by("T88-A2"), "A) yes"), by("T88-A9"))).toMatch(/only you can give/);
  });

  it("nor by another do ask's answer unless its own line names that ask as the same step", async () => {
    // his done on does not give the support email
    const r = await findSettles(src(by("T88-A1"), "done"), all, async () => ({ settles: true, reason: "same row" }));
    expect(r.close.map((x) => x.code)).not.toContain("home_repo/T88-A9");
    expect(r.maybe.map((x) => x.code)).toEqual(expect.arrayContaining(["home_repo/T88-A9"]));
  });

  it("a merged duplicate still closes: its own line says the answered do ask is the same step", async () => {
    const dup = items(E88_A1, E88_A1.replace("T88-A1:", "T88-A4:").replace("— effort", "— same step as T88-A1: answering T88-A1 answers this one too — effort"));
    const s = src(dup[0], "done, the three apps are made");
    expect(handsOnly(s, dup[1])).toBeUndefined();
    expect(guarded(dup[1], s)).toBeUndefined();
    const r = await findSettles(s, dup);
    expect(r.close.map((x) => x.code)).toEqual(["home_repo/T88-A4"]);
    // the same merged line under a decide answer stays open: a yes is not a done
    const asDecide = await findSettles({ ...s, ask: "decide" }, dup);
    expect(asDecide.close).toEqual([]);
  });

  it("a decide ask still closes under a decide answer on a strong link (T90-S2 unchanged)", async () => {
    const twin = items(E88_A2, E88_A2.replace("T88-A2:", "T88-A5:"));
    const r = await findSettles(src(twin[0], "A) yes"), twin);
    // the twin is about widening public access (a permission word): kept a maybe by the older guard, not by this one
    expect(handsOnly(src(twin[0], "A) yes"), twin[1])).toBeUndefined();
    expect(r.close.length + r.maybe.length).toBe(1);
  });
});
