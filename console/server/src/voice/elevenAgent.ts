import { VoiceError } from "./voice.js";

/**
 * Voice calls through ElevenLabs Agents (the owner asked for calls back on through ElevenLabs, and gave the key Agents
 * write access). Calls had been switched off because OpenAI's realtime
 * voice cost money; ElevenLabs runs on the grant's credits.
 *
 *   Call button ──▶ console: find or make the one desk agent ──▶ a signed call link (15 min, one call)
 *        │                                                            │
 *        └──────────── browser talks to the agent over that link ◀─────┘
 *                      (the console's prompt, briefing and tools; the key never leaves the console)
 *
 * The agent is made once on the account (found again by its name), with every tool the desk's call uses as a client tool
 * the page answers through the console's own call routes, and the prompt and first line overridable per call, so each
 * call still gets the console's instructions, briefing, inbox and earlier conversation.
 */

export const ELEVEN_AGENT_NAME = "EpicTeam Team desk call";
/** the voice that stands in for OpenAI's Marin on this account (video/library/narration.json). */
export const ELEVEN_VOICE_ID = "cgSgspJ2msm6clMCkdW9";
/** the model the call's voice speaks with: low delay (ElevenLabs asks an English agent for turbo or flash v2). */
export const ELEVEN_TTS_MODEL = "eleven_flash_v2";
export const ELEVEN_MODEL_LABEL = "elevenlabs-agents";
/** a desk answer may take a while: the agent waits this long for a client tool's result. */
export const ELEVEN_TOOL_WAIT_S = 120;

interface ToolDef {
  name: string;
  description: string;
  parameters: { properties?: Record<string, { type: string; description?: string }>; required?: string[] };
}

/** One of the console's tools as an ElevenLabs client tool (the page answers it). */
export function clientTool(t: ToolDef) {
  const properties = Object.fromEntries(
    Object.entries(t.parameters?.properties ?? {}).map(([k, p]) => [k, { type: p.type === "integer" ? "number" : p.type, description: p.description ?? k }]),
  );
  return {
    type: "client",
    name: t.name,
    description: t.description.slice(0, 1000),
    parameters: { type: "object", properties, required: t.parameters?.required ?? [] },
    expects_response: true,
    response_timeout_secs: ELEVEN_TOOL_WAIT_S,
  };
}

/** the agent as made on the account: the base prompt is replaced per call by the console's own instructions. */
export function agentBody(prompt: string, firstMessage: string, tools: ToolDef[], name: string = ELEVEN_AGENT_NAME, tags: string[] = ["epicteam", "team-desk"]) {
  return {
    name,
    tags,
    conversation_config: {
      agent: {
        first_message: firstMessage,
        language: "en",
        prompt: {
          prompt,
          tools: [...tools.filter((t) => t.name !== "hang_up").map(clientTool), { type: "system", name: "end_call", description: "End the call when he clearly says he is done, after one short goodbye.", params: { system_tool_type: "end_call" } }],
        },
      },
      tts: { voice_id: ELEVEN_VOICE_ID, model_id: ELEVEN_TTS_MODEL },
      conversation: { max_duration_seconds: 20 * 60 },
    },
    platform_settings: { overrides: { conversation_config_override: { agent: { prompt: { prompt: true }, first_message: true, language: true } } } },
  };
}

/** the same, its tools left as they are (a PATCH with tools would make a new copy of each tool on the account). */
export function withoutTools(body: ReturnType<typeof agentBody>) {
  const { tools: _t, ...prompt } = body.conversation_config.agent.prompt;
  return { ...body, conversation_config: { ...body.conversation_config, agent: { ...body.conversation_config.agent, prompt } } };
}

export interface ElevenLink {
  agentId: string;
  signedUrl: string;
}

/**
 * The console's door to ElevenLabs Agents: `link()` finds (or makes, once) the desk agent and returns a signed link
 * for one call. `key` reads agent-team-console/ELEVENLABS_API_KEY per call, held in memory only.
 */
export function elevenCalls(o: { /** the agent's name on the account (default: the Team desk's); the objectives coach has its own. */ name?: string; tags?: string[]; key: () => Promise<string | undefined>; prompt: () => string; firstMessage: () => string; tools: () => ToolDef[]; f?: typeof fetch; known?: { get(): string | undefined; set(id: string): void } }) {
  const f = o.f ?? fetch;
  const agentName = o.name ?? ELEVEN_AGENT_NAME;
  let agentId: string | undefined;
  const api = async (k: string, method: string, path: string, body?: unknown) => {
    let r: Response;
    try {
      r = await f(`https://api.elevenlabs.io${path}`, { method, headers: { "xi-api-key": k, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      throw new VoiceError(502, "elevenlabs_down", `ElevenLabs did not answer (${(e as Error).message.slice(0, 120)})`);
    }
    const j = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) throw new VoiceError(502, "elevenlabs_refused", `ElevenLabs refused the call (${r.status}): ${String(j?.detail?.message ?? j?.detail?.status ?? JSON.stringify(j?.detail ?? "no message")).slice(0, 200)}`);
    return j;
  };
  async function agent(k: string): Promise<string> {
    if (agentId) return agentId;
    let id: string | undefined = o.known?.get() || undefined;
    if (!id) {
      const found = await api(k, "GET", `/v1/convai/agents?search=${encodeURIComponent(agentName)}&page_size=30`);
      id = (found.agents ?? []).find((a: any) => a.name === agentName)?.agent_id;
    }
    const body = agentBody(o.prompt(), o.firstMessage(), o.tools(), agentName, o.tags);
    // found: brought in step with this console's greeting once per start, in the background (the call
    // never waits on it; each call overrides the prompt and greeting anyway); gone from the account: the signed link's
    // 404 makes it again (link()).
    if (id) {
      const known = id;
      void api(k, "PATCH", `/v1/convai/agents/${encodeURIComponent(known)}`, withoutTools(body)).catch((e) => {
        if (!/\(404\)/.test((e as Error).message)) console.warn(`voice: ElevenLabs agent not updated: ${(e as Error).message}`);
      });
    }
    id ??= (await api(k, "POST", "/v1/convai/agents/create", body)).agent_id as string | undefined;
    if (!id) throw new VoiceError(502, "elevenlabs_refused", "ElevenLabs made no agent");
    agentId = id;
    o.known?.set(id);
    return id;
  }
  return {
    async link(): Promise<ElevenLink> {
      const k = await o.key();
      if (!k) throw new VoiceError(503, "no_key", "the console has no ELEVENLABS_API_KEY (secret store agent-team-console/ELEVENLABS_API_KEY)");
      const id = await agent(k);
      try {
        const j = await api(k, "GET", `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(id)}`);
        return { agentId: id, signedUrl: j.signed_url };
      } catch (e) {
        // the agent was deleted on the account: make it again once.
        if (!/\(404\)/.test((e as Error).message)) throw e;
        agentId = undefined;
        o.known?.set("");
        const again = await agent(k);
        const j = await api(k, "GET", `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(again)}`);
        return { agentId: again, signedUrl: j.signed_url };
      }
    },
  };
}
export type ElevenCalls = ReturnType<typeof elevenCalls>;
