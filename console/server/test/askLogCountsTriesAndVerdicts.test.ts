import { describe, expect, it } from "vitest";
import { appendEvents, confusedWords, eventsFrom, fold, isTestAsk, parseEvents, settledEvents, weekOf, whatOf } from "../src/asks/askLog.js";

// every ask to the owner is one row: what, why only him, tries and minutes, his verdict, the dry run.
const item = (o: Record<string, unknown>) => JSON.stringify({ source: "ask", ...o });

describe("asks log", () => {
  const input = {
    from: "2026-11-09",
    now: "2026-11-13T22:00:00.000Z",
    asks: [
      { source: "ask", code: "AB-A10", ask: "unknown", state: "done", since: "2026-11-13", whyYou: "only you can create keys on the account.", question: "Mac page: http://h:9196/t/AB-A10/ (Copy button) needs Mac agent", repo: "books" },
      { source: "ask", code: "AB-A10", ask: "provide", state: "done", since: "2026-11-10T01:40:51.000Z", question: "Card sent 2026-11-12 …", repo: "books" },
      { source: "ask", code: "E907-A10", ask: "unknown", state: "done", since: "2026-11-13", whyYou: "only the Owner can confirm", question: "http://h:9196/t/E907-S29/ : You do: start Claude on the Mac ticket E907-S29" },
      { source: "ask", code: "E908-A8", ask: "decide", state: "open", since: "2026-11-13T01:39:30.000Z", question: "You decide: which do we sell first", whyYou: "what we sell is the goal itself" },
      { source: "ask", code: "OLD-A1", ask: "do", state: "open", since: "2026-10-01T00:00:00.000Z", question: "old" },
      { source: "ask", code: "TEST-A1", ask: "do", state: "open", since: "2026-11-13T00:00:00.000Z", question: "test" },
    ],
    responses: [
      { created_at: "2026-11-13T20:50:57.013Z", kind: "answer", text: "key provided in the console", item: item({ code: "AB-A10" }) },
      { created_at: "2026-11-13T00:11:42.350Z", kind: "answer", text: "I don't understand the question, man.", item: item({ code: "E909-A1", since: "2026-11-12T20:10:29.000Z", question: "Q", state: "answered" }) },
    ],
    pages: [
      { id: "sp_tax", title: "Paste the key", url: "http://h:9300/", created_at: "2026-11-13T19:00:00.000Z" },
      { id: "sp_e86", title: "Laptop ticket E907-S29: Let the team's browser sign in", url: "http://h:9196/t/E907-S29/", created_at: "2026-11-13T17:33:58.398Z" },
      { id: "sp_e31", title: "Laptop ticket E907-S7: Connect the Sample YouTube channel", url: "http://h:9196/t/E907-S7/", created_at: "2026-11-10T23:16:31.809Z" },
      { id: "sp_fb", title: "Card buttons on the phone: your feedback", url: "http://h:9310/", created_at: "2026-11-12T22:17:53.132Z" },
      { id: "sp_t", title: "TEST Laptop ticket E908-S3: x", url: "http://h:9196/t/TEST-E908-S3/", created_at: "2026-11-12T00:30:28.598Z" },
    ],
    changes: [
      { page_id: "sp_tax", step: "paste-key", state: "done", words: "", row_ref: null, ask_ref: "AB-A10", created_at: "2026-11-13T20:51:02.228Z" },
      { page_id: "sp_e86", step: "laptop-run", state: "done", words: "Part 1 done", row_ref: "E907-S29", ask_ref: null, created_at: "2026-11-13T20:56:57.287Z" },
      { page_id: "sp_e31", step: "laptop-run", state: "stuck", words: "SIGN IN TO WHAT????", row_ref: "E907-S7", ask_ref: null, created_at: "2026-11-13T20:47:24.433Z" },
    ],
    dryRuns: [{ code: "E908-A8", verdict: "fail" as const, reason: "step 1: no link to the options", at: "2026-11-13T21:00Z" }],
  };
  const v = fold(eventsFrom(input), input.now);
  const row = (id: string) => v.rows.find((r) => r.id === id)!;

  it("logs coded asks, Mac tickets and steps pages once each, skipping TEST and asks before the log starts", () => {
    expect(v.rows.map((r) => r.id).sort()).toEqual(["AB-A10", "E907-A10", "E907-S7", "E908-A8", "E909-A1"]);
    expect(row("E907-S7").kind).toBe("mac");
  });

  it("a steps page nobody ticked and no ask links is evidence, not an ask", () => {
    expect(v.rows.some((r) => r.id === "steps:sp_fb")).toBe(false);
  });

  it("an ask keeps its first asked time, its why and its kind; its linked ticket and steps page are tries on it", () => {
    const t = row("AB-A10");
    expect(t.askedAt).toBe("2026-11-10T01:40:51.000Z");
    expect(t.why).toBe("only you can create keys on the account.");
    expect(t.ask).toBe("provide");
    expect(t.tries).toBe(2);
    expect(t.state).toBe("done");
    expect(t.minToFirstPress).toBe(Math.round((Date.parse("2026-11-13T20:50:57.013Z") - Date.parse("2026-11-10T01:40:51.000Z")) / 60_000));
    const e = row("E907-A10");
    expect(e.ask).toBe("do");
    expect(e.tries).toBe(1);
    expect(e.what).toBe("You do: start Claude on the Mac ticket E907-S29");
  });

  it("reads confusing from his own words, never from a Mac agent's report, and logs the dry run", () => {
    expect(row("E909-A1").verdict).toBe("confusing");
    // answered from his card, and the inbox no longer lists it: closed at his answer, never left open for days
    expect(row("E909-A1").state).toBe("done");
    expect(row("E909-A1").doneAt).toBe("2026-11-13T00:11:42.350Z");
    expect(row("E907-S7").verdict).toBeUndefined();
    expect(row("E907-S7").stuck).toBe(1);
    expect(row("E908-A8").dryRun?.verdict).toBe("fail");
    expect(confusedWords("A yes, build as shown")).toBe(false);
    expect(confusedWords("WHAT EXACTLY I HAVE TO DO WHY ARE YOU NOT BEING SPECIFIC?")).toBe(true);
  });

  it("counts asks by week (Monday) and this week", () => {
    expect(weekOf("2026-11-13T22:00:00.000Z")).toBe("2026-11-09");
    expect(v.thisWeek).toEqual({ week: "2026-11-09", asked: 5 });
  });

  it("a second sweep adds nothing, and his tap outranks words", () => {
    const first = appendEvents("", eventsFrom(input));
    expect(appendEvents(first.text, eventsFrom(input)).added).toHaveLength(0);
    const tapped = appendEvents(first.text, [{ ev: "verdict", id: "E909-A1", at: "2026-11-13T23:00:00.000Z", verdict: "clear", by: "tap" }]).text;
    expect(fold(parseEvents(tapped)).rows.find((r) => r.id === "E909-A1")?.verdict).toBe("clear");
  });

  it("drops the leading link from what was asked", () => {
    expect(whatOf("http://h:9/x/ : You do: one tap")).toBe("You do: one tap");
  });

  it("never counts a test ask as the owner's: words opening with TEST or a test world", () => {
    expect(isTestAsk("TEST (not for Sam): a dummy key", "books")).toBe(true);
    expect(isTestAsk("approve the page", "e900-feedback-test")).toBe(true);
    expect(isTestAsk("Improvement request", "e901-test-b")).toBe(true);
    expect(isTestAsk("You do: sync X", "books")).toBe(false);
    expect(isTestAsk("Latest test results look fine", "notes")).toBe(false);
    const t = fold([
      { ev: "open", id: "E907-A98", at: "2026-11-10T07:24:00.000Z", what: "TEST (not for Sam): a key", repo: "books" },
      { ev: "open", id: "E907-A5", at: "2026-11-10T07:24:00.000Z", what: "approve the test page?", repo: "e900-feedback-test" },
      { ev: "open", id: "E907-A6", at: "2026-11-10T07:24:00.000Z", what: "pick the voice", repo: "books" },
    ] as never, "2026-11-13T22:00:00.000Z");
    expect(t.rows.map((r) => r.id)).toEqual(["E907-A6"]);
  });

  it("closes an ask whose line a persona settled with no press of his, only when its repo was read", () => {
    const at = "2026-11-09T00:00:00.000Z";
    const logged = [
      { ev: "open" as const, id: "E907-A1", at, kind: "ask" as const, repo: "repo-a" }, // gone from the inbox: settled
      { ev: "open" as const, id: "E907-A2", at, kind: "ask" as const, repo: "repo-a" }, // still listed open
      { ev: "open" as const, id: "E907-A3", at, kind: "ask" as const, repo: "repo-b" }, // repo-b not read: left alone
      { ev: "open" as const, id: "E907-A4", at, kind: "ask" as const, repo: "repo-a" },
      { ev: "close" as const, id: "E907-A4", at, how: "answered" }, // already closed
      { ev: "open" as const, id: "E907-S3", at, kind: "mac" as const, repo: "repo-a" }, // a Mac ticket closes by its own tick
    ];
    const asks = [{ source: "ask", code: "E907-A2", state: "open", repo: "repo-a" }];
    expect(settledEvents(logged, asks, "2026-11-14T00:00:00.000Z")).toEqual([{ ev: "close", id: "E907-A1", at: "2026-11-14T00:00:00.000Z", how: "settled" }]);
  });

  it("closes a Mac ticket the Mac list no longer has, never when the list was not read", () => {
    const at = "2026-11-09T00:00:00.000Z";
    const logged = [
      { ev: "open" as const, id: "E907-S3", at, kind: "mac" as const }, // off the list: its row was closed
      { ev: "open" as const, id: "E907-S4", at, kind: "mac" as const }, // still on the list
      { ev: "open" as const, id: "E907-S5", at, kind: "mac" as const }, // held by the dry run: still open
    ];
    expect(settledEvents(logged, [], "2026-11-14T00:00:00.000Z", new Set(["E907-S4", "E907-S5"])).map((e) => e.id)).toEqual(["E907-S3"]);
    expect(settledEvents(logged, [], "2026-11-14T00:00:00.000Z")).toEqual([]);
  });
});
