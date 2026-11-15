import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { listView, ROW_TEXT_MAX, rowOf } from "../src/inbox/slimList.js";

// The owner said "the inbox takes about 10 s and jumps". the budget the Inbox's list keeps.
// Production at 20:52Z: 298 items, 1.78 MB; 245 done asks were 1.74 MB of it, each answered item carried a second copy
// of itself inside `response.item`. This fixture has the same shape and sizes.
const words = (n: number, seed: string) => Array.from({ length: n }, (_, i) => `${seed}${i % 97}`).join(" ");
const item = (i: number, state: "open" | "answered" | "done") => {
  const base = {
    id: `wj_${i}`,
    source: "ask",
    state,
    repo: "acme",
    code: `EPIC-907-A${i}`,
    milestoneId: "ms_1",
    milestoneTitle: "Acme launch",
    nodeKey: `ms_1/a/b/${i}`,
    path: "docs/spines/epic-907.md",
    line: i,
    title: `EPIC-907: item ${i}`,
    ask: "do",
    question: words(60, "q"),
    recommendation: words(15, "r"),
    contextText: words(60, "c"),
    impact: words(25, "i"),
    risk: words(25, "k"),
    whyYou: words(20, "w"),
    steps: words(30, "s"),
    unblocks: words(10, "u"),
    contextLinks: Array.from({ length: 4 }, (_, j) => ({ label: `link ${j}`, url: `https://github.com/Acme/x/blob/HEAD/docs/spines/a.md?plain=1#L${j}` })),
    referencedBy: Array.from({ length: 3 }, (_, j) => ({ repo: "x", code: `E${j}`, milestoneId: "ms_2" })),
    owner: { kind: "assignment", assignmentId: "as_1", personaId: "p_1", personaName: "Delivery Manager", threadId: "t_1", label: "Delivery Manager" },
    ownerPriority: { level: "high", why: words(30, "p") },
    since: "2026-11-10",
    decidable: false,
    ...(state !== "open" ? { answer: words(40, "a"), who: "Sam", doneAt: state === "done" ? "2026-11-12" : undefined } : {}),
  };
  if (state === "open") return base;
  return {
    ...base,
    response: {
      id: `jr_${i}`,
      itemId: base.id,
      milestoneId: "ms_1",
      kind: "answer",
      text: words(80, "t"),
      createdAt: "2026-11-12T10:00:00Z",
      delivery: "delivered",
      spine: { status: "written", sha: "abc", path: base.path, at: "2026-11-12T10:00:05Z" },
      settles: { closed: ["EPIC-907-A1"], line: "also closed EPIC-907-A1" },
      item: { ...base, state: "open" },
    },
  };
};
const production = [
  ...Array.from({ length: 29 }, (_, i) => item(i, "open")),
  ...Array.from({ length: 24 }, (_, i) => item(100 + i, "answered")),
  ...Array.from({ length: 245 }, (_, i) => item(200 + i, "done")),
];
const bytes = (x: unknown) => Buffer.byteLength(JSON.stringify(x));

describe("list payload budget", () => {
  it("the production-shaped list (298 items, 245 done) goes from over 1 MB to under 420 KB, under 100 KB gzipped (production: 1,777 KB to 376 KB, 78 KB packed)", () => {
    const before = bytes(production);
    const after = listView(production);
    expect(before).toBeGreaterThan(1_000_000);
    expect(bytes(after)).toBeLessThan(420_000);
    expect(bytes(after) / before).toBeLessThan(0.3);
    expect(gzipSync(JSON.stringify(after)).length).toBeLessThan(100_000);
    // each done row stays small whatever the ask held.
    for (const r of after.filter((x) => x.state === "done")) expect(bytes(r)).toBeLessThan(1_200);
  });

  it("keeps every open card whole, drops only the copy inside an answered item's answer", () => {
    const after = listView(production);
    expect(after).toHaveLength(production.length);
    expect(after[0]).toEqual(production[0]);
    const answered = after.find((x) => x.state === "answered") as any;
    const src = production.find((x) => x.id === answered.id) as any;
    expect(answered.response.item).toBeUndefined();
    const { item: _drop, ...resp } = src.response;
    expect(answered).toEqual({ ...src, response: resp });
  });

  it("a done row carries what its folded line shows: code, question and answer cut to one line, when, the also-closed chip", () => {
    const src = production.find((x) => x.state === "done") as any;
    const r = rowOf(src) as any;
    expect(r).toMatchObject({ id: src.id, state: "done", code: src.code, repo: src.repo, milestoneId: "ms_1", doneAt: "2026-11-12", slim: true, contextLinks: [] });
    expect(r.question.length).toBeLessThanOrEqual(ROW_TEXT_MAX);
    expect(r.answer.length).toBeLessThanOrEqual(ROW_TEXT_MAX);
    expect(r.response).toMatchObject({ id: src.response.id, kind: "answer", createdAt: src.response.createdAt, settles: src.response.settles, spine: { status: "written" } });
    expect(r.owner).toEqual({ kind: "assignment", label: "Delivery Manager" });
    for (const k of ["nodeKey", "contextText", "impact", "risk", "steps", "referencedBy", "ownerPriority", "recommendation", "whyYou"]) expect(r[k]).toBeUndefined();
    // a short question is kept as it is.
    expect((rowOf({ ...src, question: "Ship it?" }) as any).question).toBe("Ship it?");
  });
});
