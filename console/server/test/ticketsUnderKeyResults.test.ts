import { describe, expect, it } from "vitest";
import { homeRepo } from "../src/identity.js";
import { placeTickets, type ScorecardNode, type SpineInfo } from "../src/scorecards.js";
import { keyResultLines, objectiveCards, objectivesBlock, ticketsLine, TICKETS_RULE } from "../src/objectives.js";

/** every ticket hangs under a key result, and each key result lists its tickets everywhere it shows. */
const info = (repo: string, path: string, queue: [string, "ready" | "running" | "waiting"][], review: string[] = []): SpineInfo => ({
  repo,
  path,
  code: "EPIC-901",
  doneMeans: { done: 0, total: 0 },
  boxes: [],
  codes: [],
  queue: queue.map(([code, state]) => ({ code, title: `${code} title`, state, status: state })),
  ...(review.length ? { review } : {}),
});
const node = (id: string, spines: string[], work: string[][]): ScorecardNode => ({
  id,
  kind: "pursuit",
  name: id,
  greens: 0,
  total: work.length,
  spines,
  children: [],
  rows: [],
  keyResults: work.map((w, i) => ({ label: `KR ${i}`, kind: "key-result", state: "red", value: "0", work: w.map((c) => { const [repo, code] = c.split(":"); return { code, repo, kind: "ticket" as const, state: "amber" as const }; }) })),
});

describe("every ticket hangs under a key result", () => {
  it("lists the open tickets of an objective's epics that no key result of any objective names", () => {
    const spineInfo = { "app:a.md": info("app", "a.md", [["E901-S1", "ready"], ["E901-S2", "running"], ["E901-S3", "waiting"]], ["E901-S4"]), "app:b.md": info("app", "b.md", [["E902-S1", "ready"]]) };
    const a = node("a", ["app:a.md"], [["app:E901-S1"]]);
    const b = node("b", ["app:b.md"], [["app:E901-S2", "app:E902-S1"]]); // E901-S2 lives in a's epic but moves b's key result
    placeTickets([a, b], spineInfo);
    expect(a.unplaced?.map((w) => w.code)).toEqual(["E901-S3", "E901-S4"]);
    expect(a.unplaced?.[1]).toMatchObject({ status: "review", epicCode: "EPIC-901", path: "a.md" });
    expect(b.unplaced).toBeUndefined();
  });

  it("the wake prompt names each objective's tickets under its key results and the ones under none, with the rule", () => {
    const body = {
      nodes: [
        { id: "a", kind: "pursuit", name: "A", rank: 1, greens: 0, total: 1, keyResults: [{ label: "K", state: "red", work: [{ code: "E901-S1", kind: "ticket", state: "amber" }, { code: "E901-S9", kind: "ticket", state: "green" }, { code: "EPIC-901", kind: "epic" }] }], unplaced: [{ code: "E901-S3" }, { code: "E901-S4" }] },
        { id: "b", kind: "pursuit", name: "B", rank: 2, greens: 0, total: 1, keyResults: [{ label: "L", state: "red", work: [{ code: "E902-S1", kind: "ticket", state: "amber" }] }] },
      ],
    };
    const block = objectivesBlock(body);
    expect(block).toContain(TICKETS_RULE);
    expect(block).toMatch(/^1\. .* 1 open ticket under its key results; 2 under none: E901-S3, E901-S4/m);
    expect(block).toMatch(/^2\. .* 1 open ticket under its key results, none under no key result/m);
    expect(objectiveCards(body)[0].keyResults[0].tickets).toEqual(["E901-S1"]);
    expect(ticketsLine({ keyResults: [], unplaced: [] })).toBeUndefined();
    expect(ticketsLine({ keyResults: [{}], unplaced: [1, 2, 3, 4, 5, 6].map((n) => ({ code: `E909-S${n}` })) })).toBe("0 open tickets under its key results; 6 under none: E909-S1, E909-S2, E909-S3, E909-S4 +2");
  });

  it("a worker brief names the key result its row hangs under, or that it hangs under none and how to place it", () => {
    const input = { nodes: [{ id: "a", kind: "pursuit", name: "a", headline: "Acme: Get 5 testers", greens: 0, total: 1, keyResults: [{ label: "Testers sign up", work: [{ code: "E901-S1", repo: homeRepo() }] }] }] };
    expect(keyResultLines(input, "E901-S1", homeRepo())).toBe("Key result: Acme: Get 5 testers: Testers sign up (key result a#0). Your work moves it; say how in your report.");
    expect(keyResultLines(input, "E901-S1", "other")).toMatch(/^Key result: none yet\. E901-S1 hangs under no key result: .*kr_tickets\.py place E901-S1 <objective id> <n> --repo other/);
  });
});
