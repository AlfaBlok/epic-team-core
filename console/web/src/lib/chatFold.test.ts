import { describe, expect, it } from "vitest";
import type { DeskMessage } from "@/api/types";
import { consoleSummary, foldChat, isConsole } from "@/lib/chatFold";
import { socialProduct } from "@/lib/identity";

// E942-S173 (found by the E942-S141 audit): his desk chat holds his words and the answers to them, not machine lines.
// The lines are from his Team desk chat of 22 and 23 Nov (the team repo's chat copy).

let n = 0;
const msg = (role: DeskMessage["role"], text: string, from?: "console"): DeskMessage => ({
  id: `m${++n}`,
  role,
  kind: "message",
  text,
  status: "completed",
  at: "2026-11-22T02:47:00Z",
  ...(from ? { from } : {}),
});
const receipt = (k: number) =>
  msg(
    "user",
    `↔ Passed to the SocialApp desk (dn_${k}): landed as EPIC-900-A32, 02:26Z, Alert: P-0414 TikTok went out with no link.\nThe desk note this desk passed to his SocialApp desk was placed there by its Delivery Manager: landed as EPIC-900-A32. Do nothing else. Reply in one line: "Passed to the SocialApp desk: landed as EPIC-900-A32, 02:26Z".`,
    "console",
  );
const echo = () => msg("assistant", "Passed to the SocialApp desk: landed as EPIC-900-A32, 02:26Z.");

describe("the desk Chat folds machine lines away from his words", () => {
  it("folds the alert passed on 58 times, with its 58 echoes, into one console row", () => {
    const lines: DeskMessage[] = [];
    for (let k = 0; k < 58; k++) lines.push(receipt(k), echo());
    const his = msg("user", "Posting failing again? Why?");
    const answer = msg("assistant", "Not all posting is down: a YouTube Short went out at 01:32Z. Three posts left with no link back, two on TikTok and one on X. Four X posts wait for your release on the digest page. The GitHub login has been down since about 01:30Z yesterday, which is likely behind it.");
    const items = foldChat([...lines, his, answer]);
    expect(items.map((x) => x.kind)).toEqual(["console", "message", "message"]);
    const fold = items[0] as Extract<(typeof items)[number], { kind: "console" }>;
    expect(fold.lines).toHaveLength(116);
    expect(consoleSummary(fold.lines)).toBe("Passed to the SocialApp desk: landed as EPIC-900-A32, 02:26Z.");
  });

  it("folds the desk's working steps above its answer", () => {
    const his = msg("user", "🎙 Voice note (Chat), 2026-11-23 · 6 min · his long note");
    const step = msg("assistant", "Reading his long note now. Next I'll match each point to the rows he's pointing back to (persona review, kernel, Bitwarden), then dispatch.");
    const answer = msg("assistant", "Got your 6 points:\n\n- **Persona review** → redo it per objective, on its ticket.\n- **Kernel** → on its ticket.\n- **Bitwarden** → on its ticket.\n- **Briefer** → removed from EpicTeam.\n- **Ingestion health manager** → kept.\n- **Delivery manager** → stays, one per objective.");
    const items = foldChat([his, step, answer]);
    expect(items.map((x) => x.kind)).toEqual(["message", "steps", "message"]);
    expect((items[2] as { m: DeskMessage }).m.id).toBe(answer.id);
  });

  it("never folds his words, a long desk message, or a long reply that follows a console line", () => {
    const worker = msg("user", "From the E988-S47 worker (run_e321e8f3). This is not Sam. Please post the reply below to Sam in the Team desk chat, word for word.", "console");
    const long = msg("assistant", `${"The multi-tenant platform is live: you can sign up as a new customer and point it at your repo. ".repeat(4)}`);
    const items = foldChat([worker, long]);
    expect(items.map((x) => x.kind)).toEqual(["console", "message"]);
    const a = msg("user", "Where in adeje should I look for Airbnb?");
    const b = msg("assistant", "Sure.");
    expect(foldChat([a, b]).map((x) => x.kind)).toEqual(["message", "message"]);
  });

  it("reads a relay receipt as the console's even before the server marks it", () => {
    const r = msg("user", `↔ Passed to the ${socialProduct()} desk (dn_1): landed as EPIC-900-A32, 02:26Z, Alert: P-0414.`);
    expect(isConsole(r)).toBe(true);
    expect(consoleSummary([msg("user", "[step done] x", "console"), msg("assistant", "[The plan](https://example.com/p) is saved.")])).toBe("The plan is saved.");
    expect(consoleSummary([msg("user", "[console lines] held while you were busy: 2 lines, oldest first.", "console")])).toBe("");
    expect(isConsole(msg("user", `Pass this to the ${socialProduct()} desk please`))).toBe(false);
  });
});
