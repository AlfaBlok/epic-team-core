import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createDesk, migrateDesk } from "../src/desk/desk.js";
import { everyRouteWords, hisWordsIn, voiceNoteWords } from "../src/desk/said.js";
import { ensureVoiceNoteRecTables } from "../src/voice/notes.js";
import { homeWorld } from "../src/identity.js";

/**
 * E948-S178 (the owner 22 Nov 20:58Z, the same note as his 20:57Z one): the row filed from his 20:57Z voice note went in as a
 * draft, "not the owner's ask (he has written nothing in the desk chat in the last 24 hours)", though the note reached the desk
 * through T3 a minute later. His voice notes from every route (the top bar's mic, a card's mic, Chat) count as his desk
 * words, whether or not the desk thread's read shows them.
 */
let dir: string;
let db: DB;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "his-words-"));
  db = openDb(path.join(dir, "console.db"));
  ensureVoiceNoteRecTables(db);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const HIS = "The inbox count is wrong again. It's showing three, but there is only two waiting for review and one in Urgent.";
const QUOTE = "It's showing three, but there is only two waiting for review and one in Urgent";
const at2057 = "2026-11-22T20:57:48.399Z";
const at2118 = Date.parse("2026-11-22T21:18:00Z");
const note = (id: string, transcript: string | null, startedAt: string, world = homeWorld(), page = "voice note from the top bar, on /inbox") =>
  db
    .prepare("INSERT INTO voice_notes (id, tenant_id, started_at, finished_at, state, page, transcript) VALUES (?, ?, ?, ?, 'posted', ?, ?)")
    .run(id, world, startedAt, startedAt, page, transcript);

describe("his desk words come from every route his voice notes take", () => {
  it("the 22 Nov case: the desk thread read shows nothing of his, the top bar note holds the quote", () => {
    note("vn_facd277a", HIS, at2057);
    // what the Add checked before: the thread alone, empty
    expect(hisWordsIn([], QUOTE, at2118)).toMatch(/written nothing in the desk chat/);
    const voice = voiceNoteWords(db, homeWorld(), at2118);
    expect(voice.map((v) => v.note)).toEqual(["vn_facd277a"]);
    expect(hisWordsIn(everyRouteWords([], voice), QUOTE, at2118)).toEqual({ text: HIS, at: at2057 });
  });

  it("a card's voice note counts too; another world's, an empty one and one older than a day do not", () => {
    note("vn_card", "Please make the menu pill count goals too, this matters to me", "2026-11-22T20:30:00Z", homeWorld(), "card E907-S3: Goals to set");
    note("vn_other", HIS, "2026-11-22T20:40:00Z", "other-world");
    note("vn_empty", null, "2026-11-22T20:50:00Z");
    note("vn_old", "this note is older than one whole day for sure", "2026-11-21T20:00:00Z");
    expect(voiceNoteWords(db, homeWorld(), at2118).map((v) => v.note)).toEqual(["vn_card"]);
    expect(hisWordsIn(voiceNoteWords(db, homeWorld(), at2118), "make the menu pill count goals too", at2118)).toMatchObject({ at: "2026-11-22T20:30:00Z" });
  });

  it("the thread's messages and his notes are read together, oldest first", () => {
    const merged = everyRouteWords([{ text: "typed later", at: "2026-11-22T21:00:00Z" }], [{ text: "spoken first", at: "2026-11-22T20:00:00Z" }]);
    expect(merged.map((m) => m.text)).toEqual(["spoken first", "typed later"]);
  });

  it("the desk's own check (the Add) finds his note with no live desk thread to read", async () => {
    migrateDesk(db);
    const desk = createDesk({ db, store: createStore(db), publicUrl: "http://console.test", reposRoot: dir, now: () => at2118 });
    note("vn_facd277a", HIS, at2057);
    expect(await desk.jordiWords(QUOTE)).toEqual({ text: HIS, at: at2057 });
    expect(await desk.jordiWords("words he never said in any note at all")).toMatch(/not in any of his desk messages/);
  });
});
