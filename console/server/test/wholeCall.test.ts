import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { CALL_TRANSCRIPT_HEAD, createVoice, type DeskPort } from "../src/voice/voice.js";
import { createWholeCall, WHOLE_GIVE_UP_MS, WHOLE_RETRY_MS } from "../src/voice/wholeCall.js";
import { requestIdOf } from "../src/desk/requests.js";
import type { DeskView } from "../src/desk/session.js";
vi.hoisted(async () => (await import("../src/identity.js")).setIdentity({ owner: "Sam" }));

// the owner on his strategy call (call_33379122), asked whether the desk sees the full call: "I want that answer
// to become yes." Every call's whole transcript lands on its desk once, a dropped or timed-out call too, as his request.

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-wholecall-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const clock = { t: Date.parse("2026-11-27T13:00:00Z") };
  const sent: { text: string; crid?: string; to: string }[] = [];
  const deskFor = (to: string): DeskPort => ({
    send: vi.fn(async (text: string, _page?: string, crid?: string) => (sent.push({ text, crid, to }), { threadId: "th", pending: false })),
    view: async () => ({ available: true, sending: 0, hasEarlier: false, messages: [], working: false }) as unknown as DeskView,
  });
  // the voice makes the tables (and its whole_posted_at column)
  const mint = vi.fn(async () => ({ value: "ek", expires_at: Math.floor(clock.t / 1000) + 60, session: { id: "sess" } }));
  const voice = createVoice({ db, mint, desk: deskFor("team"), quickStatus: async () => ({ text: "", waiting: 0, stuck: 0, working: 0 }), now: () => clock.t });
  const call = (id: string, o: { reason: string; transcript?: unknown; milestone?: string; session?: string; startedAt?: string; endedAt?: string }) =>
    db
      .prepare("INSERT INTO voice_calls (id, started_at, last_beat_at, ended_at, end_reason, model, session_id, tenant_id, milestone_id, transcript) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, o.startedAt ?? "2026-11-27T12:30:00.000Z", "2026-11-27T12:44:00.000Z", o.endedAt ?? "2026-11-27T12:44:00.000Z", o.reason, "elevenlabs-agents", o.session ?? "agent_abc", "home", o.milestone ?? null, o.transcript ? JSON.stringify(o.transcript) : null);
  const eleven = vi.fn(async (_agent: string, _at: string) => ({ conversationId: "conv_1", lines: [{ who: "owner", text: "The phone should follow the chat context." }, { who: "voice", text: "Got it." }] }));
  const whole = createWholeCall({ db, deskOf: (c) => deskFor(c.milestone_id ?? "team"), eleven, now: () => clock.t, since: "2026-11-27T00:00:00.000Z" });
  return { db, clock, sent, voice, call, eleven, whole };
}

