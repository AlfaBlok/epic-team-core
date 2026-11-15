import { Hono } from "hono";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { mountMorningRead } from "../src/desk/morning.js";

// the overnight read's morning message goes to the Team desk once a day, as a [digest] note.

function setup(result: true | string = true) {
  const db = new Database(":memory:");
  const sent: { text: string; id: string }[] = [];
  const app = new Hono();
  mountMorningRead(app, { db, notify: async (text, id) => (sent.push({ text, id }), result), now: () => new Date("2026-11-15T09:10:00Z") });
  const post = (b: unknown) => app.request("/desk/morning", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  return { app, sent, post };
}

describe("desk morning message", () => {
  it("sends once per day as a [digest] note the desk passes on whole", async () => {
    const { sent, post, app } = setup();
    const r = await post({ day: "2026-11-15", text: "Good morning. Three things:\n1. one" });
    expect(r.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].id).toBe("overnight-morning-2026-11-15");
    expect(sent[0].text.startsWith("[digest] overnight read 2026-11-15\n")).toBe(true);
    expect(sent[0].text).toContain("Send him exactly the text below as ONE message");
    expect(sent[0].text.endsWith("Good morning. Three things:\n1. one")).toBe(true);
    const again = await (await post({ day: "2026-11-15", text: "x" })).json();
    expect(again.already).toBeTruthy();
    expect(sent).toHaveLength(1);
    const g = await (await app.request("/desk/morning?day=2026-11-15")).json();
    expect(g.sent.at).toBeTruthy();
  });

  it("a test send is marked TEST and does not use up the day", async () => {
    const { sent, post } = setup();
    const t = await (await post({ day: "2026-11-15", text: "hello", test: true })).json();
    expect(t.test).toBe(true);
    expect(sent[0].text).toContain("TEST, not tonight's read: hello");
    await post({ day: "2026-11-15", text: "real" });
    expect(sent).toHaveLength(2);
  });

  it("a refused send is recorded and can be retried", async () => {
    const { sent, post, app } = setup("desk seat seat5: note waits for headroom");
    const r = await post({ day: "2026-11-15", text: "x" });
    expect(r.status).toBe(503);
    const g = await (await app.request("/desk/morning?day=2026-11-15")).json();
    expect(g.sent.error).toContain("headroom");
    await post({ day: "2026-11-15", text: "x" });
    expect(sent).toHaveLength(2);
  });

  it("refuses an empty or bad request", async () => {
    const { post } = setup();
    expect((await post({ text: "" })).status).toBe(400);
    expect((await post({ day: "15 Nov", text: "x" })).status).toBe(400);
  });
});
