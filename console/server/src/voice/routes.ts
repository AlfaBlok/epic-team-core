import type { Context, Hono } from "hono";
import { z } from "zod";
import { notJordi } from "../status/mark.js";
import { VoiceError, type Voice } from "./voice.js";
import { homeWorld, ownerName } from "../identity.js";

const usageIn = z.object({ eventId: z.string().min(1).max(120), kind: z.enum(["response", "transcription"]), usage: z.record(z.unknown()) });
const endIn = z.object({
  reason: z.string().max(40).optional(),
  transcript: z.array(z.object({ who: z.string().max(10), text: z.string().max(4000), at: z.string().max(40).optional(), feedback: z.string().max(80).optional() })).max(600).optional(),
});
const askIn = z.object({ request: z.string().min(1).max(4000), confirmed: z.boolean().optional(), words: z.string().max(20000).optional(), kind: z.literal("feedback").optional() });
/** a call started from an inbox section brings that section's cards (as the page shows them). */
const cardIn = z.object({
  kind: z.enum(["review", "ask", "goal", "team"]),
  id: z.string().min(1).max(200),
  code: z.string().max(80).optional(),
  title: z.string().min(1).max(600),
  where: z.string().max(300).optional(),
  source: z.string().max(1200).optional(),
  goal: z.string().max(600).optional(),
  delivered: z.array(z.string().max(600)).max(8).optional(),
  evidence: z.string().max(600).optional(),
  decision: z.string().max(1200).optional(),
  options: z.array(z.string().max(300)).max(8).optional(),
  question: z.string().max(2000).optional(),
  recommend: z.string().max(600).optional(),
  buttons: z.array(z.string().min(1).max(120)).max(10).optional(),
});
const startIn = z.object({ focus: z.object({ section: z.string().trim().min(1).max(120), cards: z.array(cardIn).max(60) }).optional() });
const toolIn = z.object({ name: z.string().min(1).max(60), args: z.record(z.unknown()).optional() });
const settingsIn = z.object({
  enabled: z.boolean().optional(),
  /** voice calls on or off for every world (voice notes stay on). */
  calls: z.boolean().optional(),
  model: z.string().trim().min(3).max(80).optional(),
  monthCapUsd: z.number().positive().max(500).optional(),
  quietHangupS: z.number().int().min(20).max(600).optional(),
  /** tokens of conversation the voice keeps (0 = no cap). */
  historyTokens: z.number().int().min(0).max(28000).optional(),
  /** set this world's own month cap (its campaign calls) instead of the home world's; or its own voice switch (enabled). */
  world: z.string().trim().min(1).max(80).optional(),
});

/** The platform world: the only one with the Team desk's Call (other worlds call from their campaign chats). */
const VOICE_WORLD = homeWorld();

/**
 * /api/voice. Every call route is the owner's own, from his console page (the same rule as his chat messages); the
 * off switch can be flipped OFF by any caller of this world (an agent that sees something wrong), back on only by the owner.
 * The switch and the model are the platform's, for every world's calls too; `worldVoice` sets a world's own cap.
 */
export function mountVoice(api: Hono, voice: Voice, o: { world: () => string | undefined; worldVoice?: (world: string) => Voice }) {
  const inWorld = () => (o.world() ?? VOICE_WORLD) === VOICE_WORLD;
  const bad = (c: Context, m: string) => c.json({ error: { code: "validation_error", message: m } }, 400);

  api.get(
    "/voice/state",
    guard((c) => (inWorld() ? c.json(voice.state()) : c.json({ available: false, enabled: false, reason: `Call the desk is only on ${ownerName()}'s own console` }))),
  );
  api.get(
    "/voice/calls",
    guard((c) => (inWorld() ? c.json({ calls: voice.list(Number(c.req.query("limit")) || 50), state: voice.state() }) : c.json({ calls: [] }))),
  );
  api.put(
    "/voice/settings",
    guard(async (c) => {
      if (!inWorld()) return c.json({ error: { code: "world_scope", message: `voice settings are ${homeWorld()}'s` } }, 403);
      const p = settingsIn.safeParse(await body(c));
      if (!p.success) return bad(c, "enabled (boolean), model (string), monthCapUsd (number), quietHangupS (20..600), historyTokens (0 or 2000..28000), world (a world's own cap or switch)");
      const offOnly = (p.data.enabled === false || (p.data.enabled === undefined && p.data.calls === false)) && p.data.calls !== true && p.data.model === undefined && p.data.monthCapUsd === undefined && p.data.quietHangupS === undefined && p.data.historyTokens === undefined;
      if (!offOnly) {
        const why = notJordi((n) => c.req.header(n));
        if (why) return c.json({ error: { code: "jordi_only", message: `anyone may switch voice off; switching it on, the model and the cap are ${ownerName()}'s (${why})` } }, 403);
      }
      // `world` + monthCapUsd sets that world's own month cap (its campaign calls); the platform's switch and model hold for all.
      if (p.data.world && p.data.world !== VOICE_WORLD) {
        if (!o.worldVoice) return c.json({ error: { code: "not_found", message: "no world voice on this console" } }, 404);
        if (p.data.monthCapUsd) o.worldVoice(p.data.world).setMonthCap(p.data.monthCapUsd);
        // `world` + enabled is that world's own voice switch (its calls and voice notes); on is the owner's, off anyone's.
        if (p.data.enabled !== undefined) o.worldVoice(p.data.world).setEnabled(p.data.enabled);
        return c.json(o.worldVoice(p.data.world).state());
      }
      if (p.data.enabled !== undefined) voice.setEnabled(p.data.enabled);
      if (p.data.calls !== undefined) voice.setCalls(p.data.calls);
      if (p.data.model) voice.setModel(p.data.model);
      if (p.data.monthCapUsd) voice.setMonthCap(p.data.monthCapUsd);
      if (p.data.quietHangupS) voice.setQuietHangup(p.data.quietHangupS);
      if (p.data.historyTokens !== undefined) voice.setHistoryTokens(p.data.historyTokens);
      return c.json(voice.state());
    }),
  );
  mountCalls(api, "/voice", (c) => {
    if (!inWorld()) return c.json({ error: { code: "world_scope", message: `Call the desk is only on ${ownerName()}'s own console` } }, 403);
    return voice;
  });
}

