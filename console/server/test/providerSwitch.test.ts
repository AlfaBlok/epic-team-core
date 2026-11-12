// the two console text calls (voice feedback structurer, settle judge) on Claude Haiku 5.5 behind
// CONSOLE_TEXT_MODEL_PROVIDER; unset keeps the OpenAI request byte for byte. Fixtures only, no live calls.
import { describe, expect, it, vi } from "vitest";
import { anthropicJudge, JUDGE_MODEL, openAiJudge, type SettleSource } from "../src/inbox/settles.js";
import type { WaitingItem } from "../src/inbox/waiting.js";
import { ANTHROPIC_TEXT_MODEL, textModelProvider } from "../src/textModel.js";
import { anthropicStructurer, openAiStructurer, STRUCTURE_MODEL } from "../src/voiceFeedback.js";

type Seen = { url: string; headers: Record<string, string>; body: any };
function fakeFetch(reply: unknown, status = 200) {
  const seen: Seen[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers as HeadersInit);
    seen.push({ url: String(url), headers: Object.fromEntries(h.entries()), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(reply), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, seen };
}
const claudeReply = (json: unknown, over: Record<string, unknown> = {}) => ({
  id: "msg_fixture",
  type: "message",
  role: "assistant",
  model: ANTHROPIC_TEXT_MODEL,
  content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: JSON.stringify(json) }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  ...over,
});
const key = async () => "sk-test";
const ctx = { who: "Ana", product: "SocialApp", campaign: "TEST" };
const structure = { summary: "She likes it.", sentiment: "positive", asks: ["Dark mode."], bugs: [], praise: ["Fast."], quotes: ["love it"] };

const src: SettleSource = { kind: "ask", code: "T1-A1", repo: "home_repo", question: "Paste the Anthropic key", answerKind: "answer", words: "Pasted it in step 3.", label: "home_repo/T1-A1" };
const cand = { id: "w1", source: "ask", question: "Give us the Anthropic key", repo: "home_repo", code: "T1-A2" } as unknown as WaitingItem;
const links = [{ kind: "same-key" as const, why: "both ask for ANTHROPIC_API_KEY" }];

describe("T94-S2 provider switch", () => {
  it("reads CONSOLE_TEXT_MODEL_PROVIDER: only anthropic switches, unset or anything else stays openai", () => {
    expect(textModelProvider({})).toBe("openai");
    expect(textModelProvider({ CONSOLE_TEXT_MODEL_PROVIDER: "openai" })).toBe("openai");
    expect(textModelProvider({ CONSOLE_TEXT_MODEL_PROVIDER: " Anthropic " })).toBe("anthropic");
    expect(textModelProvider({ CONSOLE_TEXT_MODEL_PROVIDER: "gemini" })).toBe("openai");
  });
});

