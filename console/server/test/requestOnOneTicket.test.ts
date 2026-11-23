import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chatCopyMessages, createRequestRows, plainTitle, requestIdOf, requestRowsIn } from "../src/desk/requests.js";
import { hisWordsIn, saidRequest } from "../src/desk/said.js";
import { readyDecision } from "../src/status/add.js";

// One request, one ticket row, a part of the kernel (the owner's note of 22 Nov: "dealing with tickets not getting lost. I
// think that ticket itself got lost"): every request of his has one id and lands on exactly one ticket row. The ids have
// the shape of the T3 item ids in the desk chat copy; the hosted request check reads the same ids.

const CLIENT = "message%3Amcp%3Aclient%253Ac112b6cc-3d3c-4c54-83c0-4e54c81842ee%3Athread-send%3A";
const AGENT = "message%3Amcp%3A0b9f2a1c-1111-2222-3333-444455556666%3Athread-send%3A";

describe("one id per request", () => {
  it("reads the id from the request id the console sent his input with", () => {
    expect(requestIdOf(`${CLIENT}chat-caedab95-0754-4cb8-9456-cd0b91ee7707`, "Where in adeje should I look for Airbnb?")).toBe("ch_caedab95");
    expect(requestIdOf(`${CLIENT}chat-files-0a1b2c3d-0754-4cb8`)).toBe("ch_0a1b2c3d");
    expect(requestIdOf(`${CLIENT}voice-note-chat-vn_69ef802c-g1`)).toBe("vn_69ef802c");
    expect(requestIdOf(`${CLIENT}memory-zcn_3df438f440546301-Log-2026-11-22.md-e-f6833e`)).toBe("e-f6833e");
  });
  it("a relay, a console line or an agent's send is no request", () => {
    expect(requestIdOf(`${CLIENT}desk-cross-dx_e69d4895-passed`)).toBeUndefined();
    expect(requestIdOf(`${AGENT}e988-s47-run_e321e8f3-step3-desk-reply`)).toBeUndefined();
    expect(requestIdOf(`${CLIENT}chat-11112222-aaaa`, "[laptop] Sam is on his laptop for 1 hour")).toBeUndefined();
  });
  it("the files notice before his voice note is no request: the voice note after it is (the same rule as the hosted check)", () => {
    expect(requestIdOf(`${CLIENT}chat-26a16a62-aaaa`, "Files for my voice note, which follows in the next message: read both, then answer once.")).toBeUndefined();
    expect(requestIdOf(`${CLIENT}chat-c19a4e39-aaaa`, "📎 Attachments (1): Sam attached this file to his message.")).toBe("ch_c19a4e39");
  });
});

const SPINE = `# EPIC-940: Lanes

## Issue Ledger

| ID | Role | Owner | Title | Status | Branch | PR | Base | Evidence | Verified | Next Action |
|----|------|-------|-------|--------|--------|----|------|----------|----------|-------------|
| E940-S98 | Ticket worker | unassigned | Data ingestion objective. vn_69ef802c | review | none | none | main | none | 2026-11-22 | none |
| E940-S99 | Ticket worker | unassigned | Something else | ready | none | none | main | none | 2026-11-22 | none |

## Decisions

| Date | Decision | Why |
|------|----------|-----|
| 2026-11-22 | E940-S98 and E940-S99 both cite vn_69ef802c | a summary names two rows: it places nothing |
| 2026-11-22 | E940-S99 ready on Sam's ask (L-37, Team desk: "x"; request ch_caedab95) | his ask |
`;