/**
 * a campaign chat's Call (the social skin's desk, any world). The same call routes as the Team desk's, under
 * `/api/milestones/:id/voice`: the path's milestone in the caller's world (auth rule 3 404s another world's id; `voiceFor`
 * returns undefined for an unknown one), one Voice per milestone scoped to its world (budget, cap, one call at a time) and
 * to that milestone (its calls only), relaying to that milestone's own chat. Who calls: the world's owner, from the page.
 */
export function mountCampaignVoice(api: Hono, voiceFor: (milestoneId: string) => Voice | undefined) {
  const pick = (c: Context) => voiceFor(c.req.param("id") ?? "") ?? c.json({ error: { code: "not_found", message: `milestone ${c.req.param("id")} not found` } }, 404);
  api.get(
    "/milestones/:id/voice/state",
    guard((c) => {
      const v = pick(c);
      return v instanceof Response ? v : c.json(v.state());
    }),
  );
  mountCalls(api, "/milestones/:id/voice", pick);
}

/**
 * the objectives coach's call (/coach): the same call routes under /voice/coach, on the coach's own
 * Voice (his objectives read only, his words relayed to a desk). The owner's own console only.
 */
export function mountCoachVoice(api: Hono, coach: Voice, o: { world: () => string | undefined }) {
  mountOwnCall(api, "/voice/coach", coach, o, "The objectives coach");
}

/**
 * one of the owner's own calls with its own agent (the objectives coach at /voice/coach, the briefing call at
 * /voice/briefing): the same call routes under its prefix, on its own Voice. The owner's own console only.
 */
export function mountOwnCall(api: Hono, prefix: string, call: Voice, o: { world: () => string | undefined }, what: string) {
  const inWorld = () => (o.world() ?? VOICE_WORLD) === VOICE_WORLD;
  api.get(
    `${prefix}/state`,
    guard((c) => (inWorld() ? c.json(call.state()) : c.json({ available: false, enabled: false, reason: `${what} is only on ${ownerName()}'s own console` }))),
  );
  mountCalls(api, prefix, (c) => (inWorld() ? call : c.json({ error: { code: "world_scope", message: `${what} is only on ${ownerName()}'s own console` } }, 403)));
}

/** a world team desk's Call: the same call routes under /tenants/:id/desk/voice, on the world's Voice (or a 404). */
export function mountWorldDeskVoice(api: Hono, voiceFor: (c: Context) => Voice | undefined) {
  const pick = (c: Context) => voiceFor(c) ?? c.json({ error: { code: "not_found", message: `no team desk for world ${c.req.param("id")}` } }, 404);
  api.get(
    "/tenants/:id/desk/voice/state",
    guard((c) => {
      const v = pick(c);
      return v instanceof Response ? v : c.json(v.state());
    }),
  );
  mountCalls(api, "/tenants/:id/desk/voice", pick);
}

function guard(fn: (c: Context) => Promise<Response> | Response) {
  return async (c: Context) => {
    try {
      return await fn(c);
    } catch (e) {
      if (e instanceof VoiceError) return c.json({ error: { code: e.code, message: e.message } }, e.status);
      throw e;
    }
  };
}

