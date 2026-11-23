import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { wheelTrackers } from "../src/trackers.js";

// every wheel holds its tracker tables: the frame's (every wheel), its product's, its own asked-for ones.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "trackers-"));
const w = (f: string, v: unknown) => (fs.mkdirSync(path.dirname(path.join(home, f)), { recursive: true }), fs.writeFileSync(path.join(home, f), typeof v === "string" ? v : JSON.stringify(v)));
const cols = ["Name", "Where", "Status", "Reply"];
w("docs/pursuits.json", { version: 1, pursuits: [{ id: "alpha-live", name: "Alpha: 5 testers", greenWhen: "five" }, { id: "solo", name: "Solo: alone", greenWhen: "x", product: "beta" }] });
w("docs/totems/every-product.json", { totems: [], trackers: { tables: [{ id: "influencers", name: "Influencers", columns: cols, statuses: ["candidate", "contacted", "replied"] }, { id: "Bad", name: "x", columns: ["a"] }] } });
w("docs/totems/a.json", { product: "alpha", name: "Alpha", objectives: ["alpha-live"], totems: [], trackers: { tables: [{ id: "editors", name: "Video editors", columns: ["Name", "Status"] }] } });
w("docs/totems/b.json", { product: "beta", name: "Beta", objectives: [], totems: [], trackers: { tables: [{ id: "venues", name: "Venues", columns: ["Name", "Status"] }] } });
w("docs/trackers/alpha-live/influencers.csv", 'Name,Where,Status,Reply\nAna,"X, YouTube",contacted,\nBo,LinkedIn,replied,"yes, a quote"\nCy,X,contacted,\n');
w("docs/trackers/alpha-live/tables.json", { tables: [{ id: "podcasts", name: "Podcasts", columns: ["Name", "Status", "Where"], shown: ["Status", "Nope"], yes: "" }, { id: "editors", name: "dup", columns: ["Name", "Status"] }] });

describe("wheelTrackers", () => {
  it("gives a wheel the frame's tables first, then its product's, then its own; the frame ships empty", () => {
    const t = wheelTrackers(home, "alpha-live")!;
    expect(t.name).toBe("Alpha: 5 testers");
    expect(t.product).toBe("alpha");
    expect(t.tables.map((x) => [x.id, x.from, x.open])).toEqual([["influencers", "frame", true], ["editors", "product", true], ["podcasts", "own", false]]);
    const inf = t.tables[0];
    expect(inf.rows).toEqual([["Ana", "X, YouTube", "contacted", ""], ["Bo", "LinkedIn", "replied", "yes, a quote"], ["Cy", "X", "contacted", ""]]);
    expect(inf.counts).toEqual([{ status: "contacted", n: 2 }, { status: "replied", n: 1 }]);
    expect(t.tables[1].rows).toEqual([]);
    // a table's folded line names its columns, the name always first; none named: every column
    expect(t.tables[2].shown).toEqual(["Name", "Status"]);
    expect(inf.shown).toBeUndefined();
  });
  it("keeps a Wave column as plain data and shows no wave file", () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), "trackers-wave-"));
    const v = (f: string, x: unknown) => (fs.mkdirSync(path.dirname(path.join(h, f)), { recursive: true }), fs.writeFileSync(path.join(h, f), typeof x === "string" ? x : JSON.stringify(x)));
    v("docs/pursuits.json", { version: 1, pursuits: [{ id: "alpha-live", name: "Alpha: 5 testers", greenWhen: "five" }] });
    v("docs/totems/every-product.json", { totems: [], trackers: { tables: [{ id: "influencers", name: "Influencers", columns: ["Name", "Wave", "Status"] }] } });
    v("docs/trackers/alpha-live/influencers.csv", "Name,Wave,Status\nAna,,candidate\nBo,1,candidate\n");
    v("docs/trackers/alpha-live/influencers.wave.json", { name: "Wave 1", messages: [{ name: "M", who: ["Bo"], text: "Hi" }] });
    const t = wheelTrackers(h, "alpha-live")!.tables[0];
    expect(t.rows).toEqual([["Ana", "", "candidate"], ["Bo", "1", "candidate"]]);
    expect(Object.keys(t)).not.toContain("wave");
  });
  it("finds a product by the objective's declared product, and refuses an unknown wheel", () => {
    expect(wheelTrackers(home, "solo")!.tables.map((x) => x.id)).toEqual(["influencers", "venues"]);
    expect(wheelTrackers(home, "nope")).toBeNull();
    expect(wheelTrackers(home, "../x")).toBeNull();
    expect(wheelTrackers(undefined, "alpha-live")).toBeNull();
  });
});
