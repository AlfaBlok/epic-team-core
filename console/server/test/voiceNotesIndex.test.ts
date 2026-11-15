import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createVoiceNotesReader, filterVoiceNotes, parseVoiceNotes, VOICE_NOTES_FILE } from "../src/voiceNotesIndex.js";
import { inQuiet, nextRunAfter, quietEnd } from "../src/cycle/nextRun.js";
import { cadence } from "../src/schemas.js";
import { cadenceText } from "../src/deck/about.js";

/** His voice notes in one place with a product filter, and a persona's quiet nights. */

const INDEX = {
  generatedAt: "2026-11-12T20:00:00Z",
  windowHours: 48,
  counts: { open: 1, delivered: 1 },
  products: { alpha: 2, beta: 1 },
  productNames: { alpha: "Alpha", beta: "Beta" },
  notes: [
    { ref: "Log/2026-11-12.md#^e-aaaaaa", key: "e-aaaaaa", source: "whatsapp", app: "WhatsApp", at: "2026-11-12T19:23:00Z", words: "harmonize them", chars: 14, products: ["alpha", "beta"], state: "open", rows: [{ code: "E904-S1", repo: "home_repo", spine: "docs/spines/e.md", epic: "EPIC-904", status: "active", title: "x", via: "row" }] },
    { ref: "Log/2026-11-12.md#^e-bbbbbb", key: "e-bbbbbb", source: "mcp", app: "Chat", at: "2026-11-12T18:00:00Z", words: "buttons", chars: 7, products: ["alpha"], state: "delivered", rows: [] },
    { ref: "bad" },
  ],
};

describe("voice notes index", () => {
  it("reads the notes, drops a broken entry and filters by product", () => {
    const body = parseVoiceNotes(JSON.stringify(INDEX));
    expect(body.notes.map((n) => n.key)).toEqual(["e-aaaaaa", "e-bbbbbb"]);
    expect(filterVoiceNotes(body, "beta").notes.map((n) => n.key)).toEqual(["e-aaaaaa"]);
    expect(filterVoiceNotes(body, "alpha").notes).toHaveLength(2);
    expect(filterVoiceNotes(body, "all").notes).toHaveLength(2);
    expect(filterVoiceNotes(body, "gamma").notes).toHaveLength(0);
    expect(Object.keys(body.productNames)).toEqual(["alpha", "beta"]);
  });

  it("reads the home repo's file and answers empty without one", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vn-index-"));
    const repo = path.join(root, "home_repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    const r = createVoiceNotesReader({ reposRoot: root, home: "home_repo" });
    expect(r.get().notes).toEqual([]);
    fs.mkdirSync(path.join(repo, path.dirname(VOICE_NOTES_FILE)), { recursive: true });
    fs.writeFileSync(path.join(repo, VOICE_NOTES_FILE), JSON.stringify(INDEX));
    expect(r.get().notes).toHaveLength(2);
    expect(r.get("beta").notes).toHaveLength(1);
    expect(r.get().generatedAt).toBe("2026-11-12T20:00:00Z");
  });
});

describe("interval cadence with a quiet window", () => {
  const q = { from: "22:00", to: "08:00", timeZone: "America/Mexico_City" };
  it("knows the quiet hours on his wall clock, across midnight", () => {
    // Mexico City is UTC-6 in November: 22:00 local = 04:00Z next day, 08:00 local = 14:00Z.
    expect(inQuiet(new Date("2026-11-13T04:30:00Z"), q)).toBe(true);
    expect(inQuiet(new Date("2026-11-13T13:59:00Z"), q)).toBe(true);
    expect(inQuiet(new Date("2026-11-13T14:00:00Z"), q)).toBe(false);
    expect(inQuiet(new Date("2026-11-12T20:00:00Z"), q)).toBe(false);
  });
  it("a wake that would fall at night waits for 08:00 there; a day wake stays 90 min on", () => {
    const c = cadence.parse({ type: "interval", everyMinutes: 90, quiet: q });
    expect(nextRunAfter(c, new Date("2026-11-12T20:00:00Z")).toISOString()).toBe("2026-11-12T21:30:00.000Z");
    expect(nextRunAfter(c, new Date("2026-11-13T03:00:00Z")).toISOString()).toBe("2026-11-13T14:00:00.000Z");
    expect(quietEnd(new Date("2026-11-13T05:00:00Z"))).toEqual(new Date("2026-11-13T05:00:00Z"));
    expect(cadenceText(c, "UTC")).toBe("every 90 minutes, quiet 22:00 to 08:00 Mexico City time");
  });
  it("refuses a made-up time zone and keeps a plain interval as before", () => {
    expect(cadence.safeParse({ type: "interval", everyMinutes: 90, quiet: { ...q, timeZone: "Mars/Base" } }).success).toBe(false);
    const plain = cadence.parse({ type: "interval", everyMinutes: 60 });
    expect(nextRunAfter(plain, new Date("2026-11-13T04:30:00Z")).toISOString()).toBe("2026-11-13T05:30:00.000Z");
  });
});
