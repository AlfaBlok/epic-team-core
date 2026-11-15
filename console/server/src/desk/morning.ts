import type { Context, Hono } from "hono";
import type { DB } from "../db.js";
import { DIGEST_MARKER } from "../plug/marks.js";
import { ownerName } from "../identity.js";

/**
 * The overnight read's morning items reach the owner on the Team desk each morning. The read's timer
 * (scripts/overnight_read.py morning, after the night's passes) composes the short message from the judge's morning
 * items and POSTs it here; this route hands it to the desk thread as a `[digest]` note (the same path and the same "send
 * him exactly the text below as ONE message" rule as the 20:00 social digest, so desk.tell moves the desk off a limited
 * seat first). Once per day: a second call for the same day answers `already`. A `test` call sends a message that opens
 * with TEST and never uses up the day.
 */
export const MORNING_TEXT_MAX = 1500;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type MorningNotifier = (text: string, clientRequestId: string) => Promise<true | string>;

export function migrateMorning(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS overnight_morning_sent (
      day TEXT PRIMARY KEY,
      sent_at TEXT,
      error TEXT,
      text TEXT
    );
  `);
}

export function morningNote(day: string, text: string, test = false): string {
  return [
    `${DIGEST_MARKER} overnight read ${day}${test ? " TEST" : ""}`,
    `The console's morning message for ${ownerName()} from the overnight read. Send him exactly the text below as ONE message (keep every link), then do nothing else:`,
    "",
    text,
  ].join("\n");
}

export function mountMorningRead(api: Hono, o: { db: DB; notify?: MorningNotifier; now?: () => Date }) {
  migrateMorning(o.db);
  const now = o.now ?? (() => new Date());
  const err = (c: Context, status: 400 | 503, code: string, message: string) => c.json({ error: { code, message } }, status);
  const row = (day: string) =>
    o.db.prepare("SELECT sent_at, error, text FROM overnight_morning_sent WHERE day = ?").get(day) as
      | { sent_at: string | null; error: string | null; text: string | null }
      | undefined;

  api.get("/desk/morning", (c) => {
    const day = c.req.query("day")?.trim() || now().toISOString().slice(0, 10);
    if (!DAY.test(day)) return err(c, 400, "validation_error", "day must be YYYY-MM-DD");
    const r = row(day);
    return c.json({ day, sent: r ? { at: r.sent_at, error: r.error, text: r.text } : null });
  });

  api.post("/desk/morning", async (c) => {
    const b = ((await c.req.json().catch(() => undefined)) ?? {}) as Record<string, unknown>;
    const day = typeof b.day === "string" && b.day.trim() ? b.day.trim() : now().toISOString().slice(0, 10);
    if (!DAY.test(day)) return err(c, 400, "validation_error", "day must be YYYY-MM-DD");
    const text = typeof b.text === "string" ? b.text.trim() : "";
    if (!text || text.length > MORNING_TEXT_MAX) return err(c, 400, "validation_error", `text (the morning message, up to ${MORNING_TEXT_MAX} characters) is required`);
    const test = b.test === true;
    if (!test) {
      const prev = row(day);
      if (prev?.sent_at) return c.json({ sent: false, already: prev.sent_at, day });
    }
    if (!o.notify) return err(c, 503, "no_channel", "the console's desk channel is off on this console (cycle disabled): no message sent");
    const body = test ? `TEST, not tonight's read: ${text}` : text;
    const id = test ? `overnight-morning-test-${day}-${now().getTime()}` : `overnight-morning-${day}`;
    const res = await o.notify(morningNote(day, body, test), id);
    const at = now().toISOString();
    if (!test)
      o.db
        .prepare(
          `INSERT INTO overnight_morning_sent (day, sent_at, error, text) VALUES (?, ?, ?, ?)
           ON CONFLICT (day) DO UPDATE SET sent_at = excluded.sent_at, error = excluded.error, text = excluded.text`,
        )
        .run(day, res === true ? at : null, res === true ? null : res, text);
    if (res !== true) return err(c, 503, "send_failed", `the morning message was not sent: ${res}`);
    return c.json({ sent: true, at, day, test, text: body });
  });
}
