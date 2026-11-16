import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb, type DB } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createAuth } from "../src/auth/identity.js";

// the social world's boxes record voice notes on the campaign's own voice routes
// (/api/milestones/:id/voice), never the Team desk's /api/voice (the home world's only: world_scope). A world other than the home world has
// voice (calls and notes) only when its own switch is on: the owner turns it on from his the home world console (PUT /api/voice/settings
// {world, enabled}); every other world's people stay without voice. The world's owner records, its members and tokens never.

const Z = "social";
const Y = "other-world";
let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function worlds() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e78s15-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  const transcribed: string[] = [];
  const app = createApp(db, {
    auth: "on",
    browser: { browserUrl: "http://127.0.0.1:9" },
    read: { reposRoot: path.join(dir, "repos"), seatsFile: path.join(dir, "seats.json"), listThreads: async () => [] },
    voice: {
      notesDir: path.join(dir, "notes"),
      transcribe: async (_a: Uint8Array, o: { filename: string }) => (transcribed.push(o.filename), { text: "Yes to this metric." }),
    },
  });
  for (const w of [Z, Y]) db.prepare("INSERT INTO tenants (id, name, skin, plan, created_at) VALUES (?, ?, 'social', 'founding', ?)").run(w, w, new Date().toISOString());
  const mZ = createStore(db, { tenant: Z }).createMilestone({ title: "Reddit campaign", repo: "acme-ai/social", path: "docs/spines/epic-2.md", owner: "Sam", paused: false });
  const mY = createStore(db, { tenant: Y }).createMilestone({ title: "Their campaign", repo: "x/y", path: "docs/spines/root.md", owner: "Them", paused: false });
  const auth = createAuth(db);
  const session = (email: string, tenant: string, role: "owner" | "member" = "owner") => `console_session=${auth.createSession(auth.addMember({ email, tenant, role }), tenant).id}`;
  const sam = session("sam@example.com", "home");
  const zJordi = session("sam@example.com", Z);
  const zMember = session("helper@example.com", Z, "member");
  const yOwner = session("owner@example.com", Y);
  const aTok = auth.createToken({ tenant: "home", label: "a persona" }).token;
  const req = async (method: string, url: string, o: { cookie?: string; bearer?: string; body?: unknown; raw?: Blob; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { "sec-fetch-site": "same-origin", ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.bearer ? { authorization: `Bearer ${o.bearer}` } : {}), ...(o.headers ?? {}) };
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const body = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
    const res = await app.request(url, { method, headers, body }, { incoming: { socket: { remoteAddress: "203.0.113.7" } } });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  };
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { db, req, mZ, mY, sam, zJordi, zMember, yOwner, aTok, transcribed };
}
const v = (id: string, rest = "") => `/api/milestones/${id}/voice${rest}`;

