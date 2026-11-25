import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { campaignObjective, namesPersona, personaChapters, readPlot, readWheel, yourPartSection } from "../src/yourPart.js";

// every persona is told its chapters (the ones it reads and writes), the plot and its objective at each wake.
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "yourpart-"));
const wheelFile = {
  product: "socialapp",
  name: "SocialApp",
  wheel: {
    class: { name: "Campaign" },
    tabs: [
      { label: "Key results", reads: ["Delivery Manager"], writes: ["The console's checks"] },
      { label: "Pipeline", lives: "acme-posts · data/posts-ledger.md", knows: "Every post and where it stands.", reads: ["Publisher", "Responder"], writes: ["Writer", "Responder"] },
      { label: "Chat", reads: ["Every worker's brief"], writes: ["You"] },
      { label: "Context", reads: ["Every worker, first"], writes: ["Every worker, last"] },
    ],
  },
};

describe("yourPart: chapters, plot and objective in every wake", () => {
  it("names the chapters this persona reads and writes, and every worker's own", () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, "docs/totems"), { recursive: true });
    fs.writeFileSync(path.join(home, "docs/totems/socialapp.json"), JSON.stringify(wheelFile));
    const w = readWheel(home, "SocialApp")!;
    expect(w.tabs.map((t) => t.label)).toEqual(["Key results", "Pipeline", "Chat", "Context"]);
    const r = personaChapters(w, "Responder");
    expect(r.reads.map((t) => t.label)).toEqual(["Pipeline", "Context"]);
    expect(r.writes.map((t) => t.label)).toEqual(["Pipeline", "Context"]);
    // a persona's long name matches its short one; "Every worker's brief" is a brief, not a persona
    expect(namesPersona("Delivery Manager", "Delivery Manager · campaign manager")).toBe(true);
    expect(namesPersona("Every worker's brief", "Scout")).toBe(false);
    const s = yourPartSection({ persona: "Responder", milestone: "Get testers", repo: "acme-world", template: "acme-posts", wheel: w });
    expect(s).toContain("Every campaign has the same 4 chapters");
    expect(s).toContain("Pipeline (acme-world · data/posts-ledger.md): Every post and where it stands ;");
    expect(s).toContain("Chapters you write back into last: Pipeline, Context.");
    expect(s).toContain("The plot: none written");
    expect(s).toContain("The objective: none names this campaign");
  });

  it("reads the plot from the spine, and a root's from its live campaigns", () => {
    const repo = tmp();
    fs.mkdirSync(path.join(repo, "docs/spines"), { recursive: true });
    fs.writeFileSync(path.join(repo, "docs/spines/root.md"), "# World\n\nParent spine: none\n");
    fs.writeFileSync(path.join(repo, "docs/spines/c1.md"), "# Credits\n\nStatus: ready\n\n## Campaign plan\n\n### Why this campaign\nStartups need a kick.\n\n### The bet\n- Free credits bring sign-ups.\n\n## Done means\n");
    fs.writeFileSync(path.join(repo, "docs/spines/c2.md"), "# Old\n\nStatus: superseded\n\n## Campaign plan\n\n### Why this campaign\nOld.\n");
    expect(readPlot(repo, "docs/spines/c1.md")).toEqual({ where: "docs/spines/c1.md § Campaign plan", lines: ["Why this campaign: Startups need a kick.", "The bet: Free credits bring sign-ups."] });
    const root = readPlot(repo, "docs/spines/root.md")!;
    expect(root.lines).toEqual(["Credits (docs/spines/c1.md § Campaign plan): Why this campaign: Startups need a kick."]);
  });

  it("finds a campaign's objective by the objective's watch, then by its campaign repo", () => {
    const ps = [
      { id: "credits", watch: [{ repo: "acme-posts", paths: ["docs/spines/c1.md"] }] },
      { id: "testers", numbers: { campaign: "acme-world" } },
      { id: "parked", parked: true, numbers: { campaign: "acme-posts" } },
    ];
    expect(campaignObjective(ps, "Acme/acme-posts", "docs/spines/c1.md")).toBe("credits");
    expect(campaignObjective(ps, "Acme/acme-world", "docs/spines/root.md")).toBe("testers");
    expect(campaignObjective(ps, "Acme/acme-posts", "docs/spines/c9.md")).toBeUndefined();
  });
});