describe("every call's whole transcript lands on its desk once", () => {
  it("a dropped call (no lines from the page) is read back from ElevenLabs and posted once, as his request with the call id", async () => {
    const s = setup();
    s.call("call_8c535b1a", { reason: "lost" });
    expect(await s.whole.tick()).toEqual(["call_8c535b1a"]);
    expect(s.eleven).toHaveBeenCalledWith("agent_abc", "2026-11-27T12:30:00.000Z");
    expect(s.sent).toHaveLength(1);
    const t = s.sent[0].text.split("\n");
    expect(t[0]).toBe(`${CALL_TRANSCRIPT_HEAD} · 2026-11-27 12:30Z · 14 min 00 s · $0.000 (elevenlabs-agents) · ended: lost · call_8c535b1a`);
    expect(t[1]).toMatch(/^Every word of this call, for you to place/);
    expect(t[2]).toMatch(/\/api\/voice\/calls\/call_8c535b1a\/transcript$/);
    expect(t).toContain("Sam: The phone should follow the chat context.");
    expect(s.sent[0].crid).toBe("voice-transcript-whole-call_8c535b1a");
    // the console reads it as his one request, the call id (the old record line stays the console's)
    expect(requestIdOf(`t3:client:x:thread-send:${s.sent[0].crid}`, s.sent[0].text)).toBe("call_8c535b1a");
    expect(requestIdOf("t3:client:x:thread-send:voice-transcript-call_8c535b1a", `${CALL_TRANSCRIPT_HEAD} · x · call_8c535b1a\nRecord only: already handled live.`)).toBeUndefined();
    // kept on the call for the next call's recall and the whole-transcript link
    expect(s.voice.wholeText("call_8c535b1a")).toContain("Sam: The phone should follow the chat context.");
    // once: the next tick posts nothing
    expect(await s.whole.tick()).toEqual([]);
    expect(s.sent).toHaveLength(1);
  });

  it("today's calls already posted as a record are posted again whole (the backfill), each once; test calls never", async () => {
    const s = setup();
    s.call("call_33379122", { reason: "bye", transcript: [{ who: "owner", text: "I want that answer to become yes." }] });
    s.db.prepare("UPDATE voice_calls SET transcript_posted_at = '2026-11-27T13:46:05.466Z' WHERE id = 'call_33379122'").run();
    s.call("call_9297cca6", { reason: "test_e84s63", transcript: [{ who: "owner", text: "test" }] });
    s.call("call_old", { reason: "bye", transcript: [{ who: "owner", text: "yesterday" }], startedAt: "2026-11-26T10:00:00.000Z", endedAt: "2026-11-26T10:10:00.000Z" });
    expect(await s.whole.tick()).toEqual(["call_33379122"]);
    expect(s.eleven).not.toHaveBeenCalled();
    expect(s.sent[0].text).toContain("Sam: I want that answer to become yes.");
    expect(await s.whole.tick()).toEqual([]);
  });

  it("a campaign call lands in its campaign's chat; a call with no words anywhere is left after the wait", async () => {
    const s = setup();
    s.call("call_camp0001", { reason: "line_dropped", milestone: "ms_1", transcript: [{ who: "owner", text: "post twice a day" }] });
    s.call("call_empty001", { reason: "lost" });
    s.eleven.mockResolvedValue(undefined as never);
    expect(await s.whole.tick()).toEqual(["call_camp0001"]);
    expect(s.sent[0].to).toBe("ms_1");
    s.clock.t += WHOLE_GIVE_UP_MS;
    expect(await s.whole.tick()).toEqual([]);
    const r = s.db.prepare("SELECT whole_posted_at FROM voice_calls WHERE id = 'call_empty001'").get() as { whole_posted_at: string };
    expect(r.whole_posted_at).toBe("none: no words (lost)");
  });

  it("a call whose ElevenLabs read keeps failing is not given up at the wait: it is read again until it lands", async () => {
    const s = setup();
    s.call("call_slow0001", { reason: "lost" });
    s.eleven.mockRejectedValue(new Error("ElevenLabs refused the transcript read (503)"));
    s.clock.t += WHOLE_GIVE_UP_MS;
    expect(await s.whole.tick()).toEqual([]);
    const left = () => (s.db.prepare("SELECT whole_posted_at FROM voice_calls WHERE id = 'call_slow0001'").get() as { whole_posted_at: string | null }).whole_posted_at;
    expect(left()).toBeNull();
    s.eleven.mockResolvedValue({ conversationId: "conv_2", lines: [{ who: "owner", text: "Is 100% of the transcript there?" }] });
    s.clock.t += 60 * 60_000;
    expect(await s.whole.tick()).toEqual(["call_slow0001"]);
    expect(s.sent[0].text).toContain("Sam: Is 100% of the transcript there?");
    expect(WHOLE_RETRY_MS).toBeGreaterThan(WHOLE_GIVE_UP_MS);
  });

  it("a call the page ends with its lines posts whole at once and the catch-up never posts it again", async () => {
    const s = setup();
    const a = await s.voice.start();
    s.clock.t += 60_000;
    await s.voice.end(a.call.id, { reason: "line_dropped", transcript: [{ who: "owner", text: "Hello?" }] });
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].crid).toBe(`voice-transcript-whole-${a.call.id}`);
    s.clock.t += 120_000;
    expect(await s.whole.tick()).toEqual([]);
  });
});