describe("T78-S15: voice in the social world", () => {
  it("another world has no voice until its own switch is on; the Team desk's voice stays home's", async () => {
    const w = worlds();
    const st = await w.req("GET", v(w.mZ.id, "/state"), { cookie: w.zJordi });
    expect(st.status).toBe(200);
    expect(st.json).toMatchObject({ enabled: false, available: false, worldOff: true, reason: "Voice is not switched on for this workspace." });
    const start = await w.req("POST", v(w.mZ.id, "/notes"), { cookie: w.zJordi, body: { page: "product slide 7" } });
    expect(start.status).toBe(409);
    expect(start.json.error.message).toMatch(/not switched on for this workspace/);
    // The box no longer asks the Team desk's route (that one is the home world's: world_scope), and the home world's own voice is unchanged.
    expect((await w.req("GET", "/api/voice/state", { cookie: w.zJordi })).json.error.code).toBe("world_scope");
    expect((await w.req("GET", "/api/voice/state", { cookie: w.sam })).json).toMatchObject({ enabled: true });
    expect((await w.req("GET", "/api/voice/state", { cookie: w.sam })).json.worldOff).toBeUndefined();
  });

  it("Sam switches the world's voice on: its owner records a note for a box (words back, nothing posted); other worlds stay off", async () => {
    const w = worlds();
    const on = await w.req("PUT", "/api/voice/settings", { cookie: w.sam, body: { world: Z, enabled: true } });
    expect(on.status, on.text).toBe(200);
    expect(on.json).toMatchObject({ enabled: true });
    expect(w.db.prepare("SELECT value FROM voice_settings WHERE key = ?").get(`enabled:${Z}`)).toEqual({ value: "on" });
    // The platform's switch is untouched by a world's.
    expect(w.db.prepare("SELECT value FROM voice_settings WHERE key = 'enabled'").get()).toBeUndefined();

    expect((await w.req("GET", v(w.mZ.id, "/state"), { cookie: w.zJordi })).json).toMatchObject({ enabled: true, available: true });
    const start = await w.req("POST", v(w.mZ.id, "/notes"), { cookie: w.zJordi, body: { page: "product slide 7" } });
    expect(start.status, start.text).toBe(201);
    const nid = start.json.note.id as string;
    expect(start.json).toMatchObject({ usdPerMin: 0.003 }); // the cost per minute shows, as on the Team desk
    const seg = await w.req("POST", v(w.mZ.id, `/notes/${nid}/segments/0`), { cookie: w.zJordi, raw: new Blob([new Uint8Array(2000).fill(1)]), headers: { "content-type": "audio/webm", "x-seconds": "6" } });
    expect(seg.status, seg.text).toBe(200);
    const fin = await w.req("POST", v(w.mZ.id, `/notes/${nid}/finish`), { cookie: w.zJordi, body: { segments: 1, fill: true } });
    expect(fin.status, fin.text).toBe(200);
    expect(fin.json.note.transcript).toBe("Yes to this metric.");
    expect(w.transcribed).toHaveLength(1);
    expect(w.db.prepare("SELECT tenant_id, milestone_id FROM voice_notes WHERE id = ?").get(nid)).toEqual({ tenant_id: Z, milestone_id: w.mZ.id });

    // Another world's people keep no voice, its owner included.
    expect((await w.req("GET", v(w.mY.id, "/state"), { cookie: w.yOwner })).json).toMatchObject({ enabled: false, worldOff: true });
    expect((await w.req("POST", v(w.mY.id, "/notes"), { cookie: w.yOwner, body: {} })).status).toBe(409);
    // In the switched-on world, a member and a token still never record (the owner's own, from the page).
    expect((await w.req("POST", v(w.mZ.id, "/notes"), { cookie: w.zMember, body: {} })).json.error.code).toBe("jordi_only");
  });

  it("only Sam switches a world on, from home; anyone may switch it off; the world itself never sets it", async () => {
    const w = worlds();
    expect((await w.req("PUT", "/api/voice/settings", { cookie: w.zJordi, body: { world: Z, enabled: true } })).json.error.code).toBe("world_scope");
    expect((await w.req("PUT", "/api/voice/settings", { bearer: w.aTok, body: { world: Z, enabled: true } })).json.error.code).toBe("jordi_only");
    await w.req("PUT", "/api/voice/settings", { cookie: w.sam, body: { world: Z, enabled: true } });
    const off = await w.req("PUT", "/api/voice/settings", { bearer: w.aTok, body: { world: Z, enabled: false } });
    expect(off.status, off.text).toBe(200);
    expect((await w.req("GET", v(w.mZ.id, "/state"), { cookie: w.zJordi })).json).toMatchObject({ enabled: false, worldOff: true });
  });

  it("the platform's off switch still stops a switched-on world", async () => {
    const w = worlds();
    await w.req("PUT", "/api/voice/settings", { cookie: w.sam, body: { world: Z, enabled: true } });
    await w.req("PUT", "/api/voice/settings", { cookie: w.sam, body: { enabled: false } });
    const st = await w.req("GET", v(w.mZ.id, "/state"), { cookie: w.zJordi });
    expect(st.json).toMatchObject({ enabled: false, reason: "Voice is switched off in the console." });
    expect(st.json.worldOff).toBeUndefined();
  });
});