describe("where a request landed, read from the epic file", () => {
  it("a row line holding the id beats a Decisions line; a Decisions line places it only when it names one row", () => {
    const got = requestRowsIn(SPINE, "acme", "docs/spines/epic-40.md");
    expect(got.get("vn_69ef802c")?.rows.map((r) => r.code)).toEqual(["E940-S98"]);
    expect(got.get("vn_69ef802c")?.rows[0].status).toBe("review");
    expect(got.get("ch_caedab95")?.rows.map((r) => r.code)).toEqual(["E940-S99"]);
  });
  it("the index scans every repo's epic files and answers [] for a request on none", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "req-rows-"));
    fs.mkdirSync(path.join(root, "acme", "docs", "spines"), { recursive: true });
    fs.writeFileSync(path.join(root, "acme", "docs", "spines", "epic-40.md"), SPINE);
    fs.mkdirSync(path.join(root, "acme", "docs", "cards"), { recursive: true });
    fs.writeFileSync(path.join(root, "acme", "docs", "cards", "E940-S99.md"), "---\nrow: E940-S99\ntitle: The inbox counts were fixed.\nname: Inbox counts fixed\n---\nbody\n");
    const idx = createRequestRows({ reposRoot: () => root });
    await idx.ready();
    expect(idx.rowsOf("ch_caedab95")?.map((r) => r.code)).toEqual(["E940-S99"]);
    expect(idx.rowsOf("ch_00000000")).toEqual([]);
    expect(idx.rowsOf("ch_caedab95")?.[0].title).toBe("Inbox counts fixed");
    expect(idx.rowsOf("vn_69ef802c")?.[0].title).toBe("Data ingestion objective");
    fs.rmSync(root, { recursive: true, force: true });
  });
  it("reads an epic kept outside docs/spines: at the repo top, in docs/, or a spine one folder under docs/", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "req-rows-"));
    const row = (code: string, id: string) => SPINE.replace("E940-S98", code).replace("vn_69ef802c", id);
    fs.mkdirSync(path.join(root, "zen", "docs"), { recursive: true });
    fs.writeFileSync(path.join(root, "zen", "docs", "EPIC-REAL-USER-TEST.md"), row("E907-S3", "vn_2e2710c0"));
    fs.writeFileSync(path.join(root, "zen", "docs", "NOTES.md"), "# notes vn_00000001, no ledger\n");
    fs.mkdirSync(path.join(root, "home2"), { recursive: true });
    fs.writeFileSync(path.join(root, "home2", "EPIC.md"), row("E907-S4", "vn_75913d30"));
    fs.mkdirSync(path.join(root, "trips", "docs", "travel"), { recursive: true });
    fs.writeFileSync(path.join(root, "trips", "docs", "travel", "TRAVEL_SPINE.md"), row("Q-5", "e-ea71a0").replace("E940-S99", "Q-6"));
    fs.writeFileSync(path.join(root, "trips", "docs", "travel", "notes.md"), row("Q-9", "ch_99999999"));
    const idx = createRequestRows({ reposRoot: () => root });
    await idx.ready();
    expect(idx.rowsOf("vn_2e2710c0")?.map((r) => r.code)).toEqual(["E907-S3"]);
    expect(idx.rowsOf("vn_75913d30")?.map((r) => r.code)).toEqual(["E907-S4"]);
    expect(idx.rowsOf("e-ea71a0")?.map((r) => r.code)).toEqual(["Q-5"]);
    expect(idx.rowsOf("ch_99999999")).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("the Add the desk files from his words stamps his request on its row", () => {
  it("his message's request id rides from his words to the Decisions line of the new row", () => {
    const msgs = [{ text: "please finish fixing anything broken due to this github problem", at: "2026-11-22T01:59:00Z", request: "ch_ff1d0bbd" }];
    const ask = hisWordsIn(msgs, "finish fixing anything broken", Date.parse("2026-11-22T02:00:00Z"));
    expect(typeof ask === "object" && ask.request).toBe("ch_ff1d0bbd");
    expect(saidRequest(msgs, "finish fixing anything broken")).toBe("ch_ff1d0bbd");
    expect(saidRequest(msgs, "something he never said")).toBe(false);
    const d = readyDecision("E906-S187", { via: "Team desk", quote: "finish fixing", request: "ch_ff1d0bbd" }, "2026-11-22");
    expect(d.decision).toMatch(/E906-S187 ready on .*; request ch_ff1d0bbd\)$/);
  });
});

// The owner, 22 Nov: "I've read this several times and I don't know what you're talking about": the task's name in plain words.
describe("the task's plain name", () => {
  it("the card's name, else its title, else the row title up to its first stop, without codes", () => {
    expect(plainTitle("---\nname: One request, one task\ntitle: x\n---", "y")).toBe("One request, one task");
    expect(plainTitle("---\ntitle: 'The inbox counts were fixed.'\n---", undefined)).toBe("The inbox counts were fixed");
    expect(plainTitle(undefined, "Every request lands on exactly one ticket row. Core: changes wheel: part of E907-S3")).toBe("Every request lands on exactly one ticket row");
    expect(plainTitle(undefined, "Follow-up of E907-S3 (E907-S4) for the inbox")).toBe("For the inbox");
    expect(plainTitle(undefined, "")).toBeUndefined();
  });
});

