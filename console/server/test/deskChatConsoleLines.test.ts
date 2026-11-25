import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { createNoteCross, hisWords } from "../src/desk/noteCross.js";
import { consoleLine } from "../src/desk/requests.js";
import { appendChat } from "../src/team/teamState.js";
import type { DeskMessage } from "../src/desk/session.js";

// E942-S173 (found by the E942-S141 audit): his desk chat holds his words and the answers to them, not machine lines. Of 778
// chat lines in 72 h only 157 were his; one alert came back 58 times in 50 minutes (22 Nov 02:26 to 03:20Z), each a
// "↔ Passed to the SocialApp desk (dn_…): landed as EPIC-900-A32" line written as his and a one-line desk reply.
// The lines below are copied from that chat (the team repo's chat copy of that day).

const RECEIPT =
  '↔ Passed to the SocialApp desk (dn_514256da): landed as EPIC-900-A32, 02:26Z, Alert: P-0414 TikTok went out with no link; P-0569 X went out with no link.\nThe desk note this desk passed to his SocialApp desk (https://example.com/social/desk/inbox/2026-11-21-acme-check-streak-posts-link-p-0414-2.md) was placed there by its Delivery Manager: landed as EPIC-900-A32. Do nothing else. Reply in one line: "Passed to the SocialApp desk: landed as EPIC-900-A32, 02:26Z".';

describe("console lines are told apart from his words", () => {
  it("marks relay receipts, held batches, note-touch lists, steps and worker relays as the console's", () => {
    expect(consoleLine(RECEIPT)).toBe(true);
    expect(consoleLine("[console lines] held while you were busy: 9 lines, oldest first.")).toBe(true);
    expect(consoleLine("🗂 Your note touched 1 card(s) in your inbox (note of 2026-11-22 05:10Z, vn_04473037):")).toBe(true);
    expect(consoleLine("[step done] Done: Laptop run: Let the team's browser use your Mac's internet again")).toBe(true);
    expect(consoleLine("[laptop] Sam is on his laptop for 1 hour, until 03:21Z.")).toBe(true);
    expect(consoleLine("❓ Mac ticket question on Laptop ticket E986-S40")).toBe(true);
    expect(consoleLine("From the E988-S47 worker (run_e321e8f3). This is not Sam. Please post the reply below")).toBe(true);
    expect(consoleLine("↔ From the SocialApp desk (dn_7f3462c4): URGENT: posting down to 3 of 60 in 24 h")).toBe(true);
  });

  it("keeps his own words his: typed, voice notes, the rest of a note, his words passed in, his files and calls", () => {
    expect(consoleLine("Posting failing again? Why?")).toBe(false);
    expect(consoleLine("🎙 Voice note (Chat), 2026-11-22 02:23Z · 0 min 23 s")).toBe(false);
    expect(consoleLine("📎 Also in this note (vn_f1f64ab1): complaint that cards are being duplicated")).toBe(false);
    expect(consoleLine('↔ From the SocialApp desk (dx_1): posting.\nPassed here.\n\nHis words: "posting failing again"')).toBe(false);
    expect(consoleLine("Files for my voice note, which follows in the next message: read both, then answer once.")).toBe(false);
    expect(consoleLine("📞 Call with the desk, 4 min")).toBe(false);
    expect(consoleLine("[Sam] ok")).toBe(false);
  });

  it("names a console line Console in the chat copy, never him", () => {
    const m = (id: string, role: DeskMessage["role"], text: string, from?: "console"): DeskMessage => ({ id, role, kind: "message", text, status: "completed", at: "2026-11-22T02:47:00Z", ...(from ? { from } : {}) });
    const t = appendChat("", "2026-11-22", [m("a", "user", RECEIPT, "console"), m("b", "assistant", "Passed to the SocialApp desk: landed as EPIC-900-A32, 02:26Z."), m("c", "user", "Posting failing again? Why?")])!;
    expect(t).toContain("## 02:47Z · Console\n<!-- m:a -->");
    expect(t).toContain("## 02:47Z · Team desk\n<!-- m:b -->");
    expect(t).toMatch(/## 02:47Z · \S+\n<!-- m:c -->/);
    expect(t).not.toMatch(/· Console\n<!-- m:c -->/);
  });
});

describe("a desk note's landing reaches his chat only when the note quotes him", () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  it("records an alert's landing without a line, and still tells him where his own words landed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "e42s173-"));
    dirs.push(root);
    const team = path.join(root, "team");
    const social = path.join(root, "social");
    fs.mkdirSync(path.join(social, "desk/inbox"), { recursive: true });
    fs.mkdirSync(path.join(team, "desk/inbox"), { recursive: true });
    const note = (name: string, body: string, status = "open") =>
      fs.writeFileSync(path.join(social, "desk/inbox", name), `---\nfrom: acme\nabout: ${name}\nreply-to: acme\nstatus: ${status}\nrow: EPIC-900-A32\n---\n${body}\n`);
    const db = openDb(path.join(root, "console.db"));
    const side = (world: string, product: string) => ({ world, product, url: `https://${world}/chat` }) as never;
    const nc = createNoteCross({
      db,
      pairs: new Map([["social", "acme"]]),
      across: (w) => (w === "acme" ? { from: side("acme", "EpicTeam"), to: side("social", "SocialApp") } : undefined),
      home: (w) => (w === "social" ? { checkout: social, name: "social" } : w === "acme" ? { checkout: team, name: "team" } : undefined),
      since: "2026-11-20",
    });
    await nc.sweep(); // the first sweep is the backfill marker
    note("2026-11-21-acme-check-streak-posts-link-p-0414-2.md", "Alert: P-0414 TikTok went out with no link.");
    note("2026-11-21-acme-his-words.md", 'His words: "posting failing again"');
    await nc.sweep();
    note("2026-11-21-acme-check-streak-posts-link-p-0414-2.md", "Alert: P-0414 TikTok went out with no link.", "answered");
    note("2026-11-21-acme-his-words.md", 'His words: "posting failing again"', "answered");
    const r = await nc.sweep();
    expect(r.receipts).toBe(1);
    const rows = db.prepare("SELECT msg_key, note, noted_at FROM desk_crossings WHERE msg_key LIKE 'note:%' ORDER BY msg_key").all() as { msg_key: string; note: string | null; noted_at: string | null }[];
    const alert = rows.find((x) => x.msg_key.includes("p-0414"))!;
    const his = rows.find((x) => x.msg_key.includes("his-words"))!;
    expect(alert.note).toBeNull();
    expect(alert.noted_at).toBeTruthy();
    expect(his.note).toContain("landed as EPIC-900-A32");
    expect(hisWords({ body: "Alert: P-0414" })).toBe(false);
    db.close();
  });
});