describe("T94-S2 structurer", () => {
  it("Claude path: Haiku 5.5, strict JSON schema, effort low, the passed key as bearer (no env credential), cost at Haiku prices", async () => {
    const { f, seen } = fakeFetch(claudeReply(structure));
    const out = await anthropicStructurer(key, f)("I love it, add dark mode", ctx);
    expect(out.structure).toEqual(structure);
    expect(out.costUsd).toBeCloseTo((1000 * 0.1 + 200 * 0.5) / 1e6, 9);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(seen[0].headers.authorization).toBe("Bearer sk-test");
    const b = seen[0].body;
    expect(b.model).toBe("claude-haiku-5-5");
    expect(b.output_config.effort).toBe("low");
    expect(b.output_config.format.type).toBe("json_schema");
    expect(b.output_config.format.schema.required).toEqual(["summary", "sentiment", "asks", "bugs", "praise", "quotes"]);
    expect(b.output_config.format.schema.additionalProperties).toBe(false);
    expect(b.system).toMatch(/^You turn one customer's spoken feedback/);
    expect(b.messages).toEqual([{ role: "user", content: "Product: SocialApp. Campaign: TEST. Speaker: Ana.\n\nTranscript:\nI love it, add dark mode" }]);
    expect(b.temperature).toBeUndefined();
  });

  it("Claude path errors are plain: no key, a refusal, an API error", async () => {
    await expect(anthropicStructurer(async () => undefined, fakeFetch({}).f)("x", ctx)).rejects.toThrow(/no ANTHROPIC_API_KEY/);
    await expect(anthropicStructurer(key, fakeFetch(claudeReply({}, { stop_reason: "refusal", content: [] })).f)("x", ctx)).rejects.toThrow(/refusal/);
    await expect(anthropicStructurer(key, fakeFetch({ type: "error", error: { type: "invalid_request_error", message: "bad" } }, 400).f)("x", ctx)).rejects.toThrow(/Claude did not answer \(400\)/);
  });

  it("OpenAI path is the request it was before T94-S2, byte for byte", async () => {
    const { f, seen } = fakeFetch({ choices: [{ message: { content: JSON.stringify(structure) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    await openAiStructurer(key, f)("I love it", ctx);
    expect(seen[0].url).toBe("https://api.openai.com/v1/chat/completions");
    expect(JSON.stringify(seen[0].body)).toBe(
      JSON.stringify({
        model: STRUCTURE_MODEL,
        temperature: 0.2,
        response_format: { type: "json_schema", json_schema: { name: "feedback", strict: true, schema: seen[0].body.response_format.json_schema.schema } },
        messages: [
          {
            role: "system",
            content:
              "You turn one customer's spoken feedback into structured notes for a product team. Use only what they said; never invent. " +
              "Write in plain, short sentences in the language they spoke. Empty lists when there is nothing of that kind.",
          },
          { role: "user", content: `Product: SocialApp. Campaign: TEST. Speaker: Ana.\n\nTranscript:\nI love it` },
        ],
      }),
    );
  });
});

describe("T94-S2 settle judge", () => {
  it("Claude path: the same prompt and schema, a strict verdict back", async () => {
    const { f, seen } = fakeFetch(claudeReply({ settles: true, reason: "Both ask for the same key." }));
    const v = await anthropicJudge(key, f)(src, cand, links);
    expect(v).toEqual({ settles: true, reason: "Both ask for the same key." });
    const b = seen[0].body;
    expect(b.model).toBe("claude-haiku-5-5");
    expect(b.output_config.format.schema.required).toEqual(["settles", "reason"]);
    expect(b.system).toMatch(/^A product owner answered one question/);
    expect(b.messages[0].content).toContain("His answer: Pasted it in step 3.");
    expect(b.messages[0].content).toContain("What links them: both ask for ANTHROPIC_API_KEY.");
  });

  it("OpenAI path keeps its model, temperature and two messages", async () => {
    const { f, seen } = fakeFetch({ choices: [{ message: { content: JSON.stringify({ settles: false, reason: "No." }) } }] });
    const v = await openAiJudge(key, f)(src, cand, links);
    expect(v.settles).toBe(false);
    const b = seen[0].body;
    expect(Object.keys(b)).toEqual(["model", "temperature", "response_format", "messages"]);
    expect(b.model).toBe(JUDGE_MODEL);
    expect(b.temperature).toBe(0);
    expect(b.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user"]);
    expect(b.messages[1].content.split("\n\n")).toHaveLength(4);
  });
});

describe("T94-S2 GET/POST /api/text-model", () => {
  it("says the provider and runs one probe of each kind on the wired calls, one per 20 s", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { createApp } = await import("../src/app.js");
    const { openDb } = await import("../src/db.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e94s2-"));
    const db = openDb(path.join(dir, "console.db"));
    vi.useFakeTimers({ toFake: ["Date"] });
    const seenT: string[] = [];
    const app = createApp(db, {
      browser: { browserUrl: "http://127.0.0.1:9" },
      voice: { notesDir: path.join(dir, "notes"), structure: async (t) => (seenT.push(t), { structure: structure as any, costUsd: 0.0001 }) },
      settle: { judge: async (s, c) => ({ settles: s.words.includes("key") && c.question.includes("key"), reason: "fixture" }) },
    });
    const call = async (method: string, url: string, body?: unknown) => {
      const r = await app.request(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, json: (await r.json()) as any };
    };
    try {
      expect((await call("GET", "/api/text-model")).json).toEqual({ provider: "openai", model: "gpt-4o-mini" });
      const s = await call("POST", "/api/text-model/probe", { kind: "structure", transcript: "TEST: I like it" });
      expect(s.status).toBe(200);
      expect(s.json.result).toEqual(structure);
      expect(s.json.costUsd).toBe(0.0001);
      expect(seenT).toEqual(["TEST: I like it"]);
      expect((await call("POST", "/api/text-model/probe", { kind: "settle", question: "q", answer: "a key", openQuestion: "the key" })).status).toBe(429);
      expect((await call("POST", "/api/text-model/probe", { kind: "other" })).status).toBe(400);
      vi.setSystemTime(Date.now() + 21_000);
      const j = await call("POST", "/api/text-model/probe", { kind: "settle", question: "Paste the key", answer: "Pasted the key", openQuestion: "Give us the key" });
      expect(j.status).toBe(200);
      expect(j.json.result).toEqual({ settles: true, reason: "fixture" });
    } finally {
      vi.useRealTimers();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
