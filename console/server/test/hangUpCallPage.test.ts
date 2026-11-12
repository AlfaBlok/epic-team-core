import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { isTenantSafe } from "../src/auth/routeScope.js";
import { CALL_TRANSCRIPT_HEAD, createVoice, ENDED_ELSEWHERE, type DeskPort } from "../src/voice/voice.js";
import { mountVoice } from "../src/voice/routes.js";
import type { DeskView } from "../src/desk/session.js";
// this file checks the text with our own owner's name (src/identity.ts; the suite's owner is neutral, hostedSetup.ts)
vi.hoisted(async () => (await import("../src/identity.js")).setIdentity({ owner: "Sam" }));

// the owner left the Chat page mid-call and came back to "A call is already on (one call at a time).
// Hang it up first." with nothing to hang up. A page that finds its world's call on without holding it gets a Hang up:
// POST <call routes>/active/end {id} ends the world's active call (any of its desks) while it is still that one. The page
// that still holds the call (another tab, the phone) hears it on its next beat and hangs up with its transcript.

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e42s21-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const clock = { t: Date.parse("2026-11-02T10:00:00Z") };
  const mint = vi.fn(async () => ({ value: "ek_test", expires_at: Math.floor(clock.t / 1000) + 60, session: { id: "sess" } }));
  const sent: string[] = [];
  const desk: DeskPort = {
    send: vi.fn(async (text: string) => (sent.push(text), { threadId: "th", pending: false })),
    view: async () => ({ available: true, sending: 0, hasEarlier: false, messages: [], working: false }) as unknown as DeskView,
  };
  const quickStatus = async () => ({ text: "", waiting: 0, stuck: 0, working: 0 });
  const voiceOf = (scope?: { world: string; milestoneId?: string }) => createVoice({ db, mint, desk, quickStatus, now: () => clock.t, ...(scope ? { scope } : {}) });
  return { db, voiceOf, voice: voiceOf(), sent, clock };
}

describe("T42-S21 hang up a call this page does not hold", () => {
  it("ends the world's active call while it is still that one; a new call can start; no transcript (the lines are not here)", async () => {
    const s = setup();
    const { call } = await s.voice.start();
    expect(s.voice.state().activeCall?.id).toBe(call.id);
    await expect(s.voice.start()).rejects.toMatchObject({ code: "one_call" });

    // A stale id (the call already ended, or a newer one is on) ends nothing.
    expect(s.voice.endActive("call_other").ended).toBe(false);
    const r = s.voice.endActive(call.id);
    expect(r.ended).toBe(true);
    expect(r.call).toMatchObject({ id: call.id, endReason: ENDED_ELSEWHERE });
    expect(r.state.activeCall).toBeUndefined();
    expect(s.sent).toEqual([]);
    expect(s.voice.endActive(call.id).ended).toBe(false); // twice is harmless
    expect((await s.voice.start()).call.id).not.toBe(call.id);
  });

  it("the page still holding it hears it on its next beat and hangs up there, and its transcript still lands in Chat", async () => {
    const s = setup();
    const { call } = await s.voice.start();
    expect(s.voice.beat(call.id).stop).toBeUndefined();
    s.voice.endActive(call.id);
    expect(s.voice.beat(call.id)).toMatchObject({ stop: ENDED_ELSEWHERE });
    await s.voice.end(call.id, { reason: ENDED_ELSEWHERE, transcript: [{ who: "owner", text: "What's waiting on me?" }] });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toContain(CALL_TRANSCRIPT_HEAD);
    expect(s.sent[0]).toContain("Sam: What's waiting on me?");
    // Another end (the lost-tab path) is still once in Chat; a call that ended any other way still answers a beat 409.
    await s.voice.end(call.id, { reason: "tab_closed", transcript: [{ who: "owner", text: "again" }] });
    expect(s.sent).toHaveLength(1);
    const b = await s.voice.start();
    await s.voice.end(b.call.id, { reason: "hangup" });
    expect(() => s.voice.beat(b.call.id)).toThrow(/has ended/);
  });

  it("per world: a campaign's page hangs up its world's call from another campaign's chat, never another world's", async () => {
    const s = setup();
    const z1 = s.voiceOf({ world: "social", milestoneId: "ms_z1" });
    const z2 = s.voiceOf({ world: "social", milestoneId: "ms_z2" });
    z1.setEnabled(true); // another world has voice once its own switch is on
    const alpha = await s.voice.start();
    const zc = await z1.start();
    // One call at a time per world: z2 sees z1's call as its world's call, the home world's is not in its world.
    expect(z2.state().activeCall?.id).toBe(zc.call.id);
    expect(z2.endActive(alpha.call.id).ended).toBe(false);
    expect(s.voice.state().activeCall?.id).toBe(alpha.call.id);
    expect(z2.endActive(zc.call.id).ended).toBe(true);
    expect(z1.state().activeCall).toBeUndefined();
    expect(s.voice.state().activeCall?.id).toBe(alpha.call.id);
  });

  it("the route: Sam's page only, an id required; TENANT_SAFE under a campaign's and a world desk's call routes", async () => {
    const s = setup();
    const api = new Hono();
    mountVoice(api, s.voice, { world: () => "home" });
    const { call } = await s.voice.start();
    const page = { "sec-fetch-site": "same-origin", "content-type": "application/json" };
    expect((await api.request("/voice/active/end", { method: "POST", headers: page, body: "{}" })).status).toBe(400);
    expect((await api.request("/voice/active/end", { method: "POST", headers: { ...page, "sec-fetch-site": "cross-site" }, body: JSON.stringify({ id: call.id }) })).status).toBe(403);
    expect((await api.request("/voice/active/end", { method: "POST", headers: { ...page, authorization: "Bearer t" }, body: JSON.stringify({ id: call.id }) })).status).toBe(403);
    expect(s.voice.state().activeCall?.id).toBe(call.id);
    const r = await api.request("/voice/active/end", { method: "POST", headers: page, body: JSON.stringify({ id: call.id }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ended: true, call: { id: call.id, endReason: ENDED_ELSEWHERE } });

    expect(isTenantSafe("POST", "/api/milestones/ms_1/voice/active/end")).toBe(true);
    expect(isTenantSafe("POST", "/api/tenants/social/desk/voice/active/end")).toBe(true);
    expect(isTenantSafe("POST", "/api/voice/active/end")).toBe(false);
  });
});