/** sendBeacon (tab closing) posts text/plain: read any body as JSON. */
async function body(c: Context) {
  const t = await c.req.text().catch(() => "");
  try {
    return t ? JSON.parse(t) : {};
  } catch {
    return undefined;
  }
}

/**
 * Every call route (start, heartbeat, usage, hang up, the voice's two tools, the call list) under `prefix`, on the Voice
 * `pick` returns (or its refusal). Every call route is the owner's own, from his console page (the same rule as his chat messages).
 */
function mountCalls(api: Hono, prefix: string, pick: (c: Context) => Voice | Response) {
  const bad = (c: Context, m: string) => c.json({ error: { code: "validation_error", message: m } }, 400);
  const ownerOnly = (fn: (c: Context, voice: Voice) => Promise<Response> | Response) =>
    guard(async (c) => {
      const voice = pick(c);
      if (voice instanceof Response) return voice;
      const why = notJordi((n) => c.req.header(n));
      if (why) return c.json({ error: { code: "jordi_only", message: `only ${ownerName()} calls the desk, from the console page in his browser (${why})` } }, 403);
      return fn(c, voice);
    });
  if (prefix !== "/voice")
    api.get(
      `${prefix}/calls`,
      guard((c) => {
        const v = pick(c);
        return v instanceof Response ? v : c.json({ calls: v.list(Number(c.req.query("limit")) || 50), state: v.state() });
      }),
    );
  api.post(
    `${prefix}/calls`,
    ownerOnly(async (c, voice) => {
      const p = startIn.safeParse((await body(c)) ?? {});
      if (!p.success) return bad(c, "focus is optional: { section, cards: [{ kind, id, title, … }] } (at most 60 cards)");
      return c.json(await voice.start(p.data.focus), 201);
    }),
  );
  api.post(`${prefix}/calls/:cid/beat`, ownerOnly((c, voice) => c.json(voice.beat(c.req.param("cid") ?? ""))));
  api.post(
    `${prefix}/calls/:cid/usage`,
    ownerOnly(async (c, voice) => {
      const p = usageIn.safeParse(await body(c));
      if (!p.success) return bad(c, "eventId, kind (response | transcription) and usage (object) are required");
      return c.json(voice.usage(c.req.param("cid") ?? "", p.data));
    }),
  );
  api.post(
    `${prefix}/calls/:cid/end`,
    ownerOnly(async (c, voice) => {
      const p = endIn.safeParse(await body(c));
      if (!p.success) return bad(c, "reason (string) and transcript ([{who, text}]) are optional, nothing else");
      return c.json(await voice.end(c.req.param("cid") ?? "", p.data));
    }),
  );
  // Hang up the world's call this page does not hold (state's activeCall); `id` must still be the active one.
  api.post(
    `${prefix}/active/end`,
    ownerOnly(async (c, voice) => {
      const p = z.object({ id: z.string().min(1).max(80) }).safeParse(await body(c));
      if (!p.success) return bad(c, "id (the active call's id) is required");
      return c.json(voice.endActive(p.data.id));
    }),
  );
  api.get(`${prefix}/calls/:cid/status`, ownerOnly(async (c, voice) => c.json(await voice.status(c.req.param("cid") ?? ""))));
  api.post(
    `${prefix}/calls/:cid/ask`,
    ownerOnly(async (c, voice) => {
      const p = askIn.safeParse(await body(c));
      if (!p.success) return bad(c, "request (string) is required");
      return c.json(await voice.ask(c.req.param("cid") ?? "", p.data.request, p.data.confirmed, p.data.words, p.data.kind), 202);
    }),
  );
  // the tools the console answers itself (the inbox walk: next_card, read_card).
  api.post(
    `${prefix}/calls/:cid/tool`,
    ownerOnly(async (c, voice) => {
      const p = toolIn.safeParse(await body(c));
      if (!p.success) return bad(c, "name (string) and args (object) are required");
      return c.json(voice.tool(c.req.param("cid") ?? "", p.data.name, p.data.args ?? {}));
    }),
  );
  // the objectives coach's relay_to_desk: his words to the Team desk or the social desk.
  api.post(
    `${prefix}/calls/:cid/relay`,
    ownerOnly(async (c, voice) => {
      const p = z.object({ desk: z.string().min(1).max(20), words: z.string().min(1).max(8000), note: z.string().max(2000).optional(), objective: z.string().max(300).optional() }).safeParse(await body(c));
      if (!p.success) return bad(c, 'desk ("team" or "social") and words (his words) are required');
      return c.json(await voice.relay(c.req.param("cid") ?? "", p.data), 201);
    }),
  );
  api.get(`${prefix}/calls/:cid/ask/:askId`, ownerOnly(async (c, voice) => c.json(await voice.askState(c.req.param("cid") ?? "", c.req.param("askId") ?? ""))));
}
