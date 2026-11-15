import { describe, expect, it } from "vitest";
import { buildDocs, createInboxSearch, fold, queryWords, searchDocs, type SearchSources } from "../src/inbox/search.js";

/**
 * the owner, 2026-11-12 21:17Z: typing a word (e.g. Condesa) filters every section of the Inbox at once,
 * matching titles, the card's text and his own notes on it.
 */
const NOW = Date.parse("2026-11-12T21:30:00Z");
const day = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

function sources(): SearchSources {
  return {
    now: NOW,
    waiting: [
      { id: "wj_open", state: "open", title: "E938-S10 Airbnb host message", question: "Which flat in La Condesa do we book?", code: "E938-A4", row: "E938-S10" },
      { id: "wj_answered", state: "answered", title: "Pick the logo", question: "Logo A or B?", code: "E909-A1" },
      { id: "wj_done_old", state: "done", doneAt: iso(NOW - 40 * day), title: "Condesa lease (old)", question: "Sign?" },
      { id: "wj_done", state: "done", doneAt: iso(NOW - 5 * day), title: "Roma Norte lease", question: "Sign?" },
      { id: "wj_fyi", state: "open", decidedBy: "Delivery Manager", title: "Decided: staging first", question: "Ship to staging?" },
    ],
    responses: [
      { id: "r1", itemId: "wj_answered", text: "B, the one with the jacaranda", createdAt: iso(NOW - day), item: { question: "Logo A or B?" }, spine: { status: "written" } },
      // a written answer whose line left the spine 10 days ago: older than the Inbox's 3-day list, inside 30 days.
      { id: "r2", itemId: "wj_gone", text: "yes, Condesa is fine", createdAt: iso(NOW - 10 * day), item: { title: "Second flat", question: "Also the Condesa flat?", code: "E938-A2", milestoneId: "ms_1" }, spine: { status: "written", at: iso(NOW - 10 * day) } },
      { id: "r3", itemId: "wj_ancient", text: "Condesa", createdAt: iso(NOW - 60 * day), item: { question: "Ancient?" }, spine: { status: "written" } },
    ],
    review: [
      { id: "rv_1", title: "Inbox search", ref: "E948-S64", face: { title: "A search box filters the inbox.", taskGoal: "Find any card by a word.", delivered: [{ ok: true, text: "Typing Polanco filters every section" }], source: "Sam said: make it fast", decision: "Keep it?" } },
      { id: "rv_2", title: "Clip", ref: "E84-4", feedback: "make the voice warmer" },
    ],
    status: [
      { id: "wj_open", kind: "ask", title: "duplicate of the ask" },
      { id: "st_ready", kind: "mark_ready", title: "E977-S3 Mark ready: the desk inbox" },
    ],
    voice: [{ words: "Por favor revisa la terraza", rows: [{ code: "E84-4" }] }],
  };
}

