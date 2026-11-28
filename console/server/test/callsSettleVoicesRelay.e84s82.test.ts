import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { createVoice, relayedNotes, type DeskPort } from "../src/voice/voice.js";
import type { DeskView } from "../src/desk/session.js";
import { CALL_FLOW_RULE, SETTLE_RULE, STALE_ON_START_MS } from "../src/voice/voice.js";
import { coachInstructions } from "../src/voice/coach.js";
import { marketingInstructions } from "../src/voice/marketing.js";
import { MANAGER_MANNER, objectiveCallInstructions, objectiveGreeting } from "../src/voice/levelCall.js";
import { objectiveOpening, objectiveRule } from "../src/voice/prepared.js";
import { switchAnswer } from "../src/voice/switchTo.js";
import { levelName } from "../src/voice/levelCall.js";
import { callVoices, voiceLabel, voiceRule, type Manager } from "../src/voice/managers.js";
import { agentBody } from "../src/voice/elevenAgent.js";

/**
 * his calls of 28 Nov:
 * call_a41d905a 13:53Z "you're going too fast ... you should go item by item and then settling them on my behalf";
 * call_2332dcc1 14:04Z "Marcus sounds very feminine ... if we have eight types of character, we should have eight voices",
 * the objective manager "went a little bit too quickly into specifics", "what's new since we last spoke" asked twice.
 */