// The line under his message must name the task for every request the hosted check counts placed (23 Nov: the
// card check found only "Not picked up yet" because the desk quoted his typed lines without their id).
describe("a typed line quoted on a row without its id still lands there", () => {
  const WORDS_SPINE = `# EPIC-941: Words

| ID | Role | Owner | Title | Status | Branch | PR | Base | Evidence | Verified | Next Action |
|----|------|-------|-------|--------|--------|----|------|----------|----------|-------------|
| E941-S1 | Ticket worker | unassigned | Landing page shots (Team desk: "update landing page of the shop with screenshots of newest version") | ready | none | none | main | none | 2026-11-23 | none |
| E941-S2 | Ticket worker | unassigned | A | ready | none | none | main | none | 2026-11-23 | Sam attached this file to his message read it first |
| E941-S3 | Ticket worker | unassigned | B | ready | none | none | main | none | 2026-11-23 | Sam attached this file to his message read it first |
| E941-S4 | Ticket worker | unassigned | C | ready | none | none | main | none | 2026-11-23 | Sam attached this file to his message read it first |
`;
  it("finds the row by 8 of his words in a row; boilerplate on three rows places nothing; an id still wins", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "req-words-"));
    fs.mkdirSync(path.join(root, "acme", "docs", "spines"), { recursive: true });
    fs.writeFileSync(path.join(root, "acme", "docs", "spines", "epic-41.md"), WORDS_SPINE);
    fs.writeFileSync(path.join(root, "acme", "docs", "spines", "epic-40.md"), SPINE);
    const idx = createRequestRows({
      reposRoot: () => root,
      wanted: () => [
        { id: "ch_3d791b67", words: "Update landing page of the shop with screenshots of newest version. Keep it short." },
        { id: "ch_11111111", words: "Sam attached this file to his message read it first" },
        { id: "vn_69ef802c", words: "🎙 Voice note (Chat), 2026-11-23 00:38Z · 0 min 10 s\nupdate landing page of the shop with screenshots of newest version" },
      ],
    });
    await idx.ready();
    expect(idx.rowsOf("ch_3d791b67")?.map((r) => r.code)).toEqual(["E941-S1"]);
    expect(idx.rowsOf("ch_3d791b67")?.[0].status).toBe("ready");
    expect(idx.rowsOf("ch_11111111")).toEqual([]);
    expect(idx.rowsOf("vn_69ef802c")?.map((r) => r.code)).toEqual(["E940-S98"]);
    expect(idx.rowsOf("ch_3d791b67")?.[0].title).toBe("Landing page shots");
    fs.rmSync(root, { recursive: true, force: true });
  });
  it("reads a repo linked in from another disk once, and skips a worktree of it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "req-link-"));
    const far = fs.mkdtempSync(path.join(os.tmpdir(), "req-far-"));
    fs.mkdirSync(path.join(far, "docs", "spines"), { recursive: true });
    fs.writeFileSync(path.join(far, "docs", "spines", "epic-41.md"), WORDS_SPINE);
    fs.symlinkSync(far, path.join(root, "acme-social"));
    fs.symlinkSync(far, path.join(root, "acme-social-again"));
    fs.mkdirSync(path.join(root, "acme-social-wt", "docs", "spines"), { recursive: true });
    fs.writeFileSync(path.join(root, "acme-social-wt", ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
    fs.writeFileSync(path.join(root, "acme-social-wt", "docs", "spines", "epic-41.md"), WORDS_SPINE);
    const idx = createRequestRows({ reposRoot: () => root, wanted: () => [{ id: "ch_3d791b67", words: "update landing page of the shop with screenshots of newest version" }] });
    await idx.ready();
    expect(idx.rowsOf("ch_3d791b67")?.map((r) => `${r.repo}/${r.code}`)).toEqual(["acme-social/E941-S1"]);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(far, { recursive: true, force: true });
  });
});

describe("an older message of his, out of the chat's cached view, still finds its row", () => {
  it("reads his messages from the Team desk's chat copy, never the desk's own replies", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "req-copy-"));
    fs.mkdirSync(path.join(root, "team", "desk", "chat"), { recursive: true });
    const day = "2026-11-22";
    fs.writeFileSync(
      path.join(root, "team", "desk", "chat", `${day}.md`),
      `# Team desk chat · ${day}\n\n## 20:00Z · Sam\n<!-- m:turn-item:message:${CLIENT}chat-780b5144-aaaa -->\n\nYou see this card, this is a great example of it asking me to do something\n\n## 20:01Z · Team desk\n<!-- m:turn-item:provider:claudeAgent:native-item:f3cccc3f -->\n\nGot your point.\n`,
    );
    const got = chatCopyMessages(root, 1, Date.parse(`${day}T23:00:00Z`));
    expect(got).toEqual([{ id: "ch_780b5144", words: "You see this card, this is a great example of it asking me to do something" }]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
