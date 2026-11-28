import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createSpineWriter } from "../src/inbox/spineWrite.js";
import { createStore } from "../src/store.js";
import { createReview } from "../src/review/review.js";
import { parseCard } from "../src/review/card.js";
import { parseFollowups } from "../src/review/followups.js";
import { askedOutput, readyOf } from "../src/review/ready.js";
import { cardText, makeRepo, spineText, web } from "./reviewFixture.js";
vi.hoisted(async () => (await import("../src/identity.js")).setIdentity({ owner: "Sam" }));

/**
 * (the owner, 28 Nov 13:16Z, voice note e-6765db): "low impact, high certainty ... autocomplete decision" closes
 * itself, logged; "if I'm asking for an output ... it needs to have a review card ... a high priority green"; "in the case
 * of uncertainty, then show me". Temp repos only.
 */
const EPIC = "docs/spines/epic-941.md";
const LIVE = "https://team.example/";
const ROOT = "# EPIC: home_repo\n\nProject name: [The team console](https://team.example/)\nRoot spine: self\n\n## Current State\n\nStatus: active\n";
let tmp: string;
let db: DB;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "console-e48s233-"));
  db = openDb(path.join(tmp, "console.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const auto = (id: string, o: Parameters<typeof cardText>[1] = {}) => cardText(id, { evidence: LIVE, ...o }).replace("confirm: yes\n", "confirm: auto — the button colour he will see in use\n");

function repoWith(rows: Parameters<typeof spineText>[2], cards: Record<string, string>) {
  const text = spineText("EPIC-941", "Desk home", rows, ["Goal sentence: Give the team desk a home of its own.", ""]).replace("Project name: [The team console](https://team.example/)\n", "");
  const files: Record<string, string> = { "docs/spines/root.md": ROOT, [EPIC]: text, "docs/cards/shot.png": "" };
  for (const [id, c] of Object.entries(cards)) files[`docs/cards/${id}.md`] = c;
  return makeRepo(tmp, "home_repo", files, { cards: false });
}
function setup() {
  const store = createStore(db);
  store.createMilestone({ title: "home_repo", repo: "home_repo", path: "docs/spines/root.md", owner: "", paused: false });
  const cycle = { runNowRequest: async () => ({ run: { id: "run_1" } }) };
  return createReview(db, { store, reposRoot: tmp, writer: createSpineWriter(), cycle, live: { fetch: web({ [LIVE]: 200 }).f, consoleHosts: [] } });
}

describe("small sure changes close themselves, asked-for outputs get a card", () => {
  it("parses `confirm: auto — <why>` in a card and in a row's followups", () => {
    expect(parseCard(["---", "row: X", "confirm: auto — a colour", "---"].join("\n"))?.confirm).toEqual({ yes: false, auto: true, why: "a colour" });
    expect(parseFollowups("followups: none; confirm: auto — a small UX fix").confirm).toEqual({ yes: false, auto: true, why: "a small UX fix" });
    expect(parseFollowups("followups: none; confirm: yes — read it").confirm).toEqual({ yes: true, why: "read it" });
  });

  it("an output he asked for is a high-priority card: a list, a shortlist, an analysis", () => {
    expect(askedOutput(["Your voice note: \"give me a shortlist of five agencies\""])).toBe(true);
    expect(askedOutput(["A competitive analysis of the three rivals was written."])).toBe(true);
    expect(askedOutput(["The button colour was changed to the accent."])).toBe(false);
    expect(askedOutput(["the data repo holds only the list of campaigns"])).toBe(false);
    expect(readyOf({ words: ["a list of 20 influencers"], evidence: { url: LIVE } })).toMatchObject({ why: "output", whyText: "A result you asked for" });
  });

  it("an auto card with a whole card closes itself; an output never does; a broken card goes back; the close is written and logged", async () => {
    const repo = repoWith(
      [
        { id: "E941-S1", title: "The send button is the accent colour", status: "review", evidence: LIVE },
        { id: "E941-S2", title: "A shortlist of five agencies", status: "review", evidence: LIVE },
        { id: "E941-S3", title: "Broken auto card", status: "review", evidence: LIVE },
        { id: "E941-S4", title: "Unsure, so shown", status: "review", evidence: LIVE },
      ],
      {
        "E941-S1": auto("E941-S1", { title: "The send button was made the accent colour." }),
        "E941-S2": auto("E941-S2", { title: "A shortlist of five agencies was made for you." }),
        "E941-S3": auto("E941-S3", { title: "Cluster F (violation 8): settings into the repo" }),
        "E941-S4": cardText("E941-S4", { evidence: LIVE }),
      },
    );
    const review = setup();
    await review.list({ wait: true, state: "all" });
    const agents = await review.list({ state: "agents" });
    expect(agents.map((i) => [i.ref, i.verdict.kind])).toEqual([
      ["E941-S1", "closes-itself"],
      ["E941-S2", "needs-rewriting"],
      ["E941-S3", "needs-rewriting"],
    ]);
    expect(agents[0].verdict.reason).toMatch(/^small sure change: the button colour he will see in use/);
    expect(agents[1].verdict.problems?.join(" ")).toMatch(/an output Sam asked for .* always gets his card/);
    const cards = await review.list({});
    expect(cards.map((i) => i.ref)).toEqual(["E941-S4"]);
    const out = await review.closeSelf();
    expect(out.map((x) => [x.ref, x.status])).toEqual([["E941-S1", "written"]]);
    expect(repo.read(EPIC)).toMatch(/\| E941-S1 \|[^\n]*done \(no confirm: small sure change: the button colour he will see in use\)/);
  });
});
