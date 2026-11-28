import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type DB } from "../src/db.js";
import { migrateDeskSessions } from "../src/desk/session.js";
import { CALL_FLOW_RULE, createVoice, WHOLE_TRANSCRIPT_ANSWER } from "../src/voice/voice.js";
import { earlierAsks, earlierAsksBlock } from "../src/voice/earlierAsks.js";
vi.hoisted(async () => (await import("../src/identity.js")).setIdentity({ owner: "Sam" }));

// his briefer call call_784648a0 (28 Nov): "can you please tell me whether you can guarantee me that as part of the design,
// the full transcript will be available? ... next time we speak, you need to know this" and "once the answers manifest,
// that you become aware of them in your context so that you can pick up ... these questions if I come back to them".

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

const NOW = Date.parse("2026-11-28T01:00:00Z");
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "console-earlier-"));
  const db: DB = openDb(path.join(dir, "console.db"));
  migrateDeskSessions(db);
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const view = (key: string, messages: unknown[]) => db.prepare("INSERT INTO desk_view_cache (desk_key, thread_id, view, updated_at) VALUES (?, 'th', ?, ?)").run(key, JSON.stringify({ messages }), new Date(NOW).toISOString());
  return { db, view };
}
const relay = (call: string, n: number, words: string, at: string) => ({
  id: `t3:client:x:thread-send:marketing-${call}-${n}`,
  role: "user",
  at,
  text: `📞 From the briefer call (${call})\nSam's words: "${words}"\nMarketing note: x.\nFile it as one request row of his, like a chat line of his.`,
});

describe("the next call knows what the team did with his earlier call asks", () => {
  it("each call-born line comes with its ticket and where it stands, and the desk's reply after it", () => {
    const s = setup();
    s.view("team", [
      relay("call_784648a0", 1, "is the design that the 100% of the transcript is gonna make it?", "2026-11-28T00:44:26.361Z"),
      relay("call_784648a0", 2, "a lot of my feedback is actually about the product, those are things that the team product handles", "2026-11-28T00:44:26.367Z"),
      { id: "a1", role: "assistant", at: "2026-11-28T00:46:00Z", text: "Both dispatched: the transcript guarantee → new ready row **E907-S3** in the [talk to desk spine](https://x/y)." },
      { id: "u9", role: "user", at: "2026-11-28T00:47:00Z", text: "a typed line, not from a call" },
      { id: "t3:client:x:thread-send:voice-check-call_784648a0", role: "user", at: "2026-11-28T00:48:00Z", text: "📞 After the call (call_784648a0): no gap" },
    ]);
    s.view("world-desk:e77-test", [relay("call_testtest", 1, "a test world's line", "2026-11-28T00:30:00Z")]);
    s.view("world-desk:old", [relay("call_oldoldol", 1, "two weeks ago", "2026-11-10T00:30:00Z")]);
    const rowsOf = (id: string) => (id.startsWith("ch_") ? [{ code: "E907-S3", repo: "team", path: "x", status: "ready", title: "Every call voice knows upfront that the full transcript lands" }] : []);
    const asks = earlierAsks(s.db, rowsOf, { now: NOW, chats: (k) => !k.includes("test") });
    expect(asks.map((a) => a.where)).toEqual(["briefer call (call_784648a0)", "briefer call (call_784648a0)"]);
    const block = earlierAsksBlock(asks);
    expect(block).toMatch(/^What the team did with what Sam asked on earlier calls/);
    expect(block).toContain(`- 28 Nov, briefer call (call_784648a0): "is the design that the 100% of the transcript is gonna make it?" → ticket: Every call voice knows upfront that the full transcript lands (ready) · the desk said: "Both dispatched: the transcript guarantee → new ready row E907-S3 in the talk to desk spine."`);
    // the second line shares the reply: said once
    expect(block.split("\n")[2]).toMatch(/the desk: the same reply as above\.$/);
    expect(block).not.toContain("typed line");
    expect(block).not.toContain("After the call");
    expect(earlierAsksBlock([])).toBe("");
  });

  it("every call's instructions say the whole transcript lands by design, and carry the earlier asks block", async () => {
    const s = setup();
    expect(CALL_FLOW_RULE).toContain(WHOLE_TRANSCRIPT_ANSWER);
    expect(CALL_FLOW_RULE).toMatch(/Never say you don't know, that it might not, or that you will check/);
    const minted: { session: { instructions: string } }[] = [];
    const mint = vi.fn(async (cfg: { session: { instructions: string } }) => (minted.push(cfg), { value: "ek", expires_at: Math.floor(NOW / 1000) + 60, session: { id: "sess" } }));
    const earlier = vi.fn((world: string) => `What the team did with what Sam asked on earlier calls (${world})`);
    const voice = createVoice({ db: s.db, mint: mint as never, desk: { send: vi.fn(), view: async () => ({ available: true, messages: [] }) as never }, quickStatus: async () => ({ text: "", waiting: 0, stuck: 0, working: 0 }), earlier, now: () => NOW });
    await voice.start();
    const ins = minted[0].session.instructions;
    expect(ins).toContain("100% of every call's transcript reaches the desk");
    expect(ins).toContain("What the team did with what Sam asked on earlier calls (home)");
    expect(earlier).toHaveBeenCalledWith("home");
  });
});
