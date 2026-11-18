import { describe, expect, it } from "vitest";
import { trackersAnswer } from "./trackersTab";

// the wheel's Trackers tab opens on its answer: how many tables and entries, which are still empty.
const t = (id: string, rows: string[][], open = true) => ({ id, name: id[0].toUpperCase() + id.slice(1), columns: ["Name", "Status"], statuses: [], from: "frame" as const, open, rows, counts: [], file: "" });

describe("trackersAnswer", () => {
  it("says how many tables and entries, and names the empty ones", () => {
    expect(trackersAnswer({ wheel: "w", name: "W", tables: [t("influencers", [])] })).toBe("1 table, 0 entries. Still empty: Influencers.");
    expect(trackersAnswer({ wheel: "w", name: "W", tables: [t("influencers", [["Ana", "contacted"]]), t("podcasts", [], false)] })).toBe("2 tables, 1 entry. 1 asked for, waiting for your yes.");
  });
});