describe("inbox search", () => {
  it("folds case and accents and splits words", () => {
    expect(fold("CancÚn Ñ")).toBe("cancun n");
    expect(queryWords('  "La  Condesa" ')).toEqual(["la", "condesa"]);
  });

  it("finds a word in every section at once: blocked, review and done (his answers, 30 days back)", () => {
    const r = searchDocs(buildDocs(sources()), "condesa");
    expect(r.hits.map((h) => [h.id, h.section]).sort()).toEqual([
      ["wj_gone", "done"],
      ["wj_open", "blocked"],
    ]);
    expect(r.counts).toEqual({ blocked: 1, review: 0, done: 1 });
    // the 40-day-old done line and the 60-day-old answer are out of the 30 days.
    expect(r.hits.some((h) => h.id === "wj_done_old" || h.id === "wj_ancient")).toBe(false);
    // the gone item comes back as its one-line row for Answered.
    expect(r.rows).toEqual([expect.objectContaining({ id: "wj_gone", state: "done", slim: true, code: "E938-A2" })]);
  });

  it("matches the card's text, his notes and his voice notes on the card's row, and says where", () => {
    const docs = buildDocs(sources());
    expect(searchDocs(docs, "polanco").hits).toEqual([expect.objectContaining({ id: "rv_1", section: "review", where: ["card"] })]);
    expect(searchDocs(docs, "jacaranda").hits).toEqual([expect.objectContaining({ id: "wj_answered", section: "done", where: ["note"] })]);
    expect(searchDocs(docs, "warmer").hits.map((h) => h.id)).toEqual(["rv_2"]);
    expect(searchDocs(docs, "terraza").hits.map((h) => h.id)).toEqual(["rv_2"]);
    expect(searchDocs(docs, "e948-s64").hits[0]).toMatchObject({ id: "rv_1", where: ["title"] });
    // every word must match (somewhere in the item).
    expect(searchDocs(docs, "condesa flat").hits.map((h) => h.id).sort()).toEqual(["wj_gone", "wj_open"]);
    expect(searchDocs(docs, "condesa jacaranda").total).toBe(0);
    // a status row the Blocked section shows (no ask card) is searchable; its id is listed once.
    expect(searchDocs(docs, "desk inbox").hits.map((h) => [h.id, h.section])).toEqual([["st_ready", "blocked"]]);
    expect(docs.filter((d) => d.id === "wj_open")).toHaveLength(1);
    // a decided-for-you item is history, not blocked.
    expect(searchDocs(docs, "staging").hits[0].section).toBe("done");
  });

  it("nothing matches: zero everywhere; one letter is no search", () => {
    const docs = buildDocs(sources());
    expect(searchDocs(docs, "zzzz")).toMatchObject({ total: 0, hits: [], rows: [] });
    expect(searchDocs(docs, "c").total).toBe(0);
  });

  it("is fast on production size: 400 asks, 600 answers, 60 cards, 120 voice notes, under 300 ms per query (cold) and 20 ms (warm)", async () => {
    const words = "airbnb condesa roma polanco logo staging inbox search voice card desk mac key deploy review".split(" ");
    const w = (i: number, n = 40) => Array.from({ length: n }, (_, k) => words[(i * 7 + k) % words.length]).join(" ");
    const big: SearchSources = {
      now: NOW,
      waiting: Array.from({ length: 400 }, (_, i) => ({ id: `wj_${i}`, state: i % 3 ? "done" : "open", doneAt: iso(NOW - (i % 20) * day), title: `E${i}-S1 ${w(i, 8)}`, question: w(i, 60), contextText: w(i + 1, 120), options: [w(i, 5), w(i + 2, 5)], code: `E${i}-A1` })),
      responses: Array.from({ length: 600 }, (_, i) => ({ id: `r_${i}`, itemId: `wj_${i % 700}`, text: w(i, 80), createdAt: iso(NOW - (i % 25) * day), item: { question: w(i, 20), title: `T${i}` }, spine: { status: "written" } })),
      review: Array.from({ length: 60 }, (_, i) => ({ id: `rv_${i}`, title: w(i, 10), ref: `E${i}-S2`, face: { title: w(i, 15), taskGoal: w(i, 15), delivered: [{ ok: true, text: w(i, 20) }], source: w(i, 40), decision: w(i, 20), qc: { words: [{ said: w(i, 30) }] } } })),
      status: Array.from({ length: 20 }, (_, i) => ({ id: `st_${i}`, kind: "stalled", title: w(i, 12) })),
      voice: Array.from({ length: 120 }, (_, i) => ({ words: w(i, 200), rows: [{ code: `E${i}-S2` }, { code: `E${i}-A1` }] })),
    };
    let t = performance.now();
    const search = createInboxSearch(async () => big, { cacheMs: 60_000 });
    const first = await search.search("condesa");
    const cold = performance.now() - t;
    expect(first.total).toBeGreaterThan(0);
    expect(cold).toBeLessThan(300);
    t = performance.now();
    for (const q of ["co", "con", "cond", "condesa", "condesa roma", "zzzz"]) await search.search(q);
    expect((performance.now() - t) / 6).toBeLessThan(20);
  });

  it("re-reads the lists after the cache window, and at once after drop()", async () => {
    let now = NOW;
    let loads = 0;
    const s = createInboxSearch(async () => (loads++, sources()), { cacheMs: 5_000, now: () => now });
    await s.search("condesa");
    await s.search("roma");
    expect(loads).toBe(1);
    now += 6_000;
    await s.search("roma");
    expect(loads).toBe(2);
    s.drop();
    await s.search("roma");
    expect(loads).toBe(3);
  });
});