describe("one item at a time, settled before the next", () => {
  it("every call voice has it, and no line says to go on without his decision", () => {
    expect(CALL_FLOW_RULE).toContain(SETTLE_RULE);
    expect(SETTLE_RULE).toMatch(/It is settled only when he decides/);
    expect(SETTLE_RULE).toMatch(/A question or a remark of his is not his decision/);
    expect(SETTLE_RULE).toMatch(/Never say 'Next topic' while the item before it is open/);
    for (const ins of [marketingInstructions("# Prepared call\nThe greeting: Hi"), coachInstructions(), objectiveCallInstructions("House: Buy a house")]) {
      expect(ins).not.toMatch(/then the next \(How every call flows/);
      expect(ins).toMatch(/settle it with him before the next|his decision on it before the next topic/);
    }
  });
});

describe("an objective's manager: the big picture first, the opening question once", () => {
  const card = { id: "house", name: "House: Buy a house", light: "red", krs: "2 of 4 key results green", stands: "", keyResults: [{ label: "A flat bought", state: "red" }] } as any;
  it("greets with what's new, not a proposal; the proposal waits until he has talked", () => {
    expect(objectiveGreeting("House: Buy a house")).toMatch(/What's new since we last spoke\?$/);
    const open = objectiveOpening(card, { person: "Sophia" });
    expect(open).toMatch(/^Hi \w+, Sophia here, the Buy a house manager\. In one line: 2 of 4 key results green\. What's new since we last spoke\?$/);
    expect(open).not.toMatch(/Our proposal|Shall we start/);
    expect(objectiveRule(card)).toMatch(/Let him talk first\. When he has said what is on his mind, the proposal you hold is/);
  });
  it("asks it once on the whole call, even after a switch, and goes into specifics only when he does", async () => {
    expect(MANAGER_MANNER).toMatch(/once on this whole call: if it was asked already on this call \(by you, or by the partner before a switch\), never ask it again/);
    expect(MANAGER_MANNER).toMatch(/Go into specifics .* only when he does/);
    expect(objectiveCallInstructions("House: Buy a house")).toContain(MANAGER_MANNER);
    const r = await switchAnswer("Buy a house", { home: "Team desk partner", cards: async () => [card], pack: async () => "pack", objectiveName: levelName });
    expect(r.result).toContain(MANAGER_MANNER);
  });
});

describe("eight characters, eight voices", () => {
  const people: Manager[] = [
    { id: "marcus", name: "Marcus", role: "board", face: "docs/personas/face-marcus.webp", voice: "nPczCjzI2devNBz1zQrb" },
    { id: "sophia", name: "Sophia", role: "campaign", objective: "s", face: "docs/personas/face-sophia.webp", voice: "cgSgspJ2msm6clMCkdW9" },
    { id: "lucia", name: "Lucía", role: "campaign", objective: "l", face: "docs/personas/face-lucia.webp", voice: "XrExE9yKIg1WjnnlVkGX" },
    { id: "books", name: "EpicBooks' manager", role: "campaign", objective: "b" },
  ];
  it("each named manager is one voice the call may switch to by its first name, plus the plain manager's", () => {
    const v = callVoices(people, { label: "Manager", voice_id: "JBFqnCBsd6RMkjVDRZzb", description: "plain" });
    expect(v.map((x) => x.label)).toEqual(["Marcus", "Sophia", "Lucia", "Manager"]);
    expect(new Set(v.map((x) => x.voice_id)).size).toBe(4);
    expect(voiceLabel("Lucía")).toBe("Lucia");
    expect(voiceRule(v[1])).toMatch(/wrap every sentence you say in <Sophia>…<\/Sophia>/);
    expect(voiceRule(undefined)).toBe("");
  });
  it("the agent may switch among them, and each call may set the voice of who answers", () => {
    const b = agentBody("p", "hi", [], "x", ["t"], "en", callVoices(people));
    expect((b.conversation_config.tts as any).supported_voices.map((x: any) => x.label)).toEqual(["Marcus", "Sophia", "Lucia"]);
    expect((b.platform_settings.overrides.conversation_config_override as any).tts).toEqual({ voice_id: true });
    expect((agentBody("p", "hi", [], "x", ["t"], "es", []).conversation_config.tts as any).supported_voices).toBeUndefined();
  });
  it("the team's file gives all eight a voice, the men and the women each their own", async () => {
    const fs = await import("node:fs");
    const doc = JSON.parse(fs.readFileSync(new URL("../../../../docs/personas/managers.json", import.meta.url), "utf8"));
    const named = doc.managers.filter((m: Manager) => m.face);
    expect(named).toHaveLength(8);
    expect(named.every((m: Manager) => /^[A-Za-z0-9]{12,40}$/.test(m.voice ?? ""))).toBe(true);
    expect(new Set(named.map((m: Manager) => m.voice)).size).toBe(8);
    expect(named.find((m: Manager) => m.id === "marcus").voice).not.toBe("cgSgspJ2msm6clMCkdW9");
    expect(doc.managerVoice).toMatch(/^[A-Za-z0-9]{12,40}$/);
  });
});

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});
function setup(relay?: (id: string, a: Record<string, unknown>, n: number) => Promise<Record<string, unknown>>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-e84s82-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const clock = { t: Date.parse("2026-11-28T14:20:00Z") };
  const mint = vi.fn(async () => ({ value: "ek_test", expires_at: Math.floor(clock.t / 1000) + 60, session: { id: "sess" } }));
  const desk: DeskPort = {
    send: vi.fn(async () => ({ threadId: "th", pending: false })),
    view: async () => ({ available: true, sending: 0, hasEarlier: false, messages: [], working: false }) as unknown as DeskView,
  };
  const quickStatus = async () => ({ text: "", waiting: 0, stuck: 0, working: 0 });
  const voice = createVoice({ db, mint, desk, quickStatus, now: () => clock.t, ...(relay ? { relay } : {}) });
  return { db, voice, clock };
}

describe("a new call after one whose hang-up never arrived (his vn_c309d256)", () => {
  it("a double press still meets one call at a time; a call whose page stopped beating is closed and the new one connects", async () => {
    const s = setup();
    const first = (await s.voice.start()).call;
    s.clock.t += 10_000;
    await expect(s.voice.start()).rejects.toMatchObject({ code: "one_call" });
    // the voice said goodbye, its hang-up was lost at the front door: no beat since
    s.clock.t += STALE_ON_START_MS;
    const second = (await s.voice.start()).call;
    expect(second.id).not.toBe(first.id);
    const row = s.db.prepare("SELECT ended_at, end_reason FROM voice_calls WHERE id = ?").get(first.id) as { ended_at: string; end_reason: string };
    expect(row.end_reason).toBe("lost");
    expect(row.ended_at).toBe(first.startedAt);
  });
});

describe("a relay the page sends again after a front-door 502 (call_a41d905a)", () => {
  it("is one note: the same key gives the stored answer, and numbers come from the call's row", async () => {
    const seen: number[] = [];
    const s = setup(async (_id, a, n) => (seen.push(n), { desk: String(a.desk), state: "sent", requestId: `marketing-x-${n}`, result: "Passed to the Team desk." }));
    const { call } = await s.voice.start();
    const a = await s.voice.relay(call.id, { desk: "team", words: "You're going too fast", key: "k1" });
    const again = await s.voice.relay(call.id, { desk: "team", words: "You're going too fast", key: "k1" });
    expect(again).toMatchObject({ desk: "team", requestId: a.requestId, result: "Passed to the Team desk." });
    await s.voice.relay(call.id, { desk: "team", words: "Second point", key: "k2" });
    expect(seen).toEqual([1, 2]);
    expect(relayedNotes(s.db, call.id).map((x) => [x.n, x.requestId, x.key])).toEqual([[1, "marketing-x-1", "k1"], [2, "marketing-x-2", "k2"]]);
  });
  it("two sends of the same key at once reach the desk once", async () => {
    let calls = 0;
    const s = setup(async () => (calls++, await new Promise((r) => setTimeout(r, 20)), { desk: "team", state: "sent", requestId: "r", result: "ok" }));
    const { call } = await s.voice.start();
    await Promise.all([s.voice.relay(call.id, { desk: "team", words: "w", key: "same" }), s.voice.relay(call.id, { desk: "team", words: "w", key: "same" })]);
    expect(calls).toBe(1);
  });
});
